'use strict';

// RUN-04 (docs/roadmap/09-runs.md): M12 `open`, wired as `commit`'s first step. It checks
// the lock holds the call's `--plan` planId, refreshes its mtime, checks the state
// `version`, then holds `call.lock` for the whole call. A matched lock then runs M16
// `commitAll` over any stored groups (EXE-02, EXE-04); with none to run (no stored groups,
// or every one already committed) EXE-05's `no-groups` refusal ends the call instead, the
// run kept. Seam 1 only: the shipped entry point as a subprocess (tests/release.test.js's
// fixture style, copied here).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CREATED = '2026-01-01T00:00:00.000Z';
const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;

function seedCommit(c) {
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
}

// A repo with one commit and the `/.commit-plan` exclude line `plan` adds before it first
// creates the run-folder directory (C:run-folder), so the fixture's run files leave the
// working tree clean, also with a `.commit-plan` link or plain file in its place.
function createRepo(t) {
  const c = createCase(t);
  seedCommit(c);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '/.commit-plan\n');
  return c;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function writeLock(runDir, content) {
  fs.mkdirSync(runDir, { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(runDir, 'lock'), text);
}

function writeRunFolder(runDir, planId, { version = 1 } = {}) {
  const folder = path.join(runDir, planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({ version }));
  return folder;
}

function matchingRun(c, { version = 1 } = {}) {
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const folder = writeRunFolder(runDir, planId, { version });
  return { runDir, planId, folder, callLock: path.join(folder, 'call.lock') };
}

function assertLockFailure(result, textPattern) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'lock', detail);
  assert.match(result.json.error.message, textPattern, detail);
}

test('commit --plan X --all with the lock held by a different planId Y → taken-over', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const holder = crypto.randomUUID();
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId: holder, created: CREATED });
  writeRunFolder(runDir, holder);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertLockFailure(result, /this run was taken over by another \/commit/);
  // The other run's lock and folder are left alone: `commit` never touches someone else's run.
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), true);
  assert.equal(fs.existsSync(path.join(runDir, holder)), true);
});

test('commit --plan X --all with no lock at all → ended', async (t) => {
  const c = createRepo(t);
  const planId = crypto.randomUUID();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertLockFailure(result, /this run has already ended/);
});

test('commit --plan X --all with a state.json version mismatch → ended', async (t) => {
  const c = createRepo(t);
  const { planId } = matchingRun(c, { version: 2 });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertLockFailure(result, /this run has already ended/);
});

// EXE-05 (docs/roadmap/10-commit-executor.md): a matching lock with no stored groups is
// refused `no-groups` (exit 1 `usage`), after the lock check advances the lock's mtime.
test('commit --plan X --all with a matching lock but no stored groups advances the lock mtime, then refuses no-groups, and call.lock does not outlive the call', async (t) => {
  const c = createRepo(t);
  const { runDir, planId, folder, callLock } = matchingRun(c);
  const lockPath = path.join(runDir, 'lock');
  const before = fs.statSync(lockPath).mtimeMs;
  fs.utimesSync(lockPath, new Date(before - 60_000), new Date(before - 60_000));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 1, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'usage', detail);
  assert.match(result.json.error.message, /no groups/, detail);
  assert.ok(fs.statSync(lockPath).mtimeMs > before - 60_000, "the lock's mtime advanced");
  // A kept run's call.lock does not outlive its call, but the run itself (lock and folder)
  // is kept: `no-groups` ends the call, not the run.
  assert.equal(fs.existsSync(callLock), false, 'call.lock is absent after the call ends');
  assert.equal(fs.existsSync(lockPath), true, "the run's own lock is kept");
  assert.equal(fs.existsSync(folder), true, 'the run folder is kept');
});

// EXE-05 AC: every stored group already committed → no-groups too, not a silent exit 0.
test('commit --plan X --all with a stored group already committed → no-groups, same as no stored groups', async (t) => {
  const c = createRepo(t);
  const { runDir, planId, folder } = matchingRun(c);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({
    version: 1, groups: [{ n: 1, units: [], header: 'feat: x', body: null, committed: true }],
  }));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 1, detail);
  assert.equal(result.json.error.kind, 'usage', detail);
  assert.match(result.json.error.message, /no groups/, detail);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha, 'no new commit was made');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), true, "the run's own lock is kept");
  assert.equal(fs.existsSync(folder), true, 'the run folder is kept');
});

// EXE-05 AC: the lock holds another planId, and no groups are stored either → the lock
// check (M12 `open`) refuses taken-over first; `no-groups` is never reached.
test('commit --plan X --all with the lock held by a different planId and no groups stored anywhere → taken-over, not no-groups', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const holder = crypto.randomUUID();
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId: holder, created: CREATED });
  writeRunFolder(runDir, holder);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertLockFailure(result, /this run was taken over by another \/commit/);
});

test('commit --plan X --all with a live call.lock → busy, and the run is kept', async (t) => {
  const c = createRepo(t);
  const { runDir, planId, folder, callLock } = matchingRun(c);
  fs.writeFileSync(callLock, JSON.stringify({ pid: process.pid, host: os.hostname() }));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertLockFailure(result, /another \/commit call on this run is still running/);
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), true);
  assert.equal(fs.existsSync(folder), true);
  assert.equal(fs.existsSync(callLock), true, 'the live call.lock is kept, not replaced');
});

// AC 5 (docs/roadmap/09-runs.md RUN-04): a `call.lock`/folder that vanishes with `ENOENT`
// mid-call maps to `taken-over`, not `internal`. Seam 1 only: the other races for this AC
// live in tests/run.test.js as in-process M12 tests; this one goes through the shipped
// entry point, injecting the ENOENT at the mtime touch (`fs.utimesSync` on the lock file)
// rather than monkeypatching `node:fs` in-process. This covers specifically the run lock
// itself vanishing at the mtime touch, not call.lock or the run folder — see the next test
// for the call.lock-vanishing half of AC 5.
test('commit --plan X --all: the lock vanishes with ENOENT at the mtime touch (real process seam) → taken-over, not internal', async (t) => {
  const c = createRepo(t);
  const { planId } = matchingRun(c);
  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_UTIMES_BASENAME: 'lock', COMMIT_TEST_FAULT_UTIMES_CODE: 'ENOENT' },
  });
  assertLockFailure(result, /this run was taken over by another \/commit/);
});

test('commit --plan X --all: call.lock\'s own create meets ENOENT (folder vanished mid-call, real process seam) → taken-over, not internal', async (t) => {
  const c = createRepo(t);
  const { planId } = matchingRun(c);
  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_WRITEFILE_BASENAME: 'call.lock', COMMIT_TEST_FAULT_WRITEFILE_CODE: 'ENOENT' },
  });
  assertLockFailure(result, /this run was taken over by another \/commit/);
});

test('commit without --plan is a usage refusal and creates nothing', async (t) => {
  const c = createRepo(t);

  const result = await runCommit(c, ['commit', '--all']);

  assert.equal(result.json.error.kind, 'usage');
  assert.equal(fs.existsSync(runDirOf(c)), false);
});
