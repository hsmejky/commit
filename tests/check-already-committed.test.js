'use strict';

// RUN-19 (docs/roadmap/09-runs.md): M15 `checkGate`. Once a budget stop (EXE-16) has left any
// group of the run committed, `check` refuses with `already-committed` (exit 1 `usage`)
// instead of clearing the stored groups and validating a fresh plan over them. The committed
// group, the run's lock and its folder all stay.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

let checkGate;
beforeEach(async () => {
  ({ checkGate } = await loadLib('run-policy'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

test('checkGate: no stored groups → never refused', () => {
  assert.equal(checkGate({}), null);
});

test('checkGate: every stored group uncommitted → never refused', () => {
  assert.equal(checkGate({ groups: [{ committed: false }, { committed: false }] }), null);
});

test('checkGate: any committed group → already-committed', () => {
  const gated = checkGate({ groups: [{ committed: true }, { committed: false }] });
  assert.equal(gated.refusal.code, 'already-committed');
  assert.equal(typeof gated.refusal.message, 'string');
  assert.ok(gated.refusal.message.length > 0);
});

// Two committed files, each modified, a `plan --split` run, and two stored groups, one per
// file, in a, b order, as `check` stores them (same shape commit-all-hook-rewrite.test.js's
// `twoGroupRun` builds).
async function twoGroupRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: `feat: change ${name}`,
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed };
}

function reflogCount(c) {
  const out = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim();
  return out === '' ? 0 : out.split('\n').length;
}

// A schedule whose single step holds once this call's own next `git commit` has landed (same
// technique as commit-all.test.js's `scheduleAfterNextCommit`): the clock reads `elapsedMs`
// (past EXE-16's 480 s floor) only after group 1 commits, so group 2 stops on the budget.
function scheduleAfterNextCommit(c, elapsedMs) {
  const schedulePath = path.join(c.root, 'schedule.json');
  const atLeast = reflogCount(c) + 1;
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast }, elapsedMs },
  ]));
  return schedulePath;
}

function runCommitAtElapsed(c, planId, elapsedMs) {
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleAfterNextCommit(c, elapsedMs) },
  });
}

function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

test('after a budget stop that committed group 1, check --plan <id> refuses already-committed, and the committed group stays', async (t) => {
  const { c, planId, runDir, seed } = await twoGroupRun(t);
  const lockPath = path.join(path.dirname(runDir), 'lock');
  const callLockPath = path.join(runDir, 'call.lock');

  const stopped = await runCommitAtElapsed(c, planId, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2], detail(stopped));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed by the budget stop');
  assert.equal(readState(runDir).groups[0].committed, true);
  assert.equal(readState(runDir).groups[1].committed, false);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 1, detail(checked));
  assert.equal(checked.json.ok, false, detail(checked));
  assert.equal(checked.json.error.kind, 'usage', detail(checked));
  assert.match(checked.json.error.message, /already committed/);

  // The committed group stays: no new commit, the SHA unchanged, and its `committed` flag
  // untouched by the refused `check` (which must not clear `state.groups`).
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), shas[0], 'no new commit was made');
  const stateAfter = readState(runDir);
  assert.equal(stateAfter.groups[0].committed, true);
  assert.equal(stateAfter.groups[1].committed, false);

  // The run itself is kept (`usage` refusals keep the run); only this call's `call.lock` ends
  // with the call (M12 `run.close()`, RUN-04).
  assert.equal(fs.existsSync(lockPath), true, "the run's own lock is kept");
  assert.equal(fs.existsSync(runDir), true, 'the run folder is kept');
  assert.equal(fs.existsSync(callLockPath), false, 'call.lock is absent after the call ends');
});

// review-RUN-19 Testing finding 4: pins `checkGate`'s place after `openRun` (M12 `open`,
// RUN-04) in CHECK_STEPS -- a live foreign `call.lock` still refuses `busy` even with a
// committed group already present, so a gate moved ahead of `open` would not pass this.
test('check --plan <id> with a committed group 1 but a live foreign call.lock → busy, not already-committed', async (t) => {
  const { c, planId, runDir } = await twoGroupRun(t);
  const callLockPath = path.join(runDir, 'call.lock');

  const stopped = await runCommitAtElapsed(c, planId, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.equal(readState(runDir).groups[0].committed, true);
  assert.equal(readState(runDir).groups[1].committed, false);

  fs.writeFileSync(callLockPath, JSON.stringify({ pid: process.pid, host: os.hostname() }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 6, detail(checked));
  assert.equal(checked.json.ok, false, detail(checked));
  assert.equal(checked.json.error.kind, 'lock', detail(checked));
  assert.match(checked.json.error.message, /another \/commit call on this run is still running/);

  const stateAfter = readState(runDir);
  assert.equal(stateAfter.groups[0].committed, true);
  assert.equal(stateAfter.groups[1].committed, false);
  assert.equal(fs.existsSync(callLockPath), true, 'the live call.lock is kept, not replaced');
});
