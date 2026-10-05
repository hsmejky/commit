'use strict';

// CHG-09 (docs/roadmap/07-change-set.md): symlinks, submodule pointers, type changes and
// dirty submodules (Q11 hash table and pass 8 amendment, C:plan `dirtySubmodules` and
// `clean`, C:plan-hunks `kind`). KD-R101 (docs/roadmap/known-deficiencies.md, user decision
// (b)): the shape and hash cases below run M10 only through Seam 1 — `plan --split` over a
// temp repo, reading `state.json`'s unit table (hash, identityKey, path, oldPath, status,
// kind) and `plan.json`'s `tracked` list (added/deleted) and the inline hunk index (range,
// body kind, the patch text in `hunks.txt`), per docs/spec/testing-seams.md Seam 1 — never
// `snapshot`/`inventory` in-process. The reader tests at the end of this file
// (`createDiffReader` fed crafted raw+patch buffers) are the accepted in-process pattern for
// that parser, shared with tests/change-set-units.test.js and
// tests/change-set-attribute-hidden.test.js, out of KD-R101's scope; a few crafted
// raw+patch cases run the reader on every OS, since a real symlink needs privileges on
// Windows.

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

const NO_SYMLINKS = process.platform === 'win32' && 'no symlinks without privileges';
const NO_EOL = '\\ No newline at end of file\n';
const ZERO = '0'.repeat(40);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Seam 1: `plan --split`, then the unit table and `tracked` list it wrote (run-folder.md,
// C:plan). Only non-clean outcomes keep a run folder (`plan.json`, `state.json`); a clean
// or `nothing` outcome is asserted from `result.json.reply` directly instead, not through
// this helper.
async function planSplit(c, argv = ['plan', '--split']) {
  const result = await runCommit(c, argv);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = result.json.runDir;
  const state = readJson(path.join(runDir, 'state.json'));
  const plan = readJson(path.join(runDir, 'plan.json'));
  return { result, runDir, state, plan, units: state.units };
}

function unitOf(units, p) {
  const unit = units.find((u) => u.path === p);
  assert.ok(unit, `no unit for ${p}`);
  return unit;
}

function trackedOf(plan, p) {
  const entry = plan.tracked.find((t) => t.path === p);
  assert.ok(entry, `no tracked entry for ${p}`);
  return entry;
}

function hunkOf(result, p) {
  const entry = result.json.hunks.hunks.find((h) => h.path === p);
  assert.ok(entry, `no hunk entry for ${p}`);
  return entry;
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

  const { result, plan, units } = await planSplit(c);
  assert.deepEqual([plan.clean, plan.dirtySubmodules], [false, []]);
  assert.equal(units.length, 1);
  const unit = unitOf(units, 'libs/x');
  assert.deepEqual([unit.oldPath, unit.status, unit.kind], [null, 'M', 'submodule']);
  assert.deepEqual(plan.tracked.map((entry) => entry.path), ['libs/x']);
  const tracked = trackedOf(plan, 'libs/x');
  assert.deepEqual([tracked.status, tracked.added, tracked.deleted], ['M', 0, 0]);
  const hunk = hunkOf(result, 'libs/x');
  assert.deepEqual([hunk.range, hunk.body], ['-0,0 +0,0', 'none']);
  // Q11: path + old and new commit ID; a gitlink has no body and is not scanned.
  assert.equal(unit.hash, sha256(`M\0libs/x\0commit ${sub.head} ${sub.prev}\0`));
  assert.equal(unit.identityKey, unit.hash);
});

test('diff.submodule=log leaves a pointer change unit and its hash unchanged', async (t) => {
  const configs = [null, (c) => c.git(['config', 'diff.submodule', 'log']), (c) => c.git(['config', 'diff.submodule', 'diff'])];
  const hashes = [];
  for (const configure of configs) {
    const c = createCase(t);
    const sub = withSubmodule(c);
    c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });
    if (configure) configure(c);
    const { units } = await planSplit(c);
    hashes.push(unitOf(units, 'libs/x').hash);
  }
  assert.equal(hashes[1], hashes[0]);
  assert.equal(hashes[2], hashes[0]);
});

