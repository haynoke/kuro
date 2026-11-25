const { execFile } = require('node:child_process');

// Only presentation/model options belong here. Permission settings are owned by
// the runner, so a stale personal config cannot silently disable protection.
function checkedArgs(engine, values = []) {
  const withValue = engine === 'claude'
    ? new Set(['--model', '--max-turns', '--max-budget-usd', '--fallback-model'])
    : new Set(['--model', '-m']);
  const flags = engine === 'codex' ? new Set(['--skip-git-repo-check']) : new Set();
  for (let i = 0; i < values.length; i++) {
    if (flags.has(values[i])) continue;
    if (withValue.has(values[i]) && values[i + 1] && !values[i + 1].startsWith('-')) { i++; continue; }
    throw new Error(`Unsupported ${engine} argument "${values[i]}" in config.json. Remove permission/sandbox overrides; Kuro keeps provider protections enabled.`);
  }
  return [...values];
}

function cliArgs(engine, config, { cwd, sessionId, effort, model, progressDir }) {
  if (engine === 'claude') {
    const extra = checkedArgs(engine, config.claudeArgs);
    if (model) {
      const i = extra.indexOf('--model');
      if (i >= 0) extra.splice(i, 2);
      extra.push('--model', model);
    }
    return ['-p', '--output-format', 'stream-json', '--verbose', ...extra,
      '--permission-mode', 'default', '--add-dir', progressDir,
      ...(effort ? ['--effort', effort] : []),
      ...(config.claudeMcpConfig ? ['--mcp-config', config.claudeMcpConfig] : []),
      ...(sessionId ? ['--resume', sessionId] : [])];
  }
  return ['-a', 'on-request', 'exec', '--sandbox', 'workspace-write',
    '--add-dir', progressDir, ...(sessionId ? ['resume'] : []), '--json',
    ...checkedArgs(engine, config.codexArgs),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ...(model ? ['-m', model] : []), ...(sessionId ? [sessionId] : ['-C', cwd]), '-'];
}

function probe(command, args, env) {
  return new Promise((resolve) => {
    execFile(command, args, { env, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return resolve({ ready: false, error: `Could not find ${command}. Install the provider CLI or set its path in config.json, then restart Kuro.` });
      if (error) return resolve({ ready: false, error: `Provider sign-in check failed. Run ${command} ${args.join(' ')} in a terminal, finish signing in, then restart Kuro.` });
      if (args[0] === 'auth') {
        try { if (JSON.parse(stdout).loggedIn !== true) throw new Error(); }
        catch { return resolve({ ready: false, error: 'Claude is not signed in. Run claude auth login in a terminal, then restart Kuro.' }); }
      } else if (!/logged in/i.test(stdout + stderr)) {
        return resolve({ ready: false, error: 'Codex is not signed in. Run codex login in a terminal, then restart Kuro.' });
      }
      resolve({ ready: true });
    });
  });
}

module.exports = { checkedArgs, cliArgs, probe };
