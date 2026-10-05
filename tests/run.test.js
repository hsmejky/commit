'use strict';

// RUN-01 (docs/roadmap/09-runs.md): M12's deletion guard and planId form. Every folder or
// file the script deletes is resolved and checked to lie strictly inside
// `<toplevel>/.commit-plan/` (no `..`, not absolute, not the directory itself), and every
// `planId` it reads must be the minted lowercase UUID v4 form (C:run-folder, story 206).

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');

let run;
beforeEach(async () => {
  run = await loadLib('run');
});

const RUN_DIR = path.resolve('some', 'repo', '.commit-plan');

test('insideRunDir resolves a minted planId and a file under it inside the run-folder directory', () => {
  const planId = crypto.randomUUID();
  assert.equal(run.insideRunDir(RUN_DIR, planId), path.join(RUN_DIR, planId));
  assert.equal(run.insideRunDir(RUN_DIR, 'lock'), path.join(RUN_DIR, 'lock'));
  assert.equal(run.insideRunDir(RUN_DIR, `${planId}/call.lock`), path.join(RUN_DIR, planId, 'call.lock'));
});

const REFUSED_NAMES = [
  ['empty', ''],
  ['the directory itself', '.'],
  ['a name resolving to the directory itself', 'a/..'],
  ['a parent traversal', '..'],
  ['a traversal out', '../victim'],
  ['a nested traversal out', 'a/../../victim'],
  ['a backslash traversal', '..\\victim'],
  ['a POSIX absolute path', '/etc/passwd'],
  ['a Windows drive path', 'C:\\Windows'],
  ['a Windows drive-relative path', 'C:victim'],
  ['a UNC path', '\\\\server\\share'],
  ['a NUL byte', 'a\0b'],
];

for (const [label, name] of REFUSED_NAMES) {
  test(`insideRunDir refuses ${label}`, () => {
    assert.throws(() => run.insideRunDir(RUN_DIR, name), /outside the run-folder directory/);
  });
}

test('insideRunDir refuses a non-string name', () => {
  assert.throws(() => run.insideRunDir(RUN_DIR, undefined), /outside the run-folder directory/);
  assert.throws(() => run.insideRunDir(RUN_DIR, 42), /outside the run-folder directory/);
});

test('isValidPlanId accepts randomUUID output and refuses every other form', () => {
  for (let i = 0; i < 20; i += 1) assert.equal(run.isValidPlanId(crypto.randomUUID()), true);
  const planId = crypto.randomUUID();
  for (const value of [planId.toUpperCase(), `${planId}/..`, `../${planId}`, '', null, 7, planId.slice(1)]) {
    assert.equal(run.isValidPlanId(value), false, JSON.stringify(value));
  }
});

// RUN-02 (docs/roadmap/09-runs.md): the per-call `call.lock` (`{ pid, host }`) and the
// shared rename-to-private-name, verify, unlink-or-put-back primitive (Q22, C:run-folder).
// The clock, this process's pid and host, and the pid probe are injected, so no case waits
// on or reads the wall clock.

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const HOST = 'this-host';

function tempDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-run-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// A pid that answered once and has exited since: the child ran to completion.
function exitedPid() {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.equal(result.status, 0);
  return result.pid;
}

const alive = () => true;
const dead = () => false;
const bytesOf = (content) => Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));

const STALENESS = [
  // [label, content, age, isAlive, stale]
  ['this host, dead pid, fresh: stale at once', { pid: 4242, host: HOST }, 0, dead, true],
  ['this host, live pid, fresh', { pid: 4242, host: HOST }, 0, alive, false],
  ['this host, live pid, just under 15 minutes', { pid: 4242, host: HOST }, 15 * MINUTE - 1, alive, false],
  ['this host, live pid, 15 minutes old', { pid: 4242, host: HOST }, 15 * MINUTE, alive, true],
  ['another host, fresh (its pid is never probed)', { pid: 4242, host: 'other-host' }, 0, dead, false],
  ['another host, aged', { pid: 4242, host: 'other-host' }, 16 * MINUTE, alive, true],
  ['unreadable (not JSON), fresh', '{"pid":', 0, dead, false],
  ['unreadable (not JSON), aged', '{"pid":', 16 * MINUTE, dead, true],
  ['pid 0 is unreadable, never probed', { pid: 0, host: HOST }, 0, dead, false],
  ['a negative pid is unreadable, never probed', { pid: -1, host: HOST }, 0, dead, false],
  ['a string pid is unreadable', { pid: '4242', host: HOST }, 0, dead, false],
  ['a fractional pid is unreadable', { pid: 4.5, host: HOST }, 0, dead, false],
  ['a missing host is unreadable', { pid: 4242 }, 0, dead, false],
  ['an empty file, fresh', '', 0, dead, false],
  ['a non-regular call.lock (no bytes), fresh', null, 0, dead, false],
  ['a non-regular call.lock (no bytes), aged', null, 16 * MINUTE, dead, true],
  ['an mtime in the future (clock skew)', { pid: 4242, host: 'other-host' }, -5 * MINUTE, alive, false],
];

for (const [label, content, age, isAlive, stale] of STALENESS) {
  test(`isCallLockStale: ${label} → ${stale ? 'stale' : 'live'}`, () => {
    const probed = [];
    const judged = run.isCallLockStale({
      bytes: content === null ? null : bytesOf(content),
      mtimeMs: T0 - age,
      now: T0,
      host: HOST,
      isAlive: (pid) => { probed.push(pid); return isAlive(pid); },
    });
    assert.equal(judged, stale);
    for (const pid of probed) assert.ok(Number.isSafeInteger(pid) && pid > 0, `probed ${pid}`);
  });
}

test('isPidAlive: this process answers, an exited one does not', () => {
  assert.equal(run.isPidAlive(process.pid), true);
  assert.equal(run.isPidAlive(exitedPid()), false);
});

// moveAsideVerified: rename `from` to the private `to`, read it, verify; a match leaves it at
// `to` for the caller, a mismatch links it back (never over an existing file).
test('moveAsideVerified: a match leaves the file at the private name', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'lock');
  const to = path.join(dir, 'lock.private');
  fs.writeFileSync(from, 'A');
  const seen = [];

  const result = run.moveAsideVerified({ from, to, verify: (bytes) => { seen.push(String(bytes)); return true; } });

  assert.equal(result.outcome, 'moved');
  assert.deepEqual(seen, ['A']);
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.readFileSync(to, 'utf8'), 'A');
});

test('moveAsideVerified: a mismatch puts the file back and drops the private name', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'lock');
  const to = path.join(dir, 'lock.private');
  fs.writeFileSync(from, 'B');
  const mtime = new Date(T0);
  fs.utimesSync(from, mtime, mtime);

  const result = run.moveAsideVerified({ from, to, verify: () => false });

  assert.equal(result.outcome, 'put-back');
  assert.equal(fs.readFileSync(from, 'utf8'), 'B');
  assert.equal(fs.statSync(from).mtimeMs, T0, 'the put-back keeps the mtime');
  assert.equal(fs.existsSync(to), false);
});

test('moveAsideVerified: a put-back that meets a new file keeps the private copy and never overwrites', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'lock');
  const to = path.join(dir, 'lock.private');
  fs.writeFileSync(from, 'B');

  // A third party puts its own file in place between the rename and the put-back.
  const result = run.moveAsideVerified({ from, to, verify: () => { fs.writeFileSync(from, 'C'); return false; } });

  assert.equal(result.outcome, 'conflict');
  assert.equal(fs.readFileSync(from, 'utf8'), 'C');
  assert.equal(fs.readFileSync(to, 'utf8'), 'B');
});

test('moveAsideVerified: a file already gone is reported, nothing created', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'lock');
  const to = path.join(dir, 'lock.private');

  const result = run.moveAsideVerified({ from, to, verify: () => true });

  assert.equal(result.outcome, 'gone');
  assert.deepEqual(fs.readdirSync(dir), []);
});

