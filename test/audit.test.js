const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

test('release auditor inspects historical blobs even after a private file is removed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'audit-release.js'), path.join(root, 'scripts', 'audit-release.js'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Kuro test fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'config.json'), '{"private":"controlled fixture"}');
  git('add', 'config.json');
  git('commit', '-m', 'Controlled private-file fixture');
  git('rm', 'config.json');
  git('commit', '-m', 'Remove fixture from current tree');
  const result = spawnSync(process.execPath, ['scripts/audit-release.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Private\/non-source file in history: config.json/);
  assert.match(result.stdout, /2 commits, and 1 unique history blobs/);
});

test('release auditor allows README screenshots and rejects other images', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuro-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'docs', 'screenshots'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'audit-release.js'), path.join(root, 'scripts', 'audit-release.js'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = (file) => {
    fs.writeFileSync(path.join(root, file), 'controlled image fixture');
    git('add', file);
    git('commit', '-m', 'Controlled image fixture');
    return spawnSync(process.execPath, ['scripts/audit-release.js'], { cwd: root, encoding: 'utf8' });
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Kuro test fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  assert.equal(commit('docs/screenshots/home.png').status, 0);
  const rejected = commit('screen.png');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Private\/non-source file is tracked: screen\.png/);
});
