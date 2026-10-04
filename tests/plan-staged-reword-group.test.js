'use strict';

// PLN-05 (docs/roadmap/08-plan-validation.md): `check` in `staged` and `reword` modes
// (C:check, C:worker-plan) requires exactly one group; the plan's own `files`, `hunks` and
// `notIncluded` are ignored and the group holds every stored unit implicitly; `newFiles`
// comes from unit status in `staged` (report only) and is always `[]` in `reword`; neither
// mode gets `split`'s own extras (collapsed directories, unstaging notes, `indexOnly`
// notices) — Seam 1 through the shipped entry point, plus the exactly-one-group rule on
// M14 `validatePlan` directly (zero and two groups, and `reword`'s forced `newFiles: []`).

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { Q6_DEFAULT_VALUES: DEFAULT_VALUES } = require('./helpers/q6-defaults.js');

let validatePlan;
beforeEach(async () => {
  ({ validatePlan } = await loadLib('plan-validator'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeWorkerPlan(runDir, value) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify(value));
}

function oneGroup(extra = {}) {
  return { version: 1, source: 'worker', groups: [{ header: 'feat: x', body: null, files: [], hunks: [], ...extra }], notIncluded: [] };
}

async function plan(c, flags) {
  const result = await runCommit(c, ['plan', ...flags]);
  assert.equal(result.exitCode, 0, detail(result));
  return { planId: result.json.planId, runDir: path.join(c.repoDir, '.commit-plan', result.json.planId) };
}

// --- `staged`: real `plan --staged` state, M14 `validatePlan` called directly -------------
//
// `check`'s success path goes straight on to `commit --all` in the same process (INT-02),
// and M16's execution for `staged` is not built yet (EXE-19/EXE-20) — a different roadmap
// slice. So these two read the real `state.json` a `plan --staged` run built (Seam 1) and
// call `validatePlan` on it directly, the same split PLN-01's own direct cases use.

function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

test('staged: a group naming only some files still holds every staged unit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  const { runDir } = await plan(c, ['--staged']);
  const bytes = Buffer.from(JSON.stringify(oneGroup({ files: ['a.txt'] })));

  const result = validatePlan(bytes, readState(runDir));

  assert.equal(result.ok, true);
  assert.deepEqual(result.groups[0].files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  assert.equal(result.groups[0].fileCount, 2);
  assert.deepEqual(result.notIncluded, []);
  assert.deepEqual(result.notices, []);
});

test('staged: a staged new file is listed in newFiles', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  c.git(['add', '--', 'a.txt', 'c.txt']);
  const { runDir } = await plan(c, ['--staged']);
  const bytes = Buffer.from(JSON.stringify(oneGroup()));

  const result = validatePlan(bytes, readState(runDir));

  assert.equal(result.ok, true);
  assert.deepEqual(result.groups[0].newFiles, ['c.txt']);
});

// --- Seam 1: staged group-count errors (end before M16, so no EXE-19/20 dependency) -------

for (const [label, groups] of [['zero groups', []], ['two groups', [{ header: 'feat: x', body: null, files: [], hunks: [] }, { header: 'feat: y', body: null, files: [], hunks: [] }]]]) {
  test(`staged: ${label} is exit 2 with group: null`, async (t) => {
    const c = createCase(t);
    seed(c, { 'a.txt': 'one\n' });
    c.writeFile('a.txt', 'one\nmore\n');
    c.git(['add', '--', 'a.txt']);
    const { planId, runDir } = await plan(c, ['--staged']);
    writeWorkerPlan(runDir, { version: 1, source: 'worker', groups, notIncluded: [] });

    const checked = await runCommit(c, ['check', '--plan', planId]);

    assert.equal(checked.exitCode, 2, detail(checked));
    assert.equal(checked.json.errors.length, 1);
    assert.equal(checked.json.errors[0].group, null);
    assert.match(checked.json.errors[0].reason, /`staged` needs exactly one group/);
  });
}

// `reword` has no Seam-1 case here: `check`'s success path goes straight on to `commit
// --all` in the same process (INT-02), and M16's execution for `reword` is not built yet
// (EXE-19/EXE-20) — a different roadmap slice. M14 is pure and mode-agnostic beyond its own
// validation, so `reword`'s rules are covered directly on `validatePlan` below instead.

// --- Direct validatePlan: the exactly-one-group rule and reword's forced newFiles ---------

const UNITS = Object.freeze([
  { id: 'h1', path: 'src/a.js', status: 'M' },
  { id: 'h2', path: 'docs/new.md', status: 'A' },
]);

function runState(mode) {
  return { mode, units: UNITS, config: { values: DEFAULT_VALUES } };
}

for (const mode of ['staged', 'reword']) {
  test(`validatePlan: ${mode} ignores the worker's files/hunks/notIncluded and holds every unit`, () => {
    const bytes = Buffer.from(JSON.stringify({
      groups: [{ header: 'feat: x', body: null, files: ['src/a.js'], hunks: [] }],
      notIncluded: [{ path: 'docs/new.md', hunks: null }],
    }));

    const result = validatePlan(bytes, runState(mode));

    assert.equal(result.ok, true);
    assert.deepEqual(result.stored[0].units, ['h1', 'h2']);
    assert.deepEqual(result.groups[0].files.map((f) => f.path).sort(), ['docs/new.md', 'src/a.js']);
    assert.deepEqual(result.notIncluded, []);
    if (mode === 'reword') assert.deepEqual(result.groups[0].newFiles, []);
    else assert.deepEqual(result.groups[0].newFiles, ['docs/new.md']);
  });

  for (const [label, groups] of [['zero', []], ['two', [{ header: 'feat: x' }, { header: 'feat: y' }]]]) {
    test(`validatePlan: ${mode} with ${label} groups is a lint error naming the mode`, () => {
      const bytes = Buffer.from(JSON.stringify({ groups, notIncluded: [] }));

      const result = validatePlan(bytes, runState(mode));

      assert.equal(result.ok, false);
      assert.deepEqual(result.errors, [{ group: null, reason: `\`${mode}\` needs exactly one group; got ${groups.length}` }]);
    });
  }
}
