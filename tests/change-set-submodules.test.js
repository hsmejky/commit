'use strict';

// CHG-09 (docs/roadmap/07-change-set.md): symlinks, submodule pointers, type changes and
// dirty submodules (Q11 hash table and pass 8 amendment, C:plan `dirtySubmodules` and
// `clean`, C:plan-hunks `kind`). M10 is called in-process against real temp repos, as the
// other change-set tests do; a few crafted raw+patch cases run the reader on every OS,
// since a real symlink needs privileges on Windows.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let changeSet;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

const NOW = () => Date.UTC(2026, 0, 1);
const NO_SYMLINKS = process.platform === 'win32' && 'no symlinks without privileges';
const NO_EOL = '\\ No newline at end of file\n';
const ZERO = '0'.repeat(40);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function snapshot(c, storedLists = { candidates: [], stagedNew: [] }) {
  return changeSet.snapshot({
    mode: 'split', storedLists, tracked: [], indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

function inventory(c) {
  return changeSet.inventory({ toplevel: c.repoDir, env: c.env, now: NOW });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A source repo with two commits, outside the main repo.
function sourceRepo(c) {
  const dir = path.join(c.root, 'sub');
  fs.mkdirSync(dir);
  c.git(['init', '-q', '-b', 'main', '.'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'inner.txt'), 'one\n');
  c.git(['add', 'inner.txt'], { cwd: dir });
  c.git(['commit', '-q', '-m', 'one'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'inner.txt'), 'two\n');
  c.git(['commit', '-q', '-am', 'two'], { cwd: dir });
  return dir;
}

// A repo with `a.txt` and a submodule at `libs/x` checked out at the source's second commit.
function withSubmodule(c) {
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'libs/x']);
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const inner = path.join(c.repoDir, 'libs', 'x');
  const rev = (spec) => c.git(['rev-parse', spec], { cwd: inner }).trim();
  return { source, inner, head: rev('HEAD'), prev: rev('HEAD~1') };
}

test('a pointer change in a submodule with untracked files inside is one submodule unit', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });
  fs.writeFileSync(path.join(sub.inner, 'build.out'), 'junk\n');

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.tracked, inv.dirtySubmodules], [false, ['libs/x'], []]);
  const units = await snapshot(c);
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.deepEqual(
    [unit.path, unit.oldPath, unit.status, unit.kind, unit.range, unit.added, unit.deleted],
    ['libs/x', null, 'M', 'submodule', '-0,0 +0,0', 0, 0],
  );
  // Q11: path + old and new commit ID; a gitlink has no body and is not scanned.
  assert.equal(unit.hash, sha256(`M\0libs/x\0commit ${sub.head} ${sub.prev}\0`));
  assert.equal(unit.identityKey, unit.hash);
  assert.deepEqual(unit.addedLines, []);
  assert.equal(unit.body.length, 0);
});

test('diff.submodule=log leaves a pointer change unit and its hash unchanged', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });
  const plain = await snapshot(c);
  c.git(['config', 'diff.submodule', 'log']);
  assert.deepEqual(await snapshot(c), plain);
  c.git(['config', 'diff.submodule', 'diff']);
  assert.deepEqual(await snapshot(c), plain);
});

test('a new and a removed submodule are A and D submodule units', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.source, 'libs/y']);
  const inv = await inventory(c);
  const units = await snapshot(c, {
    candidates: inv.candidates.map((entry) => entry.path), stagedNew: inv.stagedNew,
  });
  const y = units.find((unit) => unit.path === 'libs/y');
  assert.deepEqual([y.status, y.kind], ['A', 'submodule']);
  assert.equal(y.hash, sha256(`A\0libs/y\0commit ${ZERO} ${sub.head}\0`));

  const d = createCase(t);
  withSubmodule(d);
  d.git(['rm', '-q', 'libs/x']);
  const removed = (await snapshot(d)).find((unit) => unit.path === 'libs/x');
  assert.deepEqual([removed.status, removed.kind], ['D', 'submodule']);
  assert.equal(removed.hash, sha256(`D\0libs/x\0commit ${sub.head} ${ZERO}\0`));
});

