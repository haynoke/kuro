const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, until } = require('./helpers');

test('crash recovery resumes the saved session and marks the interrupted turn', async (t) => {
  const app = await sandbox(t);
  app.config.accounts[0].env.KURO_FIXTURE_SCENARIO = 'hold';
  fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Complete the result after restart.' });
  const route = '/api/tasks/' + created.body.id;
  await until(async () => {
    try { return JSON.parse(fs.readFileSync(path.join(app.root, 'data', 'tasks.json'))).find((x) => x.id === created.body.id); }
    catch { return null; }
  }, (task) => task?.sessions?.Codex === 'fixture-codex' && task.status === 'running');
  await app.stop();
  await app.start();
  const task = await until(async () => (await app.api(route)).body, (r) => r.status === 'done');
  assert.equal(task.turns[0].outcome, 'interrupted');
  assert.equal(task.turns[1].resumed, true);
  assert.ok(task.events.some((e) => /Runner restarted/.test(e.text)));
  const calls = fs.readFileSync(path.join(task.cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('resume'));
  assert.ok(calls[1].args.includes('fixture-codex'));
});

test('rate-limit handoff passes progress and waits for reset when all providers are limited', async (t) => {
  const app = await sandbox(t, { accounts: [
    { name: 'Codex', engine: 'codex', env: { KURO_FIXTURE_SCENARIO: 'limit' } },
    { name: 'Claude', engine: 'claude', env: {} },
  ] });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Finish after the first provider runs out.' });
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'done');
  assert.equal(task.account, 'Claude');
  assert.ok(task.events.some((e) => /Switching from Codex to Claude/.test(e.text)));
  assert.equal(task.turns[0].outcome, 'out of usage');
  assert.match(task.turns[1].prompt, /Read .*PROGRESS.md first/);
  const state = (await app.api('/api/state')).body;
  assert.ok(state.accounts[0].limitedUntil > Date.now());

  await app.stop();
  app.config.accounts[1].env.KURO_FIXTURE_SCENARIO = 'limit';
  fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
  await app.start();
  const next = await app.api('/api/tasks', { prompt: 'Wait for usage.' });
  const waiting = await until(async () => (await app.api('/api/tasks/' + next.body.id)).body, (r) => r.status === 'waiting');
  assert.ok(waiting.waitUntil > Date.now());
  assert.match(waiting.lastEvent.text, /Waiting until/);

  // Expire persisted cooldowns under controlled input rather than waiting minutes.
  await app.stop();
  const file = path.join(app.root, 'data', 'accounts.json');
  const accounts = JSON.parse(fs.readFileSync(file));
  for (const account of Object.values(accounts)) account.limitedUntil = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(accounts));
  const tasksFile = path.join(app.root, 'data', 'tasks.json');
  const tasks = JSON.parse(fs.readFileSync(tasksFile));
  for (const task of tasks) if (task.status === 'waiting') task.waitUntil = Date.now() - 1;
  fs.writeFileSync(tasksFile, JSON.stringify(tasks));
  app.config.accounts.forEach((a) => { a.env.KURO_FIXTURE_SCENARIO = 'done'; });
  fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
  await app.start();
  await until(async () => (await app.api('/api/tasks/' + next.body.id)).body, (r) => r.status === 'done', 15000);
});

test('invalid review output never produces a passed review', async (t) => {
  const app = await sandbox(t, { accounts: [
    { name: 'Codex', engine: 'codex', env: {} },
    { name: 'Claude', engine: 'claude', env: { KURO_FIXTURE_SCENARIO: 'bad-review' } },
  ] });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Work that needs review.', effort: 'high' });
  const task = await until(async () => (await app.api('/api/tasks/' + created.body.id)).body, (r) => r.status === 'blocked');
  assert.match(task.lastEvent.text, /reviewer did not return/);
});