// releaseById with its injected clock, pid, host and pid probe.
function runFixture(t, holder) {
  const toplevel = tempDir(t);
  const runDir = path.join(toplevel, '.commit-plan');
  const folder = path.join(runDir, holder);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: holder, created: '2026-01-01T00:00:00.000Z' }));
  return { toplevel, runDir, folder, callLock: path.join(folder, 'call.lock') };
}

function writeCallLockAt(file, content, mtimeMs) {
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

test('releaseById: a live call.lock → busy, the run kept', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'busy');
  assert.equal(typeof result.message, 'string');
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST });
});

test('releaseById: the injected clock ages a live call.lock to 15 minutes → released', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0 + 15 * MINUTE, pid: 7, host: HOST, isAlive: alive });

  assert.deepEqual(result, { ok: true, released: true });
  assert.deepEqual(fs.readdirSync(f.runDir), []);
});

test('releaseById: a dead pid on the injected host → released at once', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);
  const probed = [];

  const result = run.releaseById({
    toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST,
    isAlive: (pid) => { probed.push(pid); return false; },
  });

  assert.deepEqual(result, { ok: true, released: true });
  assert.deepEqual(probed, [4242]);
  assert.deepEqual(fs.readdirSync(f.runDir), []);
});

test('releaseById writes its own { pid, host } call.lock in place of a stale one before it deletes anything', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);
  // Freezes the folder the moment the lock is renamed away (the first step of the removal).
  const frozen = path.join(f.toplevel, 'frozen');
  const realRename = fs.renameSync;
  t.after(() => { fs.renameSync = realRename; });
  fs.renameSync = function renameSync(from, to) {
    if (from === path.join(f.runDir, 'lock') && !fs.existsSync(frozen)) fs.cpSync(f.folder, frozen, { recursive: true });
    return realRename.call(this, from, to);
  };

  const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: dead });

  assert.deepEqual(result, { ok: true, released: true });
  assert.deepEqual(fs.readdirSync(frozen).sort(), ['call.lock', 'state.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(frozen, 'call.lock'), 'utf8')), { pid: 7, host: HOST });
});

// review-RUN-01 finding 1: a takeover lands between `release`'s lock read and its lock
// removal. The pid probe runs in exactly that window, so the fixture swaps the lock there.
test('releaseById: a takeover between the lock read and the removal keeps the new holder\'s lock and the run', (t) => {
  const planId = crypto.randomUUID();
  const newHolder = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);
  const newLock = JSON.stringify({ planId: newHolder, created: '2026-01-01T00:20:00.000Z' });

  const result = run.releaseById({
    toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST,
    isAlive: () => {
      // The takeover: rename the old lock away, link its own into place.
      fs.renameSync(path.join(f.runDir, 'lock'), path.join(f.runDir, `lock.${newHolder}`));
      fs.writeFileSync(path.join(f.runDir, 'lock'), newLock);
      return false;
    },
  });

  assert.deepEqual(result, { ok: true, released: false });
  assert.equal(fs.readFileSync(path.join(f.runDir, 'lock'), 'utf8'), newLock, "the new holder's lock is kept");
  assert.equal(fs.existsSync(path.join(f.folder, 'state.json')), true, 'the taken-over folder is left to the takeover');
  assert.equal(fs.existsSync(f.callLock), false, "release's own call.lock is removed on its way out");
  assert.deepEqual(fs.readdirSync(f.runDir).sort(), ['lock', `lock.${newHolder}`, planId].sort(), 'no private copy left behind');
});

test('releaseById: no call.lock when the lock does not match', (t) => {
  const holder = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const f = runFixture(t, holder);
  fs.mkdirSync(path.join(f.runDir, planId));

  const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.deepEqual(result, { ok: true, released: false });
  assert.deepEqual(fs.readdirSync(path.join(f.runDir, planId)), []);
  assert.deepEqual(fs.readdirSync(f.folder), ['state.json']);
});

// review-RUN-02 finding 8: the file-in-use → `busy` mapping (Q22) exercised on every lock
// operation `release` can reach, with the same in-process monkeypatch pattern used above (a
// real subprocess cannot cause an `EPERM`/`EBUSY`/`EACCES` on demand).
// `matches` sees the full argument list, since the path that identifies the call differs by
// function: the first argument for `readFileSync`/`writeFileSync`, the *second* (the target)
// for `renameSync`/`linkSync`.
// Returns a `restore` function so a test can lift the fault early, before an assertion that
// itself needs the real `fnName` (e.g. reading back a file the fault targets) — `t.after`
// alone only lifts it once the test body has finished.
function withFsFault(t, fnName, matches, code = 'EPERM') {
  const original = fs[fnName];
  const restore = () => { fs[fnName] = original; };
  t.after(restore);
  fs[fnName] = function faulty(...args) {
    if (matches(args)) {
      const err = new Error(`${code}: fault injected by test`);
      err.code = code;
      throw err;
    }
    return original.apply(this, args);
  };
  return restore;
}

const FAULT_CODES = ['EPERM', 'EBUSY', 'EACCES'];

for (const code of FAULT_CODES) {
  test(`releaseById: ${code} on the first lock read maps to busy, not internal (finding 4)`, (t) => {
    const planId = crypto.randomUUID();
    const f = runFixture(t, planId);
    const lockPath = path.join(f.runDir, 'lock');
    withFsFault(t, 'readFileSync', (args) => args[0] === lockPath, code);

    const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: alive });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'busy');
    assert.equal(result.message, run.BUSY_FILE_IN_USE_MESSAGE);
    assert.equal(fs.existsSync(lockPath), true, 'nothing was touched');
  });

  test(`moveAsideVerified: ${code} on the rename maps to busy, nothing moved (finding 8)`, (t) => {
    const dir = tempDir(t);
    const from = path.join(dir, 'lock');
    const to = path.join(dir, 'lock.private');
    fs.writeFileSync(from, 'A');
    withFsFault(t, 'renameSync', (args) => args[1] === to, code);

    const result = run.moveAsideVerified({ from, to, verify: () => true });

    assert.equal(result.outcome, 'busy');
    assert.equal(fs.readFileSync(from, 'utf8'), 'A', 'the file never moved');
    assert.equal(fs.existsSync(to), false);
  });

  test(`moveAsideVerified: ${code} reading the moved file maps to busy and still puts it back (finding 8)`, (t) => {
    const dir = tempDir(t);
    const from = path.join(dir, 'lock');
    const to = path.join(dir, 'lock.private');
    fs.writeFileSync(from, 'A');
    withFsFault(t, 'readFileSync', (args) => args[0] === to, code);
    let verifyCalled = false;

    const result = run.moveAsideVerified({ from, to, verify: () => { verifyCalled = true; return true; } });

    assert.equal(result.outcome, 'busy');
    assert.equal(verifyCalled, false, 'verify never ran: its bytes could not be read');
    assert.equal(fs.readFileSync(from, 'utf8'), 'A', 'the file was linked back despite the busy outcome');
    assert.equal(fs.existsSync(to), false);
  });

  test(`moveAsideVerified: ${code} on the put-back link keeps the private copy, never deletes it (finding 5, 8)`, (t) => {
    const dir = tempDir(t);
    const from = path.join(dir, 'lock');
    const to = path.join(dir, 'lock.private');
    fs.writeFileSync(from, 'B');
    withFsFault(t, 'linkSync', (args) => args[1] === from, code);

    const result = run.moveAsideVerified({ from, to, verify: () => false });

    assert.equal(result.outcome, 'busy');
    assert.equal(fs.existsSync(from), false, 'nothing was ever put back at from');
    assert.equal(fs.readFileSync(to, 'utf8'), 'B', 'the private copy is kept, not deleted');
  });
}

test('moveAsideVerified: an unexpected put-back link failure (not EEXIST, not file-in-use) throws and keeps the private copy', (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, 'lock');
  const to = path.join(dir, 'lock.private');
  fs.writeFileSync(from, 'B');
  withFsFault(t, 'linkSync', (args) => args[1] === from, 'ENOSPC');

  assert.throws(() => run.moveAsideVerified({ from, to, verify: () => false }), /ENOSPC/);
  assert.equal(fs.readFileSync(to, 'utf8'), 'B', 'the private copy is kept, not deleted, on the throw');
});

