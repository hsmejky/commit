'use strict';

// INT-07 (docs/roadmap/12-integration.md): a first lint failure goes back to the worker, at
// Seam 1 (C:check "Lint failure", C:cli-and-exit-codes `lint`, Q18, stories 122 and 127).
// `check` with a message or placement error in a worker plan exits 2 `lint` with the
// `errors` array and no `reply` (C:check's lint example, "first failure, no reply", EXE-01
// item 4); the run is kept (lock and folder); lint runs over every group before any commit,
// so a plan whose second group fails commits nothing; and a corrected `plan.groups.json`
// then commits through the same run. The second-failure `lintFailed` ending is RUN-16's
// (tests/check-lint-failures.test.js).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const GOOD_HEADER = 'feat: change both files';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with `a.txt` and `b.txt` committed; `change(c)` edits the working tree, then a
// `plan --split` run holds the lock. `planArgs` adds extra flags to that `plan` call (e.g.
// `--no-user`).
async function plannedRun(t, change, planArgs = []) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  change(c);
  const head = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split', ...planArgs]);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, head, planId, runDir };
}

function modifyBoth(c) {
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
}

function renameAToC(c) {
  fs.renameSync(path.join(c.repoDir, 'a.txt'), path.join(c.repoDir, 'c.txt'));
}

function group(header, files) {
  return { header, body: null, files, hunks: [], reason: 'test' };
}

async function check(c, planId, runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'),
    JSON.stringify({ version: 1, source: 'worker', groups, notIncluded: [] }));
  return runCommit(c, ['check', '--plan', planId]);
}

function unitId(runDir, unitPath) {
  const { units } = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const matching = units.filter((unit) => unit.path === unitPath);
  assert.equal(matching.length, 1, JSON.stringify(units));
  return matching[0].id;
}

// The first failure: exit 2 `lint`, exactly `errors`, no `reply`; nothing committed, the
// real index untouched, and the run kept: the lock still holds this planId, the folder stays.
function assertFirstFailure({ c, head, planId, runDir }, checked, errors) {
  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.ok, false);
  assert.deepEqual(checked.json.error, { kind: 'lint', message: `${errors.length} error${errors.length === 1 ? '' : 's'}` });
  assert.deepEqual(checked.json.errors, errors);
  assert.equal(Object.hasOwn(checked.json, 'reply'), false, 'the first failure carries no reply');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the real index is untouched');
  const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(runDir), 'lock'), 'utf8'));
  assert.equal(lock.planId, planId, 'the lock still holds this run');
  assert.equal(fs.existsSync(path.join(runDir, 'state.json')), true, 'the run folder is kept');
}

// The corrected plan commits through the same run: one commit with `header`, holding `paths`,
// a `committed` reply, the lock and the folder gone.
function assertCorrectedCommit({ c, head, runDir }, checked, header, paths) {
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed');
  const shas = c.git(['rev-list', `${head}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'HEAD gains exactly one commit');
  assert.deepEqual(checked.json.commits, [{ n: 1, sha: shas[0], header }]);
  assert.equal(c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', shas[0]]), paths.map((p) => `${p}\n`).join(''));
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the lock is gone');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
}

test('Seam 1: a header with an unknown type → exit 2 lint naming group 1, no reply, the run kept; the corrected plan commits through the same run', async (t) => {
  const run = await plannedRun(t, modifyBoth);

  const failed = await check(run.c, run.planId, run.runDir, [group('wip: change both files', ['a.txt', 'b.txt'])]);
  assertFirstFailure(run, failed, [{ group: 1, reason: "type 'wip' not in types" }]);

  const corrected = await check(run.c, run.planId, run.runDir, [group(GOOD_HEADER, ['a.txt', 'b.txt'])]);
  assertCorrectedCommit(run, corrected, GOOD_HEADER, ['a.txt', 'b.txt']);
});

test('an unplaced unit → an error naming its ID and path, no reply, the run kept; placing it commits through the same run', async (t) => {
  const run = await plannedRun(t, modifyBoth);
  const bId = unitId(run.runDir, 'b.txt');

  const failed = await check(run.c, run.planId, run.runDir, [group(GOOD_HEADER, ['a.txt'])]);
  assertFirstFailure(run, failed, [
    { group: null, reason: `${bId} (b.txt) not placed; put it in a group or in notIncluded` },
  ]);

  const corrected = await check(run.c, run.planId, run.runDir, [group(GOOD_HEADER, ['a.txt', 'b.txt'])]);
  assertCorrectedCommit(run, corrected, GOOD_HEADER, ['a.txt', 'b.txt']);
});

test('the old path of a rename → the "use the new path" error, no reply, the run kept; the new path commits through the same run', async (t) => {
  const run = await plannedRun(t, renameAToC);
  const header = 'refactor: rename a to c';

  const failed = await check(run.c, run.planId, run.runDir, [group(header, ['a.txt'])]);
  assertFirstFailure(run, failed, [{ group: 1, reason: 'use the new path c.txt for the rename of a.txt' }]);

  const corrected = await check(run.c, run.planId, run.runDir, [group(header, ['c.txt'])]);
  assertCorrectedCommit(run, corrected, header, ['a.txt', 'c.txt']);
});

// `--no-user`: a 2-group plan runs without a human to answer a confirm handback (RUN-18),
// so this stays a lint-only story regardless of how many groups a run would otherwise stop
// to confirm.
test('story 122: lint runs over every group first; a plan whose second group fails commits nothing, and the corrected plan then commits', async (t) => {
  const run = await plannedRun(t, modifyBoth, ['--no-user']);

  const failed = await check(run.c, run.planId, run.runDir, [
    group('feat: change a', ['a.txt']),
    group('wip: change b', ['b.txt']),
  ]);
  assertFirstFailure(run, failed, [{ group: 2, reason: "type 'wip' not in types" }]);
  assert.equal(run.c.git(['rev-list', '--count', 'HEAD']).trim(), '1', 'group 1 was not committed either');

  const corrected = await check(run.c, run.planId, run.runDir, [group(GOOD_HEADER, ['a.txt', 'b.txt'])]);
  assertCorrectedCommit(run, corrected, GOOD_HEADER, ['a.txt', 'b.txt']);
});

test('two errors in one check call → both named, the message is "2 errors" (C:check\'s example); the corrected plan commits through the same run', async (t) => {
  const run = await plannedRun(t, modifyBoth);
  const bId = unitId(run.runDir, 'b.txt');

  const failed = await check(run.c, run.planId, run.runDir, [group('wip: change a', ['a.txt'])]);
  assertFirstFailure(run, failed, [
    { group: 1, reason: "type 'wip' not in types" },
    { group: null, reason: `${bId} (b.txt) not placed; put it in a group or in notIncluded` },
  ]);

  const corrected = await check(run.c, run.planId, run.runDir, [group(GOOD_HEADER, ['a.txt', 'b.txt'])]);
  assertCorrectedCommit(run, corrected, GOOD_HEADER, ['a.txt', 'b.txt']);
});
