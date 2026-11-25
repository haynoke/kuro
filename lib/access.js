const crypto = require('node:crypto');

function createAccess(config, token = process.env.KURO_AUTH_TOKEN || '') {
  const localHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
  const origins = new Set([...localHosts].map((host) => `http://${host}`));
  if (config.remoteAccess) {
    let origin;
    try { origin = new URL(config.publicOrigin); } catch { throw new Error('Remote access needs publicOrigin set to your Tailscale Serve HTTPS origin.'); }
    if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin || origin.username || origin.password) throw new Error('publicOrigin must be an HTTPS origin without a path or trailing slash.');
    if (Buffer.byteLength(token) < 32 || /[\r\n:]/.test(token)) throw new Error('Remote access needs KURO_AUTH_TOKEN with at least 32 bytes. See the phone setup in README.md.');
    localHosts.add(origin.host);
    origins.add(origin.origin);
  }
  const expected = crypto.createHash('sha256').update(`kuro:${token}`).digest();
  return (req, res) => {
    const reject = (code, message) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(code === 401 ? { 'WWW-Authenticate': 'Basic realm="Kuro", charset="UTF-8"' } : {}) });
      res.end(message);
      return false;
    };
    const addr = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (!['127.0.0.1', '::1'].includes(addr)) return reject(403, 'Kuro accepts loopback connections only. Use Tailscale Serve for phone access.');
    if (!localHosts.has(req.headers.host)) return reject(403, 'Host is not allowed. Configure authenticated remote access before using a proxy.');
    if (req.headers.origin && !origins.has(req.headers.origin)) return reject(403, 'Origin is not allowed.');
    if (config.remoteAccess) {
      const match = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(req.headers.authorization || '');
      const actual = crypto.createHash('sha256').update(match ? Buffer.from(match[1], 'base64') : '').digest();
      if (!match || !crypto.timingSafeEqual(expected, actual)) return reject(401, 'Sign in with username kuro and your KURO_AUTH_TOKEN.');
    }
    if (!['GET', 'POST'].includes(req.method)) return reject(405, 'Method not allowed.');
    if (req.method === 'POST' && req.headers['x-task-runner'] !== '1') return reject(403, 'Missing X-Task-Runner header.');
    return true;
  };
}

module.exports = { createAccess };
