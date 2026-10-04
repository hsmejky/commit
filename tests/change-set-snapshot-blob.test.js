'use strict';

// SCN-14 (docs/roadmap/05-scanner.md, M10): `snapshotBlob(repoRelativePath)` reads the repo
// config's content "on the snapshot side of the last `snapshot()` call" (C:plan-hunks) — in
// `split` mode, the working-tree file, not the index or HEAD. `staged` mode (CHG-14) is not
// built yet.

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

function seed(c, files) {
  for (const [file, content] of Object.entries(files)) c.writeFile(file, content);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function snapshot(c, storedLists = { candidates: [], stagedNew: [] }) {
  return changeSet.snapshot({
    mode: 'split', storedLists, tracked: [], indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

// Runs first (node:test preserves declaration order within a file; `import()` caches the
// module for the whole process, per tests/helpers/load-lib.js, so this must run before any
// other test here calls `snapshot()`): no `snapshot()` call has reached this module yet.
test('snapshotBlob throws when called before any snapshot() this process', async () => {
  assert.throws(() => changeSet.snapshotBlob('.claude/commit.json'), /before any snapshot/);
});

test('snapshotBlob reads the working-tree bytes of the path after a split snapshot', async (t) => {
  const c = createCase(t);
  seed(c, { '.claude/commit.json': JSON.stringify({ scanIgnore: [] }), 'src/a.js': 'one\n' });
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: ['dist/**'] }));
  c.writeFile('src/a.js', 'one\ntwo\n');
  await snapshot(c);
  const blob = changeSet.snapshotBlob('.claude/commit.json');
  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.toString('utf8'), JSON.stringify({ scanIgnore: ['dist/**'] }));
});

test('snapshotBlob returns null when the path is absent on the snapshot side', async (t) => {
  const c = createCase(t);
  seed(c, { 'src/a.js': 'one\n' });
  c.writeFile('src/a.js', 'one\ntwo\n');
  await snapshot(c);
  assert.equal(changeSet.snapshotBlob('.claude/commit.json'), null);
});
