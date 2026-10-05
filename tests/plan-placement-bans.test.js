'use strict';

// PLN-04 (docs/roadmap/08-plan-validation.md): `split`'s placement bans and `notIncluded`
// extras/notices (C:check "Validates", `notIncluded`, `notices`), at M14 `validatePlan`
// directly. These are in-process EXTRAS only (testing-seams.md:84-85: M14 is tested through
// Seam 1): the Seam-1 `check --plan` subprocess cases for all five roadmap ACs live in
// tests/plan-placement-bans-seam1.test.js. A unit with a scan hit is banned from a group
// (`files` and `hunks` placement both call the same `banScanHits`); `collapsed`,
// `stagedExcluded`, `dirtySubmodules`, `embeddedRepos` and `notUtf8` each become their own
// `notIncluded` extra; a left-out scan hit and an `indexOnly` path each become a notice; a
// worker `notIncluded` entry naming a staged-new unit (`stagedNew`) gets the unstaging note,
// with the `.gitignore` clause when `ignored`, only when the plan has at least one group
// (C:check "Unstaging note").

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { Q6_DEFAULT_VALUES } = require('./helpers/q6-defaults.js');

let validatePlan;
beforeEach(async () => {
  ({ validatePlan } = await loadLib('plan-validator'));
});

function split(units, extra = {}) {
  return { mode: 'split', units, config: { values: Q6_DEFAULT_VALUES }, ...extra };
}

function bytes(plan) {
  return Buffer.from(JSON.stringify(plan));
}

// --- Placement ban: a scan-hit unit is never valid in a group ----------------------------

test('a scan-hit unit placed in a group (files): "h4 has scan hit `github-token`; move it to notIncluded"', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: ['github-token'] }, scanLines: { h4: [14] } });
  const plan = { groups: [{ header: 'feat: x', files: ['src/b.js'] }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ group: 1, reason: 'h4 has scan hit `github-token`; move it to notIncluded' }]);
});

test('a scan-hit unit placed in a group (hunks): the same ban', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: ['github-token'] }, scanLines: { h4: [14] } });
  const plan = { groups: [{ header: 'feat: x', hunks: ['h4'] }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ group: 1, reason: 'h4 has scan hit `github-token`; move it to notIncluded' }]);
});

test('a scan-hit unit left out in notIncluded: a notice with its line, no error', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: ['github-token'] }, scanLines: { h4: [14] } });
  const plan = { groups: [], notIncluded: [{ path: 'src/b.js', hunks: null }] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [{ path: 'src/b.js', hunks: null }]);
  assert.deepEqual(result.notices, ['src/b.js:14 github-token left out']);
});

test('two hits of the same pattern on one unit: one notice per line, no duplicate', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: ['github-token', 'github-token'] }, scanLines: { h4: [14, 20] } });
  const plan = { groups: [], notIncluded: [{ path: 'src/b.js', hunks: null }] };

  const result = validatePlan(bytes(plan), runState);

  assert.deepEqual(result.notices, ['src/b.js:14 github-token left out', 'src/b.js:20 github-token left out']);
});

test('a duplicated (path, line, pattern) hit entry produces only one notice (dedupe)', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: ['github-token', 'github-token'] }, scanLines: { h4: [14, 14] } });
  const plan = { groups: [], notIncluded: [{ path: 'src/b.js', hunks: null }] };

  const result = validatePlan(bytes(plan), runState);

  assert.deepEqual(result.notices, ['src/b.js:14 github-token left out']);
});

test('a "skipped" scan entry (over the 1 MB scan limit) is never a hit and never banned', () => {
  const units = [{ id: 'h4', path: 'src/b.js', status: 'M' }];
  const runState = split(units, { scanned: { h4: 'skipped' } });
  const plan = { groups: [{ header: 'feat: x', files: ['src/b.js'] }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, []);
  assert.deepEqual(result.notices, []);
});

test('a collapsed directory placed in a group is rejected as "not a change" (PLN-02)', () => {
  const runState = split([], { collapsed: [{ dir: 'dist', count: 412, bytes: 999 }] });
  const plan = { groups: [{ header: 'feat: x', files: ['dist'] }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ group: 1, reason: 'dist is not a change' }]);
});

test('a dirtySubmodules path placed in a group is rejected as "not a change" (PLN-02)', () => {
  const runState = split([], { dirtySubmodules: ['libs/x'] });
  const plan = { groups: [{ header: 'feat: x', files: ['libs/x'] }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ group: 1, reason: 'libs/x is not a change' }]);
});

// --- notIncluded extras: automatic exclusions state.json already recorded ----------------

