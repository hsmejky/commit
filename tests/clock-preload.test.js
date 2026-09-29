'use strict';

// FND-05 (docs/roadmap/01-foundation.md): the stepping-clock preload
// (tests/helpers/clock-preload.mjs) that Seam 1 time-budget and kill-timeout tests load with
// Node's `--import`, so those cases need no real waiting (docs/spec/testing-seams.md, "Clock
// at Seam 1"). Driven here through a stub entry point (tests/fixtures/clock/run-ops.cjs), not
// the shipped scripts, which do not exist yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createCase, runEntry } = require('./helpers/process-seam.js');

const RUN_OPS = path.join(__dirname, 'fixtures', 'clock', 'run-ops.cjs');
// `--import` requires a file:// URL on Windows (a bare `C:\...` path is read as a URL scheme).
const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

// Runs run-ops.cjs with the given program and (optional) schedule, and returns the recorded
// `now` array. The schedule, when given, is written to a file in the case root and pointed at
// by COMMIT_TEST_CLOCK_SCHEDULE.
async function runOps(c, program, schedule) {
  const env = {};
  if (schedule !== undefined) {
    const schedulePath = path.join(c.root, 'schedule.json');
    fs.writeFileSync(schedulePath, JSON.stringify(schedule));
    env.COMMIT_TEST_CLOCK_SCHEDULE = schedulePath;
  }
  const result = await runEntry(c, RUN_OPS, [JSON.stringify(program)], {
    nodeArgs: ['--import', PRELOAD],
    env,
  });
  assert.equal(result.exitCode, 0, `run-ops failed: ${result.stderr}`);
  return JSON.parse(result.stdout).now;
}

// --- AC1: the first call is real time; later calls before any step run in real time too ---

test('the first Date.now() call returns real time', async (t) => {
  const c = createCase(t, { repo: false });
  const before = Date.now();
  const [first] = await runOps(c, [{ op: 'now' }]);
  const after = Date.now();
  assert.ok(first >= before - 1000 && first <= after + 1000, `${first} not near real time`);
});

test('with COMMIT_TEST_CLOCK_SCHEDULE unset, every call returns real time', async (t) => {
  const c = createCase(t, { repo: false });
  const before = Date.now();
  const [first, second] = await runOps(c, [{ op: 'now' }, { op: 'now' }]);
  const after = Date.now();
  assert.ok(first >= before - 1000 && first <= after + 1000);
  assert.ok(second >= before - 1000 && second <= after + 1000);
});

// --- AC1: a path step freezes the clock once the path exists, until a later step -----------

test('a path step is real time until the path exists, then frozen at callStarted + elapsed', async (t) => {
  const c = createCase(t, { repo: false });
  const marker = path.join(c.root, 'marker');
  const schedule = [{ event: { type: 'path', path: marker }, elapsedMs: 10_000_000 }];

  const [beforeMarker, afterMarker, stillFrozen] = await runOps(
    c,
    [{ op: 'now' }, { op: 'touch', path: marker }, { op: 'now' }, { op: 'now' }],
    schedule,
  );

  // The first call is always real time (== callStarted); real time can never reach
  // 10,000,000 ms (~2.8 h) of elapsed test run time, so an unfrozen `afterMarker` would fail
  // the exact-equality check below rather than pass it by coincidence.
  const frozenAt = beforeMarker + 10_000_000;
  assert.equal(afterMarker, frozenAt, 'must freeze at callStarted + elapsed once the path exists');
  assert.equal(stillFrozen, frozenAt, 'the clock must stay frozen on the next read too');
});

// --- AC1: two path steps freeze in turn, each until the next step's event holds -----------

test('two path steps freeze in turn at callStarted + each elapsed', async (t) => {
  const c = createCase(t, { repo: false });
  const markerA = path.join(c.root, 'a');
  const markerB = path.join(c.root, 'b');
  const schedule = [
    { event: { type: 'path', path: markerA }, elapsedMs: 1_000 },
    { event: { type: 'path', path: markerB }, elapsedMs: 2_000 },
  ];

  const [callStarted, afterA, afterB] = await runOps(
    c,
    [
      { op: 'now' },
      { op: 'touch', path: markerA },
      { op: 'now' },
      { op: 'touch', path: markerB },
      { op: 'now' },
    ],
    schedule,
  );

  assert.equal(afterA, callStarted + 1_000);
  assert.equal(afterB, callStarted + 2_000);
});

// --- AC3: a boundary step (exactly 60,000 ms elapsed) reads back exactly -------------------

