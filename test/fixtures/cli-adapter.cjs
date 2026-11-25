// Test-process-only dependency injection. Production never loads this module.
const cp = require('node:child_process');
const path = require('node:path');
for (const method of ['spawn', 'execFile']) {
  const original = cp[method];
  cp[method] = (command, args, ...rest) => {
    if (/^kuro-fixture-(codex|claude)$/.test(command)) return original(process.execPath, [path.join(__dirname, 'provider.cjs'), ...args], ...rest);
    return original(command, args, ...rest);
  };
}
