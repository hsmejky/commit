'use strict';

// RUN-12 (docs/roadmap/09-runs.md): `plan` has a 540-second deadline (M15 `deadline`,
// `cleanupDeadline`, docs/spec/modules-m14-m19.md; Q9, Q18). Past it `plan` ends as
// `timeout` (exit 5) and discards its provisional run, or releases it once it holds the lock;
// the reply's tree-state read then runs under `cleanupDeadline` (the call's start plus 580 s)
// and is not spawned past it. Seam 1 with the FND-05 stepping clock, plus M15's pure functions.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

let runPolicy;
let workflows;
beforeEach(async () => {
  runPolicy = await loadLib('run-policy');
  workflows = await loadLib('workflows');
});

// A seeded repo with one modified tracked file, so `plan` reaches step 7 and takes the lock.
function dirtyCase(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  return c;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A schedule whose single step holds once `eventPath` exists: from then on every
// `Date.now()` reads `callStarted + elapsedMs`. A marker written before launch makes the step
// active from the call's second clock read on.
function scheduleOn(c, eventPath, elapsedMs) {
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: eventPath }, elapsedMs }]));
  return schedulePath;
}

function scheduleFromStart(c, elapsedMs) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  return scheduleOn(c, marker, elapsedMs);
}

function scheduleAfterLock(c, elapsedMs) {
  return scheduleOn(c, path.join(runDirOf(c), 'lock'), elapsedMs);
}

// A PATH git shim that logs every argv it sees, then runs the real git.
function gitShim(c) {
  const log = path.join(c.root, 'git-calls.log');
  const shimDir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(shimDir);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit, 'no git on the host PATH');
  fs.writeFileSync(path.join(shimDir, 'git'), ['#!/bin/sh', `echo "$@" >> '${log}'`, `exec '${realGit}' "$@"`, ''].join('\n'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  return { log, env: { PATH: [shimDir, c.env.PATH].join(path.delimiter) } };
}

function runPlan(c, schedulePath, env = {}) {
  return runCommit(c, ['plan'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { ...env, COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });
}

function assertTimedOut(result) {
  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.match(result.json.error.message, /540-second deadline/);
  assert.equal(result.json.reply.status, 'failed');
}

// Neither the lock nor any run folder is left under `.commit-plan/`.
function assertNoRun(c) {
  const runDir = runDirOf(c);
  const left = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  assert.deepEqual(left, [], `left in .commit-plan: ${left.join(', ')}`);
}

test('the clock crossing 540 s before the provisional folder exists ends plan as timeout, with no folder and no lock', async (t) => {
  const c = dirtyCase(t);
  const result = await runPlan(c, scheduleFromStart(c, 540_000));

  assertTimedOut(result);
  assertNoRun(c);
});

test('the clock crossing 540 s only after step 7 took the lock ends plan as timeout and releases the run', async (t) => {
  const c = dirtyCase(t);
  const result = await runPlan(c, scheduleAfterLock(c, 541_000));

  assertTimedOut(result);
  assertNoRun(c);
});

test('past 540 s but below 580 s the reply still carries the tree state', async (t) => {
  const c = dirtyCase(t);
  const result = await runPlan(c, scheduleAfterLock(c, 545_000));

  assertTimedOut(result);
  const { reply, error } = result.json;
  assert.ok(reply.text.startsWith(`${error.message}\n`), `no tree-state line: ${reply.text}`);
  assertNoRun(c);
});

test('past 580 s the reply omits the tree state but still comes', async (t) => {
  const c = dirtyCase(t);
  const result = await runPlan(c, scheduleAfterLock(c, 590_000));

  assertTimedOut(result);
  assert.equal(result.json.reply.text, result.json.error.message);
  assertNoRun(c);
});

// M10 `treeState` is the only `git status --untracked-files=all` call `plan` makes.
const TREE_STATE_CALL = /\bstatus\b.*--untracked-files=all/;

function treeStateCalls(shim) {
  return fs.readFileSync(shim.log, 'utf8').split('\n').filter((line) => TREE_STATE_CALL.test(line));
}

test('below 580 s the tree-state read is spawned (git shim argv log)', { skip: SHIM_SKIP }, async (t) => {
  const c = dirtyCase(t);
  const shim = gitShim(c);
  const result = await runPlan(c, scheduleAfterLock(c, 545_000), shim.env);

  assertTimedOut(result);
  assert.equal(treeStateCalls(shim).length, 1);
  assertNoRun(c);
});

test('past 580 s the tree-state read is never spawned (git shim argv log)', { skip: SHIM_SKIP }, async (t) => {
  const c = dirtyCase(t);
  const shim = gitShim(c);
  const result = await runPlan(c, scheduleAfterLock(c, 590_000), shim.env);

  assertTimedOut(result);
  assert.deepEqual(treeStateCalls(shim), []);
  assertNoRun(c);
});

test('with the clock at 530 s plan completes normally', async (t) => {
  const c = dirtyCase(t);
  const result = await runPlan(c, scheduleFromStart(c, 530_000));

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.ok(result.json.planId, detail(result));
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), true, 'the hunk index keeps the lock');
});