for (const code of FAULT_CODES) {
  test(`releaseById: ${code} on the wx call.lock create maps to busy (finding 8)`, (t) => {
    const planId = crypto.randomUUID();
    const f = runFixture(t, planId);
    withFsFault(t, 'writeFileSync', (args) => args[0] === f.callLock, code);

    const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: dead });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'busy');
    assert.equal(result.message, run.BUSY_FILE_IN_USE_MESSAGE);
  });

  test(`releaseById: ${code} reading an existing call.lock maps to busy (finding 8)`, (t) => {
    const planId = crypto.randomUUID();
    const f = runFixture(t, planId);
    writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);
    const restoreFault = withFsFault(t, 'readFileSync', (args) => args[0] === f.callLock, code);

    const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: dead });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'busy');
    assert.equal(result.message, run.BUSY_FILE_IN_USE_MESSAGE);
    restoreFault();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST }, 'the live call.lock is untouched');
  });
}

test('releaseById: a live call.lock (genuine busy, not file-in-use) keeps the held-lock text, distinct from the file-in-use text', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  const result = run.releaseById({ toplevel: f.toplevel, planId, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'busy');
  assert.equal(result.message, run.BUSY_MESSAGE);
});

// RUN-04 (docs/roadmap/09-runs.md): M12 `open`, `commit`'s own lock check. `runFixture`
// writes a lock holding `holder` plus `<holder>/state.json` with `{"version":1}` already
// (matching `STATE_VERSION`), so these tests only need to vary the lock, the state version
// or the call.lock on top of that fixture.

// review-RUN-04 finding 12: a `.commit-plan` that is a link (a junction on Windows, a
// directory symlink elsewhere) is not a run-folder directory: `open` must not follow it,
// mirroring the `isPlainDirectory` check `releaseById` already does on the same path.
test('open: a linked .commit-plan (junction) → ended, nothing written through the link', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const planId = crypto.randomUUID();
  const folder = path.join(target, planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(target, 'lock'), JSON.stringify({ planId, created: '2026-01-01T00:00:00.000Z' }));
  fs.symlinkSync(target, path.join(toplevel, '.commit-plan'), 'junction');
  const before = fs.readdirSync(target);

  const result = run.open(planId, { toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ended');
  assert.deepEqual(fs.readdirSync(target), before, 'nothing was written through the link');
});

test('open: the lock holds a different, well-formed planId → taken-over', (t) => {
  const holder = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const f = runFixture(t, holder);

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'taken-over');
  assert.match(result.message, /this run was taken over by another \/commit/);
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), true, "the holder's lock is left alone");
  assert.equal(fs.existsSync(f.folder), true, "the holder's folder is left alone");
});

test('open: no lock at all → ended', (t) => {
  const toplevel = tempDir(t);
  const planId = crypto.randomUUID();

  const result = run.open(planId, { toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ended');
  assert.match(result.message, /this run has already ended/);
  assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan')), false, 'nothing was created');
});

test('open: an unparseable lock → ended', (t) => {
  const toplevel = tempDir(t);
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(toplevel, '.commit-plan'), { recursive: true });
  const lockPath = path.join(toplevel, '.commit-plan', 'lock');
  fs.writeFileSync(lockPath, '{"planId":');

  const result = run.open(planId, { toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'ended');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"planId":', 'the unparseable lock is left alone');
});

test('open: the lock matches but state.json\'s version differs from this build\'s → ended', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  fs.writeFileSync(path.join(f.folder, 'state.json'), '{"version":2}\n');
  const lockPath = path.join(f.runDir, 'lock');
  fs.utimesSync(lockPath, new Date(T0 - MINUTE), new Date(T0 - MINUTE));

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'ended');
  // review-RUN-04 findings 4+5: the version check runs before the mtime touch, so a build
  // mismatch never refreshes a lock it is about to refuse.
  assert.equal(fs.statSync(lockPath).mtimeMs, T0 - MINUTE, "a version mismatch does not touch the lock's mtime");
});

// review-RUN-04 finding 1: state.json routinely exceeds the run lock's 64 KB cap (it holds
// the full unit table), so it must not inherit that cap.
test('open: state.json well past 64 KB is still read, not treated as oversized', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  fs.writeFileSync(path.join(f.folder, 'state.json'), JSON.stringify({ version: 1, padding: 'x'.repeat(100_000) }));

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, true);
});

test('open: the lock matches but state.json is missing (no folder at all) → ended', (t) => {
  const toplevel = tempDir(t);
  const planId = crypto.randomUUID();
  const runDir = path.join(toplevel, '.commit-plan');
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, 'lock');
  fs.writeFileSync(lockPath, JSON.stringify({ planId, created: '2026-01-01T00:00:00.000Z' }));

  const result = run.open(planId, { toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'ended');
  assert.equal(fs.existsSync(lockPath), true, 'the lock is left alone');
});

test('open: a matching lock and version advance the lock\'s mtime and take call.lock', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const lockPath = path.join(f.runDir, 'lock');
  fs.utimesSync(lockPath, new Date(T0 - MINUTE), new Date(T0 - MINUTE));

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.deepEqual(result, { ok: true, run: { toplevel: f.toplevel, planId, callLockPath: f.callLock } });
  assert.equal(fs.statSync(lockPath).mtimeMs, T0, "open refreshes the lock's mtime");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 7, host: HOST });
});

test('open: a live call.lock → busy, the run kept', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'busy');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST }, 'kept, not replaced');
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), true);
  assert.equal(fs.existsSync(f.folder), true);
});

// The lock the earlier `readLockFile` confirmed held `planId` vanishes before the mtime
// touch: a takeover completed in that gap, not a peaceful end (unlike `release`'s lenient
// "nothing to guard" on a holder mismatch, which never had this confirmation).
test('open: the lock vanishes between the read and the mtime touch (ENOENT) → taken-over', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const lockPath = path.join(f.runDir, 'lock');
  const realUtimes = fs.utimesSync;
  t.after(() => { fs.utimesSync = realUtimes; });
  fs.utimesSync = function utimesSync(file, ...rest) {
    if (file === lockPath) fs.rmSync(lockPath, { force: true });
    return realUtimes.call(this, file, ...rest);
  };

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'taken-over');
  assert.equal(fs.existsSync(f.folder), true, 'the folder is left alone');
  assert.equal(fs.existsSync(f.callLock), false, 'no call.lock was taken');
});

// The `<planId>` folder vanishes after the lock and state-version checks already passed (a
// concurrent `release` completing in that exact window): `takeCallLock` reports "nothing to
// guard" (`path: null`), which `open` maps to `taken-over`, not a thrown error or `internal`
// (C:cli-and-exit-codes `lock` row).
test('open: the folder vanishes just before call.lock is taken → taken-over, not an error', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const statePath = path.join(f.folder, 'state.json');
  const realRead = fs.readFileSync;
  t.after(() => { fs.readFileSync = realRead; });
  fs.readFileSync = function readFileSync(file, ...rest) {
    const result = realRead.call(this, file, ...rest);
    if (file === statePath) fs.rmSync(f.folder, { recursive: true, force: true });
    return result;
  };

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'taken-over');
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), true, 'the lock is left alone');
});

// The same race, but caught at the call.lock create itself (`writeFileSync` meets `ENOENT`
// because the folder vanished at that exact instant) rather than at the earlier folder check.
test('open: call.lock\'s own create meets ENOENT (folder vanished mid-call) → taken-over', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const realWrite = fs.writeFileSync;
  t.after(() => { fs.writeFileSync = realWrite; });
  fs.writeFileSync = function writeFileSync(file, ...rest) {
    if (file === f.callLock) {
      const err = new Error('ENOENT: simulated mid-call folder removal');
      err.code = 'ENOENT';
      throw err;
    }
    return realWrite.call(this, file, ...rest);
  };

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'taken-over');
});

