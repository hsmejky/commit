// M12 Run (docs/spec/modules-m10-m13.md, Q9, Q22, C:run-folder): everything under the run
// folder. Effectful (filesystem); it spawns nothing.
//
// RUN-01 builds the tracer bullet: the minted `planId` form, the check that keeps every
// deletion strictly inside the run-folder directory, and `releaseById`. RUN-02 adds the
// `call.lock` a matching `release` takes before it deletes anything (`busy`), and the shared
// rename-verify-unlink-or-put-back primitive (`moveAsideVerified`) that removes the lock and
// replaces a stale `call.lock`, and that `acquire`'s takeover reuses; later RUN slices add `Run.create`, `peek`, `acquire`, `open`, `close`, the typed state and the sweep.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The run-folder directory's name under the toplevel (C:run-folder). */
export const RUN_DIR_NAME = '.commit-plan';

// `planId` is `crypto.randomUUID()` output (C:run-folder): a lowercase UUID v4, version
// nibble `4` and variant nibble `8`-`b` included, so an uppercase value, a path, or any
// other string that merely looks like a UUID is rejected.
const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Checks whether a value is a `planId` in the exact minted form (C:run-folder). Every
 * `planId` the script reads (`--plan`, `--take-over`, a lock's content) must pass it.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPlanId(value) {
  return typeof value === 'string' && PLAN_ID_PATTERN.test(value);
}

/**
 * The run-folder directory of a working tree (C:run-folder: per worktree).
 *
 * @param {string} toplevel the working tree's toplevel.
 * @returns {string}
 */
export function runDirOf(toplevel) {
  return path.join(toplevel, RUN_DIR_NAME);
}

function outside(name) {
  return new Error(`refusing a path outside the run-folder directory: ${JSON.stringify(name)}`);
}

/**
 * Resolves a name relative to the run-folder directory, checked to lie strictly inside it
 * (C:run-folder, story 206): not absolute on any platform, no `..` segment, and not the
 * directory itself. Every deletion goes through it.
 *
 * @param {string} runDir the run-folder directory (absolute).
 * @param {string} name a relative name such as a `planId` or `<planId>/call.lock`.
 * @returns {string} the resolved absolute path.
 * @throws {Error} when the name would resolve anywhere else.
 */
export function insideRunDir(runDir, name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) throw outside(name);
  // Absolute in either path flavour, or a Windows drive-relative `C:name`.
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw outside(name);
  }
  if (name.split(/[\\/]/).includes('..')) throw outside(name);
  const resolved = path.resolve(runDir, name);
  const relative = path.relative(runDir, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw outside(name);
  }
  return resolved;
}

// Whether `dir` is a plain directory: never a symlink or junction, never a non-directory.
// Shared by the run-folder directory check and the `<planId>` folder check right before a
// `call.lock` write (review-RUN-01 finding 1): a link swapped in for either is never
// followed, so a release or a lock write behind it never lands outside the run-folder
// directory (C:run-folder). Formerly two line-for-line copies (`isPlainDirectory`,
// `isRunFolder`); merged (review-RUN-02 findings 3, 10).
function isPlainDirectory(dir) {
  let stats;
  try {
    stats = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
  return stats.isDirectory() && !stats.isSymbolicLink();
}

// The lock holds only `{ planId, created }` (C:run-folder); a few KB is generous. Checked
// before the read so an oversized file, or a non-regular one (a FIFO would otherwise block
// `readFileSync` forever on POSIX), is never opened (review-RUN-01 finding 10).
const LOCK_MAX_BYTES = 65536;

/**
 * Reads the run lock's `planId`. A missing lock, and a lock whose content is not `{ planId,
 * … }` with a minted `planId` (unparseable, C:run-folder), hold no run.
 *
 * @param {string} runDir
 * @returns {string | null} the holder's `planId`, or `null` when no run holds the lock.
 */
// Reads without following a link (`readLockFile`, `lstat`): a link in place of `lock` is
// never a legitimate state (`plan` only ever hard-links a regular file into place), and
// this keeps every lock-type read consistent (review-RUN-02 finding 3; formerly a
// `statSync`-based duplicate of `lockPlanId`'s parse, merged per finding 10). A file-in-use
// error propagates as `InUse` for the caller to map to `busy` (finding 4).
function lockHolder(runDir) {
  const file = readLockFile(insideRunDir(runDir, 'lock'));
  return file === null ? null : lockPlanId(file.bytes);
}

/** A `call.lock` (and, later, the run lock) is stale once its mtime is this old (Q22). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

// Windows reports a file another process holds open as one of these on a rename, read or
// unlink: "someone else is on it", `busy`, never `internal` (Q22, C:run-folder).
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);

class InUse extends Error {}

function inUse(err) {
  return err && IN_USE.has(err.code) ? new InUse(err.message) : err;
}

/**
 * Reads a lock-type file without following a link: `null` when it is gone, else its
 * `lstat` and its bytes, `bytes: null` for a non-regular file or one past the size cap.
 * A file-in-use error throws `InUse`.
 */
function readLockFile(file) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw inUse(err);
  }
  if (!stats.isFile() || stats.size > LOCK_MAX_BYTES) return { stats, bytes: null };
  try {
    return { stats, bytes: fs.readFileSync(file) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw inUse(err);
  }
}

