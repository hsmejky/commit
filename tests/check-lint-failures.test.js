'use strict';

// RUN-16 (docs/roadmap/09-runs.md): the lint-failure counter ends the worker's retries
// (C:check "Lint failure", Q18, Q20, M15 `onLintFailure`). The first failure of a worker plan
// since the last `plan --hunks` is a plain exit 2 with no `reply`; the second, or the first
// with `source: user`, carries a `reply`: an interactive `lintFailed` handback that keeps the
// run, or, with `--no-user`, a `failed` reply after the lock and the folder are gone. The
// handback's answer set (`retry`/`edit`/`no`, none of `edit` for a shape-only failure) is
// RPL's, not asserted here.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const LINT_FAILED_QUESTION = 'Lint failed. Let a new worker fix it, or stop? To dictate the message, type it under Other.';

let onLintFailure;
beforeEach(async () => {
  ({ onLintFailure } = await loadLib('run-policy'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with `src/a.js` committed, then edited, and a `plan` run holding the lock.
async function plannedRun(t, planArgs = ['plan']) {
  const c = createCase(t);
  c.writeFile('src/a.js', 'one\n');
  c.git(['add', '--', 'src/a.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('src/a.js', 'one\nmore\n');
  const planned = await runCommit(c, planArgs);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function statePath(runDir) {
  return path.join(runDir, 'state.json');
}

function storedState(runDir) {
  return JSON.parse(fs.readFileSync(statePath(runDir), 'utf8'));
}

// A plan that places nothing: one "not placed" lint error.
function unplaced(source = 'worker') {
  return JSON.stringify({ version: 1, source, groups: [], notIncluded: [] });
}

async function check(c, planId, runDir, bytes) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), bytes);
  return runCommit(c, ['check', '--plan', planId]);
}

function assertPlainLintFailure(checked) {
  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.error.kind, 'lint');
  assert.equal(Object.hasOwn(checked.json, 'reply'), false, 'the first failure carries no reply');
}

function assertLintFailedHandback(checked, planId) {
  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.error.kind, 'lint');
  const { reply } = checked.json;
  assert.equal(reply.status, 'handback');
  assert.equal(reply.planId, planId);
  assert.equal(reply.handback.kind, 'lintFailed');
  assert.equal(reply.handback.question, LINT_FAILED_QUESTION);
  assert.equal(reply.text.split('\n')[0], LINT_FAILED_QUESTION);
  for (const error of checked.json.errors) assert.ok(reply.text.includes(error.reason), reply.text);
}

test('onLintFailure: the first failure of a worker plan → fix', () => {
  assert.equal(onLintFailure({}, 'worker', 'plan'), 'fix');
  assert.equal(onLintFailure({ lintFailures: 0 }, 'worker', 'plan'), 'fix');
  assert.equal(onLintFailure({ lintFailures: 0 }, 'worker', 'shape'), 'fix');
});

test('onLintFailure: the second failure since the last plan --hunks → lintFailed', () => {
  assert.equal(onLintFailure({ lintFailures: 1 }, 'worker', 'plan'), 'lintFailed');
  assert.equal(onLintFailure({ lintFailures: 1 }, 'worker', 'shape'), 'lintFailed');
});

test('onLintFailure: the first failure with source user → lintFailed', () => {
  assert.equal(onLintFailure({ lintFailures: 0 }, 'user', 'plan'), 'lintFailed');
  assert.equal(onLintFailure({}, 'user', 'plan'), 'lintFailed');
});

test('two bad check calls in a row → exit 2, then the lintFailed handback; the run is kept', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  assert.equal(storedState(runDir).lintFailures, 0, 'the in-process plan --hunks resets the counter');

  const first = await check(c, planId, runDir, unplaced());
  assertPlainLintFailure(first);
  assert.equal(storedState(runDir).lintFailures, 1);

  const second = await check(c, planId, runDir, unplaced());
  assertLintFailedHandback(second, planId);
  assert.equal(storedState(runDir).lintFailures, 2);
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), true, 'the run lock is kept');
  assert.equal(fs.existsSync(runDir), true, 'the run folder is kept');
});

test('check honours a lint counter reset to 0, as the separate plan --hunks call leaves it', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);

  assertPlainLintFailure(await check(c, planId, runDir, unplaced()));
  // The separate `plan --hunks` call and its reset are INT-12's own (C:plan-hunks, C:plan
  // step 8); this writes only the counter's resulting value to prove `check` treats it as a
  // fresh start, not that `plan --hunks` performs the reset.
  fs.writeFileSync(statePath(runDir), `${JSON.stringify({ ...storedState(runDir), lintFailures: 0 })}\n`);
  assertPlainLintFailure(await check(c, planId, runDir, unplaced()));
});

test('a source: user plan with a lint error → lintFailed on the first failure', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);

  assertLintFailedHandback(await check(c, planId, runDir, unplaced('user')), planId);
});

// Medium 2 (review-RUN-16): a shape error elsewhere in the plan must not drop a valid
// `source: "user"` (Q20: dictated text is never rewritten unseen), even though the failure's
// own `kind` stays `shape`.
test('a source: user plan with a shape error elsewhere → lintFailed on the first failure', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);

  const bytes = JSON.stringify({
    version: 1,
    source: 'user',
    groups: [],
    notIncluded: [{ path: 'src/a.js', hunks: 'not-an-array' }],
  });
  const result = await check(c, planId, runDir, bytes);
  assertLintFailedHandback(result, planId);
  assert.match(result.json.errors[0].reason, /notIncluded\[0\]\.hunks must be null or an array of hunk IDs/);
});

test('a worker plan that is not valid JSON, twice → a lintFailed ending', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);

  assertPlainLintFailure(await check(c, planId, runDir, '{ not json'));
  const second = await check(c, planId, runDir, '{ not json');
  assertLintFailedHandback(second, planId);
  assert.equal(second.json.errors.length, 1);
  assert.match(second.json.errors[0].reason, /is not valid JSON/);
  assert.deepEqual(Object.keys(second.json.errors[0]).sort(), ['group', 'reason'], 'the shape marker stays internal');
});

test('--no-user and a second failure → the lock and the folder are gone, the next plan starts fresh', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, ['plan', '--split', '--no-user']);

  assertPlainLintFailure(await check(c, planId, runDir, unplaced()));
  const second = await check(c, planId, runDir, unplaced());

  assert.equal(second.exitCode, 2, detail(second));
  assert.equal(second.json.error.kind, 'lint');
  assert.equal(second.json.reply.status, 'failed');
  assert.equal(second.json.reply.handback, null);
  for (const error of second.json.errors) assert.ok(second.json.reply.text.includes(error.reason), second.json.reply.text);
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is deleted');

  const next = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(next.exitCode, 0, detail(next));
  assert.notEqual(next.json.planId, planId);
});
