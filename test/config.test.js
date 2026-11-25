const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('../lib/config');

test('setup errors identify missing and malformed configuration without creating state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = process.env.KURO_CONFIG;
  delete process.env.KURO_CONFIG;
  t.after(() => { if (before === undefined) delete process.env.KURO_CONFIG; else process.env.KURO_CONFIG = before; });
  assert.throws(() => loadConfig(root), /Copy-Item/);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{');
  assert.throws(() => loadConfig(root), /valid JSON/);
  for (const config of [{ port: 0, accounts: [] }, { accounts: [] }, { accounts: [{ name: 'x', engine: 'other' }] }, { accounts: [{ name: 'x', engine: 'codex' }], voice: 'yes' }]) {
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => loadConfig(root));
  }
  const missing = path.join(root, 'absent.json');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'server.js')], { env: { ...process.env, KURO_CONFIG: missing, KURO_DATA_DIR: path.join(root, 'data') }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Kuro could not start/);
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
});
