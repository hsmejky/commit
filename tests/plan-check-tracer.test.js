'use strict';

// PLN-01 (docs/roadmap/08-plan-validation.md): the thin `check` workflow over M14
// `validatePlan` for a file-level worker plan, at Seam 1 (C:check, C:worker-plan): one group
// naming both modified files validates; a missing `plan.groups.json`, one that is not JSON,
// and JSON missing `groups` are each one lint error with `group: null` (exit 2); a failed
// `check` leaves no stored group in `state.json`. Plus the purity of M14 itself.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { assertPureSource } = require('./helpers/assert-pure-source.js');
// Q6 defaults (docs/decisions/q06-config-layers-and-keys.md), mirroring M4 `config.mjs`'s
// `DEFAULT_VALUES`: these direct `validatePlan` calls build their own runState (CFG-05).
const { Q6_DEFAULT_VALUES: DEFAULT_VALUES } = require('./helpers/q6-defaults.js');
// INT-27 (Q23): no heartbeat is set up in this case's Claude home, so `plan`'s guard notice
// carries into `check`'s own `notices`.
const GUARD_NOTICE = 'Guard hook did not run: `node` missing from the hook\'s PATH, plugin hooks '
  + 'disabled, or `disableAllHooks` set. Direct `git commit` is not blocked.';

let validatePlan;
beforeEach(async () => {
  ({ validatePlan } = await loadLib('plan-validator'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with two committed files, both modified, and a `plan` run holding the lock.
async function plannedRun(t, extra = {}) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  for (const [name, text] of Object.entries(extra)) c.writeFile(name, text);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function writeWorkerPlan(runDir, content) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), content);
}

function storedState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

function oneGroup(files) {
  return JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header: 'feat: change both files', body: null, files, hunks: [], reason: 'both' }],
    notIncluded: [],
  });
}

