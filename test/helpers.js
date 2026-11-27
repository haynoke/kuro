const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(read, predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for expected state: ' + JSON.stringify(value));
}

async function sandbox(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-release-'));
  const source = path.resolve(__dirname, '..');
  for (const file of ['server.js', 'index.html', 'config.example.json']) fs.copyFileSync(path.join(source, file), path.join(root, file));
  for (const dir of ['lib', 'scripts']) fs.cpSync(path.join(source, dir), path.join(root, dir), { recursive: true });
  const fixture = path.join(root, 'provider.cjs');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'provider.cjs'), fixture);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'cli-adapter.cjs'), path.join(root, 'cli-adapter.cjs'));
  const config = { ...JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'))),
    port: await unusedPort(), workspaceRoot: path.join(root, 'workspaces'), accountsRoot: path.join(root, 'profiles'),
    codexPath: 'kuro-fixture-codex', claudePath: 'kuro-fixture-claude',
    accounts: [{ name: 'Codex', engine: 'codex', env: {} }], ...overrides };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  let child;
  let output = '';
  const base = `http://127.0.0.1:${config.port}`;
  const api = async (route, body, headers = {}) => {
    const response = await fetch(base + route, { ...(body !== undefined ? { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      headers: { 'Content-Type': 'application/json', 'X-Task-Runner': '1', ...headers } });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    // SIGTERM on Windows force-terminates the server; this intentionally exercises
    // persisted crash recovery. The fixture process exits with its parent pipe.
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await delay(150);
  };
  const start = async (env = {}, headers = {}) => {
    child = spawn(process.execPath, ['--require', path.join(root, 'cli-adapter.cjs'), 'server.js'], { cwd: root, windowsHide: true,
      env: { ...process.env, KURO_CONFIG: path.join(root, 'config.json'), KURO_DATA_DIR: path.join(root, 'data'), ...env } });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let lastError;
    await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { return await api('/api/state', undefined, headers); } catch (error) { lastError = error; return null; }
    }, (r) => r?.status === 200 && r.body.accounts.every((a) => a.ready || a.setupError !== 'Checking provider sign-in…'))
      .catch((error) => { throw new Error(`${error.message}\nServer: ${output}\nFetch: ${lastError?.cause || lastError}`); });
  };
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, fixture, config, api, start, stop, output: () => output, base };
}

module.exports = { sandbox, until, unusedPort };
