const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, until } = require('./helpers');

const readConfig = (app) => JSON.parse(fs.readFileSync(path.join(app.root, 'config.json'), 'utf8'));
const writeConfig = (app) => fs.writeFileSync(path.join(app.root, 'config.json'), JSON.stringify(app.config));
const state = async (app) => (await app.api('/api/state')).body;
const taskUntil = (app, id, status, timeout) => until(async () => (await app.api('/api/tasks/' + id)).body, (t) => t.status === status, timeout);
const account = (name, engine = 'codex', scenario) => ({ name, engine, env: scenario ? { KURO_FIXTURE_SCENARIO: scenario } : {} });
const cli = (app, args, env = {}) => spawnSync(process.execPath, ['--require', path.join(app.root, 'cli-adapter.cjs'), path.join('scripts', 'accounts.js'), ...args],
  { cwd: app.root, env: { ...process.env, KURO_CONFIG: path.join(app.root, 'config.json'), ...env }, encoding: 'utf8', timeout: 20000 });

test('the command adds, signs in, reorders and removes accounts while keeping other settings', async (t) => {
  const app = await sandbox(t, { accounts: [], maxParallel: 3 });
  for (const args of [['add', 'claude'], ['add', 'claude', 'Work', 'laptop'], ['add', 'codex'], ['add', 'claude']]) {
    const run = cli(app, args);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /signed in and ready/);
  }
  let config = readConfig(app);
  assert.deepEqual(config.accounts.map((a) => a.name), ['Claude', 'Work laptop', 'Codex', 'Claude 2']);
  // The first of a provider reuses the PC sign-in; later ones get a folder of their own.
  assert.deepEqual(config.accounts[0].env, {});
  assert.deepEqual(config.accounts[2].env, {});
  const first = config.accounts[1].env.CLAUDE_CONFIG_DIR;
  const second = config.accounts[3].env.CLAUDE_CONFIG_DIR;
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), config.accountsRoot);
  assert.ok(fs.existsSync(first));
  assert.equal(config.maxParallel, 3);

  assert.equal(cli(app, ['move', 'claude 2', '1']).status, 0);
  const removed = cli(app, ['remove', 'Work', 'laptop']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(removed.stdout.includes(first));
  assert.ok(fs.existsSync(first), 'removing an account leaves its sign-in on disk');
  config = readConfig(app);
  assert.deepEqual(config.accounts.map((a) => a.name), ['Claude 2', 'Claude', 'Codex']);

  const before = fs.readFileSync(path.join(app.root, 'config.json'), 'utf8');
  for (const args of [['add', 'other'], ['add', 'claude', 'claude'], ['add', 'claude', '../x'], ['add', 'claude', 'constructor'], ['move', 'Codex', '9'], ['remove', 'nobody'], ['add', 'codex', '--force']]) {
    assert.equal(cli(app, args).status, 1, args.join(' '));
  }
  assert.equal(fs.readFileSync(path.join(app.root, 'config.json'), 'utf8'), before);
});

test('the command creates a missing config from the example', async (t) => {
  const app = await sandbox(t);
  const file = path.join(app.root, 'fresh.json');
  const example = path.join(app.root, 'config.example.json');
  fs.writeFileSync(example, JSON.stringify({ ...JSON.parse(fs.readFileSync(example, 'utf8')), codexPath: 'kuro-fixture-codex' }));
  const run = cli(app, ['add', 'codex'], { KURO_CONFIG: file });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts, [{ name: 'Codex', engine: 'codex', env: {} }]);
});