// review-RUN-04 finding 10: a file-in-use error on the mtime touch maps to `busy`, not
// `internal`, like every other lock operation.
for (const code of FAULT_CODES) {
  test(`open: ${code} on the mtime touch maps to busy (finding 10)`, (t) => {
    const planId = crypto.randomUUID();
    const f = runFixture(t, planId);
    const lockPath = path.join(f.runDir, 'lock');
    withFsFault(t, 'utimesSync', (args) => args[0] === lockPath, code);

    const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'busy');
    assert.equal(result.message, run.BUSY_FILE_IN_USE_MESSAGE);
  });
}

// review-RUN-04 finding 10: `readStateVersion` throwing `InUse` (a file-in-use error on the
// state.json read) maps to `busy`, not a thrown error.
test('open: a file-in-use error reading state.json maps to busy (finding 10)', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const statePath = path.join(f.folder, 'state.json');
  withFsFault(t, 'readFileSync', (args) => args[0] === statePath, 'EBUSY');

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'busy');
  assert.equal(result.message, run.BUSY_FILE_IN_USE_MESSAGE);
});

// review-RUN-04 finding 10: a state.json whose `version` is not a number, or missing
// entirely, is treated the same as a mismatched version → `ended`.
test('open: state.json with a non-numeric version → ended (finding 10)', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  fs.writeFileSync(path.join(f.folder, 'state.json'), '{"version":"1"}\n');

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'ended');
});

test('open: state.json with no version field at all → ended (finding 10)', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  fs.writeFileSync(path.join(f.folder, 'state.json'), '{}\n');

  const result = run.open(planId, { toplevel: f.toplevel, now: () => T0, pid: 7, host: HOST, isAlive: alive });

  assert.equal(result.code, 'ended');
});

// M12 test row (RUN-04): `run.close()` called twice, and after the folder was deleted,
// succeeds without error.
test('close: idempotent — called twice, and after the folder is deleted, never throws', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  assert.doesNotThrow(() => run.close({ toplevel: f.toplevel, planId, pid: 4242, host: HOST }));
  assert.equal(fs.existsSync(f.callLock), false);
  assert.doesNotThrow(() => run.close({ toplevel: f.toplevel, planId, pid: 4242, host: HOST }), 'second close() is a no-op');

  fs.rmSync(f.folder, { recursive: true, force: true });
  assert.doesNotThrow(() => run.close({ toplevel: f.toplevel, planId, pid: 4242, host: HOST }), 'close() after the folder is gone');
});

// review-RUN-04 findings 9+13: close() only removes a call.lock holding this call's own
// { pid, host }; a call.lock written by someone else (a takeover, or a second call that
// somehow raced in) is left in place.
test('close: a call.lock held by a different { pid, host } is left alone', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  run.close({ toplevel: f.toplevel, planId, pid: 7, host: 'other-host' });

  assert.equal(fs.existsSync(f.callLock), true, 'not ours: left alone');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST });
});

// review-RUN-04 finding 19: the realistic takeover case — same host, different pid — is its
// own test rather than only being covered alongside a host change too.
test('close: a call.lock held by a different pid on this same host is left alone (finding 19)', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);

  run.close({ toplevel: f.toplevel, planId, pid: 7, host: HOST });

  assert.equal(fs.existsSync(f.callLock), true, 'not ours: left alone');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST });
});

// review-RUN-04 finding 19: a file-in-use error reading call.lock means ownership can't be
// verified right now, so close() leaves it alone instead of throwing or deleting it.
for (const code of FAULT_CODES) {
  test(`close: ${code} reading call.lock leaves it alone instead of throwing (finding 19)`, (t) => {
    const planId = crypto.randomUUID();
    const f = runFixture(t, planId);
    writeCallLockAt(f.callLock, { pid: 4242, host: HOST }, T0);
    const restore = withFsFault(t, 'readFileSync', (args) => args[0] === f.callLock, code);

    assert.doesNotThrow(() => run.close({ toplevel: f.toplevel, planId, pid: 4242, host: HOST }));

    restore();
    assert.equal(fs.existsSync(f.callLock), true, 'left alone: ownership could not be verified');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.callLock, 'utf8')), { pid: 4242, host: HOST });
  });
}

// review-RUN-04 finding 19: unparseable call.lock content (not JSON, or missing pid/host) is
// never this call's own lock, so close() leaves it alone.
test('close: unparseable call.lock content is left alone (finding 19)', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, 'not json', T0);

  run.close({ toplevel: f.toplevel, planId, pid: 4242, host: HOST });

  assert.equal(fs.existsSync(f.callLock), true, 'unparseable: left alone');
  assert.equal(fs.readFileSync(f.callLock, 'utf8'), 'not json');
});

// review-RUN-04 finding 18: a `.commit-plan` that is a link (a junction on Windows, a
// directory symlink elsewhere) is not a run-folder directory: `close` must not follow it
// either, mirroring `open`'s and `releaseById`'s own `isPlainDirectory` check on the same
// path.
test('close: a linked .commit-plan (junction) → left alone, nothing removed through the link', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const planId = crypto.randomUUID();
  const folder = path.join(target, planId);
  fs.mkdirSync(folder, { recursive: true });
  const callLock = path.join(folder, 'call.lock');
  fs.writeFileSync(callLock, JSON.stringify({ pid: 4242, host: HOST }));
  fs.symlinkSync(target, path.join(toplevel, '.commit-plan'), 'junction');

  run.close({ toplevel, planId, pid: 4242, host: HOST });

  assert.equal(fs.existsSync(callLock), true, 'nothing was removed through the link');
});

// RUN-05 (docs/roadmap/09-runs.md): M12 `create` mints the `planId` and creates the
// provisional run folder; `runDir` is absolute, `path.resolve`d from the toplevel, with
// forward slashes even on Windows (C:run-folder); `discard` removes the folder.

test('create: runDir is the provisional folder, absolute, resolved from the toplevel, forward slashes', (t) => {
  const toplevel = tempDir(t);
  const excludePath = path.join(toplevel, 'git', 'info', 'exclude');

  const created = run.create({ toplevel, excludePath });

  assert.equal(created.ok, true);
  const { planId, runDir } = created.provisional;
  assert.equal(run.isValidPlanId(planId), true);
  assert.equal(runDir, path.resolve(toplevel, '.commit-plan', planId).split(path.sep).join('/'));
  assert.equal(path.isAbsolute(runDir), true);
  assert.equal(runDir.includes('\\'), false);
  assert.equal(fs.statSync(runDir).isDirectory(), true);
  assert.equal(fs.readFileSync(excludePath, 'utf8'), '/.commit-plan\n');
});

test('create: the exclude line is appended on its own line, and not again when present', (t) => {
  const toplevel = tempDir(t);
  const excludePath = path.join(toplevel, 'exclude');
  fs.writeFileSync(excludePath, '# git ls-files --others --exclude-from=.git/info/exclude\n*.log');

  run.create({ toplevel, excludePath }).provisional.discard();
  run.create({ toplevel, excludePath }).provisional.discard();

  assert.equal(fs.readFileSync(excludePath, 'utf8'),
    '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n/.commit-plan\n');
});

test('discard: removes the provisional folder and only it', (t) => {
  const toplevel = tempDir(t);
  const excludePath = path.join(toplevel, 'exclude');
  const kept = run.create({ toplevel, excludePath }).provisional;
  const { provisional } = run.create({ toplevel, excludePath });
  fs.writeFileSync(path.join(provisional.runDir, 'git-index'), 'x');

  provisional.discard();

  assert.deepEqual(fs.readdirSync(path.join(toplevel, '.commit-plan')), [kept.planId]);
});

// RUN-05 AC1 at module level: the run-folder directory check (C:run-folder, story 207).

