'use strict';

// RUN-01 (docs/roadmap/09-runs.md): `release --plan <planId>` ends a run. When the run lock
// holds that `planId` it removes the lock and deletes the run folder; otherwise it is a
// no-op that exits 0 (C:commit-release `release`, C:run-folder, Q22, stories 194 and 206).
// Seam 1 only: the shipped entry point as a subprocess through the FND-04 harness; each
// fixture writes the lock and folders in the C:run-folder shape, as `plan` would.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');
const { parseBaseCallerRule } = require('./helpers/reply-contract-doc.js');

const NOTHING_TO_RELEASE = 'nothing to release: the run has already ended or was taken over';
const CREATED = '2026-01-01T00:00:00.000Z';
const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
// The PATH git shim case below is POSIX-only, the same as GIT-01's (shell-less spawn on
// Windows finds only `.com`/`.exe` files, so a script shim never runs there; roadmap KD-R21).
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

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

// Writes `<runDir>/lock` with the given content (an object is written as JSON).
function writeLock(runDir, content) {
  fs.mkdirSync(runDir, { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(runDir, 'lock'), text);
}

// Creates `<runDir>/<planId>/` with a state file and the temporary index inside.
function writeRunFolder(runDir, planId) {
  const folder = path.join(runDir, planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(folder, 'git-index'), 'index bytes');
  return folder;
}

// A snapshot of every file under `dir` (relative path → content), for "unchanged" checks.
function snapshot(dir) {
  const files = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

function assertNothingReply(result, firstLine) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const { json } = result;
  assert.equal(json.version, 1);
  assert.equal(json.ok, true);
  const { reply } = json;
  assert.equal(reply.version, 1);
  assert.equal(reply.status, 'nothing');
  // No run folder is kept after a release, so the reply names no run (C:reply-and-handback).
  assert.equal(reply.planId, null);
  assert.deepEqual(reply.commits, []);
  assert.equal(reply.handback, null);
  assert.equal(reply.callerRule, parseBaseCallerRule());
  // The text ends with the tree state, read after the release (C:reply-and-handback).
  assert.equal(reply.text, `${firstLine}\nworking tree clean`);
}

test('release --plan X removes a lock holding X and deletes X/, with a nothing reply', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  // Another run's folder (a sweep candidate) is not this release's to delete.
  const other = writeRunFolder(runDir, crypto.randomUUID());

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
  assert.equal(fs.existsSync(other), true, "another run's folder is kept");
});

test('release --plan X on a lock holding Y is a no-op that keeps Y\'s lock and folder', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  const holder = crypto.randomUUID();
  writeLock(runDir, { planId: holder, created: CREATED });
  writeRunFolder(runDir, holder);
  // X's own folder, left behind: a no-op returns before touching any run folder.
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(runDir), before);
});

test('release --plan X with no lock is a no-op', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(runDir), before);
});

test('release --plan X with no .commit-plan at all is a no-op that creates none', async (t) => {
  const c = createRepo(t);

  const result = await runCommit(c, ['release', '--plan', crypto.randomUUID()]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.existsSync(runDirOf(c)), false);
});

const UNPARSEABLE_LOCKS = [
  ['not JSON', (planId) => `{"planId":"${planId}"`],
  ['JSON without a planId', () => ({ created: CREATED })],
  ['a JSON array', (planId) => [planId]],
  ['JSON null', () => 'null'],
  ['an uppercase planId', (planId) => ({ planId: planId.toUpperCase(), created: CREATED })],
];

for (const [label, content] of UNPARSEABLE_LOCKS) {
  test(`release --plan X on an unparseable lock (${label}) is a no-op`, async (t) => {
    const c = createRepo(t);
    const runDir = runDirOf(c);
    const planId = crypto.randomUUID();
    writeLock(runDir, content(planId));
    writeRunFolder(runDir, planId);
    const before = snapshot(runDir);

    const result = await runCommit(c, ['release', '--plan', planId]);

    assertNothingReply(result, NOTHING_TO_RELEASE);
    assert.deepEqual(snapshot(runDir), before);
  });
}