test('accounts added from the web page work without a restart', async (t) => {
  const app = await sandbox(t, { accounts: [] });
  await app.start();
  assert.deepEqual((await state(app)).accounts, []);
  const created = await app.api('/api/tasks', { prompt: 'Small task' });
  const blocked = await taskUntil(app, created.body.id, 'blocked');
  assert.match(blocked.lastEvent.text, /no accounts yet/);

  // Paths and environment values from the browser are ignored.
  const added = await app.api('/api/accounts', { engine: 'claude', name: 'Mine', env: { PATH: 'x' }, accountsRoot: 'x' });
  assert.equal(added.status, 200);
  assert.deepEqual(readConfig(app).accounts, [{ name: 'Mine', engine: 'claude', env: {} }]);
  await until(() => state(app), (s) => s.accounts[0]?.ready);
  await app.api(`/api/tasks/${created.body.id}/resume`, {});
  await taskUntil(app, created.body.id, 'done');

  // A second one of the same provider starts signed out, with the command that fixes it.
  assert.equal((await app.api('/api/accounts', { engine: 'claude', useExisting: true })).status, 400);
  assert.equal((await app.api('/api/accounts', { engine: 'claude' })).body.name, 'Claude');
  const waiting = await until(() => state(app), (s) => s.accounts[1]?.signInCommand);
  assert.equal(waiting.accounts[1].ready, false);
  assert.equal(waiting.accounts[1].signInCommand, "node scripts/accounts.js login 'Claude'");
  const login = cli(app, ['login', 'Claude']);
  assert.equal(login.status, 0, login.stdout + login.stderr);
  assert.equal((await app.api('/api/accounts/check', {})).status, 200);
  assert.equal((await state(app)).accounts[1].ready, true);

  assert.equal((await app.api('/api/accounts/Claude/move', { position: 1 })).status, 200);
  assert.deepEqual((await state(app)).accounts.map((a) => a.name), ['Claude', 'Mine']);
  assert.equal((await app.api('/api/accounts/Claude/move', { position: 0 })).status, 400);
  assert.equal((await app.api('/api/accounts/Mine/remove', {})).status, 200);
  assert.deepEqual((await state(app)).accounts.map((a) => a.name), ['Claude']);
  assert.equal((await app.api('/api/accounts/Mine/remove', {})).status, 404);
  assert.equal((await app.api('/api/accounts', { engine: 'nope' })).status, 400);
  assert.equal((await app.api('/api/accounts', { engine: 'codex', name: 7 })).status, 400);
});

test('a task moves down any number of accounts until one can finish it', async (t) => {
  const app = await sandbox(t, { accounts: [
    account('One', 'codex', 'limit'), account('Two', 'claude', 'limit'), account('Three', 'codex', 'limit'),
    account('Four', 'claude', 'limit'), account('Five'),
  ] });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Finish eventually.' });
  const task = await taskUntil(app, created.body.id, 'done', 30000);
  assert.deepEqual(task.turns.map((turn) => turn.account), ['One', 'Two', 'Three', 'Four', 'Five']);
});

test('a task can start with one chosen account', async (t) => {
  const app = await sandbox(t, { accounts: [account('One'), account('Two'), account('Three', 'claude')] });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Use the second.', prefer: 'account:Two' });
  assert.equal((await taskUntil(app, created.body.id, 'done')).turns[0].account, 'Two');
  const provider = await app.api('/api/tasks', { prompt: 'Use that provider.', prefer: 'claude' });
  assert.equal((await taskUntil(app, provider.body.id, 'done')).turns[0].account, 'Three');
  assert.equal((await app.api('/api/tasks', { prompt: 'x', prefer: 'account:Nobody' })).status, 400);
});

test('a waiting task continues as soon as another account is added to the config', async (t) => {
  const app = await sandbox(t, { accounts: [account('One', 'codex', 'limit')] });
  await app.start();
  const created = await app.api('/api/tasks', { prompt: 'Wait for usage.' });
  await taskUntil(app, created.body.id, 'waiting');
  app.config.accounts.push(account('Two'));
  writeConfig(app);
  const task = await taskUntil(app, created.body.id, 'done', 15000);
  assert.equal(task.account, 'Two');
  assert.ok(task.events.some((e) => /An account is available/.test(e.text)));

  // An invalid edit is ignored; removing an account drops its saved cooldown.
  fs.writeFileSync(path.join(app.root, 'config.json'), '{broken');
  await until(() => app.output(), (text) => /Kept the previous accounts/.test(text));
  assert.equal((await state(app)).accounts.length, 2);
  app.config.accounts = [account('Two')];
  writeConfig(app);
  await until(() => state(app), (s) => s.accounts.length === 1);
  await until(() => JSON.parse(fs.readFileSync(path.join(app.root, 'data', 'accounts.json'), 'utf8')), (saved) => !saved.One);
});

test('an account that keeps failing is set aside for the next one', async (t) => {
  const app = await sandbox(t, { accounts: [account('Broken', 'codex', 'error'), account('Working')] });
  const data = path.join(app.root, 'data');
  fs.mkdirSync(data);
  // Two failures already happened, so the next one is the third.
  fs.writeFileSync(path.join(data, 'tasks.json'), JSON.stringify([{ id: 'abc', num: 1, title: 'Retry', prompt: 'Do it.', cwd: app.root, effort: 'medium',
    account: 'Broken', status: 'queued', phase: 'work', rounds: 0, errors: 2, sessions: {}, inbox: [], events: [], created: Date.now(), updated: Date.now() }]));
  await app.start();
  const task = await taskUntil(app, 'abc', 'done');
  assert.equal(task.account, 'Working');
  assert.ok(task.events.some((e) => /Setting Broken aside/.test(e.text)));
});