// review-CHG-21 L3's malformed-`.gitmodules` `stage` case moved to Seam 1
// (tests/commit-all-stage-failed.test.js, review-EXE-10 Medium-1): EXE-10 maps `stage-failed`
// to exit 4, so the CLI can now reach it without an in-process M10 call (KD-R101 narrowed to
// this file's remaining `snapshot`/`inventory` calls).

test('dirt without a pointer change is in dirtySubmodules, no unit, and the tree is clean', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  fs.writeFileSync(path.join(sub.inner, 'inner.txt'), 'edited\n');
  fs.writeFileSync(path.join(sub.inner, 'build.out'), 'junk\n');

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.tracked, inv.dirtySubmodules], [true, [], ['libs/x']]);
  assert.deepEqual(await snapshot(c), []);

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.json.reply.status, 'nothing');
  // RUN-15 (C:plan `clean`): dirtySubmodules-only is named in the reply, Seam 1.
  assert.equal(result.json.reply.text.split('\n')[0], 'nothing to commit: dirty submodule: `libs/x`');
});

test('a submodule with only inner dirt next to an edit: listed in dirtySubmodules, no unit of its own', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  fs.writeFileSync(path.join(sub.inner, 'build.out'), 'junk\n');
  c.writeFile('a.txt', 'b\n');

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.tracked, inv.dirtySubmodules], [false, ['a.txt'], ['libs/x']]);
  assert.deepEqual((await snapshot(c)).map((unit) => unit.path), ['a.txt']);

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const plan = readJson(path.join(result.json.runDir, 'plan.json'));
  const state = readJson(path.join(result.json.runDir, 'state.json'));
  assert.deepEqual(plan.dirtySubmodules, ['libs/x']);
  assert.deepEqual(state.dirtySubmodules, ['libs/x']);
  assert.deepEqual(plan.tracked.map((entry) => entry.path), ['a.txt']);
});

test('a file replaced by a submodule is one T unit of kind submodule', async (t) => {
  const c = createCase(t);
  const source = sourceRepo(c);
  c.writeFile('f', 'x\n');
  c.git(['add', 'f']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, 'f'));
  c.git(['clone', '-q', source, 'f']);
  const head = c.git(['rev-parse', 'HEAD'], { cwd: path.join(c.repoDir, 'f') }).trim();

  const units = await snapshot(c);
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.deepEqual([unit.path, unit.status, unit.kind], ['f', 'T', 'submodule']);
  // C:plan-hunks: a file↔submodule `T`'s body is its file side; the gitlink line is left out.
  assert.equal(unit.body.toString(), '@@ -1 +0,0 @@\n-x\n');
  assert.deepEqual(unit.addedLines, []);
  assert.equal(unit.hash, sha256(`T\0f\0mode 100644 160000\0-x\n+Subproject commit ${head}\n`));
});

test('a new symlink and a changed target are symlink units', { skip: NO_SYMLINKS }, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('b.txt', 'b\n');
  fs.symlinkSync('a.txt', path.join(c.repoDir, 'old'));
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, 'old'));
  fs.symlinkSync('b.txt', path.join(c.repoDir, 'old'));
  fs.symlinkSync('a.txt', path.join(c.repoDir, 'new'));

  const units = await snapshot(c, { candidates: ['new'], stagedNew: [] });
  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind]), [['new', 'A', 'symlink'], ['old', 'M', 'symlink']]);
  assert.equal(units[0].hash, sha256(`A\0new\0+a.txt\n${NO_EOL}`));
  assert.equal(units[1].hash, sha256(`M\0old\0-a.txt\n${NO_EOL}+b.txt\n${NO_EOL}`));
  // A symlink target is scanned as an added line (Q11).
  assert.deepEqual(units[1].addedLines, [{ line: 1, text: 'b.txt' }]);
});

test('a file replaced by a symlink is one T unit of kind symlink', { skip: NO_SYMLINKS }, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('l', 'x\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, 'l'));
  fs.symlinkSync('a.txt', path.join(c.repoDir, 'l'));

  const units = await snapshot(c);
  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind, u.range]), [['l', 'T', 'symlink', '-1 +1']]);
  assert.equal(units[0].hash, sha256(`T\0l\0mode 100644 120000\0-x\n+a.txt\n${NO_EOL}`));
});

