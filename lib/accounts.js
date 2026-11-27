// Accounts are a list of any length in config.json. Order is priority.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { configPath, validateAccounts } = require('./config');
const { PROVIDERS, probe } = require('./providers');
const { commandSpec } = require('./commands');

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@()+-]{0,59}$/u;

function childEnv(account) {
  const env = { ...process.env };
  // Drop variables from whatever launched Kuro (for example a Claude desktop
  // session), so the workers start like a normal terminal would.
  for (const k of Object.keys(env)) {
    if (/^CLAUDE/i.test(k) || k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  const result = { ...env, ...(account.env || {}) };
  delete result.KURO_AUTH_TOKEN;
  return result;
}

const commandFor = (config, engine) => config[PROVIDERS[engine].pathKey] || PROVIDERS[engine].command;
const profileDir = (account) => account.env?.[PROVIDERS[account.engine].homeVar] || null;
const usesDefaultLogin = (accounts, engine) => accounts.some((a) => a.engine === engine && !profileDir(a));
// Changes when an account starts pointing at a different sign-in.
const fingerprint = (account) => `${account.engine}:${profileDir(account) || ''}`;
const accountsRoot = (config) => config.accountsRoot || path.join(os.homedir(), '.kuro', 'accounts');
// Quoted for PowerShell, where single quotes are literal.
const signInCommand = (name) => `node scripts/accounts.js login '${name.replace(/'/g, "''")}'`;

// Every edit re-reads the file, changes only the accounts list, and replaces it whole.
function editAccounts(root, change) {
  const file = configPath(root);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Could not read ${file}. Check that it exists and contains valid JSON.`); }
  const accounts = [...(config.accounts || [])];
  validateAccounts(accounts);
  const result = change(accounts, config);
  validateAccounts(accounts);
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ ...config, accounts }, null, 2) + '\n');
  fs.renameSync(temp, file);
  return result;
}

function findAccount(accounts, name) {
  const wanted = String(name || '').trim();
  const exact = accounts.find((a) => a.name === wanted);
  if (exact) return exact;
  const close = accounts.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (close.length === 1) return close[0];
  throw new Error(`No account named "${wanted}".`);
}

// useExisting: true reuses the sign-in already on this PC, false makes a new profile
// folder. Left out, the first account of a provider reuses it and later ones do not.
function addAccount(root, { engine, name, useExisting } = {}) {
  const provider = Object.hasOwn(PROVIDERS, engine) ? PROVIDERS[engine] : null;
  if (!provider) throw new Error(`Choose a provider: ${Object.keys(PROVIDERS).join(' or ')}.`);
  return editAccounts(root, (accounts, config) => {
    const taken = (n) => accounts.some((a) => a.name.toLowerCase() === n.toLowerCase());
    let chosen = String(name || '').trim();
    if (!chosen) {
      chosen = provider.name;
      for (let n = 2; taken(chosen); n++) chosen = `${provider.name} ${n}`;
    }
    if (!NAME_RE.test(chosen) || chosen in {}) throw new Error('Account names start with a letter or number and use letters, numbers, spaces or . _ @ ( ) + - (60 at most).');
    if (taken(chosen)) throw new Error(`There is already an account named "${chosen}".`);
    const defaultTaken = usesDefaultLogin(accounts, engine);
    const reuse = useExisting ?? !defaultTaken;
    if (reuse && defaultTaken) throw new Error(`Another account already uses the ${provider.label} sign-in on this PC. Add this one with its own sign-in.`);
    const account = { name: chosen, engine, env: {} };
    if (!reuse) {
      const dir = path.join(accountsRoot(config), `${engine}-${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(dir, { recursive: true });
      account.env[provider.homeVar] = dir;
    }
    accounts.push(account);
    return account;
  });
}

// The profile folder and its sign-in stay on disk; only the list entry goes.
function removeAccount(root, name) {
  return editAccounts(root, (accounts) => {
    const account = findAccount(accounts, name);
    accounts.splice(accounts.indexOf(account), 1);
    return account;
  });
}

// position is 1 for first.
function moveAccount(root, name, position) {
  return editAccounts(root, (accounts) => {
    const account = findAccount(accounts, name);
    if (!Number.isInteger(position) || position < 1 || position > accounts.length) throw new Error(`Position must be a number from 1 to ${accounts.length}.`);
    accounts.splice(accounts.indexOf(account), 1);
    accounts.splice(position - 1, 0, account);
    return account;
  });
}

async function accountStatus(config, account) {
  const result = await probe(commandFor(config, account.engine), PROVIDERS[account.engine].statusArgs, childEnv(account));
  if (result.signedOut) result.error = `Not signed in. In the Kuro folder, run: ${signInCommand(account.name)}`;
  return result;
}

// Opens the provider's own sign-in in this terminal, pointed at the account's profile.
function signIn(config, account) {
  const env = childEnv(account);
  const dir = profileDir(account);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const spec = commandSpec(commandFor(config, account.engine), env);
  const result = spawnSync(spec.file, [...spec.args, ...PROVIDERS[account.engine].loginArgs], { env, stdio: 'inherit' });
  if (result.error) throw new Error(`Could not start ${PROVIDERS[account.engine].label}: ${result.error.message}`);
  return result.status === 0;
}

module.exports = { childEnv, commandFor, profileDir, usesDefaultLogin, fingerprint, signInCommand, findAccount, addAccount, removeAccount, moveAccount, accountStatus, signIn };
