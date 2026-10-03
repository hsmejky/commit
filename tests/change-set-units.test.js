'use strict';

// CHG-03 (docs/roadmap/07-change-set.md): the tracer M10 path. `inventory` lists the tracked
// modifications, `snapshot` in `split` runs the pinned diff (Q11) as one `-z --raw -p` call,
// takes every path from the raw records (never from patch text) and makes one whole-file
// unit per modified file with a hash over the raw bytes; `assignIds` mints `h1…hN`.
//
// The slice's criterion ("no path is parsed out of patch text") has no Seam 1 observable
// until CHG-03b stores the unit table and prints `hunks` (KD-R1,
// docs/roadmap/known-deficiencies.md), so these cases call M10 in-process against real temp
// repos, as RUN-05 did for M12 `create` and GIT-02 for `head()`. A path whose patch headers
// render differently from the path itself (`a b/c`: `diff --git a/a b/c b/a b/c` is
// ambiguous and `--- a/a b/c` carries a trailing tab) pins the criterion.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase } = require('./helpers/process-seam.js');

let changeSet;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

const NOW = () => Date.UTC(2026, 0, 1);

function seed(c, files) {
  for (const [file, content] of Object.entries(files)) c.writeFile(file, content);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

// The temporary index lives under the case's own root, never inside the repo.
function snapshot(c, storedLists = { candidates: [], stagedNew: [] }, unborn = false) {
  return changeSet.snapshot({
    mode: 'split', storedLists, indexPath: path.join(c.root, 'git-index'), unborn,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

function inventory(c) {
  return changeSet.inventory({ toplevel: c.repoDir, env: c.env, now: NOW });
}

const EMPTY_INVENTORY = Object.freeze({
  clean: true, tracked: [], preStaged: [], candidates: [], hidden: { count: 0, sample: [] },
  stagedNew: [], stagedExcluded: [],
});

// `git diff --numstat -z HEAD`, the parser oracle: `added\tdeleted\tpath\0` per file.
function numstat(c) {
  const result = spawnSync('git', ['diff', '--numstat', '-z', 'HEAD'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  const counts = {};
  for (const record of result.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const [added, deleted, file] = record.split('\t');
    counts[file] = { added: Number(added), deleted: Number(deleted) };
  }
  return counts;
}

test('inventory: a clean tree is clean, a modified tracked file is listed', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });

  assert.deepEqual(await inventory(c), EMPTY_INVENTORY);

  c.writeFile('a.txt', 'b\n');
  assert.deepEqual(await inventory(c), { ...EMPTY_INVENTORY, clean: false, tracked: ['a.txt'] });
});

// CHG-05: candidates after `hideFilter` with size and NUL-sniffed `binary`, the hidden count
// with a byte-sorted sample of 5, staged-new paths with `ignored` from `check-ignore
// --no-index`, a hidden staged-new path in `stagedExcluded`, every staged path in `preStaged`.
test('inventory: untracked candidates, hidden files, staged-new and pre-staged paths', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), 'ign.txt\n');

  c.writeFile('new.txt', 'n\n');
  fs.writeFileSync(path.join(c.repoDir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
  for (const name of ['.f', '.e', '.d', '.c', '.b', '.a']) c.writeFile(name, 'h\n');
  c.writeFile('ign.txt', 'i\n');
  c.writeFile('staged.txt', 's\n');
  c.writeFile('.env.local', 'SECRET=1\n');
  c.git(['add', '-f', 'ign.txt', 'staged.txt', '.env.local']);
  c.writeFile('b.txt', 'B\n');
  c.git(['add', 'b.txt']);

  assert.deepEqual(await inventory(c), {
    clean: false,
    tracked: ['b.txt'],
    preStaged: ['.env.local', 'b.txt', 'ign.txt', 'staged.txt'],
    candidates: [{ path: 'bin.dat', size: 3, binary: true }, { path: 'new.txt', size: 2, binary: false }],
    hidden: { count: 6, sample: ['.a', '.b', '.c', '.d', '.e'] },
    stagedNew: [{ path: 'ign.txt', ignored: true }, { path: 'staged.txt', ignored: false }],
    stagedExcluded: [{ path: '.env.local', reason: 'hidden' }],
  });
});

test('inventory: a tree with hidden files only, untracked or staged, is clean', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('.env', 'X=1\n');
  c.writeFile('.env.local', 'Y=1\n');
  c.git(['add', '.env.local']);

  assert.deepEqual(await inventory(c), {
    ...EMPTY_INVENTORY,
    preStaged: ['.env.local'],
    hidden: { count: 1, sample: ['.env'] },
    stagedExcluded: [{ path: '.env.local', reason: 'hidden' }],
  });
});

test('inventory: a staged-new file on an unborn HEAD', async (t) => {
  const c = createCase(t);
  c.writeFile('new.txt', 'n\n');
  c.git(['add', 'new.txt']);

  assert.deepEqual(await inventory(c), {
    ...EMPTY_INVENTORY,
    clean: false,
    preStaged: ['new.txt'],
    stagedNew: [{ path: 'new.txt', ignored: false }],
  });
});

test('snapshot: two modified files become two sorted whole-file text units', async (t) => {
  const c = createCase(t);
  seed(c, { 'src/b.js': 'one\ntwo\nthree\n', 'a.md': 'x\n' });
  c.writeFile('src/b.js', 'one\nTWO\nthree\nfour\n');
  c.writeFile('a.md', 'y\n');

  const units = await snapshot(c);

  assert.deepEqual(units.map((u) => u.path), ['a.md', 'src/b.js']);
  const oracle = numstat(c);
  for (const unit of units) {
    assert.equal(unit.oldPath, null);
    assert.equal(unit.status, 'M');
    assert.equal(unit.kind, 'text');
    assert.match(unit.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual({ added: unit.added, deleted: unit.deleted }, oracle[unit.path], unit.path);
    assert.ok(Buffer.isBuffer(unit.body));
    assert.match(unit.body.toString('utf8'), /^@@ /);
  }
  assert.equal(units[0].range, '-1 +1');
  assert.equal(units[1].range, '-1,3 +1,4');
});

test('snapshot: a file with several hunks is one unit whose range encloses them all', async (t) => {
  const c = createCase(t);
  const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}\n`);
  seed(c, { 'f.txt': lines.join(''), 'eof.txt': 'x' });
  c.writeFile('f.txt', ['0\n', ...lines.slice(1, 11), 'X\n'].join(''));
  c.writeFile('eof.txt', 'x\n');

  const units = await snapshot(c);

  const f = units.find((u) => u.path === 'f.txt');
  assert.equal((f.body.toString('utf8').match(/^@@ /gm) || []).length, 2);
  assert.equal(f.range, '-1,12 +1,12');
  // The `\ No newline at end of file` line counts as neither added nor deleted.
  const oracle = numstat(c);
  for (const unit of units) {
    assert.deepEqual({ added: unit.added, deleted: unit.deleted }, oracle[unit.path], unit.path);
  }
});

test('snapshot: unit paths come from the raw pass, also when patch headers render them differently', async (t) => {
  const c = createCase(t);
  const paths = ['a b/c', 'déjà vu/ñ.txt'];
  if (process.platform !== 'win32') paths.push('tab\there/"q".txt');
  seed(c, Object.fromEntries(paths.map((p) => [p, 'old\n'])));
  for (const p of paths) c.writeFile(p, 'new\n');

  const units = await snapshot(c);

  const expected = [...paths].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  assert.deepEqual(units.map((u) => u.path), expected);
});

test('snapshot: the hash differs by path and by changed lines', async (t) => {
  const c = createCase(t);
  seed(c, { 'one.txt': 'a\nmid\nb\n', 'two.txt': 'a\nmid\nb\n', 'three.txt': 'a\nmid\nb\n' });
  c.writeFile('one.txt', 'a\nMID\nb\n');
  c.writeFile('two.txt', 'a\nMID\nb\n');
  c.writeFile('three.txt', 'a\nMID2\nb\n');

  const byPath = Object.fromEntries((await snapshot(c)).map((u) => [u.path, u.hash]));

  assert.notEqual(byPath['one.txt'], byPath['two.txt']);
  assert.notEqual(byPath['one.txt'], byPath['three.txt']);
});

test('snapshot: context changes keep the hash; the hash is the path plus the -/+ lines', async (t) => {
  const c1 = createCase(t);
  seed(c1, { 'f.txt': 'a\nb\nmid\nc\nd\n' });
  c1.writeFile('f.txt', 'a\nb\nMID\nc\nd\n');
  const c2 = createCase(t);
  seed(c2, { 'f.txt': 'p\nq\nmid\nr\ns\n' });
  c2.writeFile('f.txt', 'p\nq\nMID\nr\ns\n');

  const [u1] = await snapshot(c1);
  const [u2] = await snapshot(c2);

  assert.equal(u1.hash, u2.hash);
  const expected = crypto.createHash('sha256')
    .update(Buffer.from('f.txt\0-mid\n+MID\n')).digest('hex');
  assert.equal(u1.hash, expected);
});

test('snapshot: a newline-at-EOF edit hashes differently from the same lines with a newline', async (t) => {
  const c1 = createCase(t);
  seed(c1, { 'f.txt': 'x' });
  c1.writeFile('f.txt', 'x\n');
  const c2 = createCase(t);
  seed(c2, { 'f.txt': 'x\n' });
  c2.writeFile('f.txt', 'x');

  const [u1] = await snapshot(c1);
  const [u2] = await snapshot(c2);

  assert.notEqual(u1.hash, u2.hash);
});

test('snapshot: a "\\ No newline" marker after a context line does not change the hash', async (t) => {
  // 'end' is unchanged context in both cases; only whether it has a trailing newline differs,
  // so only case A gets a `\ No newline at end of file` marker after that context line.
  const c1 = createCase(t);
  seed(c1, { 'f.txt': 'keep\nchange\nend' });
  c1.writeFile('f.txt', 'keep\nCHANGE\nend');
  const c2 = createCase(t);
  seed(c2, { 'f.txt': 'keep\nchange\nend\n' });
  c2.writeFile('f.txt', 'keep\nCHANGE\nend\n');

  const [u1] = await snapshot(c1);
  const [u2] = await snapshot(c2);

  assert.match(u1.body.toString('utf8'), /\\ No newline at end of file/);
  assert.doesNotMatch(u2.body.toString('utf8'), /\\ No newline/);
  assert.equal(u1.hash, u2.hash);
});

test('snapshot: a count mismatch between raw records and patch sections is internal', () => {
  // Hand-built `git diff -z --raw -p` bytes (KD-R1 style): two raw `M` records but only one
  // patch section, exercising the pairing check directly without spawning git.
  const sha = '0'.repeat(40);
  const raw = Buffer.concat([
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0a.txt\0`, 'latin1'),
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0b.txt\0`, 'latin1'),
    Buffer.from([0]),
    Buffer.from(
      'diff --git a/a.txt b/a.txt\nindex 0000000..1111111 100644\n--- a/a.txt\n+++ b/a.txt\n'
      + '@@ -1,1 +1,1 @@\n-old\n+new\n',
      'latin1',
    ),
  ]);

  assert.throws(() => changeSet.unitsFromDiff(raw), /the diff has 1 patch sections for 2 raw records/);
});

test('snapshot: the hash uses raw bytes, so Latin-1 bytes that decode alike still differ', async (t) => {
  const c1 = createCase(t);
  seed(c1, { 'f.txt': Buffer.from('caf\xe9\n', 'latin1') });
  c1.writeFile('f.txt', Buffer.from('caf\xe8\n', 'latin1'));
  const c2 = createCase(t);
  seed(c2, { 'f.txt': Buffer.from('caf\xe9\n', 'latin1') });
  c2.writeFile('f.txt', Buffer.from('caf\xea\n', 'latin1'));

  const [u1] = await snapshot(c1);
  const [u2] = await snapshot(c2);

  assert.equal(u1.body.toString('utf8'), u2.body.toString('utf8'));
  assert.notEqual(u1.hash, u2.hash);
});

test('snapshot: a user diff.orderFile does not change the unit order', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const orderFile = path.join(c.root, 'order.txt');
  fs.writeFileSync(orderFile, 'c.txt\nb.txt\na.txt\n');
  c.git(['config', 'diff.orderFile', orderFile]);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) c.writeFile(name, `${name} changed\n`);
  // The fixture works: git itself now lists the paths in the reverse order.
  assert.equal(c.git(['diff', '--name-only', 'HEAD']), 'c.txt\nb.txt\na.txt\n');

  const units = await snapshot(c);

  assert.deepEqual(units.map((u) => u.path), ['a.txt', 'b.txt', 'c.txt']);
});

test('snapshot: a binary file and a mode change are not built yet', async (t) => {
  const c = createCase(t);
  seed(c, { 'bin.dat': Buffer.from([0, 1, 2, 10]) });
  c.writeFile('bin.dat', Buffer.from([0, 1, 3, 10]));
  await assert.rejects(snapshot(c), /not built yet/);

  // `core.fileMode` is false on Windows, where git takes the worktree mode from the index:
  // the temporary index is reset to HEAD's mode, so a staged `--chmod` alone shows no change
  // there (CHG-08 decides that case).
  if (process.platform === 'win32') return;
  const c2 = createCase(t);
  seed(c2, { 'run.sh': 'echo\n' });
  fs.chmodSync(path.join(c2.repoDir, 'run.sh'), 0o755);
  await assert.rejects(snapshot(c2), /not built yet/);
});

// CHG-05: the temporary index. `snapshot` copies the real index, resets the copy to HEAD,
// `git add -N`s the stored lists into it and diffs the worktree against it.
test('snapshot: a stored untracked candidate is an A unit of + lines', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('new.txt', 'one\ntwo\n');

  const units = await snapshot(c, { candidates: ['new.txt'], stagedNew: [] });

  assert.equal(units.length, 1);
  const [unit] = units;
  assert.deepEqual(
    { path: unit.path, oldPath: unit.oldPath, status: unit.status, kind: unit.kind },
    { path: 'new.txt', oldPath: null, status: 'A', kind: 'text' },
  );
  assert.deepEqual({ added: unit.added, deleted: unit.deleted, range: unit.range }, { added: 2, deleted: 0, range: '-0,0 +1,2' });
  assert.equal(unit.body.toString('utf8'), '@@ -0,0 +1,2 @@\n+one\n+two\n');
  const expected = crypto.createHash('sha256').update('new.txt\0+one\n+two\n').digest('hex');
  assert.equal(unit.hash, expected);
});

test('snapshot: a plain mv and a git mv each give one R unit with oldPath', async (t) => {
  for (const viaGit of [false, true]) {
    const c = createCase(t);
    seed(c, { 'old.txt': 'a\nb\nc\nd\n' });
    if (viaGit) {
      c.git(['mv', 'old.txt', 'moved.txt']);
    } else {
      fs.renameSync(path.join(c.repoDir, 'old.txt'), path.join(c.repoDir, 'moved.txt'));
    }
    const inv = await inventory(c);
    const units = await snapshot(c, { candidates: inv.candidates.map((x) => x.path), stagedNew: inv.stagedNew });

    assert.equal(units.length, 1, `git mv: ${viaGit}`);
    const [unit] = units;
    assert.deepEqual(
      { path: unit.path, oldPath: unit.oldPath, status: unit.status, kind: unit.kind },
      { path: 'moved.txt', oldPath: 'old.txt', status: 'R', kind: 'text' },
    );
    assert.deepEqual(
      { added: unit.added, deleted: unit.deleted, range: unit.range, body: unit.body.length },
      { added: 0, deleted: 0, range: '-0,0 +0,0', body: 0 },
    );
    assert.equal(unit.hash, crypto.createHash('sha256').update('old.txt\0moved.txt\0').digest('hex'));
  }
});

test('snapshot: a renamed and edited file hashes both paths and its -/+ lines', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': 'a\nb\nc\nd\ne\n' });
  fs.rmSync(path.join(c.repoDir, 'old.txt'));
  c.writeFile('moved.txt', 'a\nb\nC\nd\ne\n');

  const [unit] = await snapshot(c, { candidates: ['moved.txt'], stagedNew: [] });

  assert.deepEqual([unit.status, unit.oldPath, unit.path, unit.added, unit.deleted], ['R', 'old.txt', 'moved.txt', 1, 1]);
  assert.equal(unit.hash, crypto.createHash('sha256').update('old.txt\0moved.txt\0-c\n+C\n').digest('hex'));
});

test('snapshot: staged-new paths, also ignored ones and on an unborn HEAD, are A units', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), 'ign.txt\n');
  c.writeFile('ign.txt', 'i\n');
  c.writeFile('staged.txt', 's\n');
  c.git(['add', '-f', 'ign.txt', 'staged.txt']);
  const inv = await inventory(c);
  const units = await snapshot(c, { candidates: [], stagedNew: inv.stagedNew });
  assert.deepEqual(units.map((u) => [u.path, u.status]), [['ign.txt', 'A'], ['staged.txt', 'A']]);

  const unborn = createCase(t);
  unborn.writeFile('new.txt', 'n\n');
  unborn.git(['add', 'new.txt']);
  const unbornUnits = await snapshot(unborn, { candidates: [], stagedNew: [{ path: 'new.txt', ignored: false }] }, true);
  assert.deepEqual(unbornUnits.map((u) => [u.path, u.status, u.added]), [['new.txt', 'A', 1]]);
});

test('snapshot: on an unborn HEAD, git add then git mv is one A unit for the new path', async (t) => {
  const c = createCase(t);
  c.writeFile('newfile', 'n\n');
  c.git(['add', 'newfile']);
  c.git(['mv', 'newfile', 'renamed']);
  const inv = await inventory(c);

  const units = await snapshot(c, { candidates: inv.candidates.map((x) => x.path), stagedNew: inv.stagedNew }, true);

  assert.deepEqual(units.map((u) => [u.path, u.oldPath, u.status]), [['renamed', null, 'A']]);
});

test('snapshot: an empty new file is an A unit with no hunk', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('empty.txt', '');

  const [unit] = await snapshot(c, { candidates: ['empty.txt'], stagedNew: [] });

  assert.deepEqual(
    [unit.path, unit.status, unit.added, unit.deleted, unit.range, unit.body.length],
    ['empty.txt', 'A', 0, 0, '-0,0 +0,0', 0],
  );
});

test('snapshot: a stored path gone from the worktree is skipped; the real index is untouched', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'b\n');
  c.writeFile('staged.txt', 's\n');
  c.git(['add', 'staged.txt']);
  c.writeFile('new.txt', 'n\n');
  const realIndex = path.join(c.repoDir, '.git', 'index');
  const before = fs.readFileSync(realIndex);

  const units = await snapshot(c, {
    candidates: ['gone.txt', 'new.txt'],
    stagedNew: [{ path: 'staged.txt', ignored: false }],
  });

  assert.deepEqual(units.map((u) => [u.path, u.status]), [['a.txt', 'M'], ['new.txt', 'A'], ['staged.txt', 'A']]);
  assert.ok(fs.readFileSync(realIndex).equals(before));
});

test('snapshot: a failing git add -N is git-failed', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), 'ign.txt\n');
  c.writeFile('ign.txt', 'i\n');

  // Stored as not ignored, so it goes to the `git add -N` call without `-f`, which refuses it.
  await assert.rejects(
    snapshot(c, { candidates: ['ign.txt'], stagedNew: [] }),
    (err) => err.domainCode === 'git-failed' && /^git add failed/.test(err.message),
  );
});

test('snapshot: an untracked binary file and a deletion are not built yet', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  fs.writeFileSync(path.join(c.repoDir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
  await assert.rejects(snapshot(c, { candidates: ['bin.dat'], stagedNew: [] }), /binary\) is not built yet \(CHG-08\)/);

  const c2 = createCase(t);
  seed(c2, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  fs.rmSync(path.join(c2.repoDir, 'b.txt'));
  await assert.rejects(snapshot(c2), /a D change \(b\.txt\) is not built yet/);
});

test('assignIds mints h1..hN in unit order and leaves the input alone', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  c.writeFile('a.txt', 'A\n');
  c.writeFile('b.txt', 'B\n');
  const units = await snapshot(c);

  const withIds = changeSet.assignIds(units);

  assert.deepEqual(withIds.map((u) => [u.id, u.path]), [['h1', 'a.txt'], ['h2', 'b.txt']]);
  assert.equal(units[0].id, undefined);
});
