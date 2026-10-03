'use strict';

// CHG-13 (docs/roadmap/07-change-set.md): the count caps of C:untracked-files in `split`,
// M9 `applyCaps` fed by M10 `inventory`. Seam 1 through the table-driven fixture generator:
// one repo per row, directory shapes at, below and above each cap (50 per new directory, 50
// root files, 200 total), asserting `plan.json`'s `untracked.collapsed` and `stagedExcluded`,
// and that no collapsed path reaches the stored lists or the temporary index's units.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');
const { FILE_CONTENT, buildFixture } = require('./helpers/fixture-generator.js');

let changeSet;
let pathClassifier;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
  pathClassifier = await loadLib('path-classifier');
});

const NOW = () => Date.UTC(2026, 0, 1);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function collapsedEntry(dir, count) {
  return { dir, count, bytes: count * FILE_CONTENT.length };
}

function excludedEntry(dir, count) {
  return { dir, count, reason: 'collapsed' };
}

const sum = (counts) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);

const ROWS = [
  // 50 per topmost new directory.
  { name: 'a new directory below the cap (49)', untracked: { pkg: 49 } },
  { name: 'a new directory at the cap (50)', untracked: { pkg: 50 } },
  {
    name: 'a new directory above the cap (51)', untracked: { pkg: 51 },
    collapsed: [collapsedEntry('pkg', 51)],
  },
  // 50 loose files at the root.
  { name: 'root files below the cap (49)', untracked: { '.': 49 } },
  { name: 'root files at the cap (50)', untracked: { '.': 50 } },
  {
    name: 'root files above the cap (51) collapse as "."', untracked: { '.': 51 },
    collapsed: [collapsedEntry('.', 51)],
  },
  // 200 in total.
  { name: 'total below the cap (199)', untracked: { a: 50, b: 50, c: 50, d: 49 } },
  { name: 'total at the cap (200)', untracked: { a: 50, b: 50, c: 50, d: 50 } },
  {
    name: 'total above the cap (201): the largest new directory goes, ties by path',
    untracked: { d: 50, c: 50, b: 50, a: 50, '.': 1 },
    collapsed: [collapsedEntry('a', 50)],
  },
  {
    name: 'loose files alone above 200: the largest loose parent goes, ties by path',
    trackedDirs: ['src/img', 'src/icons', 'lib'],
    untracked: { 'src/img': 60, 'src/icons': 60, lib: 50, '.': 40 },
    collapsed: [collapsedEntry('src/icons', 60)],
  },
  // C:untracked-files named tests.
  {
    name: 'packages/new-lib with 60 files next to a new file in tracked packages/app/src',
    trackedDirs: ['packages/app/src'],
    untracked: { 'packages/new-lib': 30, 'packages/new-lib/src/deep': 30, 'packages/app/src': 1 },
    collapsed: [collapsedEntry('packages/new-lib', 60)],
  },
  {
    name: '51 new files in tracked db/migrations are not collapsed',
    trackedDirs: ['db/migrations'], untracked: { 'db/migrations': 51 },
  },
  {
    name: '300 files staged into a new dist/ go to stagedExcluded',
    staged: { dist: 300 },
    stagedExcluded: [excludedEntry('dist', 300)],
  },
  // Both kinds count together; each list counts only its own kind.
  {
    name: 'a directory holding untracked and staged-new paths appears in both lists',
    untracked: { build: 30 }, staged: { build: 30 },
    collapsed: [collapsedEntry('build', 30)],
    stagedExcluded: [excludedEntry('build', 30)],
  },
];