/**
 * The shared atomic replacement of a lock-type file (Q22 takeover; `release`'s lock
 * removal, a stale `call.lock`): renames `from` to the private name `to` (only one of
 * several renames of one file succeeds), reads it, and asks `verify` whether it is the file
 * the caller decided on (a rename keeps the mtime). On a match the file stays at `to` for
 * the caller to unlink or keep. On a mismatch it is linked back (`linkSync` never
 * overwrites) and the private name dropped; when a new file already sits at `from`, the
 * private copy is kept instead (an orphan for the lock's new holder to adopt).
 *
 * @param {{ from: string, to: string,
 *   verify: (bytes: Buffer | null, stats: fs.Stats) => boolean }} options
 * @returns {{ outcome: 'moved' | 'put-back' | 'conflict' | 'gone' | 'busy' }} `gone`: the
 *   rename found nothing; `busy`: a file-in-use error on the rename, the read, or the
 *   put-back link — the private copy is always kept in this case, never dropped (review-
 *   RUN-02 finding 5); `conflict`: the put-back link met `EEXIST` (a new file already at
 *   `from`), the only case where the private copy is safely dropped without it.
 */
export function moveAsideVerified({ from, to, verify }) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === 'ENOENT') return { outcome: 'gone' };
    if (IN_USE.has(err.code)) return { outcome: 'busy' };
    throw err;
  }
  let moved = null;
  let readInUse = false;
  try {
    moved = readLockFile(to);
  } catch (err) {
    if (!(err instanceof InUse)) throw err;
    readInUse = true;
  }
  if (moved !== null && verify(moved.bytes, moved.stats)) return { outcome: 'moved' };
  try {
    fs.linkSync(to, from);
  } catch (err) {
    // `EEXIST`: a new file is already in place at `from` (another call's live lock, or a
    // takeover's own lock) — the stale private copy is safely dropped (review-RUN-02
    // finding 5: only this case is `conflict`; a non-`EEXIST` failure below never deletes
    // another call's live lock, because nothing proves one is there).
    if (err.code === 'EEXIST') return { outcome: readInUse ? 'busy' : 'conflict' };
    // A file-in-use failure on the link itself: `from` may still be empty. The private copy
    // stays at `to`, never dropped, so the lock is not lost; `busy` tells the caller to
    // leave it and retry.
    if (IN_USE.has(err.code)) return { outcome: 'busy' };
    // Anything else (`EMLINK`, a vanished `to`, …) is unexpected: surface it, and leave the
    // private copy in place rather than guess at deleting it (finding 5).
    throw err;
  }
  fs.rmSync(to, { force: true });
  return { outcome: readInUse ? 'busy' : 'put-back' };
}

/**
 * Whether `process.kill(pid, 0)` finds the process: only `ESRCH` means it is gone; an
 * answer, `EPERM` included, means it lives (Q22).
 *
 * @param {number} pid a positive integer.
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// `{ pid, host }` with a positive integer pid and a non-empty host, else `null`
// (unreadable). A pid of 0 or below is never probed: `kill` would signal a process group.
function parseCallLock(bytes) {
  if (bytes === null) return null;
  let content;
  try {
    content = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (content === null || typeof content !== 'object') return null;
  const { pid, host } = content;
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof host !== 'string' || host === '') return null;
  return { pid, host };
}

/**
 * Judges a `call.lock` (Q22, C:run-folder): stale at once when it names this host and its
 * pid is gone; otherwise (another host, unreadable content, a pid that answers) stale once
 * its mtime is 15 minutes old by the injected clock. Pure given `isAlive`.
 *
 * @param {{ bytes: Buffer | null, mtimeMs: number, now: number, host: string,
 *   isAlive: (pid: number) => boolean }} options
 * @returns {boolean}
 */
