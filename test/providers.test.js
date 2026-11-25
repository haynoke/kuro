const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkedArgs, cliArgs } = require('../lib/providers');

test('provider protections remain enabled for new and resumed sessions', () => {
  for (const sessionId of [undefined, 'session-id']) {
    const codex = cliArgs('codex', {}, { cwd: '.', progressDir: 'progress', sessionId });
    assert.deepEqual(codex.slice(0, 5), ['-a', 'on-request', 'exec', '--sandbox', 'workspace-write']);
    if (sessionId) assert.ok(codex.indexOf('--sandbox') < codex.indexOf('resume'));
    const claude = cliArgs('claude', {}, { progressDir: 'progress', sessionId });
    assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'default');
    assert.ok(claude.includes('--add-dir'));
  }
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '-c', '--sandbox']) assert.throws(() => checkedArgs('codex', [flag]), /Unsupported/);
  for (const flag of ['--dangerously-skip-permissions', '--permission-mode', '--allowedTools', '--settings']) assert.throws(() => checkedArgs('claude', [flag]), /Unsupported/);
});
