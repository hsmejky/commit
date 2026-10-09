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

/** A `call.lock` and the run lock are stale once their mtime is this old (Q22). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * A stale run lock as `peek` read it (RUN-21): what the takeover verifies the moved lock
 * against, and the `planId` its notice names.
 *
 * @typedef {{ planId: string | null, touched: number, size: number, bytes: Buffer | null }} StaleLock
 */

// Windows reports a file another process holds open as one of these on a rename, read or
// unlink: "someone else is on it", `busy`, never `internal` (Q22, C:run-folder).
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES']);

class InUse extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function inUse(err) {
  return err && IN_USE.has(err.code) ? new InUse(err.message, err.code) : err;
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
 * never through a link: neither the run-folder directory itself (a `.commit-plan` junction
 * swapped in after `open`, mirroring `open`'s and `releaseById`'s own check) nor the
 * `<planId>` folder is followed when it is a link (review-RUN-04 finding 18). Only removes a
 * `call.lock` that still holds this call's own `{ pid, host }` (`process.pid`/`os.hostname()`
 * by default): one a takeover already replaced, or that cannot be read right now (a
 * file-in-use error), is left alone rather than deleted out from under its new owner
 * (review-RUN-04 findings 9, 13).
 *
 * @param {{ toplevel: string, planId: string, pid?: number, host?: string }} options
 * @returns {void}
 */
