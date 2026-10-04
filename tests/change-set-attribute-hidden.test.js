'use strict';

// CHG-11 (docs/roadmap/07-change-set.md): a path git reports binary gets its `diff`/`binary`
// attributes checked (CHG-10's one `check-attr` call, now also querying `diff` and `binary`).
// An attribute-hidden path (`-diff`, a custom diff driver, or `binary` set) gets the 1 MB
// scan-limit check first (over -> `overScanLimit: true`, stays `kind: "binary"`, no content
// read), then a NUL check on its first 8000 bytes: NUL-free becomes a `kind: "text"`
// whole-file unit (`body` empty, like a summary-only unit, C:plan-hunks) whose added lines
// come from one shared `--text` pass; a path with a NUL stays genuinely binary. A file over
// `core.bigFileThreshold` with no hiding attribute is untouched (git's own classification
// wins, review-CHG-08 finding 2).

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const nodeModule = require('node:module');
const { pathToFileURL } = require('node:url');
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

function snapshot(c, { tracked = [] } = {}) {
  return changeSet.snapshot({
    mode: 'split', storedLists: { candidates: [], stagedNew: [] }, tracked, indexPath: path.join(c.root, 'git-index'),
    unborn: false, toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

// Seam 1 (AC1): a text file marked `-diff` -> one `kind: "text"` unit, `body: "none"`, added
// lines from the shared `--text` pass.
test('a text file marked -diff is one text unit scanned through a --text pass', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.git(['add', 'x.bin']);
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', 'one\ntwo\n');

  const units = await snapshot(c, { tracked: ['x.bin'] });
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.equal(unit.path, 'x.bin');
  assert.equal(unit.kind, 'text');
  // review-CHG-11 finding 4: git's raw binary bit is kept (the hash is still the whole-file
  // `blob <old> <new>` one), so hunk-index renders the unit with no block.
  assert.equal(unit.binary, true);
  assert.equal(unit.body.length, 0);
  assert.deepEqual(unit.addedLines.map((l) => l.text), ['two']);
});

// Seam 1 (AC2): an attribute-hidden file over 1 MB is flagged overScanLimit and stays binary;
// no content is read to decide (scanner.mjs's skip check already treats the flag as skipped
// ahead of `kind`, so there is no need to flip `kind` here).
test('an attribute-hidden file over 1 MB is flagged overScanLimit and stays kind binary', async (t) => {
  const c = createCase(t);
  c.writeFile('big.bin', 'a\n');
  c.git(['add', 'big.bin']);
  c.writeFile('.gitattributes', 'big.bin -diff\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('big.bin', 'x'.repeat(1048577));

  const units = await snapshot(c, { tracked: ['big.bin'] });
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.equal(unit.kind, 'binary');
  assert.equal(unit.overScanLimit, true);
  assert.deepEqual(unit.addedLines, []);
});

// Seam 1 (AC3): a file over a lowered core.bigFileThreshold with no hiding attribute is git's
// own call to make: it stays binary, no --text pass ever runs (no attribute -> no candidate,
// AC3 holds structurally per the handoff design note, not by a spy).
test('a NUL-free file over a lowered bigFileThreshold with no attribute stays binary', async (t) => {
  const c = createCase(t);
  c.writeFile('big.txt', 'a\n');
  c.git(['add', 'big.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'core.bigFileThreshold', '10']);
  c.writeFile('big.txt', `a\n${'b'.repeat(40)}\n`);

  const units = await snapshot(c, { tracked: ['big.txt'] });
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.equal(unit.kind, 'binary');
  assert.equal(unit.overScanLimit, undefined);
});

// Seam 1 (AC4): an attribute-hidden text file and a file->symlink change (CHG-09's T unit)
// both land in the same inventory, so the shared --text pass has to pair sections for both
// without choking (no `internal`, Q11).
test('an attribute-hidden text file and a file-to-symlink change share the one --text pass', { skip: NO_SYMLINKS }, async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('a.txt', 'hello\n');
  c.git(['add', 'x.bin', 'a.txt']);
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', 'one\ntwo\n');
  fs.rmSync(path.join(c.repoDir, 'a.txt'));
  fs.symlinkSync('x.bin', path.join(c.repoDir, 'a.txt'));

  const units = await snapshot(c, { tracked: ['x.bin', 'a.txt'] });
  assert.equal(units.length, 2);
  const byPath = new Map(units.map((u) => [u.path, u]));
  assert.equal(byPath.get('x.bin').kind, 'text');
  assert.equal(byPath.get('a.txt').kind, 'symlink');
});

// review-CHG-11 finding 7: the NUL check is what keeps a genuinely binary attribute-hidden
// file binary; without it every `*.png binary` file would be read as text.
test('an attribute-hidden file with a NUL in its first 8000 bytes stays kind binary', async (t) => {
  const c = createCase(t);
  c.writeFile('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  c.writeFile('.gitattributes', 'img.png binary\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('img.png', Buffer.from([0x89, 0x50, 0x00, 0x02, 0x0a]));

  const units = await snapshot(c, { tracked: ['img.png'] });
  assert.deepEqual(units.map((u) => [u.path, u.kind, u.binary, u.overScanLimit]), [['img.png', 'binary', true, undefined]]);
  assert.deepEqual(units[0].addedLines, []);
});

// review-CHG-11 finding 7: the `binary` macro and a custom diff driver whose config says
// `binary = true` hide a text file just like `-diff` (C:plan).
test('the binary macro and a custom binary diff driver both make an attribute-hidden text unit', async (t) => {
  const c = createCase(t);
  c.writeFile('m.dat', 'one\n');
  c.writeFile('d.dat', 'one\n');
  c.writeFile('.gitattributes', 'm.dat binary\nd.dat diff=foo\n');
  c.git(['config', 'diff.foo.binary', 'true']);
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('m.dat', 'one\nmacro\n');
  c.writeFile('d.dat', 'one\ndriver\n');

  const units = await snapshot(c, { tracked: ['d.dat', 'm.dat'] });
  assert.deepEqual(
    units.map((u) => [u.path, u.kind, u.binary, u.body.length, u.addedLines.map((l) => l.text)]),
    [['d.dat', 'text', true, 0, ['driver']], ['m.dat', 'text', true, 0, ['macro']]],
  );
});

// review-CHG-11 finding 3: a deletion has no new content to sniff (Q10 decides on the new
// side), so a deleted attribute-hidden binary stays `kind: "binary"`.
test('a deleted attribute-hidden binary file stays kind binary in split mode', async (t) => {
  const c = createCase(t);
  c.writeFile('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x0a, 0x0a]));
  c.writeFile('.gitattributes', '*.png binary\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, 'img.png'));

  const units = await snapshot(c, { tracked: ['img.png'] });
  assert.deepEqual(units.map((u) => [u.path, u.status, u.kind, u.added, u.deleted]), [['img.png', 'D', 'binary', 0, 0]]);
});

function reword(c, head) {
  return changeSet.snapshot({ mode: 'reword', head, root: false, toplevel: c.repoDir, env: c.env, now: NOW });
}

// review-CHG-11 findings 1 and 7: reword reads the new content from HEAD's tree; a file
// HEAD deletes has none there, which used to make `git cat-file` fail the whole snapshot.
test('reword: a hidden text edit is a text unit and a HEAD-deleted hidden binary stays binary', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  c.writeFile('.gitattributes', 'x.bin -diff\n*.png binary\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', 'one\ntwo\n');
  c.git(['rm', '-q', 'img.png']);
  c.git(['add', 'x.bin']);
  c.git(['commit', '-q', '-m', 'edit']);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const units = await reword(c, head);
  assert.deepEqual(
    units.map((u) => [u.path, u.status, u.kind, u.binary, u.addedLines.map((l) => l.text)]),
    [['img.png', 'D', 'binary', true, []], ['x.bin', 'M', 'text', true, ['two']]],
  );
});

// review-CHG-11 finding 5: the `--text` pass re-diffs without renames when a rename's old
// path is not UTF-8, as the main pass does, so a hidden text file that is the UTF-8 new side
// of such a rename is still read as text (built with plumbing: no file name on disk needed).
test('reword: a hidden text file renamed from a non-UTF-8 path is still a scanned text unit', async (t) => {
  const c = createCase(t);
  c.writeFile('.gitattributes', '*.bin -diff\n');
  const plumb = (args, input) => {
    const r = spawnSync('git', args, { cwd: c.repoDir, env: c.env, input });
    assert.equal(r.status, 0, r.stderr && r.stderr.toString());
    return r.stdout.toString('utf8').trim();
  };
  const oldBlob = plumb(['hash-object', '-w', '--stdin'], 'one\ntwo\nthree\nfour\n');
  const newBlob = plumb(['hash-object', '-w', '--stdin'], 'one\ntwo\nthree\nfour\nfive\n');
  const tree1 = plumb(['mktree'], Buffer.from(`100644 blob ${oldBlob}\tt\xe9.bin\n`, 'latin1'));
  const tree2 = plumb(['mktree'], Buffer.from(`100644 blob ${newBlob}\tte.bin\n`, 'latin1'));
  const parent = plumb(['commit-tree', tree1, '-m', 'seed']);
  const head = plumb(['commit-tree', tree2, '-p', parent, '-m', 'rename']);

  const units = await reword(c, head);
  assert.deepEqual(
    units.map((u) => [u.path, u.status, u.kind, u.addedLines.map((l) => l.text)]),
    [['te.bin', 'A', 'text', ['one', 'two', 'three', 'four', 'five']]],
  );
});

// review-CHG-11 finding 2: the `--text` pass keeps only the hidden files' sections while it
// reads (C:plan "read for these files' sections only, discarding the rest as it arrives"):
// a reader given a keep-set still pairs every section with its record, but builds units
// (and copies hunk lines) for the kept paths alone.
test('a diff reader with a keep-set pairs every section but builds only the kept units', () => {
  const sha = '0'.repeat(40);
  const output = Buffer.from([
    `:100644 100644 ${sha} ${sha} M\0big.dat\0`,
    `:100644 100644 ${sha} ${sha} M\0x.bin\0\0`,
    'diff --git a/big.dat b/big.dat\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.bin b/x.bin\n@@ -1 +1,2 @@\n one\n+two\n',
  ].join(''), 'latin1');
  const reader = changeSet.createDiffReader(new Map(), { keep: new Set(['x.bin']) });
  for (let i = 0; i < output.length; i += 7) reader.push(output.subarray(i, i + 7));

  const units = reader.end();
  assert.deepEqual(units.map((u) => [u.path, u.added, u.addedLines.map((l) => l.text)]), [['x.bin', 1, ['two']]]);
});

const SPAWN_RECORD_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'spawn-record-preload.mjs')).href;

async function planWithSpawnLog(c, argv = ['plan']) {
  const log = path.join(c.root, 'spawns.jsonl');
  const result = await runCommit(c, argv, {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const textPasses = entries.filter((e) => Array.isArray(e.args) && e.args.includes('diff') && e.args.includes('--text'));
  return { result, textPasses, entries };
}

// review-CHG-11 findings 4 and 7 (AC1 through `plan`): the attribute-hidden text unit has no
// block (`body: "none"`, C:plan-hunks), and exactly one `--text` pass runs.
test('plan: a -diff text file is a text hunk entry with body none, from one --text pass', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', 'one\ntwo\n');

  const { result, textPasses } = await planWithSpawnLog(c);
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const entries = result.json.hunks.hunks.map(({ path: p, kind, body, lines, offset }) => ({ path: p, kind, body, lines, offset }));
  assert.deepEqual(entries, [{ path: 'x.bin', kind: 'text', body: 'none', lines: null, offset: null }], detail);
  assert.equal(textPasses.length, 1, JSON.stringify(textPasses));
});

// review-CHG-11 finding 7 (AC2 and AC3 through `plan`): an over-limit hidden file is reported
// `scan: "skipped"` and needs no `--text` pass; a file over a lowered bigFileThreshold with no
// hiding attribute stays binary and runs none either (a real spawn-log assertion).
test('plan: an over-limit hidden file is scan skipped; neither it nor a bigFileThreshold file runs a --text pass', async (t) => {
  const c = createCase(t);
  c.writeFile('big.bin', 'a\n');
  c.writeFile('big.txt', 'a\n');
  c.writeFile('.gitattributes', 'big.bin -diff\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'core.bigFileThreshold', '10']);
  c.writeFile('big.bin', 'x'.repeat(1048577));
  c.writeFile('big.txt', `a\n${'b'.repeat(40)}\n`);

  const { result, textPasses } = await planWithSpawnLog(c);
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const entries = result.json.hunks.hunks.map(({ path: p, kind, body, scan }) => ({ path: p, kind, body, scan }));
  assert.deepEqual(entries, [
    { path: 'big.bin', kind: 'binary', body: 'none', scan: 'skipped' },
    { path: 'big.txt', kind: 'binary', body: 'none', scan: undefined },
  ], detail);
  assert.deepEqual(textPasses, []);
});

// review-CHG-11-r2 new finding 1 (Low): the keep-set is actually used to drop the other
// section's unit at the reader, not merely filtered back out afterward by
// `resolveHiddenBinaries` (which would still pass every other test in this file even if the
// `keep` argument were dropped from `pinnedDiff`'s and `diffUnits`' calls, since it already
// filters its own result by path). With the same two-section raw+patch bytes, a reader built
// with a keep-set builds no unit for the path outside it; the same reader built with none
// (`keep: null`, what a dropped argument would leave in `createDiffReader`'s default) builds
// both, so the two calls are observably different.
test('a diff reader keep-set drops the other section at the reader; without one it would not', () => {
  const sha = '0'.repeat(40);
  const raw = [
    `:100644 100644 ${sha} ${sha} M\0big.dat\0`,
    `:100644 100644 ${sha} ${sha} M\0x.bin\0\0`,
  ].join('');
  const patch = [
    'diff --git a/big.dat b/big.dat\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.bin b/x.bin\n@@ -1 +1,2 @@\n one\n+two\n',
  ].join('');
  const output = Buffer.from(raw + patch, 'latin1');

  const kept = changeSet.createDiffReader(new Map(), { keep: new Set(['x.bin']) });
  for (let i = 0; i < output.length; i += 7) kept.push(output.subarray(i, i + 7));
  assert.deepEqual(kept.end().map((u) => u.path), ['x.bin']);

  const unfiltered = changeSet.createDiffReader(new Map(), { keep: null });
  for (let i = 0; i < output.length; i += 7) unfiltered.push(output.subarray(i, i + 7));
  assert.deepEqual(unfiltered.end().map((u) => u.path).sort(), ['big.dat', 'x.bin']);
});

// Runs `fn`, recording the argv of every `node:child_process` spawn made while it runs (by
// any module in this process, including the ESM library under `import()`), then restores the
// originals whatever `fn` does. `module.syncBuiltinESMExports` is needed both ways: the
// library's `import { spawn } from 'node:child_process'` binds at load time, so a plain
// CommonJS-side patch is otherwise invisible to it.
async function withSpawnArgs(fn) {
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];
  const record = (args) => calls.push(Array.isArray(args) ? args.map(String) : []);
  childProcess.spawn = function patchedSpawn(file, args, ...rest) {
    record(args);
    return originalSpawn.call(this, file, args, ...rest);
  };
  childProcess.spawnSync = function patchedSpawnSync(file, args, ...rest) {
    record(args);
    return originalSpawnSync.call(this, file, args, ...rest);
  };
  nodeModule.syncBuiltinESMExports();
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    nodeModule.syncBuiltinESMExports();
  }
}

// review-CHG-11-r3 Low finding 1: r2's new keep-set test (just above) only exercises
// `createDiffReader` directly, so it never proves `keep` actually reaches the split
// (change-set.mjs ~636) or reword (~603) call sites that build it; dropping the argument
// there still passes every test in this file, because `resolveHiddenBinaries` already
// filters the `--text` pass's result by path regardless (harmless but wasteful: the pass
// then fully builds a unit for every file in the diff, not only the kept ones).
//
// The one place dropping `keep` is actually observable: a file renamed from a non-UTF-8 old
// path outside the keep-set. `openSection` always marks such a section `{ notUtf8: true,
// rediff: <new path> }` before the keep-set override runs; with `keep` wired, a non-kept
// path's section is then replaced by the generic `NOT_UTF8_SECTION` (`rediff: null`), so it
// never reaches the `rediff.push` below it, and the `--text` pass queues no extra
// `--no-renames` rediff for it. Drop `keep` (its default becomes `null`, "keep everything")
// and the override never runs, so this unrelated rename queues one.
test('reword: an unrelated non-UTF-8-path rename outside the keep-set queues no extra --text rediff', async (t) => {
  const c = createCase(t);
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  const plumb = (args, input) => {
    const r = spawnSync('git', args, { cwd: c.repoDir, env: c.env, input });
    assert.equal(r.status, 0, r.stderr && r.stderr.toString());
    return r.stdout.toString('utf8').trim();
  };
  const oldX = plumb(['hash-object', '-w', '--stdin'], 'one\n');
  const newX = plumb(['hash-object', '-w', '--stdin'], 'one\ntwo\n');
  const renamed = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const renameBlob = plumb(['hash-object', '-w', '--stdin'], renamed);
  const tree1 = plumb(['mktree'], Buffer.from(
    `100644 blob ${oldX}\tx.bin\n100644 blob ${renameBlob}\tt\xe9.other\n`, 'latin1',
  ));
  const tree2 = plumb(['mktree'], Buffer.from(
    `100644 blob ${newX}\tx.bin\n100644 blob ${renameBlob}\tte.other\n`, 'latin1',
  ));
  const parent = plumb(['commit-tree', tree1, '-m', 'seed']);
  const head = plumb(['commit-tree', tree2, '-p', parent, '-m', 'edit']);

  const { result: units, calls } = await withSpawnArgs(() => reword(c, head));

  assert.deepEqual(
    units.map((u) => [u.path, u.status, u.kind]).sort(),
    [['te.other', 'A', 'text'], ['x.bin', 'M', 'text']],
  );
  const textRediffs = calls.filter((args) => args.includes('--text') && args.includes('--no-renames'));
  assert.deepEqual(textRediffs, [], JSON.stringify(textRediffs));
});

// review-CHG-11-r3 Low finding 1 (split half): split's own call site (runTextPass, ~636)
// needs no non-UTF-8 name on the real filesystem to prove `keep` reaches it. The old side of
// a rename only has to exist in HEAD's tree object: built with plumbing and attached to
// `main` with `update-ref`, `git reset -q -- .` (Q11 step 2) populates the temporary index
// from the object database alone, never touching a file by that name on disk. The same
// unrelated-rename-outside-the-keep-set probe as reword's test above, so this one needs no
// `holdsNonUtf8Names` skip and runs on every platform, including Windows/NTFS.
test('split: an unrelated non-UTF-8-path rename outside the keep-set queues no extra --text rediff', async (t) => {
  const c = createCase(t);
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  const plumb = (args, input) => {
    const r = spawnSync('git', args, { cwd: c.repoDir, env: c.env, input });
    assert.equal(r.status, 0, r.stderr && r.stderr.toString());
    return r.stdout.toString('utf8').trim();
  };
  const oldX = plumb(['hash-object', '-w', '--stdin'], 'one\n');
  const renamed = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const renameBlob = plumb(['hash-object', '-w', '--stdin'], renamed);
  const tree = plumb(['mktree'], Buffer.from(
    `100644 blob ${oldX}\tx.bin\n100644 blob ${renameBlob}\tt\xe9.other\n`, 'latin1',
  ));
  const head = plumb(['commit-tree', tree, '-m', 'seed']);
  c.git(['update-ref', 'refs/heads/main', head]);

  c.writeFile('x.bin', 'one\ntwo\n');
  c.writeFile('te.other', renamed);

  const { result: units, calls } = await withSpawnArgs(() => changeSet.snapshot({
    mode: 'split',
    storedLists: { candidates: ['te.other'], stagedNew: [] },
    tracked: ['x.bin'],
    indexPath: path.join(c.root, 'git-index'),
    unborn: false,
    toplevel: c.repoDir,
    env: c.env,
    now: NOW,
  }));

  assert.deepEqual(
    units.map((u) => [u.path, u.status, u.kind]).sort(),
    [['te.other', 'A', 'text'], ['x.bin', 'M', 'text']],
  );
  const textRediffs = calls.filter((args) => args.includes('--text') && args.includes('--no-renames'));
  assert.deepEqual(textRediffs, [], JSON.stringify(textRediffs));
});

// A file name given as raw bytes, relative to the repo (review-CHG-12's pattern,
// tests/change-set-raw-bytes.test.js).
function writeRaw(c, nameBytes, content) {
  fs.writeFileSync(Buffer.concat([Buffer.from(c.repoDir + path.sep), nameBytes]), content);
}

// Whether `dir`'s filesystem keeps a name with a non-UTF-8 byte exactly as written.
function holdsNonUtf8Names(dir) {
  const name = Buffer.from('probe-\xff', 'latin1');
  const full = Buffer.concat([Buffer.from(dir + path.sep), name]);
  try {
    fs.writeFileSync(full, '');
  } catch {
    return false;
  }
  const held = fs.readdirSync(dir, { encoding: 'buffer' }).some((entry) => entry.equals(name));
  fs.rmSync(full);
  return held;
}

// review-CHG-11-r2 new finding 2 (Low): split's own `--text` pass has its own `--no-renames`
// rediff step (change-set.mjs ~638-640, review-CHG-11 finding 5's split half), separate from
// the main pass's rediff (CHG-12) that reword's test 9 already covers. A rename whose old
// path is not UTF-8 into a hidden new path exercises both: the main pass drops the pair and
// rediffs to an `A` unit for the new path (CHG-12), and the shared `--text` keep-set pass hits
// the very same non-UTF-8-old-path rename again and must rediff a second time to read it as
// text.
test('split: a hidden text file renamed from a non-UTF-8 path gets its own --text rediff', async (t) => {
  const c = createCase(t);
  if (!holdsNonUtf8Names(c.repoDir)) {
    t.skip('the filesystem cannot hold a file name that is not valid UTF-8');
    return;
  }
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const body = `${lines.join('\n')}\n`;
  writeRaw(c, Buffer.from('t\xe9.bin', 'latin1'), body);
  c.git(['add', '-A']);
  c.writeFile('.gitattributes', 'new.bin -diff\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(Buffer.concat([Buffer.from(c.repoDir + path.sep), Buffer.from('t\xe9.bin', 'latin1')]));
  c.writeFile('new.bin', `${body}extra\n`);

  const units = await changeSet.snapshot({
    mode: 'split',
    storedLists: { candidates: ['new.bin'], stagedNew: [] },
    tracked: [],
    indexPath: path.join(c.root, 'git-index'),
    unborn: false,
    toplevel: c.repoDir,
    env: c.env,
    now: NOW,
  });

  assert.deepEqual(
    units.map((u) => [u.path, u.status, u.kind, u.addedLines.map((l) => l.text)]),
    [['new.bin', 'A', 'text', [...lines, 'extra']]],
  );
});

// review-CHG-11-r2 new finding 3 (Low, AC1): a secret in an attribute-hidden file's added
// lines reaches the scanner end to end through `plan` (CHG-16), not only through the probe
// the r2 review ran by hand. Token built at run time (tests/plan-scan.test.js's pattern).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

test('plan: a secret added to a -diff hidden text file is found by the scan', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('.gitattributes', 'x.bin -diff\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', `one\nconst token = "${githubToken('a')}";\n`);

  const result = await runCommit(c, ['plan']);
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const entries = result.json.hunks.hunks.map(({ path: p, kind, body, scan }) => ({ path: p, kind, body, scan }));
  assert.deepEqual(entries, [{ path: 'x.bin', kind: 'text', body: 'none', scan: ['github-token'] }], detail);
});

// review-CHG-11-r2 Low finding 9 (reword's two `cat-file` calls per attribute-hidden
// candidate): with the fix (newOid read straight off the main pass's own unit, one
// `cat-file --batch-check` sizing every candidate, then one streamed `cat-file --batch`
// reading every under-limit candidate's content), the spawn count stays at two whatever the
// candidate count. `big.bin`'s `scan` stays undefined, not `"skipped"`: Q20 ("no content
// changes, so no content scan") makes `scanDiff` short-circuit `ctx.scanMap` to `{}` for the
// whole of `reword` mode, over-limit or not, so the batch path's own `overScanLimit` flag
// (verified separately: it still keeps `kind: "binary"` and empties `addedLines`) never
// reaches a scan tag there; only `split` mode's over-limit file is reported `scan: "skipped"`.
//
// review-CHG-11-r3 Low finding 2: `a.bin` and `b.bin` alone were both `text`, so a
// misassigned `streamCatFileBatch` result (e.g. `units[units.length - 1 - index]`, pairing a
// path with the wrong object's classification) passed unnoticed. `b.bin` now carries a NUL in
// its new content, so it must stay `kind: "binary"` while `a.bin` stays `text`; any swap
// between the two is now observable. `m.bin` pins the 8000-byte sniff cap itself: its new
// content is 9000 bytes with a NUL only at byte 8500, past the sniff window, so it must still
// come back `text` (a sniff that reads the whole object, not just the first 8000 bytes, would
// wrongly call it binary).
test('plan --reword: three attribute-hidden files cost two cat-file calls in all', async (t) => {
  const c = createCase(t);
  c.writeFile('a.bin', 'one\n');
  c.writeFile('b.bin', 'one\n');
  c.writeFile('big.bin', 'one\n');
  c.writeFile('m.bin', 'one\n');
  c.writeFile('.gitattributes', '*.bin -diff\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.bin', 'one\na\n');
  c.writeFile('b.bin', Buffer.from('one\n\0b\n'));
  c.writeFile('big.bin', 'x'.repeat(1048577));
  const mContent = Buffer.alloc(9000, 0x78);
  mContent[8500] = 0;
  c.writeFile('m.bin', mContent);
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'edit']);

  const { result, entries } = await planWithSpawnLog(c, ['plan', '--reword']);
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const hunks = result.json.hunks.hunks.map(({ path: p, kind, body, scan }) => ({ path: p, kind, body, scan }));
  assert.deepEqual(hunks, [
    { path: 'a.bin', kind: 'text', body: 'none', scan: undefined },
    { path: 'b.bin', kind: 'binary', body: 'none', scan: undefined },
    { path: 'big.bin', kind: 'binary', body: 'none', scan: undefined },
    { path: 'm.bin', kind: 'text', body: 'none', scan: undefined },
  ], detail);
  const catFiles = entries.filter((e) => Array.isArray(e.args) && e.args.includes('cat-file'));
  assert.equal(catFiles.length, 2, JSON.stringify(catFiles));
});