test('release --plan X when the lock path is a directory is a no-op', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(runDir, 'lock'), { recursive: true });
  writeRunFolder(runDir, planId);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.existsSync(path.join(runDir, planId, 'state.json')), true);
});

// Story 206: a forged lock cannot make `release` delete anything outside `.commit-plan/`.
// Only a lock holding the call's own `--plan` value (itself a minted UUID, checked by M1)
// releases, so a lock naming a path never matches.
test('a lock naming a traversal or absolute path deletes nothing outside .commit-plan/', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const inRepo = path.join(c.repoDir, 'victim');
  const outside = path.join(c.root, 'victim');
  for (const dir of [inRepo, outside]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
  }
  c.git(['add', 'victim/keep.txt']);
  c.git(['commit', '-q', '-m', 'victim']);
  const forged = ['../victim', '../../victim', outside, `${crypto.randomUUID()}/../../victim`];

  for (const name of forged) {
    writeLock(runDir, { planId: name, created: CREATED });
    const result = await runCommit(c, ['release', '--plan', crypto.randomUUID()]);

    assertNothingReply(result, NOTHING_TO_RELEASE);
    assert.equal(fs.readFileSync(path.join(inRepo, 'keep.txt'), 'utf8'), 'keep\n', name);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n', name);
    assert.equal(fs.existsSync(path.join(runDir, 'lock')), true, `the forged lock ${name} is kept`);
  }
});

// A `.commit-plan` that is a link (a junction on Windows, a directory symlink elsewhere)
// is not a run-folder directory: `release` never follows it, so a matching lock behind it
// deletes nothing (C:run-folder, story 206).
test('release does not follow a .commit-plan link to a directory outside the repo', async (t) => {
  const c = createRepo(t);
  const target = path.join(c.root, 'elsewhere');
  const planId = crypto.randomUUID();
  writeLock(target, { planId, created: CREATED });
  writeRunFolder(target, planId);
  fs.symlinkSync(target, runDirOf(c), 'junction');
  const before = snapshot(target);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(target), before);
});

test('release deletes a <planId> junction without following it into its target', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
  fs.symlinkSync(target, path.join(runDir, planId), 'junction');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the junction entry is gone');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n', 'the target is kept');
});

test('release deletes a link nested inside <planId>/ without descending into its target', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const folder = writeRunFolder(runDir, planId);
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
  fs.symlinkSync(target, path.join(folder, 'nested'), 'junction');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(folder), false, 'the run folder is gone');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n', "the nested link's target is kept");
});

test('release --plan X when .commit-plan is a regular file is a no-op', async (t) => {
  const c = createRepo(t);
  const planId = crypto.randomUUID();
  fs.writeFileSync(runDirOf(c), 'not a directory\n');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.readFileSync(runDirOf(c), 'utf8'), 'not a directory\n');
});

test('release --plan X removes a matching lock even when X/ does not exist', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

// Finding 3 (review-RUN-01): the release itself (lock and folder gone) succeeds, but the
// reply's tree-state read only renders a clean tree today (the walking skeleton's thin
// read; CHG-04 completes it with the "N files left" case), so a release on a dirty tree
// still ends the call `internal` even though the run has already ended.
test('release on a dirty tree still ends the run, but the reply fails internal (thin tree-state read, CHG-04)', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  c.writeFile('dirty.txt', 'x\n');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
  assert.equal(result.exitCode, 1, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'internal');
});