test('create: a tracked .commit-plan refuses with run-folder before any write', (t) => {
  const toplevel = tempDir(t);
  const excludePath = path.join(toplevel, 'exclude');

  const created = run.create({ toplevel, excludePath, tracked: true });

  assert.deepEqual(created, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_TEXT });
  assert.equal(run.RUN_FOLDER_TEXT, '`.commit-plan` is tracked or not a plain directory; remove it by hand');
  assert.equal(fs.existsSync(excludePath), false);
  assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan')), false);
});

// review-RUN-05 finding 5: when the caller names the actual tracked variant (M3
// `isTracked`'s result), the refusal text names it instead of the generic text.
test('create: a tracked .commit-plan names the actual tracked variant', (t) => {
  const toplevel = tempDir(t);
  const excludePath = path.join(toplevel, 'exclude');

  const created = run.create({ toplevel, excludePath, tracked: '.Commit-Plan' });

  assert.deepEqual(created, {
    ok: false,
    code: 'run-folder',
    message: '`.Commit-Plan` is tracked; remove it by hand',
  });
});

test('create: a link swapped in for .commit-plan by the time of its mkdir refuses, nothing written through it', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const runDir = path.join(toplevel, '.commit-plan');
  // Another process puts a link in place right as `create` makes the directory: the check
  // after `mkdir` must catch what the check before it could not see. A junction on Windows
  // needs no privileges; a symlink elsewhere.
  const realMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, options) => {
    if (path.resolve(dir) === runDir) {
      fs.symlinkSync(target, runDir, process.platform === 'win32' ? 'junction' : 'dir');
      return undefined;
    }
    return realMkdir(dir, options);
  });

  const created = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  assert.deepEqual(created, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_TEXT });
  assert.deepEqual(fs.readdirSync(target), []);
});

// review-RUN-05 finding 2: a link swapped in for `.commit-plan` after the post-mkdir check
// but before `<planId>/` is made: the check after that last mkdir refuses, so no later write
// of the run lands behind the link. The fresh empty `<planId>/` the mkdir made through the
// link is left alone (no deletion ever goes through a link).
test('create: a link swapped in for .commit-plan just before the <planId> mkdir refuses', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const runDir = path.join(toplevel, '.commit-plan');
  const realMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, options) => {
    if (path.dirname(path.resolve(dir)) === runDir) {
      fs.rmdirSync(runDir);
      fs.symlinkSync(target, runDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return realMkdir(dir, options);
  });

  const created = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  assert.deepEqual(created, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_TEXT });
  const [planId, ...rest] = fs.readdirSync(target);
  assert.deepEqual(rest, []);
  assert.deepEqual(fs.readdirSync(path.join(target, planId)), []);
});

// review-RUN-05 finding 6: the `<planId>/` half of the post-mkdir recheck
// (`!isPlainDirectory(folder)`). Here `.commit-plan` itself stays a plain directory
// throughout, so only swapping the `<planId>/` folder for a link can trip the check.
test('create: the <planId> folder swapped for a link just after its mkdir refuses, nothing written through it', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const runDir = path.join(toplevel, '.commit-plan');
  const realMkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, options) => {
    const resolved = path.resolve(dir);
    if (resolved !== runDir && path.dirname(resolved) === runDir) {
      realMkdir(resolved, options);
      fs.rmdirSync(resolved);
      fs.symlinkSync(target, resolved, process.platform === 'win32' ? 'junction' : 'dir');
      return undefined;
    }
    return realMkdir(dir, options);
  });

  const created = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  assert.deepEqual(created, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_TEXT });
  assert.equal(fs.lstatSync(runDir).isDirectory(), true);
  assert.equal(fs.lstatSync(runDir).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(target), []);
});

// review-RUN-05 finding 3: `discard` checks `.commit-plan` is still a plain directory, like
// `releaseById`, `open` and `close`: nothing is removed through a link swapped in after
// `create`.
test('discard: a link swapped in for .commit-plan after create → nothing removed through it', (t) => {
  const toplevel = tempDir(t);
  const target = tempDir(t);
  const runDir = path.join(toplevel, '.commit-plan');
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  fs.rmSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(target, provisional.planId));
  fs.writeFileSync(path.join(target, provisional.planId, 'theirs'), 'x');
  fs.symlinkSync(target, runDir, process.platform === 'win32' ? 'junction' : 'dir');

  provisional.discard();

  assert.deepEqual(fs.readdirSync(path.join(target, provisional.planId)), ['theirs']);
});

// review-RUN-05 finding 4: a removal error (a Windows file lock past `rmSync`'s retries)
// never throws out of `discard`, so it cannot replace `plan`'s outcome or original error:
// `discard` returns the notice and leaves the folder for the 24-hour sweep (C:run-folder).
test('discard: a removal error returns a notice, never throws, and keeps the folder', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });

  const notice = provisional.discard();

  assert.equal(notice, run.discardNotice(provisional.planId, 'EBUSY'));
  assert.equal(
    notice,
    `run folder \`.commit-plan/${provisional.planId}\` was not removed (EBUSY); the 24-hour sweep removes it`,
  );
  t.mock.restoreAll();
  assert.equal(fs.statSync(provisional.runDir).isDirectory(), true);
});

test('discard: a removed folder returns no notice', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  assert.equal(provisional.discard(), null);
  assert.equal(fs.existsSync(provisional.runDir), false);
});

// review-CHG-03b finding 1: once `linkSync` has put the lock in place, removing its now-
// redundant temporary file is best-effort; a failure there must not fail the acquire or lose
// the lock, because the next `/commit` would then see a lock naming a run whose folder is
// gone. The leftover temp is for the sweep (RUN-07) to collect.
test('acquire: a temp-file removal failure after a successful link does not fail the acquire', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const tempName = run.lockTempName(provisional.planId);
  const realRmSync = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(target) === tempName) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRmSync(target, options);
  });

  const acquired = provisional.acquire({ now: () => T0 });

  assert.equal(acquired.ok, true);
  const runDir = path.join(toplevel, '.commit-plan');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), true, 'the lock is in place');
  assert.equal(fs.existsSync(path.join(runDir, tempName)), true, 'the temp file is left for the sweep');
});

// RUN-21 review Medium-2: `run.finishTakeover()` is "a no-op without a takeover"
// (docs/spec/modules-m10-m13.md:279); a fresh `acquire` with no `takeOver` must still carry
// one that returns `null` and never throws, for a caller that calls it unconditionally.
test('acquire: a fresh acquire with no takeover still has a finishTakeover that is a no-op', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  const acquired = provisional.acquire({ now: () => T0 });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.run.finishTakeover(), null);
});

// review-RUN-06 finding 1: `acquire`'s lost race (`EEXIST`) must name the holder in the
// typed result (`planId`, `created`, `touched`), matching M12's interface ("`held` with
// holder") and the failure shape, not just the rendered message.
test('acquire: a lost race to a lock already in place returns held with the holder fields', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  const holderId = crypto.randomUUID();
  const created = '2026-09-26T13:58:02.000Z';
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: holderId, created }));

  const acquired = provisional.acquire({ now: () => T0 });

  assert.equal(acquired.ok, false);
  assert.equal(acquired.code, 'held');
  const touched = fs.statSync(path.join(runDir, 'lock')).mtimeMs;
  assert.deepEqual(acquired.holder, { planId: holderId, created, touched });
  assert.match(acquired.message, /^another \/commit run is in progress \(started \d{2}:\d{2}, last active \d+ s ago\)$/);
  assert.equal(fs.readFileSync(path.join(runDir, 'lock'), 'utf8'), JSON.stringify({ planId: holderId, created }), "the winner's lock is untouched");
});

// RUN-07: a read-only `peek` before any inventory work. A live lock refuses `held` the same
// way `acquire`'s lost race does (RUN-06), carrying the same holder fields.
test('peek: no lock is ok and touches nothing', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });

  assert.deepEqual(provisional.peek({ now: () => T0 }), { ok: true, stale: null });
});