test('a new and a removed submodule are A and D submodule units', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.source, 'libs/y']);
  const { units: added } = await planSplit(c);
  const y = unitOf(added, 'libs/y');
  assert.deepEqual([y.status, y.kind], ['A', 'submodule']);
  assert.equal(y.hash, sha256(`A\0libs/y\0commit ${ZERO} ${sub.head}\0`));

  const d = createCase(t);
  withSubmodule(d);
  d.git(['rm', '-q', 'libs/x']);
  const { units: removed } = await planSplit(d);
  const x = unitOf(removed, 'libs/x');
  assert.deepEqual([x.status, x.kind], ['D', 'submodule']);
  assert.equal(x.hash, sha256(`D\0libs/x\0commit ${sub.head} ${ZERO}\0`));
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

  const { result, units } = await planSplit(c);
  assert.equal(units.length, 1);
  const unit = unitOf(units, 'f');
  assert.deepEqual([unit.status, unit.kind], ['T', 'submodule']);
  assert.equal(unit.hash, sha256(`T\0f\0mode 100644 160000\0-x\n+Subproject commit ${head}\n`));
  const hunk = hunkOf(result, 'f');
  assert.equal(hunk.body, 'file');
  // C:plan-hunks: a file<->submodule `T`'s body is its file side; the gitlink line is left out.
  const hunksTxt = fs.readFileSync(result.json.hunks.hunksFile, 'utf8');
  assert.ok(hunksTxt.includes('@@ -1 +0,0 @@\n-x\n'), hunksTxt);
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

  const { units } = await planSplit(c);
  const newUnit = unitOf(units, 'new');
  const oldUnit = unitOf(units, 'old');
  assert.deepEqual([newUnit.status, newUnit.kind], ['A', 'symlink']);
  assert.deepEqual([oldUnit.status, oldUnit.kind], ['M', 'symlink']);
  assert.equal(newUnit.hash, sha256(`A\0new\0+a.txt\n${NO_EOL}`));
  assert.equal(oldUnit.hash, sha256(`M\0old\0-a.txt\n${NO_EOL}+b.txt\n${NO_EOL}`));
});

test('a file replaced by a symlink is one T unit of kind symlink', { skip: NO_SYMLINKS }, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('l', 'x\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, 'l'));
  fs.symlinkSync('a.txt', path.join(c.repoDir, 'l'));

  const { result, units } = await planSplit(c);
  const unit = unitOf(units, 'l');
  assert.deepEqual([unit.status, unit.kind], ['T', 'symlink']);
  assert.equal(unit.hash, sha256(`T\0l\0mode 100644 120000\0-x\n+a.txt\n${NO_EOL}`));
  const hunk = hunkOf(result, 'l');
  assert.equal(hunk.range, '-1 +1');
});

test('a submodule replaced by a file is one T unit of kind submodule whose body is the file', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  fs.rmSync(sub.inner, { recursive: true, force: true });
  c.writeFile('libs/x', 'p\nq\n');

  const { result, plan, units } = await planSplit(c);
  assert.equal(units.length, 1);
  const unit = unitOf(units, 'libs/x');
  assert.deepEqual([unit.status, unit.kind], ['T', 'submodule']);
  assert.equal(unit.hash, sha256(`T\0libs/x\0mode 160000 100644\0-Subproject commit ${sub.head}\n+p\n+q\n`));
  const tracked = trackedOf(plan, 'libs/x');
  assert.deepEqual([tracked.added, tracked.deleted], [2, 0]);
  // C:plan-hunks: unlike a pointer change, it has a block, so the worker sees the file.
  const hunk = hunkOf(result, 'libs/x');
  assert.equal(hunk.body, 'file');
  const hunksTxt = fs.readFileSync(result.json.hunks.hunksFile, 'utf8');
  assert.ok(hunksTxt.includes('@@ -0,0 +1,2 @@\n+p\n+q\n'), hunksTxt);
});

test('submodule ignore=all hides no pointer change from the inventory (review-CHG-09 finding 1)', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['config', '-f', '.gitmodules', 'submodule.libs/x.ignore', 'all']);
  c.git(['commit', '-q', '-am', 'ignore all']);
  c.git(['config', 'diff.ignoreSubmodules', 'all']);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });

  const { plan, units } = await planSplit(c);
  assert.deepEqual([plan.clean, plan.dirtySubmodules], [false, []]);
  const unit = unitOf(units, 'libs/x');
  assert.deepEqual([unit.status, unit.kind], ['M', 'submodule']);
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

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.json.reply.status, 'nothing');
  // RUN-15 (C:plan `clean`): a non-UTF-8 submodule path is named in its `\xNN` form, Seam 1.
  assert.equal(result.json.reply.text.split('\n')[0], 'nothing to commit: dirty submodule: `s\\xff`');
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

  // C:plan `dirtySubmodules`: only a tree with a `.gitmodules` file is checked for dirt, so
  // dirt alone (no pointer change) leaves the tree fully clean, not even a dirty-submodule
  // note in the reply.
  const clean = await runCommit(c, ['plan']);
  assert.equal(clean.exitCode, 0, detail(clean));
  assert.equal(clean.json.reply.status, 'nothing');
  assert.equal(clean.json.reply.text.split('\n')[0], 'nothing to commit');

  c.git(['checkout', '-q', 'HEAD~1'], { cwd: inner });
  const { plan, units } = await planSplit(c);
  assert.equal(plan.clean, false);
  assert.deepEqual(plan.tracked.map((entry) => entry.path), ['emb']);
  assert.equal(unitOf(units, 'emb').kind, 'submodule');
});

test('an untracked embedded repository is no candidate and no unit; alone it leaves the tree clean', async (t) => {
  const c = createCase(t);
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['clone', '-q', source, 'nested']);

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
