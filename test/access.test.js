const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAccess } = require('../lib/access');

function request(access, { host = 'localhost:8790', address = '127.0.0.1', method = 'GET', headers = {} } = {}) {
  let status = 200;
  const res = { writeHead(code, h) { status = code; this.headers = h; }, end() {} };
  const allowed = access({ socket: { remoteAddress: address }, method, headers: { host, ...headers } }, res);
  return { allowed, status, headers: res.headers };
}

test('localhost boundary rejects DNS rebinding, non-loopback, cross-origin and headerless writes', () => {
  const access = createAccess({ port: 8790 });
  assert.equal(request(access).allowed, true);
  for (const options of [{ host: 'evil.example:8790' }, { address: '100.64.0.1' }, { headers: { origin: 'https://evil.example' } }, { method: 'POST' }]) assert.equal(request(access, options).status, 403);
  assert.equal(request(access, { method: 'POST', headers: { 'x-task-runner': '1', origin: 'http://localhost:8790' } }).allowed, true);
  assert.equal(request(access, { method: 'DELETE' }).status, 405);
});

test('remote mode fails closed and authenticates every resource, including localhost', () => {
  const config = { port: 8790, remoteAccess: true, publicOrigin: 'https://pc.example.ts.net' };
  const token = 'a'.repeat(48);
  assert.throws(() => createAccess(config, ''), /KURO_AUTH_TOKEN/);
  assert.throws(() => createAccess({ ...config, publicOrigin: 'http://pc.example.ts.net' }, token), /HTTPS/);
  assert.throws(() => createAccess({ ...config, publicOrigin: 'https://pc.example.ts.net/' }, token), /origin/);
  const access = createAccess(config, token);
  assert.equal(request(access).status, 401);
  assert.match(request(access).headers['WWW-Authenticate'], /^Basic/);
  assert.equal(request(access, { host: 'pc.example.ts.net' }).status, 401);
  assert.equal(request(access, { headers: { authorization: 'Basic ' + Buffer.from('kuro:wrong').toString('base64') } }).status, 401);
  const authorization = 'Basic ' + Buffer.from(`kuro:${token}`).toString('base64');
  assert.equal(request(access, { host: 'pc.example.ts.net', headers: { authorization } }).allowed, true);
  assert.equal(request(access, { host: 'pc.example.ts.net', headers: { authorization, origin: 'https://evil.example' } }).status, 403);
});