export function close({ toplevel, planId, pid = process.pid, host = os.hostname() }) {
  const runDir = runDirOf(toplevel);
  if (!isPlainDirectory(runDir) || !isPlainDirectory(insideRunDir(runDir, planId))) return;
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
 * Removes the lock when it still holds `planId` (`moveAsideVerified`: a takeover that landed
 * after the caller's read gets its lock put back), then deletes the run folder and the
 * private copy. Shared by `releaseById` and the run `acquire` returns (`run.release()`).
 *
 * @param {string} runDir the run-folder directory.
 * @param {string} planId
 * @returns {'moved' | 'put-back' | 'conflict' | 'gone' | 'busy'} `moveAsideVerified`'s outcome;
 *   only `moved` removed anything.
 */
function removeOwnRun(runDir, planId) {
  const aside = insideRunDir(runDir, `lock.${crypto.randomUUID()}`);
  const { outcome } = moveAsideVerified({
    from: insideRunDir(runDir, 'lock'),
    to: aside,
    verify: (bytes) => lockPlanId(bytes) === planId,
  });
  if (outcome !== 'moved') return outcome;
  // Folder first, then the renamed lock: a kill in between leaves a renamed lock whose
  // chain ends at a missing folder, which the next adopter counts done (C:run-folder).
  fs.rmSync(insideRunDir(runDir, planId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(aside, { force: true });
  return outcome;
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
    const outcome = removeOwnRun(runDir, planId);
    if (outcome === 'busy') return busy(true);
    return { ok: true, released: outcome === 'moved' };
  } finally {
    if (call.path !== null) close({ toplevel, planId, pid, host });
  }
}

/** The `info/exclude` line that keeps the run-folder directory out of git (C:run-folder). */
export const EXCLUDE_LINE = `/${RUN_DIR_NAME}`;

// Appends `EXCLUDE_LINE` to the common dir's `info/exclude` unless a line already holds it
// (git strips only unescaped trailing spaces, not tabs, so a line is compared without its
// trailing spaces; review-RUN-05 finding 7).
function ensureExcludeLine(excludePath) {
  let text = '';
  try {
    text = fs.readFileSync(excludePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text.split(/\r?\n/).some((line) => line.replace(/ +$/, '') === EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(excludePath, `${separator}${EXCLUDE_LINE}\n`);
}

/** The `run-folder` refusal text (C:run-folder; C:cli-and-exit-codes recorded texts). */
export const RUN_FOLDER_TEXT = '`.commit-plan` is tracked or not a plain directory; remove it by hand';

/**
 * The `run-folder` refusal text for a filesystem that cannot hard-link (C:run-folder `lock` row,
 * RUN-09): the lock link failed `ENOTSUP`/`ENOSYS`, or a persisting `EPERM`/`EBUSY` and the
 * hard-link probe failed too. Nothing to remove by hand: the folder is fine, its filesystem is not.
 */
export const RUN_FOLDER_NO_HARD_LINKS_TEXT = "the run folder's filesystem does not support hard links";

function noHardLinksRefusal() {
  return { ok: false, code: 'run-folder', message: RUN_FOLDER_NO_HARD_LINKS_TEXT };
}

// Whether nothing stands at `dir`: the only state besides a plain directory `create`
// accepts there before its first write.
function isAbsent(dir) {
  try {
    fs.lstatSync(dir);
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * The notice for a provisional run folder `discard` could not remove; the 24-hour sweep
 * removes it later (C:run-folder).
 *
 * @param {string} planId
 * @param {string} code the error's `code`, such as `EBUSY`.
 * @returns {string}
 */
export function discardNotice(planId, code) {
  return `run folder \`${RUN_DIR_NAME}/${planId}\` was not removed (${code}); the 24-hour sweep removes it`;
}

/**
 * The notice for a `release()` that could not remove the run lock because another operation
 * on it is in progress (`busy`, review-CHG-03b finding 2): the lock and its folder are kept
 * together, unlike `discardNotice`'s folder-only removal failure (finding 10).
 *
 * @param {string} planId
 * @returns {string}
 */
export function lockKeptNotice(planId) {
  return `run lock \`${RUN_DIR_NAME}/lock\` for \`${planId}\` was not released (busy); the run and its folder stay in place`;
}

/** The `run-folder` refusal text naming the tracked variant actually found (finding 5). */
function trackedRunFolderText(trackedAs) {
  return `\`${trackedAs}\` is tracked; remove it by hand`;
}

// `trackedAs`: the case-variant path the index holds, when known (M3 `isTracked`), to name
// it in the message instead of the generic text; omitted (or a plain `true`/`false`) when
// the caller does not have it, or the cause is not tracking at all (a link or non-directory).
function runFolderRefusal(trackedAs) {
  const message = typeof trackedAs === 'string' ? trackedRunFolderText(trackedAs) : RUN_FOLDER_TEXT;
  return { ok: false, code: 'run-folder', message };
}

/**
 * M12 `Run.create` (RUN-05, `plan` step 3): checks the run-folder directory, adds the
 * exclude line once, mints the `planId` and creates the provisional run folder
 * `<toplevel>/.commit-plan/<planId>/`.
 *
 * Before its first write it `lstat`s `<toplevel>/.commit-plan`: a symlink, a junction, a
 * non-directory, or a path tracked in the index (`tracked`, which M18 asks git for: M12
 * spawns nothing) refuses with `run-folder`; after `mkdir` it checks again, and once more
 * after creating `<planId>/` (C:run-folder, story 207), so a link swapped in meanwhile is
 * never written through.
 *
 * @param {{ toplevel: string, excludePath: string, tracked: string | boolean,
 *   sleep?: (ms: number) => void }} options
 *   `excludePath`: the common dir's `info/exclude` (M2 `gitPath`); `tracked`: the case-variant
 *   path the index holds under `.commit-plan`, such as `.Commit-Plan` (M3 `isTracked`), or
 *   `null`/`false` when it holds none, or `true` when the caller knows it is tracked but not
 *   which variant; `sleep` (RUN-09): the delay `write`'s rename and `acquire`'s lock link use
 *   between Windows file-in-use retries, injected so a test never waits out a real delay
 *   (default a real synchronous sleep).
 * @returns {{ ok: true, provisional: { planId: string, runDir: string,
 *   write: (name: string, data: string | Uint8Array) => void,
 *   peek: (options?: { now?: () => number }) => { ok: true, stale: StaleLock | null }
 *     | { ok: false, code: 'held', message: string,
 *         holder: { planId: string | null, created: string | null, touched: number } | null },
 *   acquire: (options?: { now?: () => number, takeOver?: StaleLock | string }) => { ok: true, run: object,
 *       takeover: { planId: string | null, notice: string, killedRun: null } | null }
 *     | { ok: false, code: 'held' | 'busy' | 'ended' | 'run-folder', message: string,
 *         holder: { planId: string | null, created: string | null, touched: number } | null },
 *   discard: () => string | null } }
 *   | { ok: false, code: 'run-folder', message: string }}
 *   `runDir`: the folder, absolute and `path.resolve`d from the toplevel, with forward
 *   slashes (C:run-folder); `write(name, data)` writes `<planId>/<name>` atomically
 *   (temporary name, then rename; KD-R37: `state.json` is written before `acquire`);
 *   `acquire()` takes the run lock with no takeover (CHG-03b) and returns the run, whose
 *   `write` is the same and whose `release()` removes the lock and the folder;
 *   `acquire({ takeOver })` (RUN-21) takes over the stale lock `peek` reported instead
 *   (`takeOverLock`), and its run also has `finishTakeover()`; `acquire({ takeOver: <planId> })`
 *   (RUN-22) takes over the named run's lock whatever its age (`takeOverNamed`);
 *   `discard()` deletes the folder (every outcome that takes no lock).
 *   Inside M12 a local `runDir` is `.commit-plan` itself (`runDirOf`); only this output
 *   field names the `<planId>/` folder, keeping C:plan's `runDir` (review-RUN-05 finding 8).
 */
export function create({ toplevel, excludePath, tracked, sleep = sleepSync }) {
  const runDir = runDirOf(toplevel);
  if (tracked) return runFolderRefusal(tracked);
  if (!(isAbsent(runDir) || isPlainDirectory(runDir))) return runFolderRefusal();
  ensureExcludeLine(excludePath);
  const planId = crypto.randomUUID();
  fs.mkdirSync(runDir, { recursive: true });
  if (!isPlainDirectory(runDir)) return runFolderRefusal();
  const folder = insideRunDir(runDir, planId);
  fs.mkdirSync(folder);
  // A link swapped in between the check above and this mkdir is caught here, before any
  // later write of the run; the `<planId>/` made through it is left (nothing is deleted
  // through a link). Node has no `openat`, so the window narrows but cannot close.
  if (!isPlainDirectory(runDir) || !isPlainDirectory(folder)) return runFolderRefusal();
  // Never throws: a removal error must not replace the call's outcome or original error.
  // Nothing is removed through a `.commit-plan` swapped for a link after `create`, like
  // `releaseById`, `open` and `close` (review-RUN-05 findings 3, 4).
  const discard = () => {
    try {
      if (!isPlainDirectory(runDir)) return null;
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return null;
    } catch (err) {
      return discardNotice(planId, err.code || 'error');
    }
  };
  const write = (name, data) => writeAtomic(folder, name, data, sleep);
  const peek = ({ now = Date.now } = {}) => peekLock(runDir, now);
  const acquire = ({ now = Date.now, takeOver } = {}) => {
    if (takeOver === undefined) return acquireLock(runDir, planId, folder, now, sleep);
    // A string is the `--take-over <planId>` form (RUN-22); an object is the stale holder
    // `peek` reported (RUN-21).
    return typeof takeOver === 'string'
      ? takeOverNamed(runDir, planId, folder, now, sleep, takeOver)
      : takeOverLock(runDir, planId, folder, now, sleep, takeOver);
  };
  return { ok: true, provisional: { planId, runDir: folder.split(path.sep).join('/'), write, peek, acquire, discard } };
}

// RUN-09 (Q22, C:run-folder): on Windows a file another process briefly holds open (an AV
// scanner, a backup tool, an indexer) fails a rename or a hard-link creation with `EPERM` or
// `EBUSY`, which usually clears within about a second. `retryInUse` retries `attempt()` on
// exactly those two codes, sleeping between tries (`sleep`, injected so a test never waits
// out a real delay — the fault-injection preload makes a boundary fail deterministically,
// docs/spec/testing-seams.md); any other code (`EEXIST`, `ENOTSUP`, `ENOSYS`, `EIO`, …)
// rethrows at once, for the caller to map. Once the delays run out the last attempt's throw
// (if any) propagates, for the caller to decide (the lock link's probe below; a plain
// `writeAtomic` rename just counts it as a failure, C:run-folder "Versioned").
const RETRY_DELAYS_MS = Object.freeze([100, 150, 200, 250, 300]); // ~1000 ms, a few retries.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryInUse(attempt, sleep) {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return attempt();
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      sleep(delay);
    }
  }
  return attempt();
}

// Every write of a run file (`state.json`, `plan.json`, `hunks.txt`) goes to a temporary name
// in the run folder, then a rename into place, so no reader sees a half-written file
// (C:run-folder "Versioned"). RUN-09: a Windows `EPERM`/`EBUSY` on the rename is retried
// about a second before it counts as a failure, like the lock link below.
function writeAtomic(folder, name, data, sleep = sleepSync) {
  const target = path.join(folder, name);
  const temp = path.join(folder, `${name}.tmp`);
  fs.writeFileSync(temp, data);
  retryInUse(() => fs.renameSync(temp, target), sleep);
}

/**
 * The lock's temporary file in the run-folder directory, linked into place as `lock`.
 * Named apart from a renamed lock (`lock.<planId>`), which adoption owns (C:run-folder).
 *
 * @param {string} planId
 * @returns {string}
 */
export function lockTempName(planId) {
  return `lock-${planId}.tmp`;
}

// RUN-09 (Q22, C:run-folder "lock" row): once the lock link's `EPERM`/`EBUSY` persists past
// `retryInUse`'s retries, this decides between `busy` (another process genuinely has a file
// of the link in use) and `run-folder` (the filesystem cannot hard-link at all). It writes a
// fresh source file and hard-links it once more, both inside this call's own `<planId>/`
// folder, which sits on the same filesystem as `lock` (review-RUN-09 findings 6, 7):
// - a fresh source, not the lock's temporary file, so a scanner or indexer still holding that
//   temporary file (the very `EBUSY` being decided) cannot fail the probe too;
// - inside the `<planId>/` folder, so the names are fixed (a test's fault-injection basename
//   needs no `planId`) yet never shared: no concurrent run probes the same name, and a leftover
//   that a held handle kept from being removed lives only in a folder that is discarded with
//   the refusal (or swept after 24 hours), never poisoning a later run's probe.
// A successful probe proves hard links work here, so the original failure must be contention;
// an `EEXIST` on the probe link proves the same (only a successful link can leave that name);
// any other failure, of the source write or the link, means the filesystem cannot be trusted.
const PROBE_SOURCE = 'hardlink-probe.tmp';
const PROBE_LINK = 'hardlink-probe.link';

function hardLinkWorks(folder) {
  const source = path.join(folder, PROBE_SOURCE);
  const target = path.join(folder, PROBE_LINK);
  let works;
  try {
    fs.writeFileSync(source, '');
    fs.linkSync(source, target);
    works = true;
  } catch (err) {
    works = err.code === 'EEXIST';
  }
  for (const file of [target, source]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort: a leftover goes with the `<planId>/` folder (discarded, or swept).
    }
  }
  return works;
}

function cleanupLockTemp(temp) {
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // The lock was never linked: a leftover temp here is `lock-<planId>.tmp`, which RUN-08's
    // sweep removes once it is 24 hours old; this best-effort cleanup only shortens the wait,
    // and the original link error is what matters here.
  }
}

// M12 `acquire` without a takeover (CHG-03b, C:plan step 7): `{ planId, created }` written to
// a temporary file in `.commit-plan/` and hard-linked into place as `.commit-plan/lock`
// (`linkSync` never overwrites, so no reader sees a lock without its content). On a link
// failure the temporary file is removed (best-effort: the original error always wins, review-
// CHG-03b finding 1); once the link has succeeded the lock is in place regardless of what
// happens to its temporary file, so that removal is best-effort too and a leftover goes to
// the sweep (RUN-07, C:run-folder "leftover lock temporary files") rather than failing an
// acquire whose lock already stands. A link that fails with `EEXIST` is a race lost to
// another run's lock (RUN-06): `held`, naming that lock, and nothing of it is touched.
// RUN-09: `ENOTSUP`/`ENOSYS` (the filesystem cannot hard-link at all) refuses `run-folder` at
// once, without a probe; `EPERM`/`EBUSY` are retried about a second (`retryInUse`), and one
// still failing after the retries falls back to the hard-link probe above. Any other error
// (`EIO`, …) still throws, unchanged.
function acquireLock(runDir, planId, folder, now, sleep = sleepSync) {
  const linked = linkOwnLock(runDir, planId, folder, now, sleep);
  if (!linked.ok) return linked;
  return { ok: true, run: ownRun(runDir, planId, folder, sleep), takeover: null };
}

// The link part of `acquireLock`, shared with `takeOverLock`: `{ ok: true }` once the lock is
// in place, else the refusal above (`held`, `run-folder`, `busy`); other errors throw.
function linkOwnLock(runDir, planId, folder, now, sleep) {
  const temp = insideRunDir(runDir, lockTempName(planId));
  const lock = insideRunDir(runDir, 'lock');
  fs.writeFileSync(temp, JSON.stringify({ planId, created: new Date(now()).toISOString() }), { flag: 'wx' });
  try {
    retryInUse(() => fs.linkSync(temp, lock), sleep);
  } catch (err) {
    if (err.code === 'EEXIST') {
      cleanupLockTemp(temp);
      return held(runDir, now);
    }
    if (err.code === 'ENOTSUP' || err.code === 'ENOSYS') {
      cleanupLockTemp(temp);
      return noHardLinksRefusal();
    }
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      const result = hardLinkWorks(folder) ? busy(true) : noHardLinksRefusal();
      cleanupLockTemp(temp);
      return result;
    }
    cleanupLockTemp(temp);
    throw err;
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Leftover lock temporary file: the sweep's (RUN-07), not this call's to fail over.
  }
  return { ok: true };
}

/**
 * The automatic takeover's notice (RUN-21, C:plan step 3), naming the stale run's `planId`,
 * or the unreadable lock when it held none in the minted form.
 *
 * @param {string | null} planId
 * @returns {string}
 */
export function takeoverNotice(planId) {
  const minutes = STALE_AFTER_MS / 60_000;
  return planId === null
    ? `took over a stale, unreadable /commit lock (idle for ${minutes} minutes or more)`
    : `took over the stale /commit run \`${planId}\` (idle for ${minutes} minutes or more)`;
}

// M12 `acquire({ takeOver })` (RUN-21, Q22, C:plan step 3, C:run-folder): the automatic
// takeover of the stale lock `peek` reported (`stale`). The lock is renamed to
// `lock.<own planId>` (only one of several renames succeeds) and verified against the bytes
// and mtime `peek` judged stale (a rename keeps the mtime): a lock touched or replaced since
// is put back (`moveAsideVerified`) and refuses `held` naming the lock now in place; a put-back
// meeting a new lock (`conflict`) keeps the private copy as an orphan (adopted by RUN-25).
// A rename `ENOENT` (another takeover won) re-peeks once (RUN-20b item 4): a lock in place →
// `held` with a fresh holder; no lock → this call links its own lock with no takeover (the
// winner's renamed lock left behind is an orphan, whose adoption is RUN-25's). Once moved,
// the own lock is linked exactly as `acquireLock` links it; a link `EEXIST` refuses `held`
// and deletes nothing of the takeover (the renamed lock and the old folder stay for the next
// `plan`; M18's `finally` discards only this call's provisional folder). `killedRun` is
// always `null` here: reading the killed run's state is RUN-23's.
function takeOverLock(runDir, planId, folder, now, sleep, stale) {
  const lock = insideRunDir(runDir, 'lock');
  const renamed = insideRunDir(runDir, `lock.${planId}`);
  const { outcome } = moveAsideVerified({
    from: lock,
    to: renamed,
    verify: (bytes, stats) => stats.isFile()
      && stats.mtimeMs === stale.touched
      && stats.size === stale.size
      && (bytes === null || stale.bytes === null || bytes.equals(stale.bytes)),
  });
  if (outcome === 'gone') {
    let file = null;
    try {
      file = readLockFile(lock);
    } catch (err) {
      if (!(err instanceof InUse)) throw err;
      return busy(true);
    }
    if (file !== null) return heldBy(file, now);
    return acquireLock(runDir, planId, folder, now, sleep);
  }
  if (outcome === 'busy') return busy(true);
  if (outcome !== 'moved') return held(runDir, now);
  const linked = linkOwnLock(runDir, planId, folder, now, sleep);
  if (!linked.ok) return linked;
  const run = ownRun(runDir, planId, folder, sleep);
  run.finishTakeover = () => finishTakeover(runDir, stale.planId, renamed);
  return { ok: true, run, takeover: { planId: stale.planId, notice: takeoverNotice(stale.planId), killedRun: null } };
}

/**
 * The `--take-over <planId>` notice (RUN-22): names the replaced run; the lock's age is not
 * part of it, since `--take-over` takes a fresh lock too.
 *
 * @param {string} planId
 * @returns {string}
 */
export function namedTakeoverNotice(planId) {
  return `replaced the /commit run \`${planId}\` at your request`;
}

// `--take-over`'s own `ended` text (Q22, KD-S3): the handback was answered after the named run
// ended on its own. Apart from `ended()`, whose text is about the calling run.
function namedRunEnded() {
  return { ok: false, code: 'ended', message: 'that run has already ended; run /commit again' };
}

// M12 `acquire({ takeOver: <planId> })` (RUN-22, Q9, Q22, C:plan `--take-over`): skips `peek`
// and takes over the lock of the run the user was asked about, whatever its age. The lock is
// renamed to `lock.<own planId>` and verified to hold `target` (not its age; an unparseable
// lock never matches): a mismatch is put back (`moveAsideVerified`) and refuses `held` naming
// the holder now in place; a put-back meeting a new lock keeps the private copy as an orphan
// (adopted by RUN-25). A rename `ENOENT` re-peeks once (RUN-20b item 4): a lock in place →
// `held` naming it, no lock → `ended`. Once moved, the old run's `call.lock` is taken before
// the own lock is linked (`takeCallLock`): a live one → `busy`, the lock put back so the old
// run goes on; a folder that is gone → `ended`, after deleting the renamed lock (its chain
// ends at a missing folder). The own lock is then linked exactly as `acquireLock` links it.
// `killedRun` is `null` here: reading the killed run's state is RUN-23's.
function takeOverNamed(runDir, planId, folder, now, sleep, target) {
  const lock = insideRunDir(runDir, 'lock');
  const renamed = insideRunDir(runDir, `lock.${planId}`);
  const { outcome } = moveAsideVerified({
    from: lock,
    to: renamed,
    verify: (bytes) => lockPlanId(bytes) === target,
  });
  if (outcome === 'gone') {
    let file = null;
    try {
      file = readLockFile(lock);
    } catch (err) {
      if (!(err instanceof InUse)) throw err;
      return busy(true);
    }
    return file === null ? namedRunEnded() : heldBy(file, now);
  }
  if (outcome === 'busy') return busy(true);
  if (outcome !== 'moved') return held(runDir, now);
  const call = takeCallLock(runDir, target, { now, pid: process.pid, host: os.hostname(), isAlive: isPidAlive });
  if (!call.ok) {
    putBack(renamed, lock);
    return call;
  }
  if (call.path === null) {
    fs.rmSync(renamed, { force: true });
    return namedRunEnded();
  }
  // If this link fails, the old run's `call.lock` just taken stays behind; it is stale as soon
  // as this call exits (a dead pid), so the next taker proceeds.
  const linked = linkOwnLock(runDir, planId, folder, now, sleep);
  if (!linked.ok) return linked;
  const run = ownRun(runDir, planId, folder, sleep);
  run.finishTakeover = () => finishTakeover(runDir, target, renamed);
  return { ok: true, run, takeover: { planId: target, notice: namedTakeoverNotice(target), killedRun: null } };
}

// Links the renamed lock back as `lock` and drops the private name. A link that fails (a new
// lock already in place, a file in use) keeps the private copy, an orphan for the next adopter,
// like `moveAsideVerified`'s put-back.
function putBack(renamed, lock) {
  try {
    fs.linkSync(renamed, lock);
    fs.rmSync(renamed, { force: true });
  } catch {
    // Kept as the orphan.
  }
}

// `run.finishTakeover()` (RUN-21, RUN-20b item 2): deletes the taken-over run's folder first
// (only when the stale lock named a minted `planId`; `rmSync` removes a link entry itself,
// never what it points to), then the renamed lock last, the same order as `removeOwnRun`: a
// kill in between leaves a renamed lock whose chain ends at a missing folder. Never throws: a
// failure becomes the returned notice (`null` when all went), and a folder that could not be
// deleted keeps the renamed lock as the chain's evidence. Nothing is deleted through a
// `.commit-plan` swapped for a link meanwhile.
function finishTakeover(runDir, stalePlanId, renamed) {
  if (!isPlainDirectory(runDir)) return null;
  if (stalePlanId !== null) {
    try {
      fs.rmSync(insideRunDir(runDir, stalePlanId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      return discardNotice(stalePlanId, err.code || 'error');
    }
  }
  try {
    fs.rmSync(renamed, { force: true });
  } catch (err) {
    return sweepNotice(path.basename(renamed), err.code || 'error');
  }
  return null;
}

/**
 * The holder's clock parts — local `HH:MM` for `created` and whole seconds idle against
 * `nowMs` — shared by `heldMessage` (the `held` failure's own text) and INT-05's `lock`
 * handback (`lockHandbackFailure` in workflows.mjs), so both treat an unreadable holder the
 * same way: `null` when there is no holder, its `planId` is not in the minted form, or
 * `created` does not parse as a date (missing, garbage, or any other non-date string).
 *
 * @param {{ planId: string | null, created: string | null, touched: number } | null} holder
 *   `null` when no lock could be read.
 * @param {number} nowMs
 * @returns {{ hhmm: string, idleSeconds: number } | null}
 */
export function lockHolderClock(holder, nowMs) {
  if (holder === null || holder.planId === null) return null;
  const started = holder.created === null ? Number.NaN : Date.parse(holder.created);
  if (Number.isNaN(started)) return null;
  const date = new Date(started);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const idleSeconds = Math.max(0, Math.round((nowMs - holder.touched) / 1000));
  return { hhmm, idleSeconds };
}

/**
 * The `held` refusal text (C:cli-and-exit-codes, failure shape): the holder's start time
 * (`created`, local `HH:MM`) and how long ago it was last active (`touched`, the lock's
 * mtime, against the injected clock), via `lockHolderClock`. An unparseable lock, or one
 * whose `planId` is not in the minted form, gets the unreadable-lock text instead; a lock
 * gone again by the time it is read names no holder.
 *
 * @param {{ planId: string | null, created: string | null, touched: number } | null} holder
 *   `null` when no lock could be read.
 * @param {number} nowMs
 * @returns {string}
 */
function heldMessage(holder, nowMs) {
  if (holder === null) return 'another /commit run is in progress';
  const clock = lockHolderClock(holder, nowMs);
  if (clock === null) return 'the /commit lock is unreadable (corrupt or not written by /commit)';
  return `another /commit run is in progress (started ${clock.hhmm}, last active ${clock.idleSeconds} s ago)`;
}

// `acquire`'s lost race (RUN-06): reads the lock now in place, without following a link, to
// name its holder. A file-in-use error on that read names no holder rather than failing the
// refusal. `holder` (`{ planId, created, touched } | null`) rides along in the typed result,
// matching M12's interface ("`held` with holder"); `plan` turns it into the failure shape's
// `planId`/`created`/`touched` error fields (RUN-07).
function held(runDir, now) {
  let file = null;
  try {
    file = readLockFile(insideRunDir(runDir, 'lock'));
  } catch (err) {
    if (!(err instanceof InUse)) throw err;
  }
  return heldBy(file, now);
}

// The `held` refusal for the lock file already read (`readLockFile`'s result, `null` when it
// was gone): `peek` passes its own read, so the lock is read once and a holder releasing
// right after it never makes the refusal holder-less (review-RUN-07 finding 5). For a lock
// whose `planId` is not in the minted form (unparseable included), `created` is `null` too
// (C:cli-and-exit-codes): a corrupt or foreign lock's content names nothing.
function heldBy(file, now) {
  let holder = null;
  if (file !== null) {
    const planId = lockPlanId(file.bytes);
    holder = { planId, created: planId === null ? null : lockCreated(file.bytes), touched: file.stats.mtimeMs };
  }
  return { ok: false, code: 'held', message: heldMessage(holder, now()), holder };
}

function lockCreated(bytes) {
  if (bytes === null) return null;
  try {
    const content = JSON.parse(bytes.toString('utf8'));
    return content !== null && typeof content.created === 'string' ? content.created : null;
  } catch {
    return null;
  }
}

/**
 * M12 `peek` (RUN-07, `plan` step 3): a read-only check of the run lock, before any inventory
 * work. A live lock (its mtime under 15 minutes old, Q22) refuses the same way `acquire`'s
 * lost race does (`held`, RUN-06's `held()`), so a `peek` refusal and a lost-race refusal
 * carry the same `planId`/`created`/`touched` holder shape (the handback built on top of it
 * is INT-05's). A file-in-use error reading the lock is `busy`, like every other lock
 * operation (Q22). No lock is `ok` with `stale: null`; a lock stale by mtime (whatever its
 * content) is `ok` with `stale` (RUN-21): what `acquire({ takeOver })` verifies the moved lock
 * against (its mtime `touched`, `size` and `bytes`, `null` for a non-regular or oversized
 * file) and the `planId` the takeover notice names (`null` when not in the minted form). The
 * orphan renamed locks `peek` also reports are RUN-25's; nothing here adopts anything.
 *
 * @param {string} runDir
 * @param {() => number} now
 * @returns {{ ok: true, stale: StaleLock | null } | { ok: false, code: 'held', message: string,
 *   holder: { planId: string | null, created: string | null, touched: number } | null }}
 */
function peekLock(runDir, now) {
  let file;
  try {
    file = readLockFile(insideRunDir(runDir, 'lock'));
  } catch (err) {
    if (!(err instanceof InUse)) throw err;
    return busy(true);
  }
  if (file === null) return { ok: true, stale: null };
  if (now() - file.stats.mtimeMs < STALE_AFTER_MS) return heldBy(file, now);
  const { stats, bytes } = file;
  return { ok: true, stale: { planId: lockPlanId(bytes), touched: stats.mtimeMs, size: stats.size, bytes } };
}

// The run `acquire` returns: `write` as before the lock, and `release()`, which removes the
// lock (only while it still holds `planId`) and the run folder, returning `{ notice, kept }`.
// `release` never throws: a removal error becomes a notice and never replaces the call's
// outcome or original error, like `discard`. On `busy` (the lock rename hit a file-in-use
// error, `releaseById`'s own `busy(true)` case) the lock was never removed: `kept: true`
// tells the caller to leave the folder alone too, so the lock and its folder stay consistent
// for the next `/commit` to find an ordinary held run (review-CHG-03b finding 2); any other
// removal error is the folder's (finding 10), reported with `discardNotice` as before.
function ownRun(runDir, planId, folder, sleep) {
  return {
    planId,
    write: (name, data) => writeAtomic(folder, name, data, sleep),
    release: () => releaseOwn(runDir, planId),
    // M12 spec (docs/spec/modules-m10-m13.md:279): "a no-op without a takeover". A real
    // takeover's `acquire` (`takeOverLock`) overwrites this with the one that deletes the
    // old folder and the renamed lock.
    finishTakeover: () => null,
  };
}

// The never-throwing release shared by `ownRun`'s `release()` and `releaseOpen`.
function releaseOwn(runDir, planId) {
  if (!isPlainDirectory(runDir)) return { notice: null, kept: false };
  let outcome;
  try {
    outcome = removeOwnRun(runDir, planId);
  } catch (err) {
    return { notice: discardNotice(planId, err.code || 'error'), kept: false };
  }
  if (outcome === 'busy') return { notice: lockKeptNotice(planId), kept: true };
  return { notice: null, kept: false };
}

/**
 * M12 `open` (RUN-04): `commit`'s first step, wired as the whole call's own lock check. In
 * order (Q22 "reads the lock, checks it holds its planId", then the state `version`, then
 * refreshes the mtime, then the call.lock for the whole call):
 * 0. The run-folder directory itself must be a plain directory, never a link (mirroring
 *    `releaseById`'s own check): a `.commit-plan` junction is never followed → `ended`,
 *    nothing read or written through it (review-RUN-04 finding 12). An `EPERM`/`EACCES`
 *    from this check's `lstat` throws to `internal` rather than mapping to `busy`, matching
 *    `releaseById`'s (and now `close`'s) identical check; noted only for consistency with
 *    Q22's lock-operation-busy rule, not changed (review-RUN-04 finding 20).
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

/**
 * M12 `run.touch()` (EXE-02): the verify-and-touch M16 runs before each group. Reads the run
 * lock without following a link; when it still holds `planId`, refreshes its mtime
 * (`touched`) against the injected clock. A lock that is gone, unreadable as a minted
 * `planId`, holds another `planId`, or vanishes before the touch → `taken-over` (the call's
 * own `open` matched it, so the run was taken over since); a file-in-use error → `busy`.
 *
 * @param {{ toplevel: string, planId: string }} run the run `open` returned.
 * @param {{ now?: () => number }} options the clock, injectable for tests.
 * @returns {{ ok: true } | { ok: false, code: 'taken-over' | 'busy', message: string }}
 * @throws {Error} on an unexpected filesystem error.
 */
export function touch({ toplevel, planId }, { now = Date.now } = {}) {
  const runDir = runDirOf(toplevel);
  if (!isPlainDirectory(runDir)) return takenOver();
  const lock = insideRunDir(runDir, 'lock');
  let holder;
  try {
    holder = lockHolder(runDir);
  } catch (err) {
    if (err instanceof InUse) return busy(true);
    throw err;
  }
  if (holder !== planId) return takenOver();
  try {
    const d = new Date(now());
    fs.utimesSync(lock, d, d);
  } catch (err) {
    if (err.code === 'ENOENT') return takenOver();
    if (IN_USE.has(err.code)) return busy(true);
    throw err;
  }
  return { ok: true };
}

/**
 * M12 release of a run `open` returned (EXE-02, M18 after the last group): removes the lock
 * while it still holds `planId` (`moveAsideVerified`, a takeover's lock is put back), then
 * the run folder (its `call.lock` with it, so the call's later `close()` has nothing left
 * to do). Unlike `releaseById` it takes no `call.lock`: the calling `commit` already holds
 * its own. Never throws, like the release `acquire` returns: a removal error becomes a
 * `discardNotice`, and a lock rename hit by a file-in-use error keeps the run
 * (`kept: true`, `lockKeptNotice`).
 *
 * @param {{ toplevel: string, planId: string }} run the run `open` returned.
 * @returns {{ notice: string | null, kept: boolean }}
 */
export function releaseOpen({ toplevel, planId }) {
  return releaseOwn(runDirOf(toplevel), planId);
}

/** A `<planId>/` folder or a lock temporary file is swept once its mtime is this old (Q22). */
export const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

const RENAMED_LOCK_PREFIX = 'lock.';
const LOCK_TEMP_PATTERN = /^lock-(.+)\.tmp$/;

/**
 * The notice for an entry the sweep could not remove (RUN-08): the outcome is unchanged. A
 * removal that fails partway may unlink some children first, which refreshes the entry's own
 * mtime, so it is not necessarily the very next `plan` that retries it successfully
 * (C:run-folder, C:cli-and-exit-codes recorded texts).
 *
 * @param {string} name the entry's name in the run-folder directory, `''` for the directory.
 * @param {string} code the error code.
 * @returns {string}
 */
export function sweepNotice(name, code) {
  const shown = name === '' ? RUN_DIR_NAME : `${RUN_DIR_NAME}/${name}`;
  return `\`${shown}\` was not swept (${code}); the 24-hour sweep retries it`;
}

/**
 * The notice for a lock-type file (`lock` or a `lock.<planId>`) the sweep could not read
 * (RUN-08 review finding 7): rather than degrade silently, this call sweeps no folder at all
 * (the safe choice: an unreadable file might be hiding a chain), though it still sweeps aged
 * lock temporary files, which never carry a chain (C:cli-and-exit-codes recorded texts).
 *
 * @param {string} name the lock-type file's name in the run-folder directory.
 * @param {string} code the error code.
 * @returns {string}
 */
export function sweepKeepsNotice(name, code) {
  return `\`${RUN_DIR_NAME}/${name}\` could not be read (${code}); old run folders were not swept`;
}

// The `planId`s whose folders the sweep must keep whatever their age, or `null` when one of
// the lock-type files could not be read (the folders are then left for a later sweep, and a
// notice is pushed via `sweepKeepsNotice` rather than left silent, finding 7): the one the
// lock names, and every run on a renamed lock file's chain (C:run-folder "Orphan renamed
// locks"). A chain links `lock.<A>` (A's provisional folder) to the run its content names, X,
// and on from X through `lock.X`, which is itself one of the listed files, so collecting the
// name and the content of every `lock.<planId>` covers every chain without walking one.
// Nothing here follows a link (`readLockFile` reads by `lstat`).
function sweepKeeps(runDir, names, notices) {
  const keep = new Set();
  let holder;
  try {
    holder = lockHolder(runDir);
  } catch (err) {
    notices.push(sweepKeepsNotice('lock', err.code || 'error'));
    return null;
  }
  if (holder !== null) keep.add(holder);
  for (const name of names) {
    if (!name.startsWith(RENAMED_LOCK_PREFIX)) continue;
    const renamer = name.slice(RENAMED_LOCK_PREFIX.length);
    if (!isValidPlanId(renamer)) continue;
    keep.add(renamer);
    let file;
    try {
      file = readLockFile(insideRunDir(runDir, name));
    } catch (err) {
      notices.push(sweepKeepsNotice(name, err.code || 'error'));
      return null;
    }
    const named = file === null ? null : lockPlanId(file.bytes);
    if (named !== null) keep.add(named);
  }
  return keep;
}

// What the sweep may remove of one entry, judged by its name and `lstat` alone: a plain
// `<planId>/` directory, or a regular `lock-<planId>.tmp` file, each in the minted form.
// A link of any kind (symlink, junction) is never a candidate, so it is never followed.
function sweepKind(name, stats) {
  if (stats.isSymbolicLink()) return null;
  if (isValidPlanId(name)) return stats.isDirectory() ? 'folder' : null;
  const temp = LOCK_TEMP_PATTERN.exec(name);
  if (temp !== null && isValidPlanId(temp[1])) return stats.isFile() ? 'temp' : null;
  return null;
}

/**
 * M12 `sweep` (RUN-08, Q22, C:run-folder, story 195), run by `plan` at the end of step 7:
 * deletes the `<planId>/` folders older than 24 hours (by mtime, against the injected clock)
 * that the lock does not name, and the lock temporary files (`lock-<planId>.tmp`) as old.
 * It considers only entries named in the minted form and never follows a link: a link in
 * place of an entry, or of `.commit-plan` itself, is left alone. It never deletes a renamed
 * lock file (`lock.<planId>`, its own or a release's put-back) nor a folder on such a file's
 * chain: adoption owns them (RUN-20b). A fresh lock temporary file may be another `plan`'s,
 * between its write and its link, so the 24 hours apply to it too. Never throws: a cleanup
 * error becomes a notice (`sweepNotice`), and a lock-type file the sweep cannot read becomes
 * one too (`sweepKeepsNotice`, finding 7) rather than silently skipping every folder; neither
 * ever changes the outcome.
 *
 * @param {{ toplevel: string, now?: () => number }} options the clock, injectable for tests.
 * @returns {string[]} the notices, one per entry that could not be removed or read.
 */
export function sweep({ toplevel, now = Date.now }) {
  const runDir = runDirOf(toplevel);
  const notices = [];
  let names;
  try {
    if (!isPlainDirectory(runDir)) return notices;
    names = fs.readdirSync(runDir);
  } catch (err) {
    notices.push(sweepNotice('', err.code || 'error'));
    return notices;
  }
  const keep = sweepKeeps(runDir, names, notices);
  const cutoff = now() - SWEEP_AFTER_MS;
  for (const name of names) {
    try {
      const entry = insideRunDir(runDir, name);
      const stats = fs.lstatSync(entry);
      const kind = sweepKind(name, stats);
      if (kind === null || stats.mtimeMs >= cutoff) continue;
      if (kind === 'folder' && (keep === null || keep.has(name))) continue;
      // Re-checked right before each removal: nothing is removed through a `.commit-plan`
      // swapped for a link mid-sweep, like `discard` and `release`.
      if (!isPlainDirectory(runDir)) return notices;
      fs.rmSync(entry, { recursive: kind === 'folder', force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // An entry gone by now (another call's own cleanup) is nothing to report.
      if (err.code !== 'ENOENT') notices.push(sweepNotice(name, err.code || 'error'));
    }
  }
  return notices;
}

/**
 * M12 `run.state` (PLN-01): the parsed `<planId>/state.json` of a run `open` returned, read
 * after `open` already checked its `version`. A read or parse error throws (`internal`).
 *
 * @param {{ toplevel: string, planId: string }} run
 * @returns {object}
 */
export function readState({ toplevel, planId }) {
  return JSON.parse(fs.readFileSync(insideRunDir(runDirOf(toplevel), `${planId}/state.json`), 'utf8'));
}

/**
 * M12 `run.write('state.json', …)` (PLN-01): replaces `<planId>/state.json` atomically
 * (temporary name, then rename, C:run-folder "Versioned"), one JSON object plus a newline.
 *
 * @param {{ toplevel: string, planId: string }} run
 * @param {object} state
 * @returns {void}
 */
export function writeState({ toplevel, planId }, state) {
  writeAtomic(insideRunDir(runDirOf(toplevel), planId), 'state.json', `${JSON.stringify(state)}\n`);
}

/**
 * M12 `run.write(name, …)` on an open run (CHG-19): replaces `<planId>/<name>` atomically,
 * as `writeState` does for `state.json`; a separate `plan --hunks` writes `hunks.txt` with it.
 *
 * @param {{ toplevel: string, planId: string }} run
 * @param {string} name a file name inside the run's folder.
 * @param {string} data
 * @returns {void}
 */
export function writeRunFile({ toplevel, planId }, name, data) {
  writeAtomic(insideRunDir(runDirOf(toplevel), planId), name, data);
}

/**
 * M12 `run.readWorkerPlan()` (PLN-01): the bytes of `<planId>/plan.groups.json`
 * (C:worker-plan), or `null` when there is no such regular file (missing, a link, a
 * directory, a FIFO), which M14 reports as a lint error. Other errors throw (`internal`).
 *
 * @param {{ toplevel: string, planId: string }} run
 * @returns {Buffer | null}
 */
export function readWorkerPlan({ toplevel, planId }) {
  const file = insideRunDir(runDirOf(toplevel), `${planId}/plan.groups.json`);
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  if (!stats.isFile()) return null;
  return fs.readFileSync(file);
}
