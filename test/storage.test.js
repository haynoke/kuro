const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../lib/storage');

test('state is replaced atomically and corrupt state is never silently discarded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  assert.deepEqual(readJson(file, []), []);
  writeJson(file, [{ id: 'test', status: 'running' }]);
  assert.equal(readJson(file)[0].status, 'running');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readJson(file, []), /Restore a backup/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
