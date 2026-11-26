const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const forbidden = /^(?:config\.json|mcp\.json|data\/|\.release-local\/|\.impeccable\/|\.env(?:\.|$)|\.aws\/|\.codex\/|\.agents\/|DESIGN\.md$|PRODUCT\.md$)|(?:^|\/)(?:auth|credentials)\.json$|\.(?:png|jpe?g|webp|gif|log|pem|key)$/i;
// README screenshots are the only images that belong in the repository.
const isPrivate = (file) => !/^docs\/screenshots\/[\w-]+\.png$/.test(file) && forbidden.test(file);
const patterns = [
  ['personal Windows path', /[A-Z]:[\\/](?:Users|Documents and Settings)[\\/](?!Public\b|Default\b)[^\s<>"'`]+/i],
  ['private network address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['credential-like value', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
let failed = false;
const files = git('ls-files', '-z').split('\0').filter(Boolean);
for (const file of files) if (isPrivate(file)) { console.error(`Private/non-source file is tracked: ${file}`); failed = true; }
const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean);
const blobs = new Map();
for (const commit of commits) {
  for (const entry of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
    const [, , type, hash, file] = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (type !== 'blob') continue;
    if (isPrivate(file)) { console.error(`Private/non-source file in history: ${file} (${commit.slice(0, 8)})`); failed = true; }
    if (!blobs.has(hash)) blobs.set(hash, file);
  }
}
// Include uncommitted edits to tracked files as well as the actual history.
const texts = [...files.filter((file) => fs.existsSync(path.join(root, file))).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
  ...[...blobs].map(([hash, file]) => [`${file} (history ${hash.slice(0, 8)})`, git('cat-file', 'blob', hash)])];
for (const [file, content] of texts) for (const [label, pattern] of patterns) {
  // Reserved addresses in access-control fixtures are controlled test inputs.
  if (label === 'private network address' && file.startsWith('test/')) continue;
  if (pattern.test(content)) { console.error(`${label} requires review: ${file}`); failed = true; }
}
console.log(`Reviewed ${files.length} tracked files, ${commits.length} commits, and ${blobs.size} unique history blobs.`);
process.exitCode = failed ? 1 : 0;
