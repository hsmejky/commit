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

function snapshot(c) {
  return changeSet.snapshot({ mode: 'split', toplevel: c.repoDir, env: c.env, now: NOW });
}

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

  const options = { toplevel: c.repoDir, env: c.env, now: NOW };
  assert.deepEqual(await changeSet.inventory(options), { clean: true, tracked: [] });

  c.writeFile('a.txt', 'b\n');
  assert.deepEqual(await changeSet.inventory(options), { clean: false, tracked: ['a.txt'] });
});

test('inventory: untracked, staged and deleted paths are not built yet', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const options = { toplevel: c.repoDir, env: c.env, now: NOW };

  c.writeFile('new.txt', 'n\n');
  await assert.rejects(changeSet.inventory(options), /not built yet/);
  c.git(['add', 'new.txt']);
  await assert.rejects(changeSet.inventory(options), /not built yet/);
  c.git(['rm', '-q', '--cached', 'new.txt']);
  fs.rmSync(path.join(c.repoDir, 'new.txt'));
  c.git(['rm', '-q', 'b.txt']);
  await assert.rejects(changeSet.inventory(options), /not built yet/);
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

  const c2 = createCase(t);
  seed(c2, { 'run.sh': 'echo\n' });
  // `core.fileMode` is false on Windows, where git takes the worktree mode from the index.
  c2.git(['update-index', '--chmod=+x', 'run.sh']);
  if (process.platform !== 'win32') fs.chmodSync(path.join(c2.repoDir, 'run.sh'), 0o755);
  await assert.rejects(snapshot(c2), /not built yet/);
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
