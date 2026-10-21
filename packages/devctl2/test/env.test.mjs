import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { $ } from 'zx';
import { findEnvFiles, updateAllAppEnvFiles } from '../dist/utils/env.js';

const PRUNED = new Set(['node_modules', '.git', '.claude']);
const tmpDirs = [];

async function mkTmp(prefix) {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

async function write(root, rel, content = 'X=1\n') {
  const full = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, content);
  return full;
}

let root;
let realFiles;

before(async () => {
  root = await mkTmp('devctl2-env-find-');
  realFiles = [
    await write(root, '.env'),
    await write(root, 'apps/api/.env'),
    await write(root, 'apps/web/.env'),
    await write(root, 'packages/database/.env'),
  ];
  // decoys
  await write(root, 'node_modules/pkg/.env');
  await write(root, 'apps/web/node_modules/pkg/.env');
  await write(root, '.claude/worktrees/wt/apps/api/.env');
  await write(root, '.git/.env');
  await write(root, 'apps/web/.claude/.env');
  await write(root, 'apps/web/.env.example');
  await fs.promises.mkdir(path.join(root, 'apps/odd/.env'), { recursive: true });
  await fs.promises.symlink(path.join(root, 'apps/api'), path.join(root, 'apps/link'), 'dir');
  await fs.promises.mkdir(path.join(root, 'apps/web/linked'), { recursive: true });
  await fs.promises.symlink('../.env', path.join(root, 'apps/web/linked/.env'));
});

after(async () => {
  for (const dir of tmpDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('returns only real .env files', async () => {
  const result = await findEnvFiles(root);
  assert.deepEqual([...result].sort(), [...realFiles].sort());
});

test('never enters pruned directories', async () => {
  const seen = [];
  const entered = [];
  const readdir = async (dir, opts) => {
    seen.push(String(dir));
    if (String(dir).split(path.sep).some((seg) => PRUNED.has(seg))) {
      // findEnvFiles skips a directory whose read fails, so a throw alone could be
      // swallowed. Record the path as well and assert on the record below.
      entered.push(String(dir));
      throw new assert.AssertionError({ message: `walk entered pruned directory: ${dir}` });
    }
    return fs.promises.readdir(dir, opts);
  };
  const result = await findEnvFiles(root, { readdir });
  assert.ok(Array.isArray(result));
  assert.deepEqual(entered, [], 'walk must never read a pruned directory');
  assert.ok(seen.includes(path.join(root, 'apps/api')), 'wrapper should have been used for apps/api');
});

test('skips symlinks and survives a failing subtree', async () => {
  const result = await findEnvFiles(root);
  const linkDir = path.join(root, 'apps/link');
  assert.ok(!result.some((p) => p.startsWith(linkDir + path.sep)), 'no result under apps/link');
  assert.ok(!result.includes(path.join(root, 'apps/web/linked/.env')));

  const calls = [];
  const recording = async (dir, opts) => {
    calls.push(String(dir));
    return fs.promises.readdir(dir, opts);
  };
  await findEnvFiles(root, { readdir: recording });
  assert.ok(calls.length > 0, 'wrapper should have been used');
  assert.ok(!calls.includes(linkDir), 'apps/link must never be passed to readdir');
  assert.ok(
    !calls.some((c) => c.startsWith(linkDir + path.sep)),
    'nothing under apps/link may be read',
  );

  const webDir = path.join(root, 'apps/web');
  const attempted = [];
  const failing = async (dir, opts) => {
    attempted.push(String(dir));
    if (String(dir) === webDir) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return fs.promises.readdir(dir, opts);
  };
  const partial = await findEnvFiles(root, { readdir: failing });
  assert.ok(attempted.includes(webDir), 'apps/web read must have been attempted');
  assert.ok(!partial.includes(path.join(root, 'apps/web/.env')));
  assert.deepEqual(
    [...partial].sort(),
    [
      path.join(root, '.env'),
      path.join(root, 'apps/api/.env'),
      path.join(root, 'packages/database/.env'),
    ].sort(),
  );
});

test('returns absolute paths for a relative root', async () => {
  const origCwd = process.cwd();
  process.chdir(path.dirname(root));
  try {
    const result = await findEnvFiles(path.basename(root));
    assert.ok(result.every((p) => path.isAbsolute(p)), 'every path must be absolute');
    assert.deepEqual([...result].sort(), [...realFiles].sort());
  } finally {
    process.chdir(origCwd);
  }
});

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.name === '.git' && d !== dir) continue;
      if (e.isDirectory()) {
        if (full === path.join(dir, '.git')) continue;
        await walk(full);
      } else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

test('updateAllAppEnvFiles keeps copy and rewrite behaviour', async () => {
  const base = await mkTmp('devctl2-env-update-');
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  await fs.promises.mkdir(main);
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      stdio: 'pipe',
    });
  git(main, 'init', '-q', '-b', 'main');
  await write(main, 'README.md', 'hi\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', linked, '-b', 't');

  await write(main, 'apps/api/.env', 'DATABASE_URL=postgres://old\n');
  await write(main, 'apps/web/.env', 'WEB=1\n');
  await write(main, 'apps/mock-integration-server/.env', 'DATABASE_URL=postgres://fixed\n');
  await write(main, '.claude/worktrees/x/.env', 'DATABASE_URL=postgres://claude\n');
  await write(main, 'node_modules/p/.env', 'DATABASE_URL=postgres://nm\n');
  await write(linked, 'apps/web/.env', 'KEEP=1');
  await write(linked, 'example.env.example/.env', 'DATABASE_URL=postgres://old\n');
  const keepFiles = ['.claude/worktrees/y/.env', 'node_modules/q/.env', 'apps/x/.claude/.env'];
  for (const rel of keepFiles) await write(linked, rel, 'DATABASE_URL=postgres://keep\n');

  const snapshot = new Map();
  for (const f of await listFiles(main)) {
    if (f.includes(`${path.sep}.git${path.sep}`)) continue;
    snapshot.set(f, await fs.promises.readFile(f));
  }

  const origCwd = process.cwd();
  const origZxCwd = $.cwd;
  const origLog = console.log;
  process.chdir(linked);
  $.cwd = linked;
  console.log = () => {};
  try {
    await updateAllAppEnvFiles(
      { features: { database: true }, apps: {} },
      linked,
      { databaseUrl: 'postgres://new' },
    );
  } finally {
    console.log = origLog;
    $.cwd = origZxCwd;
    process.chdir(origCwd);
  }

  const read = (rel) => fs.promises.readFile(path.join(linked, rel), 'utf8');
  assert.match(await read('apps/api/.env'), /DATABASE_URL=postgres:\/\/new/);
  assert.equal(await read('apps/web/.env'), 'KEEP=1');
  assert.match(await read('apps/mock-integration-server/.env'), /postgres:\/\/fixed/);
  assert.match(await read('example.env.example/.env'), /postgres:\/\/old/);
  for (const rel of keepFiles) assert.match(await read(rel), /postgres:\/\/keep/);
  assert.ok(!fs.existsSync(path.join(linked, '.claude/worktrees/x/.env')), 'main .claude decoy must not be copied');
  assert.ok(!fs.existsSync(path.join(linked, 'node_modules/p/.env')), 'main node_modules decoy must not be copied');

  for (const [file, bytes] of snapshot) {
    assert.deepEqual(await fs.promises.readFile(file), bytes, `main file changed: ${file}`);
  }
});