export function isCallLockStale({ bytes, mtimeMs, now, host, isAlive }) {
  const content = parseCallLock(bytes);
  if (content !== null && content.host === host && !isAlive(content.pid)) return true;
  return now - mtimeMs >= STALE_AFTER_MS;
}

// `busy`'s text (Q22, C:cli-and-exit-codes `lock` row) covers two different causes: a live
// `call.lock` naming a running process (`fileInUse: false`), and a lock-type file another
// process has open, which on Windows fails a rename, read or link with `EPERM`/`EBUSY`/
// `EACCES` (`fileInUse: true`). On Windows both really mean "another process has the file",
// so the same text fits; on POSIX those codes more often mean a real permission problem, not
// a running call, so the file-in-use case gets its own text there (review-RUN-02 finding 6).
export const BUSY_MESSAGE = 'another /commit call on this run is still running; try again once it has finished';
export const BUSY_FILE_IN_USE_MESSAGE = process.platform === 'win32'
  ? BUSY_MESSAGE
  : "the run's lock could not be read or replaced (permission denied or in use); try again";

function busy(fileInUse = false) {
  return { ok: false, code: 'busy', message: fileInUse ? BUSY_FILE_IN_USE_MESSAGE : BUSY_MESSAGE };
}

// M12 `open`'s other two typed refusals (Q22, C:run-folder "versioned state"): no lock, or a
// state `version` this build does not recognize ("a run started by another plugin build");
// and a lock that holds a different, well-formed `planId` (someone else's run took over).
// Neither implies cleanup: `ended` never deletes another plugin build's possibly-live state,
// and `taken-over` leaves the new holder's files alone.
function ended() {
  return { ok: false, code: 'ended', message: 'this run has already ended; run /commit again' };
}

function takenOver() {
  return { ok: false, code: 'taken-over', message: 'this run was taken over by another /commit; run /commit again' };
}

/** The `version` field `plan`/`check` write into `<planId>/state.json` (C:run-folder). */
export const STATE_VERSION = 1;

/**
 * Reads `<planId>/state.json`'s `version` field, tolerant of everything that means "treat as
 * ended" (missing, non-regular, unparseable, or no numeric `version`): `null`. A genuine
 * file-in-use error (lstat/read `EPERM`/`EBUSY`/`EACCES`) throws `InUse` instead, so `open`
 * maps it to `busy` like every other lock operation, not to `ended` (review-RUN-02 finding 4
 * applied here too). Mirrors `readLockFile`'s lstat/ENOENT/non-regular handling, but with no
 * size cap of its own beyond the regular-file check that already stops a FIFO: unlike the
 * run lock (a small `{planId,created}` object capped at `LOCK_MAX_BYTES`), state.json holds
 * the full unit table and routinely exceeds that for a sizeable change set (C:run-folder,
 * review-RUN-04 finding 1).
 *
 * @param {string} runDir
 * @param {string} planId
 * @returns {number | null}
 */
function readStateVersion(runDir, planId) {
  const file = insideRunDir(runDir, `${planId}/state.json`);
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw inUse(err);
  }
  if (!stats.isFile()) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw inUse(err);
  }
  let content;
  try {
    content = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (content === null || typeof content !== 'object') return null;
  return typeof content.version === 'number' ? content.version : null;
}

/**
 * Takes the run's `call.lock` exclusively (Q22 "one call per run at a time"). No folder,
 * or a folder that is a link or not a directory, holds no call to guard: nothing is
 * written. A live `call.lock` → `busy`; a stale one is replaced through
 * `moveAsideVerified` (bytes plus mtime), then the create is retried.
 *
 * @returns {{ ok: true, path: string | null } | { ok: false, code: 'busy', message: string }}
 */