for (const row of ROWS) {
  test(`caps (split): ${row.name}`, async (t) => {
    const c = createCase(t);
    buildFixture(c, row);

    const result = await runCommit(c, ['plan']);

    assert.equal(result.exitCode, 0, detail(result));
    const plan = readJson(path.join(result.json.runDir, 'plan.json'));
    const state = readJson(path.join(result.json.runDir, 'state.json'));
    assert.deepEqual(plan.untracked.collapsed, row.collapsed ?? []);
    assert.deepEqual(plan.stagedExcluded, row.stagedExcluded ?? []);
    assert.deepEqual(state.stagedExcluded, row.stagedExcluded ?? []);

    // Survivors only: the stored lists and the snapshot's units leave every collapsed path out.
    const collapsedCount = sum(Object.fromEntries((row.collapsed ?? []).map((e) => [e.dir, e.count])));
    const excludedCount = sum(Object.fromEntries((row.stagedExcluded ?? []).map((e) => [e.dir, e.count])));
    assert.equal(state.candidates.length, sum(row.untracked) - collapsedCount);
    assert.equal(state.stagedNew.length, sum(row.staged) - excludedCount);
    assert.equal(plan.untracked.candidates.length, state.candidates.length);
    const stored = new Set(['seed.txt', ...state.candidates, ...state.stagedNew.map((e) => e.path)]);
    const unitPaths = result.json.hunks.hunks.map((unit) => unit.path);
    assert.deepEqual(unitPaths.filter((p) => !stored.has(p)), []);
    assert.equal(unitPaths.length, stored.size);
  });
}

test('caps (split): a force-added hidden staged-new file goes to stagedExcluded as hidden', async (t) => {
  const c = createCase(t);
  buildFixture(c, { trackedDirs: [] });
  c.writeFile('.gitignore', '.idea/\n');
  c.writeFile('.idea/workspace.xml', '<x/>\n');
  c.git(['add', '-f', '.idea/workspace.xml']);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  const plan = readJson(path.join(result.json.runDir, 'plan.json'));
  assert.deepEqual(plan.stagedExcluded, [{ path: '.idea/workspace.xml', reason: 'hidden' }]);
  assert.deepEqual(plan.untracked.collapsed, []);
});

// `plan --staged` is not built yet (CHG-14): the caps' mode gate is pinned on M10 directly.
test('caps: a 60-file new directory under staged mode is not collapsed', async (t) => {
  const c = createCase(t);
  buildFixture(c, { staged: { pkg: 60 } });

  const result = await changeSet.inventory({ toplevel: c.repoDir, env: c.env, now: NOW, mode: 'staged' });

  assert.equal(result.stagedNew.length, 60);
  assert.deepEqual(result.collapsed, []);
  assert.deepEqual(result.stagedExcluded, []);
});

test('caps: an unborn HEAD makes every directory new', async (t) => {
  const c = createCase(t);
  for (let i = 1; i <= 51; i += 1) c.writeFile(`src/f${i}.txt`, FILE_CONTENT);

  const result = await changeSet.inventory({
    toplevel: c.repoDir, env: c.env, now: NOW, mode: 'split', unborn: true,
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.collapsed, [collapsedEntry('src', 51)]);
  assert.equal(result.clean, true);
});

test('applyCaps: ties break in UTF-8 byte order, not UTF-16 code unit order', () => {
  // U+FFFF (EF BF BF) sorts before U+10000 (F0 90 80 80) in bytes; in UTF-16 the surrogate
  // pair D800 DC00 sorts first.
  const bmp = 'x￿';
  const astral = 'x\u{10000}';
  const candidates = [];
  const add = (dir, count) => {
    for (let i = 0; i < count; i += 1) candidates.push({ path: `${dir}/${i}`, size: 1, binary: false });
  };
  add(astral, 50);
  add(bmp, 50);
  add('a', 49);
  add('b', 2);
  for (let i = 0; i < 50; i += 1) candidates.push({ path: `r${i}.txt`, size: 1, binary: false });

  const result = pathClassifier.applyCaps(candidates, [], []);

  assert.deepEqual(result.collapsed, [{ dir: bmp, count: 50, bytes: 50 }]);
  assert.equal(result.candidates.length, 151);
});
