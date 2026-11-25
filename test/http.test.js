const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { sandbox, until } = require('./helpers');

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
}

test('HTTP access gates pages, API, uploads and task images with the same credentials', async (t) => {
  const app = await sandbox(t);
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Make a result.' });
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'done');
  fs.writeFileSync(path.join(app.root, 'data', 'tasks', task.id, 'files', 'test.png'), 'fixture image');
  await app.stop();
  Object.assign(app.config, { remoteAccess: true, publicOrigin: 'https://kuro.example.ts.net' });
  fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
  const token = 'controlled-test-token-'.repeat(3);
  // start() waits for an authenticated API response.
  const authorization = 'Basic ' + Buffer.from(`kuro:${token}`).toString('base64');
  await app.start({ KURO_AUTH_TOKEN: token }, { authorization });
  for (const route of ['/', '/api/state', '/uploads/img-1-abc.png', '/screens/shot-1.png', `/files/${task.id}/test.png`]) {
    assert.equal((await fetch(app.base + route)).status, 401);
  }
  assert.equal((await fetch(app.base, { headers: { authorization } })).status, 200);
  assert.equal((await fetch(app.base + `/files/${task.id}/test.png`, { headers: { authorization } })).status, 200);
  assert.equal(await rawGet(app.base + '/api/state', { authorization, Host: 'evil.example' }), 403);
  assert.equal((await fetch(app.base + '/api/state', { headers: { authorization, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(app.base + '/api/tasks', { method: 'POST', headers: { authorization }, body: '{}' })).status, 403);
  assert.equal(await rawGet(app.base + '/api/state', { authorization, Host: 'kuro.example.ts.net' }), 200);
});
