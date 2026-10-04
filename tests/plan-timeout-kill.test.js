'use strict';

// GIT-07 (docs/roadmap/06-git-adapters.md): every M2 call of a call takes its timeout from the
// call's deadline (M15 `deadline`, `releaseDeadline`; M2 `withDeadline`). Seam 1 with the
// FND-05 stepping clock: a clean filter that never ends stands for a stalled git call, and
// the deadline (not the test harness) has to end it, killing the filter's process too (the
// tree kill, not only the direct `git` child). The filter is a heartbeat process
// (tests/helpers/heartbeat.js), so "gone after the call" is observed, not inferred from a pid.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { heartbeat, killLeftovers, stopped } = require('./helpers/heartbeat.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

// A schedule active from the call's second clock read on: every `Date.now()` after the call's
// own start reads `callStarted + elapsedMs` (plan-deadline.test.js, release.test.js).
function scheduleFromStart(c, elapsedMs) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs }]));
  return schedulePath;
}

function forwardSlashes(p) {
  return p.split(path.sep).join('/');
}

// Seeds `a.txt` under a `filter=slow` attribute and only then configures the filter, so the
// seed commit itself never runs it. `script` is the filter's Node source.
function filteredRepo(t, script) {
  const c = createCase(t);
  c.writeFile('.gitattributes', 'a.txt filter=slow\n');
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', '.gitattributes', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '/.commit-plan\n');
  const scriptPath = path.join(c.root, 'filter.js');
  fs.writeFileSync(scriptPath, script);
  const command = `'${forwardSlashes(process.execPath)}' '${forwardSlashes(scriptPath)}'`;
  c.git(['config', 'filter.slow.clean', command]);
  return c;
}

function runClocked(c, argv, elapsedMs) {
  return runCommit(c, argv, {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleFromStart(c, elapsedMs) },
    timeoutMs: 45_000,
  });
}

test('a clean filter that never ends, 535 s into plan: exit 5 timeout, no run, the filter tree killed', async (t) => {
  const c = filteredRepo(t, '');
  const beat = path.join(c.root, 'filter');
  fs.writeFileSync(path.join(c.root, 'filter.js'), heartbeat(beat));
  killLeftovers(t, () => [beat]);
  c.writeFile('a.txt', 'one\nmore\n');

  const startedAt = Date.now();
  const result = await runClocked(c, ['plan'], 535_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.match(result.json.error.message, /540-second deadline/);
  assert.equal(result.json.reply.status, 'failed');
  // review-GIT-07 finding Low-6: AC1's "within about 10 s" (5 s of remaining budget plus
  // KILL_GRACE_MS) was unasserted; the 45 s harness timeout alone would not catch a kill that
  // regressed to polling a full extra grace (Low-4) or longer. 30 s keeps headroom over the
  // ~17 s measured here for a slower host while still well short of the 45 s harness cap.
  assert.ok(elapsedMs < 30_000, `expected well under 30 s, took ${elapsedMs}ms`);
  assert.ok(fs.existsSync(`${beat}.pid`), 'the filter ran');
  const runDir = runDirOf(c);
  const left = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  assert.deepEqual(left, [], `left in .commit-plan: ${left.join(', ')}`);
  assert.equal(await stopped(beat), true, 'the filter process is gone after the call');
});

// `release`'s own steps never read the worktree, so the reply's tree-state read is the
// first `git status`, and the filter stalls it. `a.txt` keeps its content but gets a future
// mtime, so `git status` has to run the filter to compare it.
test('release 42 s into the call with a stalling git status: the tree-state read times out, exit 0, no tree-state line', async (t) => {
  const c = filteredRepo(t, '');
  const beat = path.join(c.root, 'filter');
  fs.writeFileSync(path.join(c.root, 'filter.js'), heartbeat(beat));
  killLeftovers(t, () => [beat]);
  const future = new Date(Date.now() + 3_600_000);
  fs.utimesSync(path.join(c.repoDir, 'a.txt'), future, future);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(runDir, planId), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId, created: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(runDir, planId, 'state.json'), '{"version":1}\n');

  const result = await runClocked(c, ['release', '--plan', planId], 42_000);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.equal(result.json.reply.status, 'nothing');
  assert.equal(result.json.reply.text, 'nothing committed', 'the timed-out read omits the tree-state line');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the release itself completed');
  assert.ok(fs.existsSync(`${beat}.pid`), 'the tree-state read ran the stalling filter');
  assert.equal(await stopped(beat), true, 'the filter process is gone after the call');
});

// review-GIT-07 finding Medium-2: `check` and `infer` took no deadline at all, so a stalled
// git call inside them never ended. Both now take their own M15 `deadline` the way `plan`
// does; stepping the clock to exactly 540 s elapsed trips the coarse pre-step check
// (`pastDeadline`) before the first step runs, so no filter is needed to prove the bound.
test('check 540 s into the call: exit 5 timeout, no step ran', async (t) => {
  const c = createCase(t);
  const planId = crypto.randomUUID();

  const result = await runClocked(c, ['check', '--plan', planId], 540_000);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.match(result.json.error.message, /540-second deadline/);
  assert.equal(fs.existsSync(runDirOf(c)), false, 'no run folder was ever opened');
});

test('infer 540 s into the call: exit 5 timeout, no step ran', async (t) => {
  const c = createCase(t);

  const result = await runClocked(c, ['infer'], 540_000);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.match(result.json.error.message, /540-second deadline/);
});