// KD-R33, KD-R64: an `internal` throw past step 7 (an FND-10-style `EIO` on a rename) ends
// `plan` with a `failed` reply whose tree-state read runs against `cleanupDeadline`, not the
// spent 540 s `deadline`. In process, so `fs.renameSync` can fail; the injected clock jumps
// to `elapsedMs` at the throw itself. The throw is narrowed to the `plan.json` rename (M12
// `write`'s `writeAtomic`, `run.mjs`), which runs after `storeAndLock`'s `acquire`: the
// earlier `state.json` rename, and `acquireLock`'s own `linkSync` for the lock itself, both
// pass through to the real `fs.renameSync`, so the lock is actually held when the throw
// lands (review-RUN-12 finding 1; the untargeted mock never took the lock, making the
// lock-released assertion vacuous). `lockExistedAtThrow` pins that it was.
async function internalAt(t, elapsedMs, extraInjected = {}) {
  const c = dirtyCase(t);
  const start = Date.UTC(2026, 0, 1);
  const lockPath = path.join(runDirOf(c), 'lock');
  const originalRename = fs.renameSync.bind(fs);
  let thrown = false;
  let lockExistedAtThrow = null;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) !== 'plan.json') return originalRename(from, to);
    thrown = true;
    lockExistedAtThrow = fs.existsSync(lockPath);
    throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
  });
  const injected = {
    env: c.env, now: () => (thrown ? start + elapsedMs : start), claudeHome: c.claudeHome, cwd: c.repoDir,
    ...extraInjected,
  };
  try {
    const result = await workflows.plan({}, injected, { cwd: c.repoDir });
    return { c, result, lockExistedAtThrow };
  } finally {
    t.mock.restoreAll();
  }
}

test('an internal throw past 540 s but below 580 s still reads the tree state for its reply', async (t) => {
  const { result, lockExistedAtThrow } = await internalAt(t, 545_000);

  assert.equal(lockExistedAtThrow, true, 'the lock was held when the plan.json rename threw');
  assert.equal(result.failure.kind, 'internal');
  assert.equal(result.failure.message, 'unexpected error: EIO: i/o error, rename');
  const { reply } = result.failure;
  assert.equal(reply.status, 'failed');
  assert.ok(reply.text.startsWith(`${result.failure.message}
`), `no tree-state line: ${reply.text}`);
});

test('an internal throw past 580 s skips the tree-state read but the reply still comes', async (t) => {
  const { c, result, lockExistedAtThrow } = await internalAt(t, 590_000);

  assert.equal(lockExistedAtThrow, true, 'the lock was held when the plan.json rename threw');
  assert.equal(result.failure.kind, 'internal');
  assert.equal(result.failure.reply.status, 'failed');
  assert.equal(result.failure.reply.text.split('\nNotices:')[0], result.failure.message);
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false, 'the lock is released');
});

test('an internal throw writes the stack to stderr, like the commit.cjs backstop', async (t) => {
  const chunks = [];
  const { result } = await internalAt(t, 545_000, { stderr: { write: (chunk) => chunks.push(chunk) } });

  assert.equal(result.failure.kind, 'internal');
  assert.equal(chunks.length, 1, `expected exactly one stderr write, got: ${chunks.join('|')}`);
  assert.match(chunks[0], /^commit: unexpected error\n/);
  assert.match(chunks[0], /EIO: i\/o error, rename/);
});

// AC6 (`plan --hunks` takes its own deadline from its own start): this pins M15's half of it,
// `deadline`/`cleanupDeadline` are pure in the call's own start, with no state shared between
// calls. The Seam 1 half (a separate `plan --hunks --plan <planId>` call crossing its own
// deadline) is CHG-19's, in tests/plan-hunks-resnapshot.test.js.
test('M15 deadline and cleanupDeadline are the call\'s own start plus 540 s and 580 s', () => {
  assert.equal(runPolicy.DEADLINE_MS, 540_000);
  assert.equal(runPolicy.CLEANUP_DEADLINE_MS, 580_000);
  assert.equal(runPolicy.deadline(1_000), 541_000);
  assert.equal(runPolicy.cleanupDeadline(1_000), 581_000);
  assert.equal(runPolicy.deadline(90_000), 630_000, 'a later call takes its own deadline');
  assert.equal(runPolicy.deadline(1_000), 541_000, 'an earlier call\'s deadline is unchanged');
  assert.equal(runPolicy.cleanupDeadline(90_000), 670_000);
});

