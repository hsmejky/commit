'use strict';

// PLN-02 (docs/roadmap/08-plan-validation.md): completeness and path resolution in a `split`
// `check` (C:check "Validates", C:worker-plan file-level slice), at Seam 1: every unit is
// placed exactly once, in a group or in `notIncluded` (by ID or by a `hunks: null` path
// entry); every path in `files` and `notIncluded` is a real change; a rename is named by its
// new path only; zero groups is valid. Plus the same rules on M14 `validatePlan` directly.

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

// A repo with `src/a.js` and `src/c.js` committed; `change(c)` then edits the working tree,
// and a `plan` run holds the lock.
async function plannedRun(t, change) {
  const c = createCase(t);
  c.writeFile('src/a.js', 'one\n');
  c.writeFile('src/c.js', 'three\n');
  c.git(['add', '--', 'src/a.js', 'src/c.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  change(c);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function modifyBoth(c) {
  c.writeFile('src/a.js', 'one\nmore\n');
  c.writeFile('src/c.js', 'three\nmore\n');
}

function storedState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

function unitId(runDir, unitPath) {
  const units = storedState(runDir).units.filter((unit) => unit.path === unitPath);
  assert.equal(units.length, 1, JSON.stringify(units));
  return units[0].id;
}

async function check(c, planId, runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
  return runCommit(c, ['check', '--plan', planId]);
}

function group(header, files) {
  return { header, body: null, files, hunks: [], reason: header };
}

test('a unit in no group and not in notIncluded → exit 2, "<id> (<path>) not placed"', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, modifyBoth);
  const id = unitId(runDir, 'src/c.js');

  const checked = await check(c, planId, runDir, { groups: [group('feat: a', ['src/a.js'])], notIncluded: [] });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.error, { kind: 'lint', message: '1 error' });
  assert.deepEqual(checked.json.errors, [
    { group: null, reason: `${id} (src/c.js) not placed; put it in a group or in notIncluded` },
  ]);
  assert.equal(Object.hasOwn(storedState(runDir), 'groups'), false);
});

test('a path in two groups → an error naming it, with the second group number', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, modifyBoth);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: a', ['src/a.js', 'src/c.js']), group('feat: again', ['src/a.js'])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 2, reason: 'src/a.js is in group 1 and group 2; place it once' },
  ]);
});

test('a path in a group and in notIncluded → an error naming it', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, modifyBoth);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: a', ['src/a.js', 'src/c.js'])],
    notIncluded: [{ path: 'src/c.js', hunks: null, reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: null, reason: 'src/c.js is in group 1 and notIncluded; place it once' },
  ]);
});

test('a path that is not a change, in files or in notIncluded → an error each', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, modifyBoth);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: a', ['src/a.js', 'src/x.js'])],
    notIncluded: [{ path: 'src/c.js', hunks: null, reason: 'later' }, { path: 'README.md', hunks: null, reason: 'no' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.error, { kind: 'lint', message: '2 errors' });
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: 'src/x.js is not a change' },
    { group: null, reason: 'README.md is not a change' },
  ]);
});

function renameAToB(c) {
  fs.renameSync(path.join(c.repoDir, 'src', 'a.js'), path.join(c.repoDir, 'src', 'b.js'));
}

test('a rename named by its old path → "use the new path src/b.js for the rename of src/a.js"', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, renameAToB);

  const checked = await check(c, planId, runDir, { groups: [group('refactor: rename a', ['src/a.js'])], notIncluded: [] });

  assert.equal(checked.exitCode, 2, detail(checked));
  // The rename's unit gets no "not placed" error of its own: the rename error says where it goes.
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: 'use the new path src/b.js for the rename of src/a.js' },
  ]);
});

test('a rename named by its old path in notIncluded → the same error with group: null', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, renameAToB);

  const checked = await check(c, planId, runDir, {
    groups: [],
    notIncluded: [{ path: 'src/a.js', hunks: null, reason: 'later' }],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: null, reason: 'use the new path src/b.js for the rename of src/a.js' },
  ]);
});

