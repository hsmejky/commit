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
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase } = require('./helpers/process-seam.js');

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
  assert.equal(unit.binary, false);
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
