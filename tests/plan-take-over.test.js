'use strict';

// RUN-22 (docs/roadmap/09-runs.md, Q9, Q22, C:plan `--take-over`, C:run-folder `call.lock`
// row): `plan --take-over <planId>` skips `peek` and takes over only the named run's lock,
// whatever its age, at the Seam 1 process boundary. A moved lock holding another `planId` is
// put back and refused `lock` naming that holder; the old run's `call.lock` is taken (a live
// call -> `busy`, a dead pid on this host -> proceeds); an unparseable lock is never taken over
// this way; a lock or folder already gone refuses `ended`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const OLD_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const ENDED_TEXT = 'that run has already ended; run /commit again';
const CREATED = '2026-09-26T13:58:02.000Z';

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function entries(c) {
  return fs.existsSync(runDirOf(c)) ? fs.readdirSync(runDirOf(c)).sort() : [];
}

function lockContent(c) {
  return JSON.parse(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'));
}

// A run held by `planId` with a FRESH lock (not stale): its folder and its lock.
function heldRun(c, planId, { folder = true, content } = {}) {
  if (folder) {
    fs.mkdirSync(path.join(runDirOf(c), planId), { recursive: true });
    fs.writeFileSync(path.join(runDirOf(c), planId, 'state.json'), '{}\n');
  } else {
    fs.mkdirSync(runDirOf(c), { recursive: true });
  }
  fs.writeFileSync(path.join(runDirOf(c), 'lock'), content ?? JSON.stringify({ planId, created: CREATED }));
  // A whole-second mtime a few minutes old: fresh (under 15 minutes) but recognisable.
  const touched = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60 * 1000);
  fs.utimesSync(path.join(runDirOf(c), 'lock'), touched, touched);
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return child.pid;
}

function callLock(c, planId, pid) {
  fs.writeFileSync(path.join(runDirOf(c), planId, 'call.lock'), JSON.stringify({ pid, host: os.hostname() }));
}

function snapshotLock(c) {
  const lock = path.join(runDirOf(c), 'lock');
  return { lock, bytes: fs.readFileSync(lock), mtimeMs: fs.statSync(lock).mtimeMs };
}

function assertLockUnchanged(before) {
  assert.deepEqual(fs.readFileSync(before.lock), before.bytes);
  assert.equal(fs.statSync(before.lock).mtimeMs, before.mtimeMs);
}

test('Seam 1: a fresh lock held by X, then plan --take-over X: the new run holds the lock, X is gone', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OLD_ID);

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 0, detail(result));
  const { planId } = result.json;
  assert.notEqual(planId, OLD_ID);
  assert.equal(lockContent(c).planId, planId);
  assert.deepEqual(entries(c), ['lock', planId].sort(), 'X folder and lock.<planId> are gone');
});

test('Seam 1: a clean tree after --take-over X: the reply carries the --take-over notice', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  heldRun(c, OLD_ID);

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.reply.notices, [`replaced the /commit run \`${OLD_ID}\` at your request`], detail(result));
  assert.deepEqual(entries(c), [], 'X and the new run are gone');
});

test('Seam 1: the lock holds Y, plan --take-over X: lock naming Y, Y put back byte for byte with its mtime', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OTHER_ID);
  const before = snapshotLock(c);

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.error.planId, OTHER_ID, detail(result));
  assert.equal(result.json.reply.handback.kind, 'lock', detail(result));
  assertLockUnchanged(before);
  assert.deepEqual(entries(c), [OTHER_ID, 'lock'].sort(), 'Y keeps its lock and folder; nothing of the call stays');
});

test('Seam 1: X call.lock holds a live pid: busy, the run is untouched', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OLD_ID);
  callLock(c, OLD_ID, process.pid);
  const before = snapshotLock(c);

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.match(result.json.error.message, /still running/, detail(result));
  assertLockUnchanged(before);
  assert.deepEqual(entries(c), [OLD_ID, 'lock'].sort());
  assert.ok(fs.existsSync(path.join(runDirOf(c), OLD_ID, 'state.json')));
});

test('Seam 1: X call.lock holds a dead pid on this host: the takeover succeeds', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OLD_ID);
  callLock(c, OLD_ID, deadPid());

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(lockContent(c).planId, result.json.planId);
  assert.deepEqual(entries(c), ['lock', result.json.planId].sort());
});

test('Seam 1: a fresh unparseable lock and --take-over: lock, the lock untouched', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OLD_ID, { content: 'not json' });
  const before = snapshotLock(c);

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.reply?.handback ?? null, null, 'an unparseable lock gets no handback (story 191)');
  assertLockUnchanged(before);
  assert.deepEqual(entries(c), [OLD_ID, 'lock'].sort());
});

test('Seam 1: a traversal planId in --take-over: usage, nothing outside .commit-plan is touched', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  fs.writeFileSync(path.join(c.repoDir, 'keep.txt'), 'keep\n');
  const before = fs.readdirSync(c.repoDir).sort();

  const result = await runCommit(c, ['plan', '--take-over', '../keep.txt']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'usage', detail(result));
  assert.deepEqual(fs.readdirSync(c.repoDir).sort(), before);
  assert.deepEqual(entries(c), []);
});

test('Seam 1 (RUN-20b item 4): no lock, plan --take-over X: lock (ended), nothing of the new run is left', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.error.message, ENDED_TEXT, detail(result));
  assert.deepEqual(entries(c), []);
});

test('Seam 1 (RUN-20b item 4): X lock in place but X folder gone: lock (ended), no lock.<planId> left', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  heldRun(c, OLD_ID, { folder: false });

  const result = await runCommit(c, ['plan', '--take-over', OLD_ID]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.error.message, ENDED_TEXT, detail(result));
  assert.deepEqual(entries(c), []);
});