test('a submodule replaced by a file is one T unit of kind submodule whose body is the file', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  fs.rmSync(sub.inner, { recursive: true, force: true });
  c.writeFile('libs/x', 'p\nq\n');

  const units = await snapshot(c);
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.deepEqual(
    [unit.path, unit.status, unit.kind, unit.added, unit.deleted],
    ['libs/x', 'T', 'submodule', 2, 0],
  );
  assert.equal(unit.body.toString(), '@@ -0,0 +1,2 @@\n+p\n+q\n');
  assert.deepEqual(unit.addedLines, [{ line: 1, text: 'p' }, { line: 2, text: 'q' }]);
  assert.equal(unit.hash, sha256(`T\0libs/x\0mode 160000 100644\0-Subproject commit ${sub.head}\n+p\n+q\n`));

  // C:plan-hunks: unlike a pointer change, it has a block, so the worker sees the file.
  const hunkIndex = await loadLib('hunk-index');
  const { stdoutObj } = hunkIndex.renderHunks(
    { runDir: 'C:/r', mode: 'split', config: { values: { scanIgnore: [] } } },
    [{ ...unit, id: 'h1' }],
  );
  assert.equal(stdoutObj.hunks[0].body, 'file');
});

test('submodule ignore=all hides no pointer change from the inventory (review-CHG-09 finding 1)', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['config', '-f', '.gitmodules', 'submodule.libs/x.ignore', 'all']);
  c.git(['commit', '-q', '-am', 'ignore all']);
  c.git(['config', 'diff.ignoreSubmodules', 'all']);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.tracked, inv.dirtySubmodules], [false, ['libs/x'], []]);
  assert.deepEqual(
    (await snapshot(c)).map((unit) => [unit.path, unit.status, unit.kind]),
    [['libs/x', 'M', 'submodule']],
  );
});

test('a dirty submodule whose path is not UTF-8 is listed in its \\xNN form (review-CHG-09 finding 8)', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  const name = Buffer.from('s\xff', 'latin1');
  const dir = Buffer.concat([Buffer.from(c.repoDir + path.sep), name]);
  try {
    fs.mkdirSync(dir);
  } catch {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }
  if (!fs.readdirSync(c.repoDir, { encoding: 'buffer' }).some((entry) => entry.equals(name))) {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }
  fs.rmdirSync(dir);
  // Cloned under a UTF-8 name, then renamed: argv cannot carry the byte 0xff.
  c.git(['clone', '-q', sub.source, 'tmpsub']);
  fs.renameSync(path.join(c.repoDir, 'tmpsub'), dir);
  const indexInfo = Buffer.concat([Buffer.from(`160000 ${sub.head}\t`), name, Buffer.from('\n')]);
  const added = spawnSync('git', ['update-index', '--add', '--index-info'], {
    cwd: c.repoDir, env: c.env, input: indexInfo,
  });
  assert.equal(added.status, 0, String(added.stderr));
  c.git(['commit', '-q', '-m', 'non-UTF-8 gitlink']);
  fs.writeFileSync(Buffer.concat([dir, Buffer.from('/build.out')]), 'junk\n');

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.tracked, inv.dirtySubmodules], [true, [], ['s\\xff']]);
});

test('a gitlink without .gitmodules: a pointer change is a unit, dirt alone is not reported', async (t) => {
  const c = createCase(t);
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['clone', '-q', source, 'emb']);
  c.git(['add', 'a.txt', 'emb']);
  c.git(['commit', '-q', '-m', 'seed']);
  const inner = path.join(c.repoDir, 'emb');
  fs.writeFileSync(path.join(inner, 'build.out'), 'junk\n');

  // C:plan `dirtySubmodules`: only a tree with a `.gitmodules` file is checked for dirt.
  const dirty = await inventory(c);
  assert.deepEqual([dirty.clean, dirty.tracked, dirty.dirtySubmodules], [true, [], []]);

  c.git(['checkout', '-q', 'HEAD~1'], { cwd: inner });
  const moved = await inventory(c);
  assert.deepEqual([moved.clean, moved.tracked, moved.dirtySubmodules], [false, ['emb'], []]);
  assert.deepEqual((await snapshot(c)).map((unit) => [unit.path, unit.kind]), [['emb', 'submodule']]);
});