test('peek: a fresh lock held by another planId refuses held with the holder fields, matching acquire\'s shape', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  const holderId = crypto.randomUUID();
  const created = '2026-09-26T13:58:02.000Z';
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: holderId, created }));
  const touched = fs.statSync(path.join(runDir, 'lock')).mtimeMs;

  const peeked = provisional.peek({ now: () => touched + 40_000 });

  assert.equal(peeked.ok, false);
  assert.equal(peeked.code, 'held');
  assert.deepEqual(peeked.holder, { planId: holderId, created, touched });
  assert.match(peeked.message, /^another \/commit run is in progress \(started \d{2}:\d{2}, last active 40 s ago\)$/);
  assert.equal(fs.readFileSync(path.join(runDir, 'lock'), 'utf8'), JSON.stringify({ planId: holderId, created }), 'the holder\'s lock is untouched');
});

test('peek: a fresh lock with garbage content refuses held with planId: null', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  fs.writeFileSync(path.join(runDir, 'lock'), 'not json');
  const touched = fs.statSync(path.join(runDir, 'lock')).mtimeMs;

  const peeked = provisional.peek({ now: () => touched + 1000 });

  assert.equal(peeked.ok, false);
  assert.equal(peeked.code, 'held');
  assert.deepEqual(peeked.holder, { planId: null, created: null, touched });
  assert.equal(peeked.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
});

test('peek: a fresh lock whose planId is not in the minted form refuses held with planId and created null', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: 'not-a-uuid', created: '2026-09-26T13:58:02.000Z' }));
  const touched = fs.statSync(path.join(runDir, 'lock')).mtimeMs;

  const peeked = provisional.peek({ now: () => touched + 1000 });

  assert.equal(peeked.ok, false);
  assert.equal(peeked.code, 'held');
  // C:cli-and-exit-codes: a malformed `planId` nulls `created` too (a corrupt or foreign lock).
  assert.deepEqual(peeked.holder, { planId: null, created: null, touched });
});

test('peek: a lock one millisecond short of stale still refuses held', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: crypto.randomUUID(), created: '2026-09-26T13:58:02.000Z' }));
  const touched = fs.statSync(path.join(runDir, 'lock')).mtimeMs;

  const peeked = provisional.peek({ now: () => touched + run.STALE_AFTER_MS - 1 });

  assert.equal(peeked.ok, false);
  assert.equal(peeked.code, 'held');
});

// review-RUN-07 finding 5: the holder comes from the one read `peek` already made, so a
// holder releasing right after that read never turns the refusal into a holder-less one.
test('peek: the holder is named from its single read of the lock, even if the lock goes right after it', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  const lock = path.join(runDir, 'lock');
  const holderId = crypto.randomUUID();
  const created = '2026-09-26T13:58:02.000Z';
  fs.writeFileSync(lock, JSON.stringify({ planId: holderId, created }));
  const touched = fs.statSync(lock).mtimeMs;
  const realRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (target, options) => {
    const bytes = realRead(target, options);
    if (path.resolve(String(target)) === lock) {
      reads += 1;
      fs.unlinkSync(lock);
    }
    return bytes;
  });

  const peeked = provisional.peek({ now: () => touched + 1000 });

  assert.equal(reads, 1);
  assert.equal(peeked.code, 'held');
  assert.deepEqual(peeked.holder, { planId: holderId, created, touched });
});

// RUN-21: a lock stale by mtime is `ok`, and `stale` carries what `acquire({ takeOver })`
// verifies the moved lock against (its bytes and its mtime, Q22) and the `planId` the
// takeover notice names (`null` for a lock with no minted `planId`).
test('peek: a lock stale by mtime is ok and reports it as stale', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  const holderId = crypto.randomUUID();
  const content = JSON.stringify({ planId: holderId, created: '2026-09-26T13:58:02.000Z' });
  fs.writeFileSync(path.join(runDir, 'lock'), content);
  const stats = fs.statSync(path.join(runDir, 'lock'));
  const staleAt = stats.mtimeMs + run.STALE_AFTER_MS;

  assert.deepEqual(provisional.peek({ now: () => staleAt }), {
    ok: true,
    stale: { planId: holderId, touched: stats.mtimeMs, size: stats.size, bytes: Buffer.from(content) },
  });
});

test('peek: a stale unparseable lock is stale too, with planId: null', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  fs.writeFileSync(path.join(runDir, 'lock'), 'not json');
  const stats = fs.statSync(path.join(runDir, 'lock'));

  const peeked = provisional.peek({ now: () => stats.mtimeMs + run.STALE_AFTER_MS });

  assert.deepEqual(peeked, { ok: true, stale: { planId: null, touched: stats.mtimeMs, size: 8, bytes: Buffer.from('not json') } });
});

// RUN-21 (Q22, C:plan step 3): the automatic takeover. A stale run `X` with its folder, aged
// past 15 minutes; `peek` reports it and `acquire({ takeOver })` renames it to
// `lock.<own planId>`, verifies bytes and mtime, and links its own lock.
function staleRun(t, { content } = {}) {
  const toplevel = tempDir(t);
  const created = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: () => {} });
  const runDir = path.join(toplevel, '.commit-plan');
  const staleId = crypto.randomUUID();
  fs.mkdirSync(path.join(runDir, staleId));
  fs.writeFileSync(path.join(runDir, staleId, 'state.json'), '{}\n');
  const lock = path.join(runDir, 'lock');
  const bytes = content ?? JSON.stringify({ planId: staleId, created: '2026-09-26T13:58:02.000Z' });
  fs.writeFileSync(lock, bytes);
  const aged = new Date(T0 - run.STALE_AFTER_MS - 60_000);
  fs.utimesSync(lock, aged, aged);
  const now = () => T0;
  const peeked = created.provisional.peek({ now });
  assert.equal(peeked.ok, true);
  assert.notEqual(peeked.stale, null);
  return { provisional: created.provisional, runDir, lock, staleId, bytes, aged, now, stale: peeked.stale };
}

test('takeoverNotice names the stale planId, or the unreadable lock', () => {
  const planId = '11111111-1111-4111-8111-111111111111';
  assert.equal(run.takeoverNotice(planId), 'took over the stale /commit run `11111111-1111-4111-8111-111111111111` (idle for 15 minutes or more)');
  assert.equal(run.takeoverNotice(null), 'took over a stale, unreadable /commit lock (idle for 15 minutes or more)');
});

test('acquire takeOver: links its own lock, keeps the renamed lock until finishTakeover, which deletes the old folder and then it', (t) => {
  const { provisional, runDir, lock, staleId, bytes, now, stale } = staleRun(t);
  const renamed = path.join(runDir, `lock.${provisional.planId}`);

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, true);
  assert.deepEqual(acquired.takeover, { planId: staleId, notice: run.takeoverNotice(staleId), killedRun: null });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).planId, provisional.planId);
  assert.equal(fs.readFileSync(renamed, 'utf8'), bytes, 'the renamed lock keeps the stale bytes');
  assert.ok(fs.existsSync(path.join(runDir, staleId)), 'the old folder waits for finishTakeover');

  assert.equal(acquired.run.finishTakeover(), null);

  assert.equal(fs.existsSync(path.join(runDir, staleId)), false);
  assert.equal(fs.existsSync(renamed), false);
  assert.deepEqual(fs.readdirSync(runDir).sort(), ['lock', provisional.planId].sort());
});

test('acquire takeOver: the old folder is deleted before the renamed lock (RUN-20b item 2)', (t) => {
  const { provisional, runDir, staleId, now, stale } = staleRun(t);
  const acquired = provisional.acquire({ now, takeOver: stale });
  const realRm = fs.rmSync;
  const order = [];
  t.mock.method(fs, 'rmSync', (target, options) => {
    order.push(path.basename(String(target)));
    return realRm(target, options);
  });

  acquired.run.finishTakeover();

  assert.deepEqual(order, [staleId, `lock.${provisional.planId}`]);
  assert.equal(fs.existsSync(path.join(runDir, staleId)), false);
});