// A TOCTOU gap remains between each `isPlainDirectory` check here (and in `close`)
// and the operation that follows it (the `wx` create, the rename, the `rmSync`): a junction
// swapped in inside that window still redirects the operation. Node has no
// `openat`/`O_NOFOLLOW` for directory path components, so this cannot be fully closed;
// impact is small (`wx` never overwrites, the payload is `{pid,host}`, and `rmSync` could at
// worst delete a same-named file in the junction's target). Accepted residual gap: KD-S79
// (review-RUN-02 finding 7).
function takeCallLock(runDir, planId, { now, pid, host, isAlive }) {
  const folder = insideRunDir(runDir, planId);
  const callLock = insideRunDir(runDir, `${planId}/call.lock`);
  const content = JSON.stringify({ pid, host });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isPlainDirectory(folder)) return { ok: true, path: null };
    try {
      fs.writeFileSync(callLock, content, { flag: 'wx' });
      return { ok: true, path: callLock };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, path: null };
      if (IN_USE.has(err.code)) return busy(true);
      if (err.code !== 'EEXIST') throw err;
    }
    let judged;
    try {
      judged = readLockFile(callLock);
    } catch (err) {
      if (err instanceof InUse) return busy(true);
      throw err;
    }
    if (judged === null) continue;
    if (!isCallLockStale({ bytes: judged.bytes, mtimeMs: judged.stats.mtimeMs, now: now(), host, isAlive })) {
      return busy();
    }
    if (!isPlainDirectory(folder)) return { ok: true, path: null };
    const aside = insideRunDir(runDir, `${planId}/call.lock.${crypto.randomUUID()}`);
    const { outcome } = moveAsideVerified({
      from: callLock,
      to: aside,
      verify: (bytes, stats) => stats.mtimeMs === judged.stats.mtimeMs
        && (bytes === null ? judged.bytes === null : judged.bytes !== null && bytes.equals(judged.bytes)),
    });
    // `moveAsideVerified`'s own `busy` outcome always stems from a file-in-use errno (the
    // rename, the read of the moved file, or, now, a non-`EEXIST` link-back failure below).
    if (outcome === 'moved' || outcome === 'conflict') fs.rmSync(aside, { recursive: true, force: true });
    if (outcome !== 'moved' && outcome !== 'gone') return busy(true);
  }
  return busy();
}

/**
 * M12 `run.close()` (RUN-04; `release` RUN-02 and `commit`'s `finally`, GIT-08's signal
 * handler): removes the call's own `call.lock`, idempotent and `ENOENT`-tolerant (the folder
 * already deleted by the release itself, by a takeover, or by a second `close()` call) and
 * never through a link. Only removes a `call.lock` that still holds this call's own
 * `{ pid, host }` (`process.pid`/`os.hostname()` by default): one a takeover already
 * replaced, or that cannot be read right now (a file-in-use error), is left alone rather than
 * deleted out from under its new owner (review-RUN-04 findings 9, 13).
 *
 * @param {{ toplevel: string, planId: string, pid?: number, host?: string }} options
 * @returns {void}
 */
export function close({ toplevel, planId, pid = process.pid, host = os.hostname() }) {
  const runDir = runDirOf(toplevel);
  if (!isPlainDirectory(insideRunDir(runDir, planId))) return;
  const callLock = insideRunDir(runDir, `${planId}/call.lock`);
  let judged;
  try {
    judged = readLockFile(callLock);
  } catch (err) {
    if (err instanceof InUse) return; // can't verify ownership right now; leave it
    throw err;
  }
  if (judged === null) return; // already gone
  const content = parseCallLock(judged.bytes);
  if (content === null || content.pid !== pid || content.host !== host) return; // not ours
  try {
    fs.rmSync(callLock, { force: true });
  } catch (err) {
    if (!IN_USE.has(err.code)) throw err;
  }
}

