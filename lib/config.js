const fs = require('node:fs');
const path = require('node:path');

function loadConfig(root) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Kuro needs Node.js 22 or newer.');
  const file = process.env.KURO_CONFIG ? path.resolve(process.env.KURO_CONFIG) : path.join(root, 'config.json');
  if (!fs.existsSync(file)) throw new Error('Missing config.json. In the Kuro folder, run: Copy-Item config.example.json config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Could not read config.json. Check that it contains valid JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json must contain an object.');
  config.port ??= 8790;
  for (const [key, min, max] of [['port', 1, 65535], ['maxParallel', 1, 16], ['maxRounds', 1, 1000], ['reviewRounds', 0, 10]]) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)) throw new Error(`Invalid ${key}: expected an integer from ${min} to ${max}.`);
  }
  if (!Array.isArray(config.accounts) || !config.accounts.length) throw new Error('Configure at least one account with engine "codex" or "claude".');
  const names = new Set();
  for (const account of config.accounts) {
    if (!account || typeof account.name !== 'string' || !account.name.trim() || names.has(account.name) || !['claude', 'codex'].includes(account.engine)) throw new Error('Accounts need unique names and engine "codex" or "claude".');
    if (account.env !== undefined && (!account.env || typeof account.env !== 'object' || Array.isArray(account.env) || Object.values(account.env).some((v) => typeof v !== 'string'))) throw new Error('Account env values must be strings.');
    names.add(account.name);
  }
  for (const key of ['claudeArgs', 'codexArgs']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== 'string'))) throw new Error(`${key} must be an array of strings.`);
  }
  for (const key of ['chat', 'voice', 'desktopControl', 'remoteAccess']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
  }
  for (const key of ['workspaceRoot', 'codexPath', 'claudePath', 'pythonPath', 'claudeMcpConfig']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) throw new Error(`${key} must be a nonempty path string.`);
  }
  return config;
}

module.exports = { loadConfig };