test('acquire takeOver: a stale unparseable lock is taken over; finishTakeover deletes only the renamed lock', (t) => {
  const { provisional, runDir, lock, staleId, now, stale } = staleRun(t, { content: 'not json' });

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, true);
  assert.deepEqual(acquired.takeover, { planId: null, notice: run.takeoverNotice(null), killedRun: null });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).planId, provisional.planId);
  assert.equal(acquired.run.finishTakeover(), null);
  assert.equal(fs.existsSync(path.join(runDir, `lock.${provisional.planId}`)), false);
  assert.ok(fs.existsSync(path.join(runDir, staleId)), 'no planId names a folder to delete');
});

test('acquire takeOver: a lock touched after the peek is put back byte for byte with its mtime, and refuses held', (t) => {
  const { provisional, runDir, lock, bytes, now, stale } = staleRun(t);
  const touchedAgain = new Date(T0 - 1000);
  fs.utimesSync(lock, touchedAgain, touchedAgain);

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, false);
  assert.equal(acquired.code, 'held');
  assert.equal(acquired.holder.touched, touchedAgain.getTime());
  assert.equal(fs.readFileSync(lock, 'utf8'), bytes);
  assert.equal(fs.statSync(lock).mtimeMs, touchedAgain.getTime());
  assert.equal(fs.existsSync(path.join(runDir, `lock.${provisional.planId}`)), false);
});

test('acquire takeOver: a lock replaced after the peek (same mtime, other bytes) is put back and refuses held', (t) => {
  const { provisional, lock, aged, now, stale } = staleRun(t);
  const other = JSON.stringify({ planId: crypto.randomUUID(), created: '2026-09-26T13:58:03.000Z' });
  fs.writeFileSync(lock, other);
  fs.utimesSync(lock, aged, aged);

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, false);
  assert.equal(acquired.code, 'held');
  assert.equal(fs.readFileSync(lock, 'utf8'), other);
});

// RUN-21 review Medium-1: the ENOENT-with-a-new-lock-in-place case moved to Seam 1
// (tests/plan-takeover.test.js, "a rename ENOENT on the takeover with the stale lock still
// in place refuses held naming it"); this case ("no lock in place") cannot be reached at
// Seam 1 without a further preload change (the fault only throws, it cannot also remove the
// lock file), so it stays here (KD-R, docs/roadmap/known-deficiencies.md).
test('acquire takeOver: a rename ENOENT with no lock in place links its own lock, with no takeover', (t) => {
  const { provisional, lock, now, stale } = staleRun(t);
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(String(from)) === lock) {
      fs.unlinkSync(lock);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return realRename(from, to);
  });

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.takeover, null);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).planId, provisional.planId);
});

test('acquire takeOver: a lock linked by another call after the rename refuses held and deletes nothing of the takeover', (t) => {
  const { provisional, runDir, lock, staleId, bytes, now, stale } = staleRun(t);
  const otherId = crypto.randomUUID();
  const realLink = fs.linkSync;
  t.mock.method(fs, 'linkSync', (existing, target) => {
    if (path.resolve(String(target)) === lock) {
      fs.writeFileSync(lock, JSON.stringify({ planId: otherId, created: '2026-09-26T14:20:00.000Z' }));
    }
    return realLink(existing, target);
  });

  const acquired = provisional.acquire({ now, takeOver: stale });

  assert.equal(acquired.ok, false);
  assert.equal(acquired.code, 'held');
  assert.equal(acquired.holder.planId, otherId);
  assert.equal(fs.readFileSync(path.join(runDir, `lock.${provisional.planId}`), 'utf8'), bytes);
  assert.ok(fs.existsSync(path.join(runDir, staleId)));
});

// RUN-21 review Medium-1: moved to Seam 1 (tests/plan-takeover.test.js, "a file in use on
// the takeover rename is busy, the stale lock and folder stay"), now that the fault preload
// can match the takeover rename's source basename.

test('finishTakeover: a failed old-folder deletion becomes a notice and keeps the renamed lock', (t) => {
  const { provisional, runDir, staleId, now, stale } = staleRun(t);
  const acquired = provisional.acquire({ now, takeOver: stale });
  const realRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(String(target)) === staleId) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return realRm(target, options);
  });

  assert.equal(acquired.run.finishTakeover(), run.discardNotice(staleId, 'EBUSY'));
  assert.ok(fs.existsSync(path.join(runDir, `lock.${provisional.planId}`)), 'the renamed lock is kept');
});

test('peek: a lock file in use (Windows) is busy, not held', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const runDir = path.join(toplevel, '.commit-plan');
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId: crypto.randomUUID(), created: '2026-09-26T13:58:02.000Z' }));
  const realLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, options) => {
    if (path.resolve(target) === path.join(runDir, 'lock')) {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    return realLstat(target, options);
  });

  const peeked = provisional.peek({ now: () => T0 });

  assert.equal(peeked.ok, false);
  assert.equal(peeked.code, 'busy');
});

// RUN-09 (docs/roadmap/09-runs.md, Q22, C:run-folder "lock" row): Windows file-in-use errors
// on the lock link (`EPERM`/`EBUSY`) retry about a second, then fall back to a hard-link
// probe; `ENOTSUP`/`ENOSYS` skip straight to `run-folder`. `sleep` is stubbed to a no-op so no
// case waits on a real delay (every CI OS, no real Windows lock needed).
const NO_SLEEP = () => {};

for (const code of ['EPERM', 'EBUSY']) {
  test(`acquire: ${code} on the lock link that clears within the retries still succeeds`, (t) => {
    const toplevel = tempDir(t);
    const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
    const realLinkSync = fs.linkSync;
    let failuresLeft = 2;
    t.mock.method(fs, 'linkSync', (existing, target) => {
      if (path.basename(target) === 'lock' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error(code), { code });
      }
      return realLinkSync(existing, target);
    });

    const acquired = provisional.acquire({ now: () => T0 });

    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan', 'lock')), true);
    assert.deepEqual(fs.readdirSync(provisional.runDir).filter((name) => name.startsWith('hardlink-probe')), [], 'no probe when the link eventually succeeds');
  });

  // review-RUN-09 finding 7: the failure here comes from the lock's temporary file (the link
  // *source*) being held, so any link from it fails; the probe links a fresh source of its own
  // inside the `<planId>/` folder and still succeeds → `busy`.
  test(`acquire: ${code} on the lock link persisting past the retries, probe from a fresh source succeeds → busy, nothing left`, (t) => {
    const toplevel = tempDir(t);
    const sleeps = [];
    const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: (ms) => sleeps.push(ms) });
    const realLinkSync = fs.linkSync;
    const links = [];
    t.mock.method(fs, 'linkSync', (existing, target) => {
      links.push(`${path.relative(toplevel, existing)} -> ${path.relative(toplevel, target)}`.split(path.sep).join('/'));
      if (path.basename(existing).startsWith('lock-')) throw Object.assign(new Error(code), { code });
      return realLinkSync(existing, target);
    });

    const acquired = provisional.acquire({ now: () => T0 });

    assert.deepEqual(acquired, { ok: false, code: 'busy', message: run.BUSY_FILE_IN_USE_MESSAGE });
    const lockLink = `.commit-plan/${run.lockTempName(provisional.planId)} -> .commit-plan/lock`;
    const folder = `.commit-plan/${provisional.planId}`;
    assert.deepEqual(links, [...Array(6).fill(lockLink), `${folder}/hardlink-probe.tmp -> ${folder}/hardlink-probe.link`]);
    assert.deepEqual(sleeps, [100, 150, 200, 250, 300]);
    assert.deepEqual(fs.readdirSync(path.join(toplevel, '.commit-plan')), [provisional.planId], 'no lock and no temp left');
    assert.deepEqual(fs.readdirSync(provisional.runDir), [], 'both probe files removed');
  });
}