function lockPlanId(bytes) {
  if (bytes === null) return null;
  let content;
  try {
    content = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  return isValidPlanId(content.planId) ? content.planId : null;
}

/**
 * Ends the run `planId` names (`release`, C:commit-release): reads the lock first; when it
 * holds `planId`, takes the run's `call.lock` (a live one → `busy`, the run kept), then
 * removes the lock through `moveAsideVerified` (verify `planId`; a takeover that landed
 * after the read gets its lock put back and the release becomes the no-op) and deletes the
 * run folder before the private copy. Otherwise does nothing and creates nothing (the run
 * has already ended, or was taken over and the lock is someone else's, Q22).
 *
 * @param {{ toplevel: string, planId: string, now?: () => number, pid?: number,
 *   host?: string, isAlive?: (pid: number) => boolean }} options the clock, this call's
 *   pid and host, and the pid probe, injectable for tests.
 * @returns {{ ok: true, released: boolean } | { ok: false, code: 'busy', message: string }}
 *   `released: false` for the no-op.
 * @throws {Error} on an unexpected filesystem error.
 */
export function releaseById({
  toplevel, planId, now = Date.now, pid = process.pid, host = os.hostname(), isAlive = isPidAlive,
}) {
  const runDir = runDirOf(toplevel);
  if (!isValidPlanId(planId) || !isPlainDirectory(runDir)) return { ok: true, released: false };
  let holder;
  try {
    holder = lockHolder(runDir);
  } catch (err) {
    // review-RUN-02 finding 4: the very first lock read maps a file-in-use error to `busy`
    // like every other lock operation (Q22), instead of throwing to `internal`.
    if (err instanceof InUse) return busy(true);
    throw err;
  }
  if (holder !== planId) return { ok: true, released: false };
  const call = takeCallLock(runDir, planId, { now, pid, host, isAlive });
  if (!call.ok) return call;
  try {
    const aside = insideRunDir(runDir, `lock.${crypto.randomUUID()}`);
    const { outcome } = moveAsideVerified({
      from: insideRunDir(runDir, 'lock'),
      to: aside,
      verify: (bytes) => lockPlanId(bytes) === planId,
    });
    if (outcome === 'busy') return busy(true);
    if (outcome !== 'moved') return { ok: true, released: false };
    // Folder first, then the renamed lock: a kill in between leaves a renamed lock whose
    // chain ends at a missing folder, which the next adopter counts done (C:run-folder).
    fs.rmSync(insideRunDir(runDir, planId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(aside, { force: true });
    return { ok: true, released: true };
  } finally {
    if (call.path !== null) close({ toplevel, planId, pid, host });
  }
}

/**
 * M12 `open` (RUN-04): `commit`'s first step, wired as the whole call's own lock check. In
 * order (Q22 "reads the lock, checks it holds its planId, then refreshes the mtime", then
 * the state `version`, then the call.lock for the whole call):
 * 0. The run-folder directory itself must be a plain directory, never a link (mirroring
 *    `releaseById`'s own check): a `.commit-plan` junction is never followed → `ended`,
 *    nothing read or written through it (review-RUN-04 finding 12).
 * 1. Reads the run lock. No lock, or one that does not parse to a minted `planId` → `ended`.
 * 2. A lock holding a different, well-formed `planId` → `taken-over`.
 * 3. The lock holds `planId`. `<planId>/state.json`'s `version` must match this build's
 *    `STATE_VERSION`; a mismatch (including unreadable) → `ended` (a run started by another
 *    plugin build), never a cleanup of someone else's possibly-live state. Checked before the
 *    mtime touch below, so a build mismatch never refreshes a lock it is about to refuse
 *    (review-RUN-04 findings 4, 5).
 * 4. Refreshes the lock's mtime (`touched`). A lock that vanishes in that gap (a takeover, or
 *    a concurrent `release`, completed between the read and the touch) → `taken-over`, not
 *    the lenient "nothing to guard" `release` uses on a holder mismatch, because the lock was
 *    just confirmed to hold `planId` moments ago.
 * 5. Takes `call.lock` for the whole call (`takeCallLock`): `busy` on a live one; a folder
 *    that is missing or not a plain directory by now → `taken-over` (the lock matched
 *    moments ago, so a folder gone by now means a takeover raced this call, not a peaceful
 *    end).
 *
 * @param {string} planId
 * @param {{ toplevel: string, now?: () => number, pid?: number, host?: string,
 *   isAlive?: (pid: number) => boolean }} options the clock, this call's pid and host, and
 *   the pid probe, injectable for tests.
 * @returns {{ ok: true, run: { toplevel: string, planId: string, callLockPath: string | null } }
 *   | { ok: false, code: 'ended' | 'taken-over' | 'busy', message: string }}
 * @throws {Error} on an unexpected filesystem error.
 */
export function open(planId, {
  toplevel, now = Date.now, pid = process.pid, host = os.hostname(), isAlive = isPidAlive,
}) {
  const runDir = runDirOf(toplevel);
  if (!isPlainDirectory(runDir)) return ended();
  let lockFile;
  try {
    lockFile = readLockFile(insideRunDir(runDir, 'lock'));
  } catch (err) {
    if (err instanceof InUse) return busy(true);
    throw err;
  }
  const holder = lockFile === null ? null : lockPlanId(lockFile.bytes);
  if (holder === null) return ended();
  if (holder !== planId) return takenOver();

  let version;
  try {
    version = readStateVersion(runDir, planId);
  } catch (err) {
    if (err instanceof InUse) return busy(true);
    throw err;
  }
  if (version !== STATE_VERSION) return ended();

  try {
    const d = new Date(now());
    fs.utimesSync(insideRunDir(runDir, 'lock'), d, d);
  } catch (err) {
    if (err.code === 'ENOENT') return takenOver();
    if (IN_USE.has(err.code)) return busy(true);
    throw err;
  }

  const call = takeCallLock(runDir, planId, { now, pid, host, isAlive });
  if (!call.ok) return call;
  if (call.path === null) return takenOver();
  return { ok: true, run: { toplevel, planId, callLockPath: call.path } };
}
