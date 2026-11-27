const { execFile } = require('node:child_process');
const { commandSpec } = require('./commands');

// What differs between the supported CLIs when handling accounts.
const PROVIDERS = {
  claude: { label: 'Claude Code', name: 'Claude', command: 'claude', pathKey: 'claudePath', argsKey: 'claudeArgs',
    homeVar: 'CLAUDE_CONFIG_DIR', statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'] },
  codex: { label: 'Codex', name: 'Codex', command: 'codex', pathKey: 'codexPath', argsKey: 'codexArgs',
    homeVar: 'CODEX_HOME', statusArgs: ['login', 'status'], loginArgs: ['login'] },
};

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
    let spec;
    try { spec = commandSpec(command, env); }
    catch (error) { return resolve({ ready: false, error: error.message }); }
    execFile(spec.file, [...spec.args, ...args], { env, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return resolve({ ready: false, error: `Could not find ${command}. Install the provider CLI or set its path in config.json.` });
      // Both CLIs exit with an error when signed out, so read the answer first.
      let signedIn;
      if (args[0] === 'auth') {
        try { signedIn = JSON.parse(stdout).loggedIn === true; } catch {}
      } else {
        const text = stdout + stderr;
        signedIn = /not logged in/i.test(text) ? false : /logged in/i.test(text) ? true : undefined;
      }
      if (signedIn === false) return resolve({ ready: false, signedOut: true, error: 'Not signed in.' });
      if (error || !signedIn) return resolve({ ready: false, error: `Sign-in check failed. Run ${command} ${args.join(' ')} in a terminal to see why.` });
      resolve({ ready: true });
    });
  });
}

module.exports = { PROVIDERS, checkedArgs, cliArgs, probe };
