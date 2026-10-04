'use strict';

// PLN-03 (docs/roadmap/08-plan-validation.md): hunk-level worker plans in a `split` `check`
// (C:check "Validates", C:worker-plan hunk-level slice), at Seam 1: hunk IDs exist in the
// state and are used once; `files` and `hunks` are not mixed (a `notIncluded[].hunks` entry
// counts as `hunks`); identical hunks (same identity key) share one placement; a
// `notIncluded` ID belongs to the entry's path; `groups[].files[].hunks` counts the path's
// hunks in the group.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

let validatePlan;
beforeEach(async () => {
  ({ validatePlan } = await loadLib('plan-validator'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`);
}

// A repo where `f.txt` has three separate hunks (lines 1, 15 and 30 edited) and `g.txt` one;
// a `plan` run holds the lock.
async function threeHunkRun(t) {
  const c = createCase(t);
  const lines = numbered(30);
  c.writeFile('f.txt', lines.join(''));
  c.writeFile('g.txt', 'one\n');
  c.git(['add', '--', 'f.txt', 'g.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[14] = 'middle\n';
  edited[29] = 'last\n';
  c.writeFile('f.txt', edited.join(''));
  c.writeFile('g.txt', 'one\nmore\n');
  return planned(c);
}

// A repo where `f.txt` holds the same edit twice (identical hunks) and one other edit.
async function identicalHunkRun(t) {
  const c = createCase(t);
  const block = ['a\n', 'b\n', 'c\n', 'old\n', 'd\n', 'e\n', 'f\n'];
  const filler = numbered(10);
  c.writeFile('f.txt', [...block, ...filler, ...block, ...filler].join(''));
  c.git(['add', '--', 'f.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const edit = (lines) => lines.map((line) => (line === 'old\n' ? 'new\n' : line));
  const tail = [...filler];
  tail[9] = 'ten\n';
  c.writeFile('f.txt', [...edit(block), ...filler, ...edit(block), ...tail].join(''));
  return planned(c);
}

async function planned(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  const { planId, runDir } = result.json;
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return { c, planId, runDir, units: state.units };
}

function storedState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

async function check(c, planId, runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
  return runCommit(c, ['check', '--plan', planId]);
}

function group(header, hunks) {
  return { header, body: null, files: [], hunks, reason: header };
}

test('a group holding two of a file\'s three hunks → files[].hunks: 2', async (t) => {
  const { c, planId, runDir, units } = await threeHunkRun(t);
  assert.deepEqual(units.map((unit) => [unit.id, unit.path]), [['h1', 'f.txt'], ['h2', 'f.txt'], ['h3', 'f.txt'], ['h4', 'g.txt']]);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: top and g', ['h1', 'h4', 'h3'])],
    notIncluded: [{ path: 'f.txt', hunks: ['h2'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.groups, [{
    n: 1,
    header: 'feat: top and g',
    body: null,
    fileCount: 2,
    files: [
      { path: 'f.txt', status: 'M', new: false, hunks: 2 },
      { path: 'g.txt', status: 'M', new: false, hunks: 1 },
    ],
    newFiles: [],
  }]);
  assert.deepEqual(storedState(runDir).groups.map(({ n, units: ids }) => ({ n, ids })), [{ n: 1, ids: ['h1', 'h4', 'h3'] }]);
  // INT-02 routes only whole-file groups into `commit --all`: a hunk-level plan stops at its
  // validated groups, nothing committed, the run kept.
  assert.equal(checked.json.commits, undefined);
  assert.equal(c.git(['diff', '--name-only']), 'f.txt\ng.txt\n');
});

test('an unknown ID and an ID used twice → one error each with the group number', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: f', ['h1', 'h2', 'h9']), group('feat: rest', ['h2', 'h3', 'h4'])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: 'h9 is not a hunk ID of this run' },
    { group: 2, reason: 'h2 (f.txt) is in group 1 and group 2; place it once' },
  ]);
  assert.equal(Object.hasOwn(storedState(runDir), 'groups'), false);
});

test('an ID named twice in one group → "in group 1 twice"', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: all', ['h1', 'h2', 'h3', 'h4', 'h1'])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [{ group: 1, reason: 'h1 (f.txt) is in group 1 twice; place it once' }]);
});

const MIXED = { group: null, reason: '`files` and `hunks` are mixed; use hunk IDs everywhere or paths everywhere' };

test('files and hunks mixed across groups → error', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: f', ['h1', 'h2', 'h3']), { header: 'feat: g', body: null, files: ['g.txt'], hunks: [] }],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [MIXED]);
});

test('files in a group and IDs in notIncluded[].hunks → mixed', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: g', body: null, files: ['g.txt'], hunks: [] }],
    notIncluded: [{ path: 'f.txt', hunks: ['h1', 'h2', 'h3'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [MIXED]);
});

test('hunks in groups and a whole path in notIncluded (hunks: null) are not mixed', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: f', ['h1', 'h2', 'h3'])],
    notIncluded: [{ path: 'g.txt', hunks: null, reason: 'later' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
});

// `f.txt` in `identicalHunkRun`: h1 and h2 are the same edit (one identity key), h3 another.
async function identicalIds(t) {
  const run = await identicalHunkRun(t);
  const [h1, h2, h3] = run.units;
  assert.deepEqual([h1.id, h2.id, h3.id], ['h1', 'h2', 'h3']);
  assert.equal(h1.identityKey, h2.identityKey);
  assert.notEqual(h1.identityKey, h3.identityKey);
  return run;
}

const IDENTICAL = { group: null, reason: 'h1 and h2 are identical; place them together' };

test('identical hunks split across groups → "h1 and h2 are identical; place them together"', async (t) => {
  const { c, planId, runDir } = await identicalIds(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: one', ['h1', 'h3']), group('feat: two', ['h2'])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [IDENTICAL]);
});

test('identical hunks with one in notIncluded → the same error', async (t) => {
  const { c, planId, runDir } = await identicalIds(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: one', ['h1', 'h3'])],
    notIncluded: [{ path: 'f.txt', hunks: ['h2'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [IDENTICAL]);
});

test('identical hunks both in one group → valid', async (t) => {
  const { c, planId, runDir } = await identicalIds(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: one', ['h2', 'h1'])],
    notIncluded: [{ path: 'f.txt', hunks: ['h3'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.groups[0].files, [{ path: 'f.txt', status: 'M', new: false, hunks: 2 }]);
});

test('a notIncluded ID whose unit has another path than the entry → error', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: f', ['h1', 'h2', 'h3'])],
    notIncluded: [{ path: 'f.txt', hunks: ['h4'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [{ group: null, reason: 'h4 is a hunk of g.txt, not of f.txt' }]);
});

test('an ID named twice in one notIncluded entry → "in notIncluded twice"', async (t) => {
  const { c, planId, runDir } = await threeHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: g', ['h4'])],
    notIncluded: [{ path: 'f.txt', hunks: ['h1', 'h2', 'h3', 'h3'], reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [{ group: null, reason: 'h3 (f.txt) is in notIncluded twice; place it once' }]);
});

test('an ID in a group and its whole path in notIncluded (hunks: null) → one error, not also identical', async (t) => {
  const { c, planId, runDir } = await identicalIds(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: one', ['h1', 'h3'])],
    notIncluded: [{ path: 'f.txt', hunks: null, reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [{ group: null, reason: 'f.txt is in group 1 and notIncluded; place it once' }]);
});

test('validatePlan: three identical hunks in two places → one error naming all three', () => {
  const units = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => ({
    id, path: 'f.txt', oldPath: null, status: 'M', identityKey: id === 'h2' || id === 'h4' ? id : 'same',
  }));
  const values = {
    types: ['feat'], scope: 'forbidden', maxSubjectLength: 72, subjectCase: 'lower', body: 'forbidden', scanIgnore: [],
  };
  const plan = { groups: [{ header: 'feat: x', hunks: ['h1', 'h2', 'h3', 'h4'] }], notIncluded: [{ path: 'f.txt', hunks: ['h5'] }] };

  const result = validatePlan(Buffer.from(JSON.stringify(plan)), { mode: 'split', units, config: { values } });

  assert.deepEqual(result.errors, [{ group: null, reason: 'h1, h3 and h5 are identical; place them together' }]);
});
