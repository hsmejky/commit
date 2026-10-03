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
  clean: true, tracked: [], preStaged: [], candidates: [], collapsed: [], hidden: { count: 0, sample: [] },
  stagedNew: [], stagedExcluded: [], notUtf8: [],
});

// `git diff --numstat -z HEAD`, the parser oracle: `added\tdeleted\tpath\0` per file, or
// `added\tdeleted\t\0old\0new\0` for a rename (git never quotes a `-z` path), keyed by the
// new path.
function numstat(c) {
  const result = spawnSync('git', ['diff', '--numstat', '-z', 'HEAD'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  const tokens = result.stdout.toString('utf8').split('\0');
  const counts = {};
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    i += 1;
    if (record === '') continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    const added = Number(record.slice(0, firstTab));
    const deleted = Number(record.slice(firstTab + 1, secondTab));
    const file = record.slice(secondTab + 1);
    if (file === '') {
      const newPath = tokens[i + 1];
      counts[newPath] = { added, deleted };
      i += 2;
    } else {
      counts[file] = { added, deleted };
    }
  }
  return counts;
}

// `unitsFromDiff` is a test-only convenience over `createDiffReader` (CHG-06): production
// code (`snapshot`) pushes chunks as M2's `onStdout` delivers them and never needs the
// whole-buffer form.
function unitsFromDiff(output) {
  const reader = changeSet.createDiffReader();
  reader.push(output);
  return reader.end();
}

test('inventory: a clean tree is clean, a modified tracked file is listed', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });

  assert.deepEqual(await inventory(c), EMPTY_INVENTORY);

  c.writeFile('a.txt', 'b\n');
  assert.deepEqual(await inventory(c), { ...EMPTY_INVENTORY, clean: false, tracked: ['a.txt'] });
});

// CHG-05: candidates after `hideFilter` with size and NUL-sniffed `binary`, the hidden count
// with a byte-sorted sample of 5, staged-new paths with `ignored` from `ls-files --cached
// --ignored --exclude-standard`, a hidden staged-new path in `stagedExcluded`, every staged
// path in `preStaged`.
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
    collapsed: [],
    hidden: { count: 6, sample: ['.a', '.b', '.c', '.d', '.e'] },
    stagedNew: [{ path: 'ign.txt', ignored: true }, { path: 'staged.txt', ignored: false }],
    stagedExcluded: [{ path: '.env.local', reason: 'hidden' }],
    notUtf8: [],
  });
});

// An untracked file removed between `ls-files --others` and its `lstat` (an editor temp
// file, build output) is skipped, not an internal failure.
test('candidateFacts: a path gone since the listing is skipped', (t) => {
  const c = createCase(t);
  c.writeFile('kept.txt', 'k\n');

  assert.deepEqual(
    changeSet.candidateFacts(c.repoDir, ['gone.txt', 'kept.txt', 'gone-dir/x.txt']),
    [{ path: 'kept.txt', size: 2, binary: false }],
  );
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

// C:plan: the inventory reads `git status` with `--no-renames`, so a rename's old path is its
// own deletion in `tracked`, also when the new path is hidden and goes to `stagedExcluded`.
test('inventory: a tracked file renamed to a hidden name keeps its deletion (mv + add -N)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  fs.renameSync(path.join(c.repoDir, 'a.txt'), path.join(c.repoDir, '.env'));
  c.git(['add', '-N', '.env']);

  assert.deepEqual(await inventory(c), {
    ...EMPTY_INVENTORY,
    clean: false,
    tracked: ['a.txt'],
    stagedExcluded: [{ path: '.env', reason: 'hidden' }],
  });
});

test('inventory: a tracked file renamed to a hidden name keeps its deletion (git mv)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.git(['mv', 'a.txt', '.env']);

  assert.deepEqual(await inventory(c), {
    ...EMPTY_INVENTORY,
    clean: false,
    tracked: ['a.txt'],
    preStaged: ['.env', 'a.txt'],
    stagedExcluded: [{ path: '.env', reason: 'hidden' }],
  });
});