// review-GIT-07 finding Low-7 (GIT-07 AC5): each workflow takes the call's start from
// `injected.callStarted` (read once at dispatch) and never re-reads it from the clock. The
// injected clock sits exactly at the deadline measured from `callStarted`, so only a
// workflow that honours `callStarted` ends `timeout`; one that re-read the clock as its start
// would see a full budget and go on.
for (const [name, argv, elapsedMs] of [
  ['plan', {}, 540_000],
  ['check', { plan: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' }, 540_000],
  ['infer', {}, 540_000],
  ['release', { plan: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' }, 45_000],
]) {
  test(`${name} takes its deadline from injected.callStarted, not a fresh clock read`, async (t) => {
    const c = dirtyCase(t);
    const start = Date.UTC(2026, 0, 1);
    const injected = {
      env: c.env, now: () => start + elapsedMs, claudeHome: c.claudeHome, cwd: c.repoDir, callStarted: start,
    };
    const result = await workflows[name](argv, injected, { cwd: c.repoDir });
    assert.equal(result.failure?.kind, 'timeout', JSON.stringify(result));
  });
}

// review-GIT-07 r2 finding Low-2 (C:cli-and-exit-codes: "exits 3-5 end the run"): a `check`
// whose 540 s deadline passes after M12 `open` took the run ends `timeout` and releases the
// run, lock and folder. The injected clock reads the deadline only once `call.lock` exists,
// which `open` creates the moment it succeeds, so the timeout lands on the step after
// `openRun`; before the fix only this call's `call.lock` went and the run was kept.
test('check past its deadline after opening the run ends timeout and releases the lock and the run folder', async (t) => {
  const c = dirtyCase(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  const folder = path.join(runDir, planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId, created: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({ version: 1 }));
  const start = Date.UTC(2026, 0, 1);
  const callLock = path.join(folder, 'call.lock');
  const injected = {
    env: c.env,
    now: () => (fs.existsSync(callLock) ? start + 540_000 : start),
    claudeHome: c.claudeHome,
    cwd: c.repoDir,
    callStarted: start,
  };

  const result = await workflows.check({ plan: planId }, injected, { cwd: c.repoDir });

  assert.equal(result.failure?.kind, 'timeout', JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(folder), false, 'the run folder is deleted');
});

// review-GIT-07 r2 finding Low-3: a git call that the deadline itself ends, while the injected
// clock is still short of it, ends the workflow `timeout`, never `internal`. The clock reads
// 10 ms before the deadline except when its direct caller is in M2 process-adapter.mjs (the
// `run` budget read), where it reads the deadline: every pre-step clock check passes, and the
// first deadline-scoped git call is skipped as spent, which marks the scope expired.
// Deterministic: no real spawn has to outlast a timer. `spent` records that such a call
// happened, so a case that stops reaching one fails instead of passing on the coarse check.
function clockSpentInsideRun(deadlineAt) {
  const clock = { spent: false };
  clock.now = () => {
    if (!new Error().stack.split('\n')[2].includes('process-adapter.mjs')) return deadlineAt - 10;
    clock.spent = true;
    return deadlineAt;
  };
  return clock;
}

// `infer`'s first scoped git call is M3 `head`, which throws on the skipped call's null exit
// code: only `runStepsWithin`'s throw-after-expiry mapping turns that into `timeout` (the
// part-1 bug review-GIT-07 r2 names).
test('infer whose HEAD read the deadline ends ends timeout, not internal', async (t) => {
  const c = dirtyCase(t);
  const start = Date.UTC(2026, 0, 1);
  const clock = clockSpentInsideRun(start + 540_000);
  const injected = { env: c.env, now: clock.now, claudeHome: c.claudeHome, cwd: c.repoDir, callStarted: start };

  const result = await workflows.infer({}, injected, { cwd: c.repoDir });

  assert.equal(clock.spent, true, 'a deadline-scoped git call was reached');
  assert.deepEqual(result.failure, { kind: 'timeout', message: '/commit passed its 540-second deadline' });
});

// `check` and `release` make their only scoped git call outside a working tree (M3
// `classifyNoWorkTree`, inside `probeRepo`). The next step's `pastDeadline` sees the expired
// scope with the clock still short of the deadline and ends the call `timeout` before the
// KD-S78 throw; without that clause the throw's own mapping in `runStepsWithin` must. In a
// working tree neither subcommand makes a scoped git call before M12 `open`/`releaseById`,
// so no scope can expire there; `release`'s kept lock and folder past its deadline (user
// decision on KD-R78) are pinned by the clock-driven Seam 1 case in
// tests/plan-timeout-kill.test.js.
for (const [name, elapsedMs, message] of [
  ['check', 540_000, '/commit passed its 540-second deadline'],
  ['release', 45_000, '/commit release passed its 45-second deadline'],
]) {
  test(`${name} outside a working tree whose git call the deadline ends ends timeout, not internal`, async (t) => {
    const c = createCase(t, { repo: false });
    const start = Date.UTC(2026, 0, 1);
    const clock = clockSpentInsideRun(start + elapsedMs);
    const injected = { env: c.env, now: clock.now, claudeHome: c.claudeHome, cwd: c.root, callStarted: start };

    const result = await workflows[name]({ plan: crypto.randomUUID() }, injected, { cwd: c.root });

    assert.equal(clock.spent, true, 'a deadline-scoped git call was reached');
    assert.deepEqual(result.failure, { kind: 'timeout', message });
  });
}
