'use strict';

// CHG-11 (docs/roadmap/07-change-set.md): a path git reports binary gets its `diff`/`binary`
// attributes checked (CHG-10's one `check-attr` call, now also querying `diff` and `binary`).
// An attribute-hidden path (`-diff`, a custom diff driver, or `binary` set) gets the 1 MB
// scan-limit check first (over -> `overScanLimit: true`, stays `kind: "binary"`, no content
// read), then a NUL check on its first 8000 bytes: NUL-free becomes a `kind: "text"`
// whole-file unit (`body` empty, like a summary-only unit, C:plan-hunks) whose added lines
// come from one shared `--text` pass; a path with a NUL stays genuinely binary. A file over
// `core.bigFileThreshold` with no hiding attribute is untouched (git's own classification
// wins, review-CHG-08 finding 2 / KD-R70 until this slice).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

async function planWithSpawnLog(c) {
  const log = path.join(c.root, 'spawns.jsonl');
  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const textPasses = entries.filter((e) => Array.isArray(e.args) && e.args.includes('diff') && e.args.includes('--text'));
  return { result, textPasses };
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
