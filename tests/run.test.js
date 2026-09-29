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