test('release run from a subdirectory releases the run of the toplevel', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  c.writeFile('sub/file.txt', 'x\n');
  c.git(['add', 'sub/file.txt']);
  c.git(['commit', '-q', '-m', 'sub']);

  const result = await runCommit(c, ['release', '--plan', planId], { cwd: path.join(c.repoDir, 'sub') });

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

// RUN-02: the per-call `call.lock` (`{ pid, host }`, C:run-folder, Q22, story 209). A
// matching `release` takes it before it deletes anything; a live one refuses with exit 6
// `lock` (`busy`) and keeps the run; a stale one is replaced. Ageing is done on the file's
// mtime (`fs.utimesSync`), never by waiting.

const STALE_AGE_MS = 16 * 60 * 1000;

function writeCallLock(runDir, planId, content, { ageMs = 0 } = {}) {
  const file = path.join(runDir, planId, 'call.lock');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(file, then, then);
  }
  return file;
}

// A pid that answered once and has exited since: this host's `process.kill(pid, 0)` fails
// with `ESRCH`, the trace of a killed call.
function exitedPid() {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.equal(result.status, 0);
  return result.pid;
}

function matchingRun(c) {
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  return { runDir, planId };
}

function assertBusy(result) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'lock', detail);
  assert.match(result.json.error.message, /another \/commit call on this run is still running/);
}

function assertReleased(result, runDir, planId) {
  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
  assert.deepEqual(fs.readdirSync(runDir), [], 'no private copy of the lock or call.lock is left');
}

test('release on a run whose call.lock names this test process (live, this host) exits 6 lock busy and keeps the run', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  writeCallLock(runDir, planId, { pid: process.pid, host: os.hostname() });
  const before = snapshot(runDir);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertBusy(result);
  assert.deepEqual(snapshot(runDir), before, 'the lock, the folder and the live call.lock are kept');
});

test('release on a run whose call.lock names a dead pid on this host replaces it at once and releases', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  writeCallLock(runDir, planId, { pid: exitedPid(), host: os.hostname() });

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertReleased(result, runDir, planId);
});

test('release on a run whose call.lock names a live pid on this host but is 15+ minutes old replaces it and releases', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  writeCallLock(runDir, planId, { pid: process.pid, host: os.hostname() }, { ageMs: STALE_AGE_MS });

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertReleased(result, runDir, planId);
});

const JUDGED_BY_MTIME = [
  ['another host', () => ({ pid: exitedPid(), host: `not-${os.hostname()}` })],
  ['unreadable content', () => '{"pid":'],
  ['an empty file', () => ''],
];

for (const [label, content] of JUDGED_BY_MTIME) {
  test(`release on a fresh call.lock with ${label} exits 6 lock busy and keeps the run`, async (t) => {
    const c = createRepo(t);
    const { runDir, planId } = matchingRun(c);
    writeCallLock(runDir, planId, content());
    const before = snapshot(runDir);

    const result = await runCommit(c, ['release', '--plan', planId]);

    assertBusy(result);
    assert.deepEqual(snapshot(runDir), before);
  });

  test(`release on a call.lock with ${label} aged past 15 minutes replaces it and releases`, async (t) => {
    const c = createRepo(t);
    const { runDir, planId } = matchingRun(c);
    writeCallLock(runDir, planId, content(), { ageMs: STALE_AGE_MS });

    const result = await runCommit(c, ['release', '--plan', planId]);

    assertReleased(result, runDir, planId);
  });
}

test('release on a lock that does not match never creates a call.lock', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  const holder = crypto.randomUUID();
  writeLock(runDir, { planId: holder, created: CREATED });
  writeRunFolder(runDir, holder);
  writeRunFolder(runDir, planId);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.existsSync(path.join(runDir, planId, 'call.lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, holder, 'call.lock')), false);
});

// review-RUN-01 finding 1: the lock is removed by renaming it to a private name in
// `.commit-plan/` (then verified and unlinked), never by a bare unlink by name. The
// fault-preload's log records every rename target without failing any.
test('release removes the lock by renaming it to a private name first, then leaves nothing behind', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  const log = path.join(c.root, 'renames.log');

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_LOG: log },
  });

  assertReleased(result, runDir, planId);
  const targets = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const lockRenames = targets.filter((target) => path.dirname(target) === runDir
    && /^lock\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path.basename(target)));
  assert.equal(lockRenames.length, 1, targets.join('\n'));
});

