const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandSpec } = require('../lib/commands');

test('Windows npm providers run through Node without a shell or shim interpolation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'codex.cmd'), '@echo unsafe shim content must never be executed');
  assert.throws(() => commandSpec('codex', { PATH: root }, 'win32'), /native provider CLI/);
  const entry = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// fixture');
  assert.deepEqual(commandSpec('codex', { PATH: root }, 'win32'), { file: process.execPath, args: [entry] });
  const exe = path.join(root, 'codex.exe');
  fs.writeFileSync(exe, 'fixture');
  assert.deepEqual(commandSpec('codex', { PATH: root }, 'win32'), { file: exe, args: [] });
  assert.deepEqual(commandSpec('/usr/bin/codex', {}, 'linux'), { file: '/usr/bin/codex', args: [] });
});
