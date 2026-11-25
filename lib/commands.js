const fs = require('node:fs');
const path = require('node:path');

// Node cannot execute npm's Windows .cmd shims with shell:false. Run the known
// package entry point directly, keeping prompts on stdin and out of cmd.exe.
function commandSpec(command, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: command, args: [] };
  const candidates = /[\\/]/.test(command)
    ? [command]
    : String(env.PATH || env.Path || '').split(path.delimiter).flatMap((dir) => [path.join(dir, command + '.exe'), path.join(dir, command + '.cmd')]);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (!/\.cmd$/i.test(candidate)) return { file: candidate, args: [] };
    const name = path.basename(candidate, '.cmd').toLowerCase();
    const entry = { codex: ['@openai', 'codex', 'bin', 'codex.js'], claude: ['@anthropic-ai', 'claude-code', 'cli.js'] }[name];
    const script = entry && path.join(path.dirname(candidate), 'node_modules', ...entry);
    if (script && fs.existsSync(script)) return { file: process.execPath, args: [script] };
    throw new Error(`Cannot run ${candidate} without a shell. Install the native provider CLI or set its executable path in config.json.`);
  }
  return { file: command, args: [] };
}

module.exports = { commandSpec };
