'use strict';

// RUN-27 (docs/roadmap/09-runs.md): M15 `runEnd` is the single source of which ending outcomes
// release the run and which keep it (C:cli-and-exit-codes error table, C:run-folder). The unit
// table pins the rule itself; the Seam 1 cases pin the endings RUN-27 builds on top of it: an
// `internal` throw in `check` and `commit` releases the run (it used to leave it), and the
// release's own notice reaches the caller (a busy lock rename keeps the run, a folder-removal
// error is reported) for `commit --all`'s last group, `check`'s `--no-user` lint ending and
// `check`'s `timed-out` ending.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { makeReadOnlyFolder, removalErrorCode } = require('./helpers/read-only-folder.js');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

let runEnd;
test.before(async () => {
  ({ runEnd } = await loadLib('run-policy'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

test('runEnd: the refusal codes that keep the run, and every other that releases it', () => {
  for (const code of ['unconfirmed', 'no-groups', 'already-committed', 'lint', 'held', 'taken-over', 'ended', 'busy']) {
    assert.equal(runEnd({ kind: 'refusal', code }), 'keep', code);
  }
  for (const code of [
    'head-moved', 'index-changed', 'index-locked', 'unmatched', 'mismatch', 'git-failed',
    'stage-failed', 'backstop-hit', 'timed-out', 'killed-leftover', 'staged-empty',
  ]) {
    assert.equal(runEnd({ kind: 'refusal', code }), 'release', code);
  }
});

test('runEnd: lint failures, check results, commit outcomes, release, internal and plan', () => {
  assert.equal(runEnd({ kind: 'lintFailure', ending: 'fix' }, { interactive: false }), 'keep');
  assert.equal(runEnd({ kind: 'lintFailure', ending: 'lintFailed' }, { interactive: true }), 'keep');
  assert.equal(runEnd({ kind: 'lintFailure', ending: 'lintFailed' }, {}), 'keep');
  assert.equal(runEnd({ kind: 'lintFailure', ending: 'lintFailed' }, { interactive: false }), 'release');
  assert.equal(runEnd({ kind: 'checkResult', route: 'confirm' }), 'keep');
  assert.equal(runEnd({ kind: 'checkResult', route: 'commit' }), 'keep', 'commitOutcome decides after the commit');
  assert.equal(runEnd({ kind: 'checkResult', route: 'handedBack' }), 'release');
  assert.equal(runEnd({ kind: 'checkResult', route: 'releaseNothing' }), 'release');
  assert.equal(runEnd({ kind: 'commitOutcome', remaining: 0 }), 'release');
  assert.equal(runEnd({ kind: 'commitOutcome', remaining: 2 }), 'keep', 'a budget stop');
  assert.equal(runEnd({ kind: 'commitOutcome', remaining: 2, code: 'head-moved' }), 'release');
  assert.equal(runEnd({ kind: 'commitOutcome', remaining: 2, code: 'taken-over' }), 'keep');
  assert.equal(runEnd({ kind: 'release' }), 'release');
  assert.equal(runEnd({ kind: 'release', timedOut: true }), 'keep');
  assert.equal(runEnd({ kind: 'internal' }), 'release');
  assert.equal(runEnd({ kind: 'plan', hunks: true }), 'keep');
  assert.equal(runEnd({ kind: 'plan', hunks: false }), 'release');
});

test('runEnd: a failed or skipped unstage keeps the run whatever the outcome', () => {
  assert.equal(runEnd({ kind: 'refusal', code: 'stage-failed', unstageKept: true }), 'keep');
  assert.equal(runEnd({ kind: 'commitOutcome', remaining: 0, code: 'git-failed', unstageKept: true }), 'keep');
  assert.equal(runEnd({ kind: 'internal', unstageKept: true }), 'keep');
});

test('runEnd: an unknown event kind throws', () => {
  assert.throws(() => runEnd({ kind: 'nope' }), /unknown event kind/);
});

function group(header, files) {
  return { header, body: null, files, hunks: [], reason: 'test' };
}

// A repo with `a.txt` and `b.txt` committed, both then modified, and a `plan --split` run
// holding the lock (`planArgs` adds flags such as `--no-user`).
async function plannedRun(t, planArgs = []) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan', '--split', ...planArgs]);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir, lockPath: path.join(path.dirname(runDir), 'lock') };
}

function writePlan(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'),
    JSON.stringify({ version: 1, source: 'worker', groups, notIncluded: [] }));
}

function faultOptions(env) {
  return { nodeArgs: ['--import', FAULT_PRELOAD], env };
}

function assertRunGone({ lockPath, runDir }) {
  assert.equal(fs.existsSync(lockPath), false, 'the lock is gone');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
}

test('Seam 1: an internal throw in check after open releases the run: failed reply, lock and folder gone', async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  writePlan(run.runDir, [group('feat: change both files', ['a.txt', 'b.txt'])]);

  const checked = await runCommit(run.c, ['check', '--plan', run.planId],
    faultOptions({ COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json=EIO' }));

  assert.equal(checked.exitCode, 1, detail(checked));
  assert.equal(checked.json.error.kind, 'internal');
  assert.equal(checked.json.reply.status, 'failed', 'the internal ending carries a failed reply');
  assertRunGone(run);
});

test('Seam 1: an internal throw in commit after open releases the run: failed reply, lock and folder gone', async (t) => {
  const run = await plannedRun(t);
  // Two groups, interactive: `check` stores them and hands back a confirmation, run kept.
  writePlan(run.runDir, [group('feat: change a', ['a.txt']), group('feat: change b', ['b.txt'])]);
  const checked = await runCommit(run.c, ['check', '--plan', run.planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(fs.existsSync(run.lockPath), true, 'a confirm handback keeps the run');

  const committed = await runCommit(run.c, ['commit', '--plan', run.planId, '--all', '--confirmed'],
    faultOptions({ COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json=EIO' }));

  assert.equal(committed.exitCode, 1, detail(committed));
  assert.equal(committed.json.error.kind, 'internal');
  assert.equal(committed.json.reply.status, 'failed');
  assertRunGone(run);
});

const LOCK_KEPT = (planId) => `run lock \`.commit-plan/lock\` for \`${planId}\` was not released (busy); the run and its folder stay in place`;

test('Seam 1: commit --all, last group, a busy lock rename → the committed reply carries the kept notice and keeps planId', async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  writePlan(run.runDir, [group('feat: change both files', ['a.txt', 'b.txt'])]);

  const checked = await runCommit(run.c, ['check', '--plan', run.planId],
    faultOptions({ COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=EPERM' }));

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed');
  assert.ok(checked.json.reply.notices.includes(LOCK_KEPT(run.planId)), detail(checked));
  assert.equal(checked.json.reply.planId, run.planId, 'the run is kept, so the reply names it');
  assert.equal(fs.existsSync(run.lockPath), true, 'the busy lock rename kept the lock');
  assert.equal(fs.existsSync(run.runDir), true, 'and the folder');
});

test('Seam 1: check --no-user, second lint failure, a busy lock rename → the failed reply carries the kept notice', async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  writePlan(run.runDir, [group('wip: change both files', ['a.txt', 'b.txt'])]);
  const first = await runCommit(run.c, ['check', '--plan', run.planId]);
  assert.equal(first.exitCode, 2, detail(first));

  const second = await runCommit(run.c, ['check', '--plan', run.planId],
    faultOptions({ COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=EPERM' }));

  assert.equal(second.exitCode, 2, detail(second));
  assert.equal(second.json.reply.status, 'failed');
  // `plan`'s stored guard notice now rides along (KD-R92); the release notice comes last.
  const { notices } = second.json.reply;
  assert.ok(notices[0].startsWith('Guard hook did not run'), detail(second));
  assert.deepEqual(notices.slice(1), [LOCK_KEPT(run.planId)]);
  assert.equal(fs.existsSync(run.lockPath), true, 'the run is kept');
});

// Unverified on the Windows development host (the case is skipped there); it mirrors the
// sweep's read-only-folder cases (tests/run-sweep.test.js).
test('Seam 1: commit --all, last group, a folder-removal error → the committed reply carries its notice', {
  skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as non-root',
}, async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  writePlan(run.runDir, [group('feat: change both files', ['a.txt', 'b.txt'])]);
  makeReadOnlyFolder(path.join(run.runDir, 'stuck'));
  t.after(() => fs.chmodSync(path.join(run.runDir, 'stuck'), 0o755));

  const checked = await runCommit(run.c, ['check', '--plan', run.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed');
  const code = removalErrorCode();
  assert.ok(checked.json.reply.notices.some((n) => n.includes('was not removed') && n.includes(`(${code})`)),
    detail(checked));
});

test('Seam 1: check timed-out after open, a busy lock rename → the failure carries the kept notice', async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  writePlan(run.runDir, [group('feat: change both files', ['a.txt', 'b.txt'])]);
  // The clock passes the 540 s deadline once `open` has taken this call's `call.lock`.
  const schedulePath = path.join(run.c.root, 'clock.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'path', path: path.join(run.runDir, 'call.lock') }, elapsedMs: 541_000 },
  ]));

  const checked = await runCommit(run.c, ['check', '--plan', run.planId], {
    nodeArgs: ['--import', FAULT_PRELOAD, '--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=EPERM', COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assert.equal(checked.exitCode, 5, detail(checked));
  assert.equal(checked.json.error.kind, 'timeout');
  assert.deepEqual(checked.json.notices, [LOCK_KEPT(run.planId)]);
  assert.equal(fs.existsSync(run.lockPath), true, 'the run is kept');
});

// KD-R92 (RUN-27): a lint failure that ends the worker's part of the run carries the notices
// `plan` stored, like every other ending. The stored `state.json` notices are seeded here (the
// guard notice depends on the heartbeat), so the case does not rely on how `plan` produced them.
const STORED_NOTICE = 'a notice plan stored in state.json';

function seedStoredNotice(run) {
  const statePath = path.join(run.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.notices = [STORED_NOTICE];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

test('Seam 1: check, interactive second lint failure → the lintFailed handback reply carries the stored notices', async (t) => {
  const run = await plannedRun(t);
  seedStoredNotice(run);
  writePlan(run.runDir, [group('wip: change both files', ['a.txt', 'b.txt'])]);
  const first = await runCommit(run.c, ['check', '--plan', run.planId]);
  assert.equal(first.exitCode, 2, detail(first));
  const second = await runCommit(run.c, ['check', '--plan', run.planId]);

  assert.equal(second.exitCode, 2, detail(second));
  assert.equal(second.json.reply.status, 'handback', detail(second));
  assert.deepEqual(second.json.reply.notices, [STORED_NOTICE], detail(second));
});

test('Seam 1: check --no-user, second lint failure → the failed reply carries the stored notices ahead of the release notice', async (t) => {
  const run = await plannedRun(t, ['--no-user']);
  seedStoredNotice(run);
  writePlan(run.runDir, [group('wip: change both files', ['a.txt', 'b.txt'])]);
  const first = await runCommit(run.c, ['check', '--plan', run.planId]);
  assert.equal(first.exitCode, 2, detail(first));

  const second = await runCommit(run.c, ['check', '--plan', run.planId],
    faultOptions({ COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=EPERM' }));

  assert.equal(second.json.reply.status, 'failed', detail(second));
  assert.deepEqual(second.json.reply.notices, [STORED_NOTICE, LOCK_KEPT(run.planId)], detail(second));
});
