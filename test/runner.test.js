const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, until } = require('./helpers');
const { spawnSync } = require('node:child_process');

test('clean-copy task completes and public defaults disable optional services', async (t) => {
  const app = await sandbox(t);
  await app.start();
  assert.match(await (await fetch(app.base)).text(), /<title>Kuro<\/title>/);
  const state = (await app.api('/api/state')).body;
  assert.deepEqual(state.features, { chat: false, voice: false, desktopControl: false });
  assert.equal((await app.api('/api/chats', { text: 'hello' })).status, 503);
  assert.equal((await app.api('/api/transcribe', 'audio')).status, 503);
  assert.equal((await app.api('/api/tasks', { prompt: 42 })).status, 400);
  assert.equal((await app.api('/api/tasks', '{')).status, 400);
  assert.equal((await app.api('/api/tasks', { prompt: 'Do it', cwd: __filename })).status, 400);
  const created = await app.api('/api/tasks', { prompt: 'Create a small result and check it.', effort: 'medium' });
  assert.equal(created.status, 200);
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'done');
  assert.equal(fs.readFileSync(path.join(task.cwd, 'result.txt'), 'utf8'), 'kuro fixture task complete\n');
  assert.match(task.progress, /Completed and checked/);
  assert.equal(task.turns[0].outcome, 'done');
  const calls = fs.readFileSync(path.join(task.cwd, 'calls.jsonl'), 'utf8');
  assert.equal(JSON.parse(calls.trim()).tokenLeaked, false);
});

test('missing provider blocks once with an actionable error and never claims usage exhaustion', async (t) => {
  const app = await sandbox(t, { codexPath: path.join(__dirname, 'missing-provider.exe') });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Small task' });
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'blocked');
  assert.match(task.lastEvent.text, /Could not find/);
  assert.equal(task.waitUntil, null);
  assert.equal(task.turns.length, 0);
});

test('Claude permission denials stop for the user even if the agent reports DONE', async (t) => {
  const app = await sandbox(t);
  app.config.accounts = [{ name: 'Claude', engine: 'claude', env: { KURO_FIXTURE_SCENARIO: 'permission' } }];
  fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Small task' });
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'blocked');
  assert.match(task.lastEvent.text, /permission or sandbox/);
});

test('a second server exits with a useful port conflict message', async (t) => {
  const app = await sandbox(t);
  await app.start();
  const result = spawnSync(process.execPath, ['server.js'], { cwd: app.root,
    env: { ...process.env, KURO_CONFIG: path.join(app.root, 'config.json'), KURO_DATA_DIR: path.join(app.root, 'other-data') }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already used.*Change "port"/);
});

test('corrupt persisted tasks stop startup without overwriting the file', async (t) => {
  const app = await sandbox(t);
  const data = path.join(app.root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'tasks.json'), '{corrupt');
  const result = spawnSync(process.execPath, ['server.js'], { cwd: app.root,
    env: { ...process.env, KURO_CONFIG: path.join(app.root, 'config.json'), KURO_DATA_DIR: data }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Restore a backup/);
  assert.equal(fs.readFileSync(path.join(data, 'tasks.json'), 'utf8'), '{corrupt');
});