test('a step at exactly 60000 ms elapsed reads back exactly', async (t) => {
  const c = createCase(t, { repo: false });
  const marker = path.join(c.root, 'marker');
  const schedule = [{ event: { type: 'path', path: marker }, elapsedMs: 60_000 }];

  const [callStarted, frozen] = await runOps(
    c,
    [{ op: 'now' }, { op: 'touch', path: marker }, { op: 'now' }],
    schedule,
  );

  assert.equal(frozen, callStarted + 60_000);
});

// --- AC2: a step already held at start applies from the second call on ---------------------

test('a step whose path already exists before launch applies from the second call on', async (t) => {
  const c = createCase(t, { repo: false });
  const marker = path.join(c.root, 'marker');
  fs.writeFileSync(marker, ''); // event already holds before the process even starts
  const schedule = [{ event: { type: 'path', path: marker }, elapsedMs: 5_000 }];

  const [callStarted, frozen] = await runOps(c, [{ op: 'now' }, { op: 'now' }], schedule);
  assert.equal(frozen, callStarted + 5_000);
});

// --- AC2: the schedule reacts to events, not to how many times Date.now() was called -------

test('extra reads before the event holds do not advance the schedule', async (t) => {
  const c = createCase(t, { repo: false });
  const marker = path.join(c.root, 'marker');
  const schedule = [{ event: { type: 'path', path: marker }, elapsedMs: 10_000_000 }];

  const before = Date.now();
  const readings = await runOps(
    c,
    [
      { op: 'now' }, { op: 'now' }, { op: 'now' }, { op: 'now' }, { op: 'now' },
      { op: 'touch', path: marker },
      { op: 'now' },
    ],
    schedule,
  );
  const after = Date.now();
  const [callStarted, ...beforeMarker] = readings.slice(0, 5);
  const afterMarker = readings[5];
  for (const reading of beforeMarker) {
    assert.ok(
      reading >= before - 1000 && reading <= after + 1000,
      `${reading} not near real time (must not freeze before the path exists)`,
    );
  }
  assert.equal(afterMarker, callStarted + 10_000_000);
});

// --- AC2: a reflog-entry-count event ---------------------------------------------------------

test('a reflogCount step freezes once the ref has at least the given number of entries', async (t) => {
  const c = createCase(t); // repo: true (default)
  const schedule = [
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast: 2 }, elapsedMs: 20_000_000 },
  ];

  const before = Date.now();
  const [callStarted, beforeCommits, afterOneCommit, afterTwoCommits] = await runOps(
    c,
    [
      { op: 'now' },
      { op: 'now' },
      { op: 'commit', cwd: c.repoDir, message: 'first' }, // reflog count -> 1 (below atLeast)
      { op: 'now' },
      { op: 'commit', cwd: c.repoDir, message: 'second' }, // reflog count -> 2 (meets atLeast)
      { op: 'now' },
    ],
    schedule,
  );
  const after = Date.now();

  assert.ok(
    beforeCommits >= before - 1000 && beforeCommits <= after + 1000,
    `${beforeCommits} not near real time`,
  );
  assert.ok(
    afterOneCommit >= before - 1000 && afterOneCommit <= after + 1000,
    `${afterOneCommit} not near real time (one entry must not meet atLeast: 2)`,
  );
  assert.equal(afterTwoCommits, callStarted + 20_000_000);
});

// --- schedule validation: elapsedMs must be finite and strictly increasing -----------------

test('a schedule with a non-finite or non-increasing elapsedMs fails the launch', async (t) => {
  const badSchedules = [
    [{ event: { type: 'path', path: '/x' }, elapsedMs: Number.NaN }],
    [{ event: { type: 'path', path: '/x' }, elapsedMs: 1_000 }, { event: { type: 'path', path: '/y' }, elapsedMs: 1_000 }],
    [{ event: { type: 'path', path: '/x' }, elapsedMs: 2_000 }, { event: { type: 'path', path: '/y' }, elapsedMs: 1_000 }],
  ];
  for (const schedule of badSchedules) {
    const c = createCase(t, { repo: false });
    const schedulePath = path.join(c.root, 'schedule.json');
    fs.writeFileSync(schedulePath, JSON.stringify(schedule));
    const result = await runEntry(c, RUN_OPS, [JSON.stringify([{ op: 'now' }])], {
      nodeArgs: ['--import', PRELOAD],
      env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
    });
    assert.notEqual(result.exitCode, 0, `launch must fail for schedule ${JSON.stringify(schedule)}`);
    assert.match(result.stderr, /elapsedMs/);
  }
});

// --- AC4: the preload is never referenced from the packaged plugin directory ---------------

test('the packaged plugin directory contains no reference to the clock preload', () => {
  const pluginDir = path.join(__dirname, '..', 'plugin');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, 'utf8').includes('clock-preload')) offenders.push(full);
    }
  })(pluginDir);
  assert.deepEqual(offenders, []);
});