test('a rename named by its new path validates as one R file', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, renameAToB);

  const checked = await check(c, planId, runDir, { groups: [group('refactor: rename a', ['src/b.js'])], notIncluded: [] });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.groups[0].files, [{ path: 'src/b.js', status: 'R', new: false, hunks: null }]);
  assert.deepEqual(checked.json.groups[0].newFiles, []);
});

test('all units in notIncluded, zero groups → ok: true, groups: []', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, modifyBoth);
  const notIncluded = [
    { path: 'src/a.js', hunks: null, reason: 'not part of the intent' },
    { path: 'src/c.js', hunks: null, reason: 'not part of the intent' },
  ];

  const checked = await check(c, planId, runDir, { groups: [], notIncluded });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.ok, true);
  assert.deepEqual(checked.json.groups, []);
  assert.deepEqual(checked.json.notIncluded, notIncluded);
  assert.deepEqual(storedState(runDir).groups, []);
});

// M14 directly, over a hand-built unit table.
const UNITS = Object.freeze([
  { id: 'h1', path: 'src/a.js', oldPath: null, status: 'M' },
  { id: 'h2', path: 'src/a.js', oldPath: null, status: 'M' },
  { id: 'h3', path: 'src/b.js', oldPath: 'src/old.js', status: 'R' },
  { id: 'h4', path: 'docs/new.md', oldPath: null, status: 'A' },
]);

function validate(plan) {
  return validatePlan(Buffer.from(JSON.stringify(plan)), { mode: 'split', units: UNITS });
}

// A plan naming IDs in `notIncluded[].hunks` is hunk-level (PLN-03: never mixed with `files`).
test('validatePlan: notIncluded by ID places single units', () => {
  const result = validate({
    groups: [{ header: 'feat: x', hunks: ['h3', 'h4'] }],
    notIncluded: [{ path: 'src/a.js', hunks: ['h1', 'h2'], reason: 'later' }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.stored, [{ n: 1, units: ['h3', 'h4'], header: 'feat: x', body: null }]);
});

test('validatePlan: one ID of a path left out names the other unit as not placed', () => {
  const result = validate({
    groups: [{ header: 'feat: x', hunks: ['h3', 'h4'] }],
    notIncluded: [{ path: 'src/a.js', hunks: ['h1'], reason: 'later' }],
  });

  assert.deepEqual(result.errors, [
    { group: null, reason: 'h2 (src/a.js) not placed; put it in a group or in notIncluded' },
  ]);
});

test('validatePlan: an ID in notIncluded that a group already holds, and an unknown ID', () => {
  const result = validate({
    groups: [{ header: 'feat: x', hunks: ['h1', 'h2', 'h3', 'h4'] }],
    notIncluded: [{ path: 'src/a.js', hunks: ['h2', 'h9'], reason: 'later' }],
  });

  assert.deepEqual(result.errors, [
    { group: null, reason: 'h2 (src/a.js) is in group 1 and notIncluded; place it once' },
    { group: null, reason: 'h9 is not a hunk ID of this run' },
  ]);
});

test('validatePlan: the same path twice in notIncluded', () => {
  const result = validate({
    groups: [{ header: 'feat: x', files: ['src/b.js', 'docs/new.md'] }],
    notIncluded: [{ path: 'src/a.js', reason: 'one' }, { path: 'src/a.js', hunks: null, reason: 'two' }],
  });

  assert.deepEqual(result.errors, [{ group: null, reason: 'src/a.js is in notIncluded twice; place it once' }]);
});

test('validatePlan: a path named twice in one group is placed once', () => {
  const result = validate({ groups: [{ header: 'feat: x', files: ['src/a.js', 'src/a.js', 'src/b.js', 'docs/new.md'] }] });

  assert.equal(result.ok, true);
  assert.equal(result.groups[0].fileCount, 3);
});

test('validatePlan: notIncluded[].hunks that is not null or an ID array is a shape error', () => {
  const result = validate({ groups: [], notIncluded: [{ path: 'src/a.js', hunks: 'h1' }] });

  assert.deepEqual(result, {
    ok: false,
    code: 'lint',
    errors: [{ group: null, reason: 'plan.groups.json: notIncluded[0].hunks must be null or an array of hunk IDs' }],
  });
});