test('a collapsed directory becomes a notIncluded extra', () => {
  const runState = split([], { collapsed: [{ dir: 'dist', count: 412, bytes: 999 }] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'dist', hunks: null, reason: '412 untracked files in dist/ — add to .gitignore or commit by hand' },
  ]);
});

test('a hidden staged exclusion gets the unstaging note when the plan has a group', () => {
  const runState = split([], { stagedExcluded: [{ path: '.env.local', reason: 'hidden' }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [{
    path: '.env.local',
    hunks: null,
    reason: '.env.local was staged but is hidden — commit by hand; committing this plan unstages it',
  }]);
});

// Q11 (q11-atomic-commits-by-functionality.md:75-76): a collapsed staged directory's reason
// uses plural "them" (distinct from a single hidden path's singular "it" above).
test('a collapsed staged exclusion gets the unstaging note with plural "them" (Q11)', () => {
  const runState = split([], { stagedExcluded: [{ dir: 'build', count: 7, reason: 'collapsed' }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [{
    path: 'build',
    hunks: null,
    reason: '7 staged new files in build/ — commit by hand; committing this plan unstages them',
  }]);
});

test('...with zero groups, no unstaging note on a stagedExcluded entry at all', () => {
  const runState = split([], { stagedExcluded: [{ path: '.env.local', reason: 'hidden' }] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: '.env.local', hunks: null, reason: '.env.local was staged but is hidden — commit by hand' },
  ]);
});

test('a dirty submodule becomes a notIncluded extra', () => {
  const runState = split([], { dirtySubmodules: ['libs/x'] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'libs/x', hunks: null, reason: 'libs/x has uncommitted changes inside — commit inside the submodule first' },
  ]);
});

test('an embedded repository becomes a notIncluded extra', () => {
  const runState = split([], { embeddedRepos: ['nested'] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'nested', hunks: null, reason: 'nested is an embedded git repository — add it as a submodule by hand' },
  ]);
});

test('a non-UTF-8 path becomes a notIncluded extra', () => {
  const runState = split([], { notUtf8: ['src/\\xFF.js'] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'src/\\xFF.js', hunks: null, reason: 'path is not UTF-8 — commit by hand' },
  ]);
});

// --- Worker's own notIncluded entries: unstaging note for a staged-new unit --------------

test('a worker notIncluded entry naming a gitignored staged-new unit gets the note with the .gitignore clause', () => {
  const units = [{ id: 'u1', path: 'new.txt', status: 'A' }];
  const runState = split(units, { stagedNew: [{ path: 'new.txt', ignored: true }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [{ path: 'new.txt', reason: 'leaving out for now' }] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [{
    path: 'new.txt',
    reason: 'leaving out for now; committing this plan unstages it and .gitignore then hides it from `git status`',
  }]);
});

test('...same entry, but a non-ignored staged-new unit gets the note without the .gitignore clause', () => {
  const units = [{ id: 'u1', path: 'new.txt', status: 'A' }];
  const runState = split(units, { stagedNew: [{ path: 'new.txt', ignored: false }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [{ path: 'new.txt', reason: 'leaving out for now' }] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'new.txt', reason: 'leaving out for now; committing this plan unstages it' },
  ]);
});

test('a hunk-level worker notIncluded entry (hunks array, not null) naming a staged-new unit also gets the note', () => {
  const units = [{ id: 'u1', path: 'new.txt', status: 'A' }];
  const runState = split(units, { stagedNew: [{ path: 'new.txt', ignored: false }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [{ path: 'new.txt', hunks: ['u1'], reason: 'leaving out for now' }] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [
    { path: 'new.txt', hunks: ['u1'], reason: 'leaving out for now; committing this plan unstages it' },
  ]);
});

test('...with zero groups in the plan, no unstaging note at all', () => {
  const units = [{ id: 'u1', path: 'new.txt', status: 'A' }];
  const runState = split(units, { stagedNew: [{ path: 'new.txt', ignored: true }] });
  const plan = { groups: [], notIncluded: [{ path: 'new.txt', reason: 'leaving out for now' }] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notIncluded, [{ path: 'new.txt', reason: 'leaving out for now' }]);
});

// --- Notices: an indexOnly path, only when the plan has a group --------------------------

test('an indexOnly path becomes a notice when the plan has a group', () => {
  const runState = split([], { indexOnly: [{ path: 'x', blob: 'abc123', ignored: false }] });
  const plan = { groups: [{ header: 'feat: x' }], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notices, [
    'x: the staged version differs from your working tree; committing this plan discards it — recover with `git cat-file -p abc123`',
  ]);
});

test('...with zero groups in the plan, no indexOnly notice', () => {
  const runState = split([], { indexOnly: [{ path: 'x', blob: 'abc123', ignored: false }] });
  const plan = { groups: [], notIncluded: [] };

  const result = validatePlan(bytes(plan), runState);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notices, []);
});
