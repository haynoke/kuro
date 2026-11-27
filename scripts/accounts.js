// Add, remove and reorder accounts. A running Kuro picks changes up by itself.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, configPath } = require('../lib/config');
const { PROVIDERS } = require('../lib/providers');
const accounts = require('../lib/accounts');

const ROOT = path.resolve(__dirname, '..');
const ENGINES = Object.keys(PROVIDERS).join('|');
const USAGE = `Usage: node scripts/accounts.js <command>

  list                          show accounts in priority order
  add <${ENGINES}> [name]      add an account and sign in
      --new                     give it its own sign-in, even if it is the first
      --no-login                skip signing in for now
  login <name>                  sign an account in again
  move <name> <position>        change priority (1 is used first)
  remove <name>                 stop using an account`;

async function report(config, account) {
  const status = await accounts.accountStatus(config, account);
  console.log(status.ready ? `${account.name}: signed in and ready` : `${account.name}: ${status.error}`);
  return status;
}

async function main() {
  const [command = 'list', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  const flags = rest.filter((a) => a.startsWith('--'));
  const words = rest.filter((a) => !a.startsWith('--'));
  const unknown = flags.some((f) => !(command === 'add' && ['--new', '--no-login'].includes(f)));
  if (unknown || !['list', 'add', 'login', 'move', 'remove'].includes(command)) throw new Error(`Unrecognized command.\n\n${USAGE}`);

  const file = configPath(ROOT);
  if (command === 'add' && !fs.existsSync(file)) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), file, fs.constants.COPYFILE_EXCL);
    console.log('Created config.json from the example.');
  }
  const config = loadConfig(ROOT);

  if (command === 'list') {
    if (!config.accounts.length) return console.log(`No accounts yet. Add one: node scripts/accounts.js add <${ENGINES}>`);
    for (const [i, a] of config.accounts.entries()) {
      const status = await accounts.accountStatus(config, a);
      console.log(`${i + 1}. ${a.name} (${PROVIDERS[a.engine].label}): ${status.ready ? 'ready' : status.error}`);
    }
  } else if (command === 'add') {
    const account = accounts.addAccount(ROOT, { engine: words[0], name: words.slice(1).join(' '), useExisting: flags.includes('--new') ? false : undefined });
    console.log(`Added ${account.name} (${PROVIDERS[account.engine].label}).`);
    let status = await report(config, account);
    if (status.signedOut && !flags.includes('--no-login')) {
      console.log(`Starting ${PROVIDERS[account.engine].label} sign-in. Use the login you want for "${account.name}".`);
      accounts.signIn(config, account);
      status = await report(config, account);
    }
    if (!status.ready && !flags.includes('--no-login')) process.exitCode = 1;
  } else if (command === 'login') {
    const account = accounts.findAccount(config.accounts, words.join(' '));
    accounts.signIn(config, account);
    if (!(await report(config, account)).ready) process.exitCode = 1;
  } else if (command === 'move') {
    const position = Number(words.at(-1));
    const account = accounts.moveAccount(ROOT, words.slice(0, -1).join(' '), position);
    console.log(`${account.name} is now number ${position}.`);
  } else {
    const account = accounts.removeAccount(ROOT, words.join(' '));
    console.log(`Removed ${account.name}.`);
    const dir = accounts.profileDir(account);
    if (dir) console.log(`Its sign-in is still on this PC. Delete this folder to erase it: ${dir}`);
  }
}

main().catch((error) => { console.error('Kuro accounts: ' + error.message); process.exitCode = 1; });