// C:plan: an intent-to-add entry stages no content (a commit leaves it out of the tree), so
// it is staged-new but not pre-staged. A non-ASCII path comes through unquoted.
test('inventory: an intent-to-add path is staged-new, not pre-staged', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('déjà ü.txt', 'n\n');
  c.git(['add', '-N', 'déjà ü.txt']);

  assert.deepEqual(await inventory(c), {
    ...EMPTY_INVENTORY,
    clean: false,
    stagedNew: [{ path: 'déjà ü.txt', ignored: false }],
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

test('snapshot: a modified file is one unit per hunk; a renamed file is one unit whose range encloses its hunks', async (t) => {
  const c = createCase(t);
  const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}\n`);
  const edited = ['0\n', ...lines.slice(1, 11), 'X\n'].join('');
  seed(c, { 'f.txt': lines.join(''), 'eof.txt': 'x', 'old.txt': lines.join('') });
  c.writeFile('f.txt', edited);
  c.writeFile('eof.txt', 'x\n');
  c.git(['mv', 'old.txt', 'new.txt']);
  c.writeFile('new.txt', edited);

  const units = await snapshot(c, { candidates: [], stagedNew: [{ path: 'new.txt', ignored: false }] });

  const hunkCount = (unit) => (unit.body.toString('utf8').match(/^@@ /gm) || []).length;
  const f = units.filter((u) => u.path === 'f.txt');
  assert.deepEqual(f.map((u) => [u.range, hunkCount(u)]), [['-1,4 +1,4', 1], ['-9,4 +9,4', 1]]);
  const renamed = units.find((u) => u.path === 'new.txt');
  assert.deepEqual([renamed.status, renamed.range, hunkCount(renamed)], ['R', '-1,12 +1,12', 2]);
  // The `\ No newline at end of file` line counts as neither added nor deleted. The oracle
  // is keyed by the new path, same as a rename unit's `path`, so the rename counts toward
  // it too.
  const oracle = numstat(c);
  const sums = {};
  for (const unit of units) {
    sums[unit.path] = sums[unit.path] ?? { added: 0, deleted: 0 };
    sums[unit.path].added += unit.added;
    sums[unit.path].deleted += unit.deleted;
  }
  for (const [file, counts] of Object.entries(sums)) assert.deepEqual(counts, oracle[file], file);
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
  // CHG-06: the identity key leaves out the occurrence index (here 0) the hash ends with.
  const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
  assert.equal(u1.identityKey, sha('f.txt\0-mid\n+MID\n'));
  assert.equal(u1.hash, sha('f.txt\0-mid\n+MID\n\0' + '0'));
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

  assert.throws(() => unitsFromDiff(raw), /the diff has 1 patch sections for 2 raw records/);
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

// CHG-08: whole-file units per Q11's hash table, each part framed so none can pass for another.
function blobId(c, spec) {
  return c.git(['rev-parse', spec]).trim();
}

test('snapshot: a binary edit is one binary unit hashed over its path and full blob IDs', async (t) => {
  const c = createCase(t);
  seed(c, { 'bin.dat': Buffer.from([0, 1, 2, 10]) });
  c.writeFile('bin.dat', Buffer.from([0, 1, 3, 10]));
  const oldId = blobId(c, 'HEAD:bin.dat');
  const newId = c.git(['hash-object', 'bin.dat']).trim();

  const [unit, ...rest] = await snapshot(c);

  assert.equal(rest.length, 0);
  assert.deepEqual(
    { status: unit.status, kind: unit.kind, range: unit.range, added: unit.added, deleted: unit.deleted, body: unit.body.length },
    { status: 'M', kind: 'binary', range: '-0,0 +0,0', added: 0, deleted: 0, body: 0 },
  );
  const expected = crypto.createHash('sha256').update(`M\0bin.dat\0blob ${oldId} ${newId}\0`).digest('hex');
  assert.equal(unit.hash, expected);
  assert.equal(unit.identityKey, expected);
});

test('snapshot: a new and a deleted binary file use the zero ID on the missing side', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.dat': Buffer.from([0, 9]) });
  const oldId = blobId(c, 'HEAD:old.dat');
  fs.rmSync(path.join(c.repoDir, 'old.dat'));
  fs.writeFileSync(path.join(c.repoDir, 'new.dat'), Buffer.from([0, 7, 7]));
  const newId = c.git(['hash-object', 'new.dat']).trim();
  const zero = '0'.repeat(oldId.length);

  const units = await snapshot(c, { candidates: ['new.dat'], stagedNew: [] });

  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind]), [['new.dat', 'A', 'binary'], ['old.dat', 'D', 'binary']]);
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(units[0].hash, sha(`A\0new.dat\0blob ${zero} ${newId}\0`));
  assert.equal(units[1].hash, sha(`D\0old.dat\0blob ${oldId} ${zero}\0`));
});

test('snapshot: a deleted text file is one D unit of - lines', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'one\ntwo\n' });
  fs.rmSync(path.join(c.repoDir, 'b.txt'));

  const [unit, ...rest] = await snapshot(c);

  assert.equal(rest.length, 0);
  assert.deepEqual(
    { path: unit.path, status: unit.status, kind: unit.kind, range: unit.range, added: unit.added, deleted: unit.deleted },
    { path: 'b.txt', status: 'D', kind: 'text', range: '-1,2 +0,0', added: 0, deleted: 2 },
  );
  assert.equal(unit.body.toString('utf8'), '@@ -1,2 +0,0 @@\n-one\n-two\n');
  assert.equal(unit.hash, crypto.createHash('sha256').update('D\0b.txt\0-one\n-two\n').digest('hex'));
});

// A committed 100755 file whose worktree copy reads as 100644 under `core.fileMode=true`
// gives a mode change on every platform (Windows has no executable bit to set).
test('snapshot: a mode change, alone or with an edit, is one mode unit hashed over both modes', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.fileMode', 'true']);
  seed(c, { 'run.sh': 'echo\n', 'ed.sh': '1\n2\n' });
  c.git(['update-index', '--chmod=+x', '--', 'run.sh', 'ed.sh']);
  c.git(['commit', '-q', '-m', 'exec']);
  for (const file of ['run.sh', 'ed.sh']) fs.chmodSync(path.join(c.repoDir, file), 0o644);
  c.writeFile('ed.sh', '1\ntwo\n');

  const units = await snapshot(c);

  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind, u.range]), [
    ['ed.sh', 'M', 'mode', '-1,2 +1,2'],
    ['run.sh', 'M', 'mode', '-0,0 +0,0'],
  ]);
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(units[0].hash, sha('M\0ed.sh\0mode 100755 100644\0-2\n+two\n'));
  assert.equal(units[1].hash, sha('M\0run.sh\0mode 100755 100644\0'));
  assert.equal(units[1].body.length, 0);
});

// CHG-08 decision: the status tag rules out the rename-vs-mode collision the review found
// (a pure rename to a path spelled like a mode marker used to hash the same as a chmod of
// the same path: both unions were `a.txt\0mode 100755 100644\0` without the tag).
test('snapshot: a rename to a path spelled like a mode marker does not collide with a chmod', async (t) => {
  const c1 = createCase(t);
  seed(c1, { 'a.txt': 'x\n' });
  fs.renameSync(path.join(c1.repoDir, 'a.txt'), path.join(c1.repoDir, 'mode 100755 100644'));
  const inv1 = await inventory(c1);
  const [renameUnit] = await snapshot(c1, { candidates: inv1.candidates.map((x) => x.path), stagedNew: inv1.stagedNew });

  const c2 = createCase(t);
  c2.git(['config', 'core.fileMode', 'true']);
  seed(c2, { 'a.txt': 'x\n' });
  c2.git(['update-index', '--chmod=+x', '--', 'a.txt']);
  c2.git(['commit', '-q', '-m', 'exec']);
  fs.chmodSync(path.join(c2.repoDir, 'a.txt'), 0o644);
  const [chmodUnit] = await snapshot(c2);

  assert.deepEqual([renameUnit.status, renameUnit.oldPath, renameUnit.path], ['R', 'a.txt', 'mode 100755 100644']);
  assert.deepEqual([chmodUnit.status, chmodUnit.path, chmodUnit.kind], ['M', 'a.txt', 'mode']);
  assert.notEqual(renameUnit.hash, chmodUnit.hash);
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(renameUnit.hash, sha('R\0a.txt\0mode 100755 100644\0'));
  assert.equal(chmodUnit.hash, sha('M\0a.txt\0mode 100755 100644\0'));
});

test('snapshot: a binary file with a mode change is one binary unit hashing both mode and blob IDs', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.fileMode', 'true']);
  seed(c, { 'bin.dat': Buffer.from([0, 1, 2, 10]) });
  c.git(['update-index', '--chmod=+x', '--', 'bin.dat']);
  c.git(['commit', '-q', '-m', 'exec']);
  fs.chmodSync(path.join(c.repoDir, 'bin.dat'), 0o644);
  const oldId = blobId(c, 'HEAD:bin.dat');
  c.writeFile('bin.dat', Buffer.from([0, 1, 3, 10]));
  const newId = c.git(['hash-object', 'bin.dat']).trim();

  const [unit, ...rest] = await snapshot(c);

  assert.equal(rest.length, 0);
  assert.deepEqual(
    { status: unit.status, kind: unit.kind, range: unit.range, body: unit.body.length },
    { status: 'M', kind: 'binary', range: '-0,0 +0,0', body: 0 },
  );
  const expected = crypto.createHash('sha256')
    .update(`M\0bin.dat\0mode 100755 100644\0blob ${oldId} ${newId}\0`).digest('hex');
  assert.equal(unit.hash, expected);
});

test('snapshot: a rename with a mode change hashes old and new path and both modes', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.fileMode', 'true']);
  seed(c, { 'old.sh': 'echo\n' });
  c.git(['update-index', '--chmod=+x', '--', 'old.sh']);
  c.git(['commit', '-q', '-m', 'exec']);
  fs.renameSync(path.join(c.repoDir, 'old.sh'), path.join(c.repoDir, 'moved.sh'));
  fs.chmodSync(path.join(c.repoDir, 'moved.sh'), 0o644);
  const inv = await inventory(c);

  const units = await snapshot(c, { candidates: inv.candidates.map((x) => x.path), stagedNew: inv.stagedNew });

  assert.equal(units.length, 1);
  const [unit] = units;
  assert.deepEqual(
    { status: unit.status, oldPath: unit.oldPath, path: unit.path, kind: unit.kind, range: unit.range },
    { status: 'R', oldPath: 'old.sh', path: 'moved.sh', kind: 'mode', range: '-0,0 +0,0' },
  );
  assert.equal(
    unit.hash,
    crypto.createHash('sha256').update('R\0old.sh\0moved.sh\0mode 100755 100644\0').digest('hex'),
  );
});

test('snapshot: a type change is not built yet (CHG-09)', { skip: process.platform === 'win32' && 'no symlinks without privileges' }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'l': 'x\n' });
  fs.rmSync(path.join(c.repoDir, 'l'));
  fs.symlinkSync('a.txt', path.join(c.repoDir, 'l'));
  await assert.rejects(snapshot(c), /a T change \(l\) is not built yet \(CHG-09\)/);
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
  const expected = crypto.createHash('sha256').update('A\0new.txt\0+one\n+two\n').digest('hex');
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
    assert.equal(unit.hash, crypto.createHash('sha256').update('R\0old.txt\0moved.txt\0').digest('hex'));
  }
});

test('snapshot: a renamed and edited file hashes both paths and its -/+ lines', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': 'a\nb\nc\nd\ne\n' });
  fs.rmSync(path.join(c.repoDir, 'old.txt'));
  c.writeFile('moved.txt', 'a\nb\nC\nd\ne\n');

  const [unit] = await snapshot(c, { candidates: ['moved.txt'], stagedNew: [] });

  assert.deepEqual([unit.status, unit.oldPath, unit.path, unit.added, unit.deleted], ['R', 'old.txt', 'moved.txt', 1, 1]);
  assert.equal(unit.hash, crypto.createHash('sha256').update('R\0old.txt\0moved.txt\0-c\n+C\n').digest('hex'));
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

// Racy git: a same-size edit within the second of the last index write keeps the entry's
// stat data, so git sees it only because the entry is not older than the index file. A copy
// with a fresh mtime lost that and the snapshot came back empty (CI on Linux and macOS, whose
// git compares whole seconds). Fixed times make the race deterministic; `core.checkStat
// minimal` compares only the mtime's seconds and the size on every platform.
test('snapshot: a racily clean same-size edit is still a unit', async (t) => {
  const c = createCase(t);
  seed(c, { 'racy.txt': 'old\n' });
  c.git(['config', 'core.checkStat', 'minimal']);
  const file = path.join(c.repoDir, 'racy.txt');
  const realIndex = path.join(c.repoDir, '.git', 'index');
  const then = new Date(Date.UTC(2020, 0, 1));
  fs.utimesSync(file, then, then);
  c.git(['update-index', '-q', '--refresh']);
  c.writeFile('racy.txt', 'new\n');
  fs.utimesSync(file, then, then);
  fs.utimesSync(realIndex, then, then);
  assert.equal(c.git(['diff-files', '--name-only']), 'racy.txt\n', 'git itself sees the edit');

  const units = await snapshot(c);

  assert.deepEqual(units.map((u) => [u.path, u.status, u.range]), [['racy.txt', 'M', '-1 +1']]);
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

// CHG-06: the streamed patch pass, fed crafted `git diff -z --raw -p` bytes (KD-R1 style).
function craftedDiff(headerPath) {
  const sha = '0'.repeat(40);
  return Buffer.concat([
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0a b.txt\0`, 'latin1'),
    Buffer.from([0]),
    Buffer.from(
      `diff --git a/${headerPath} b/${headerPath}\nindex 0000000..1111111 100644\n--- a/x\n+++ b/x\n`
      + '@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n@@ -9 +9,2 @@\n ctx\n+two\n',
      'latin1',
    ),
  ]);
}

test('snapshot: the streamed reader gives the same units however the output is chunked', () => {
  const output = craftedDiff('a b.txt');
  const whole = unitsFromDiff(output);
  const reader = changeSet.createDiffReader();
  for (let i = 0; i < output.length; i += 1) reader.push(output.subarray(i, i + 1));
  const byByte = reader.end();

  assert.deepEqual(byByte, whole);
  assert.deepEqual(whole.map((u) => [u.path, u.range, u.added, u.deleted]), [
    ['a b.txt', '-1,2 +1,2', 1, 1], ['a b.txt', '-9 +9,2', 1, 0],
  ]);
  assert.deepEqual(whole[1].addedLines, [{ line: 10, text: 'two' }]);
});

test('snapshot: a section header that does not match its raw record path is internal', () => {
  assert.throws(() => unitsFromDiff(craftedDiff('other.txt')), /patch section 1 does not match raw record 1/);
});

// CHG-06: crafted raw+patch bytes whose paths hold TAB, LF, `"`, `\`, DEL and `\x01`, plus a
// rename whose new path needs quoting and whose old path does not, fed one byte at a time so
// chunk boundaries inside the rename's 3-field raw record are exercised too. Runs on every
// OS (unlike the real-git check against `quoteTwo`'s escape table, which only covers a
// quoted path on non-Windows). The expected header text below is not derived from
// `quoteTwo`: it is the literal bytes git's own `quote_two` prints for these paths with
// `core.quotePath=false` (hand-verified against real git for the review of this slice), so a
// wrong escape in `quoteTwo` would make the reader reject its own header as a mismatch.
test('snapshot: the reader pairs headers whose paths need C-style quoting, including a rename with only one side quoted', () => {
  const sha = '0'.repeat(40);
  const weirdPath = 'a\x01b\x7fc\\d"e\tf\ng.txt';
  const weirdHeader = '"a/a\\001b\\177c\\\\d\\"e\\tf\\ng.txt" "b/a\\001b\\177c\\\\d\\"e\\tf\\ng.txt"';
  const renameHeader = 'a/plain.txt "b/ta\\tb\\"q.txt"';
  const raw = Buffer.concat([
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0`, 'latin1'),
    Buffer.from(weirdPath, 'latin1'),
    Buffer.from([0]),
    Buffer.from(`:100644 100644 ${sha} ${sha} R100\0plain.txt\0`, 'latin1'),
    Buffer.from('ta\tb"q.txt', 'latin1'),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
  const patch = Buffer.from(
    `diff --git ${weirdHeader}\n@@ -1,1 +1,1 @@\n-old\n+new\ndiff --git ${renameHeader}\n`,
    'latin1',
  );
  const output = Buffer.concat([raw, patch]);
  const reader = changeSet.createDiffReader();
  for (let i = 0; i < output.length; i += 1) reader.push(output.subarray(i, i + 1));

  const units = reader.end();

  assert.deepEqual(units.map((u) => [u.path, u.oldPath, u.status, u.added, u.deleted]), [
    [weirdPath, null, 'M', 1, 1],
    ['ta\tb"q.txt', 'plain.txt', 'R', 0, 0],
  ]);
});