test('an untracked embedded repository is no candidate and no unit; alone it leaves the tree clean', async (t) => {
  const c = createCase(t);
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['clone', '-q', source, 'nested']);

  const inv = await inventory(c);
  assert.deepEqual([inv.clean, inv.candidates, inv.embeddedRepos], [true, [], ['nested']]);
  assert.deepEqual(await snapshot(c), []);

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.json.reply.status, 'nothing');
  // RUN-15 (C:plan `clean`): embeddedRepos-only is named in the reply, Seam 1.
  assert.equal(result.json.reply.text.split('\n')[0], 'nothing to commit: embedded repository: `nested`');
});

test('an untracked embedded repository next to an edit is stored in embeddedRepos, never planned', async (t) => {
  const c = createCase(t);
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['clone', '-q', source, 'nested']);
  c.writeFile('a.txt', 'b\n');

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const plan = readJson(path.join(result.json.runDir, 'plan.json'));
  const state = readJson(path.join(result.json.runDir, 'state.json'));
  assert.deepEqual(state.embeddedRepos, ['nested']);
  assert.deepEqual(state.candidates, []);
  assert.deepEqual(plan.untracked.candidates, []);
  assert.deepEqual(plan.tracked.map((entry) => entry.path), ['a.txt']);
});

// Crafted output, the shape git prints (checked with `git diff --raw -p`): a type change's
// one raw record owns two consecutive sections with its path, a delete and then a new file.
function typeChangeDiff({ second = true } = {}) {
  const [s1, s2] = ['1'.repeat(40), '2'.repeat(40)];
  const parts = [
    `:100644 120000 ${s1.slice(0, 7)} ${ZERO.slice(0, 7)} T\0l\0`,
    `:100644 100644 ${s1.slice(0, 7)} ${s2.slice(0, 7)} M\0z.txt\0`,
    'diff --git a/l b/l\ndeleted file mode 100644\n',
    `index ${s1}..${ZERO}\n--- a/l\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`,
  ];
  if (second) {
    parts.push(
      'diff --git a/l b/l\nnew file mode 120000\n',
      `index ${ZERO}..${s2}\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+a.txt\n${NO_EOL}`,
    );
  }
  parts.push(
    `diff --git a/z.txt b/z.txt\nindex ${s1}..${s2} 100644\n--- a/z.txt\n+++ b/z.txt\n`,
    '@@ -1 +1 @@\n-old\n+new\n',
  );
  return Buffer.from(parts.join(''));
}

test('reader: a type change owns two consecutive sections, however the output is chunked', () => {
  const output = typeChangeDiff();
  const whole = changeSet.createDiffReader();
  whole.push(output);
  const units = whole.end();
  const byByte = changeSet.createDiffReader();
  for (let i = 0; i < output.length; i += 1) byByte.push(output.subarray(i, i + 1));
  assert.deepEqual(byByte.end(), units);

  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind, u.range]), [
    ['l', 'T', 'symlink', '-1 +1'], ['z.txt', 'M', 'text', '-1 +1'],
  ]);
  assert.equal(units[0].hash, sha256(`T\0l\0mode 100644 120000\0-x\n+a.txt\n${NO_EOL}`));
  assert.equal(units[0].body.toString(), `@@ -1 +0,0 @@\n-x\n@@ -0,0 +1 @@\n+a.txt\n${NO_EOL}`);
  assert.deepEqual(units[0].addedLines, [{ line: 1, text: 'a.txt' }]);
});

test('reader: a type change with one section is internal', () => {
  const reader = changeSet.createDiffReader();
  assert.throws(() => {
    reader.push(typeChangeDiff({ second: false }));
    reader.end();
  }, /type change \(l\) has one patch section, not two/);
});

test('reader: a symlink target change is one symlink unit over the old and new target', () => {
  const [s1, s2] = ['1'.repeat(40), '2'.repeat(40)];
  const reader = changeSet.createDiffReader();
  reader.push(Buffer.from([
    `:120000 120000 ${s1.slice(0, 7)} ${s2.slice(0, 7)} M\0l\0`,
    `diff --git a/l b/l\nindex ${s1}..${s2} 120000\n--- a/l\n+++ b/l\n`,
    `@@ -1 +1 @@\n-a.txt\n${NO_EOL}+b.txt\n${NO_EOL}`,
  ].join('')));
  const units = reader.end();
  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind]), [['l', 'M', 'symlink']]);
  assert.equal(units[0].hash, sha256(`M\0l\0-a.txt\n${NO_EOL}+b.txt\n${NO_EOL}`));
});