test('a plan with one group naming both modified files validates into groups[0]', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, oneGroup(['a.txt', 'b.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.ok, true);
  assert.deepEqual(checked.json.groups, [{
    n: 1,
    header: 'feat: change both files',
    body: null,
    fileCount: 2,
    files: [
      { path: 'a.txt', status: 'M', new: false, hunks: null },
      { path: 'b.txt', status: 'M', new: false, hunks: null },
    ],
    newFiles: [],
  }]);
  assert.deepEqual(checked.json.notIncluded, []);
  assert.deepEqual(checked.json.notices, [GUARD_NOTICE]);
  // INT-02: the stored group goes straight on to `commit --all` in the same process, so it
  // shows as the commit (both files, the planned header) and the run is released
  // (tests/first-end-to-end-commit.test.js covers that path in full).
  assert.deepEqual(checked.json.commits.map(({ n, header }) => ({ n, header })), [{ n: 1, header: 'feat: change both files' }]);
  assert.equal(c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'a.txt\nb.txt\n');
  assert.equal(fs.existsSync(runDir), false);
});

test('newFiles comes from the unit status: an untracked file in a group is new', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, { 'c.txt': 'three\n' });
  writeWorkerPlan(runDir, oneGroup(['c.txt', 'a.txt', 'b.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const [group] = checked.json.groups;
  assert.deepEqual(group.files[0], { path: 'c.txt', status: 'A', new: true, hunks: null });
  assert.deepEqual(group.newFiles, ['c.txt']);
  assert.equal(group.fileCount, 3);
});

for (const [label, content, reason] of [
  ['no plan.groups.json', null,
    'plan.groups.json is missing; write it in the run folder, then run check again'],
  ['plan.groups.json not valid JSON', '{ "groups": [',
    null],
  ['valid JSON missing groups', '{ "version": 1, "notIncluded": [] }',
    'plan.groups.json: `groups` must be an array'],
]) {
  test(`${label} → exit 2, one lint error with group: null`, async (t) => {
    const { c, planId, runDir } = await plannedRun(t);
    if (content !== null) writeWorkerPlan(runDir, content);

    const checked = await runCommit(c, ['check', '--plan', planId]);

    assert.equal(checked.exitCode, 2, detail(checked));
    assert.deepEqual(checked.json.error, { kind: 'lint', message: '1 error' });
    assert.equal(checked.json.errors.length, 1);
    assert.equal(checked.json.errors[0].group, null);
    if (reason !== null) assert.equal(checked.json.errors[0].reason, reason);
    else assert.match(checked.json.errors[0].reason, /^plan\.groups\.json is not valid JSON: /);
    assert.equal(checked.json.reply, undefined);
  });
}

test('after a failed check, no stored group remains in state.json', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  // A group stored as a passing `check` stores it, plus a prior confirm handback, so the
  // failing `check` has something to clear. Written by hand: a passing `check` now commits
  // its group and releases the run in the same process (INT-02), leaving nothing to clear.
  const beforeSecond = storedState(runDir);
  beforeSecond.groups = [{
    n: 1, units: beforeSecond.units.map((unit) => unit.id), header: 'feat: change both files', body: null, committed: false,
  }];
  beforeSecond.awaitingConfirm = true;
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(beforeSecond)}\n`);

  writeWorkerPlan(runDir, 'not json');
  const second = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(second.exitCode, 2, detail(second));
  const state = storedState(runDir);
  assert.equal(Object.hasOwn(state, 'groups'), false);
  assert.equal(Object.hasOwn(state, 'awaitingConfirm'), false);
});

test('check on a run that has ended is refused with lock', async (t) => {
  const { c, planId } = await plannedRun(t);
  await runCommit(c, ['release', '--plan', planId]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 6, detail(checked));
  assert.equal(checked.json.error.kind, 'lock');
});

// M14 is pure (docs/spec/modules.md), importing only M6 and M8 (PLN-06).
test('plan-validator.mjs is pure', () => {
  assertPureSource('plan-validator', { allowImports: ['./message-grammar.mjs', './scanner.mjs'] });
});

// PLN-06: M14 lints every message through M6's own `lint`, never a copy of its rules.
test('plan-validator.mjs imports lint from message-grammar.mjs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'scripts', 'lib', 'plan-validator.mjs'), 'utf8');
  assert.match(source, /import\s*\{[^}]*\blint\b[^}]*\}\s*from\s*'\.\/message-grammar\.mjs'/);
});

const UNITS = Object.freeze([
  { id: 'h1', path: 'src/a.js', status: 'M' },
  { id: 'h2', path: 'src/a.js', status: 'M' },
  { id: 'h3', path: 'docs/new.md', status: 'A' },
]);

test('validatePlan resolves a path to all of its units and stores them per group', () => {
  const bytes = Buffer.from(JSON.stringify({ groups: [{ header: 'feat: x', files: ['src/a.js', 'docs/new.md'] }] }));

  const result = validatePlan(bytes, { mode: 'split', units: UNITS, config: { values: DEFAULT_VALUES } });

  assert.equal(result.ok, true);
  assert.deepEqual(result.stored, [{ n: 1, units: ['h1', 'h2', 'h3'], header: 'feat: x', body: null, attribution: false }]);
  assert.deepEqual(result.groups[0].newFiles, ['docs/new.md']);
});

for (const [label, value, reason] of [
  ['a JSON array', '[]', 'plan.groups.json: expected a JSON object'],
  ['a group without a header', '{"groups":[{"files":[]}]}', 'plan.groups.json: groups[0].header must be a string'],
  ['a non-string path', '{"groups":[{"header":"feat: x","files":[1]}]}',
    'plan.groups.json: groups[0].files must be an array of paths'],
  // MSG-06: bytes that are not UTF-8 now fail through M6 `normalise`, whose own reason
  // ("message not UTF-8", C:message-grammar) replaces this file's generic wording.
  ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), 'message not UTF-8'],
]) {
  test(`validatePlan: ${label} is a shape error with group: null`, () => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

    const result = validatePlan(bytes, { mode: 'split', units: UNITS });

    assert.deepEqual(result, { ok: false, code: 'lint', kind: 'shape', source: undefined, errors: [{ group: null, reason }] });
  });
}