// review-RUN-09 finding 6: only a successful link can leave the probe's link name behind, so
// an `EEXIST` on it (a leftover from an earlier probe in this folder) proves hard links work.
test('acquire: EPERM persisting on the lock link with a leftover probe link → still busy, not run-folder', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
  fs.writeFileSync(path.join(provisional.runDir, 'hardlink-probe.link'), '');
  const realLinkSync = fs.linkSync;
  t.mock.method(fs, 'linkSync', (existing, target) => {
    if (path.basename(target) === 'lock') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return realLinkSync(existing, target);
  });

  const acquired = provisional.acquire({ now: () => T0 });

  assert.deepEqual(acquired, { ok: false, code: 'busy', message: run.BUSY_FILE_IN_USE_MESSAGE });
  assert.deepEqual(fs.readdirSync(provisional.runDir), [], 'the leftover and the fresh source removed');
});

test('acquire: EPERM on the lock link persisting past the retries, probe also fails → run-folder', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  });

  const acquired = provisional.acquire({ now: () => T0 });

  assert.deepEqual(acquired, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_NO_HARD_LINKS_TEXT });
  assert.deepEqual(fs.readdirSync(path.join(toplevel, '.commit-plan')), [provisional.planId], 'no lock and no temp left');
});

for (const code of ['ENOTSUP', 'ENOSYS']) {
  test(`acquire: ${code} on the lock link refuses run-folder at once, without a probe`, (t) => {
    const toplevel = tempDir(t);
    const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
    const realLinkSync = fs.linkSync;
    const linkTargets = [];
    t.mock.method(fs, 'linkSync', (existing, target) => {
      linkTargets.push(path.basename(target));
      if (path.basename(target) === 'lock') throw Object.assign(new Error(code), { code });
      return realLinkSync(existing, target);
    });

    const acquired = provisional.acquire({ now: () => T0 });

    assert.deepEqual(acquired, { ok: false, code: 'run-folder', message: run.RUN_FOLDER_NO_HARD_LINKS_TEXT });
    assert.deepEqual(linkTargets, ['lock'], 'a single attempt, no retry and no probe link');
  });
}

test('acquire: EIO on the lock link still throws (unaffected by the retry/probe)', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('EIO'), { code: 'EIO' });
  });

  assert.throws(() => provisional.acquire({ now: () => T0 }), /EIO/);
  assert.deepEqual(fs.readdirSync(path.join(toplevel, '.commit-plan')), [provisional.planId], 'the temp is still cleaned up');
});

for (const code of ['EPERM', 'EBUSY']) {
  test(`write: ${code} on a run-file rename that clears within the retries still succeeds`, (t) => {
    const toplevel = tempDir(t);
    const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
    const realRenameSync = fs.renameSync;
    let failuresLeft = 2;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(to) === 'state.json' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error(code), { code });
      }
      return realRenameSync(from, to);
    });

    provisional.write('state.json', '{}');

    assert.equal(fs.readFileSync(path.join(provisional.runDir, 'state.json'), 'utf8'), '{}');
  });

  test(`write: ${code} on a run-file rename persisting past the retries still counts as a failure`, (t) => {
    const toplevel = tempDir(t);
    const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: NO_SLEEP });
    t.mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error(code), { code });
    });

    assert.throws(() => provisional.write('state.json', '{}'), new RegExp(code));
  });
}

// review-RUN-09 finding 11: the run `acquire` returns writes `plan.json`/`hunks.txt` with the
// same injected `sleep` as the provisional `write`, never a real delay.
test('write after acquire: a persisting EPERM on the rename retries with the injected sleep', (t) => {
  const toplevel = tempDir(t);
  const sleeps = [];
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false, sleep: (ms) => sleeps.push(ms) });
  const acquired = provisional.acquire({ now: () => T0 });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  });

  assert.throws(() => acquired.run.write('plan.json', '{}'), /EPERM/);
  assert.deepEqual(sleeps, [100, 150, 200, 250, 300]);
});

// review-CHG-03b finding 2: `release()` on a lock rename that hits a file-in-use error
// (`busy`, like `releaseById`'s own case) must not silently lose the lock: it reports a
// notice and `kept: true`, so `plan`'s `finally` leaves the folder in place too.
test('release: a busy lock rename reports a notice and kept: true, the lock stays (finding 2, 10)', (t) => {
  const toplevel = tempDir(t);
  const { provisional } = run.create({ toplevel, excludePath: path.join(toplevel, 'exclude'), tracked: false });
  const acquired = provisional.acquire({ now: () => T0 });
  assert.equal(acquired.ok, true);
  const lockPath = path.join(toplevel, '.commit-plan', 'lock');
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === lockPath) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRename(from, to);
  });

  const released = acquired.run.release();

  assert.deepEqual(released, { notice: run.lockKeptNotice(provisional.planId), kept: true });
  // finding 10: the busy-lock notice reads differently from the folder-removal notice.
  assert.notEqual(released.notice, run.discardNotice(provisional.planId, 'EPERM'));
  assert.equal(fs.existsSync(lockPath), true, 'the lock stays in place');
  assert.equal(fs.existsSync(provisional.runDir), true, 'the folder stays too');
});

// review-RUN-05 finding 7: git strips only unescaped trailing spaces from an exclude line,
// so `/.commit-plan<TAB>` does not match `.commit-plan` and the line is still added; a line
// with trailing spaces does match and is not added again.
test('create: an exclude line with a trailing tab is not the exclude line; trailing spaces are', (t) => {
  const toplevel = tempDir(t);
  const tabbed = path.join(toplevel, 'tabbed');
  const spaced = path.join(toplevel, 'spaced');
  fs.writeFileSync(tabbed, '/.commit-plan\t\n');
  fs.writeFileSync(spaced, '/.commit-plan  \n');

  run.create({ toplevel, excludePath: tabbed, tracked: false }).provisional.discard();
  run.create({ toplevel, excludePath: spaced, tracked: false }).provisional.discard();

  assert.equal(fs.readFileSync(tabbed, 'utf8'), '/.commit-plan\t\n/.commit-plan\n');
  assert.equal(fs.readFileSync(spaced, 'utf8'), '/.commit-plan  \n');
});

// EXE-02: M12 `touch()` before each group, and the release of a run `open` returned.
test('touch: a lock still holding planId gets its mtime refreshed', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  const lockPath = path.join(f.runDir, 'lock');
  fs.utimesSync(lockPath, new Date(T0 - MINUTE), new Date(T0 - MINUTE));

  const result = run.touch({ toplevel: f.toplevel, planId }, { now: () => T0 });

  assert.deepEqual(result, { ok: true });
  assert.equal(fs.statSync(lockPath).mtimeMs, T0);
});

test('touch: a lock holding another planId → taken-over, the lock untouched', (t) => {
  const holder = crypto.randomUUID();
  const f = runFixture(t, holder);
  const lockPath = path.join(f.runDir, 'lock');
  fs.utimesSync(lockPath, new Date(T0 - MINUTE), new Date(T0 - MINUTE));

  const result = run.touch({ toplevel: f.toplevel, planId: crypto.randomUUID() }, { now: () => T0 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'taken-over');
  assert.equal(fs.statSync(lockPath).mtimeMs, T0 - MINUTE);
});

test('touch: no lock at all → taken-over', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  fs.rmSync(path.join(f.runDir, 'lock'));

  const result = run.touch({ toplevel: f.toplevel, planId }, { now: () => T0 });

  assert.equal(result.code, 'taken-over');
});

test('releaseOpen: removes the lock and the run folder, call.lock included', (t) => {
  const planId = crypto.randomUUID();
  const f = runFixture(t, planId);
  writeCallLockAt(f.callLock, { pid: 7, host: HOST }, T0);

  const result = run.releaseOpen({ toplevel: f.toplevel, planId });

  assert.deepEqual(result, { notice: null, kept: false });
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), false);
  assert.equal(fs.existsSync(f.folder), false);
});

test('releaseOpen: a lock holding another planId is left alone, with the folders', (t) => {
  const holder = crypto.randomUUID();
  const f = runFixture(t, holder);
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(f.runDir, planId));

  const result = run.releaseOpen({ toplevel: f.toplevel, planId });

  assert.deepEqual(result, { notice: null, kept: false });
  assert.equal(fs.existsSync(path.join(f.runDir, 'lock')), true);
  assert.equal(fs.existsSync(f.folder), true);
});