// review-RUN-01 finding 1: a `<planId>` that is a link is never followed to write the
// `call.lock` (a junction swapped in after the lock check must not redirect the write).
test('release on a <planId> junction writes no call.lock into its target', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(runDir, planId), 'junction');
  const log = path.join(c.root, 'renames.log');

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_LOG: log },
  });

  assertNothingReply(result, 'nothing committed');
  assert.deepEqual(fs.readdirSync(target), [], 'nothing was written through the junction');
  const targets = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  assert.equal(targets.some((p) => p.startsWith(target)), false, targets.join('\n'));
});

test('release with no git binary on PATH exits 1 env and deletes nothing', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);
  const emptyBin = path.join(c.root, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const env = {};
  for (const key of Object.keys(c.env)) {
    if (key.toUpperCase() === 'PATH') env[key] = undefined;
  }
  env.PATH = emptyBin;

  const result = await runCommit(c, ['release', '--plan', planId], { env });

  assert.equal(result.exitCode, 1, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'env');
  assert.deepEqual(snapshot(runDir), before);
});

// RUN-03: M15 `releaseDeadline` bounds `release`'s tree-state read to 45 s from the call's
// start (C:reply-and-handback). The stepping clock (FND-05) is driven from a marker file
// written before the process even launches, so its "path exists" step is already active on
// the schedule's first check: every `Date.now()` call after the very first (the call's own
// start) reads back frozen at `callStarted + elapsedMs`, for the whole call.
function clockScheduleAt(c, elapsedMs) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'path', path: marker }, elapsedMs },
  ]));
  return schedulePath;
}

test('release past the 45 s tree-state budget (46 s elapsed since the call\'s start) omits the tree state', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  const schedulePath = clockScheduleAt(c, 46_000);

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  assert.equal(result.json.ok, true, detail);
  const { reply } = result.json;
  assert.equal(reply.status, 'nothing');
  assert.equal(reply.text, 'nothing committed', 'no tree-state line past the 45 s budget');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the release itself completed: the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
});

test('release below the 45 s tree-state budget still carries the tree state', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  const schedulePath = clockScheduleAt(c, 44_000);

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

// review-RUN-03 finding 5: a case at exactly 45 000 ms pins the `>=` choice (workflows.mjs
// `finalReply`: `now() >= deadline`) at the boundary itself, not just a value on each side.
test('release at exactly 45 000 ms elapsed since the call\'s start omits the tree state', async (t) => {
  const c = createRepo(t);
  const { runDir, planId } = matchingRun(c);
  const schedulePath = clockScheduleAt(c, 45_000);

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  assert.equal(result.json.ok, true, detail);
  assert.equal(result.json.reply.text, 'nothing committed', 'exactly 45 000 ms is already past the budget');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

// review-RUN-03 finding 4: the "never spawned" claim (workflows.mjs comment near
// `finalReply`) needs more than the omitted-text assertion above, which a spawned-then-
// discarded read would also pass. A PATH git shim that logs every call it sees pins it down.
test('release past the 45 s budget never spawns the tree-state git status call', { skip: SHIM_SKIP }, async (t) => {
  const c = createRepo(t);
  const { planId } = matchingRun(c);
  const schedulePath = clockScheduleAt(c, 46_000);
  const log = path.join(c.root, 'git-calls.log');
  const shimDir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(shimDir);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit, 'no git on the host PATH');
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/bin/sh',
    `echo "$@" >> '${log}'`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);

  const result = await runCommit(c, ['release', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: {
      ...pathOverride(c, [shimDir, c.env.PATH]),
      COMMIT_TEST_CLOCK_SCHEDULE: schedulePath,
    },
  });

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  assert.equal(result.json.reply.text, 'nothing committed', detail);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.doesNotMatch(calls, /status/, `git status was spawned past the deadline: ${calls}`);
});
