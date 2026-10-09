'use strict';

// EXE-21 (docs/roadmap/10-commit-executor.md): a killed reword (`--amend --only`) removes only
// its own `index.lock` (Q18, story 215). Seam 1 with the stepping clock
// (tests/helpers/clock-preload.mjs): the clock reads 535 s at the call's first group, so the
// amend gets a 5 s budget and M2 kills the sleeping `pre-commit` hook tree at it. The hook
// installs a detached survivor (CHG-23 approach) that re-creates `index.lock` mid-kill, so the
// two-marker rule (Q18) is proven on every OS; the hook also records that git held the lock.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { slash, installHook, lockOf, installSurvivor } = require('./helpers/lock-survivor.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const TEST_TIMEOUT = { timeout: 90_000 };
const LEFT_NOTICE = 'index.lock was left in place — if no git process is running, check it and remove it by hand';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

async function killedReword(t, survivor) {
  const c = createCase(t);
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', 'fix: old message']);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  fs.writeFileSync(path.join(planned.json.runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups: [{ header: 'fix: better message', body: null, files: [], hunks: [] }], notIncluded: [],
  }));
  installSurvivor(c, survivor);
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
  const result = await runCommit(c, ['check', '--plan', planned.json.planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });
  return { c, result };
}

test('AC1: the plugin\'s own leftover index.lock (made between the markers) is removed, no lock notice, no marker left', TEST_TIMEOUT, async (t) => {
  const { c, result } = await killedReword(t, { killOffsetMs: -500 });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.ok(fs.existsSync(path.join(c.root, 'lock.seen')), 'the hook saw index.lock while it ran');
  assert.equal(fs.existsSync(lockOf(c)), false, 'the own lock is removed');
  assert.ok(!result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.git')).filter((n) => n.startsWith('commit-guard-')), [], 'no marker is left');
});

test('AC2: a lock another process created after the kill began is kept, with the notice', TEST_TIMEOUT, async (t) => {
  const { c, result } = await killedReword(t, { killOffsetMs: 1000 });

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(path.join(c.root, 'lock.seen')), 'the hook saw index.lock while it ran');
  assert.ok(fs.existsSync(lockOf(c)), 'a foreign lock is never removed');
  assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
});
