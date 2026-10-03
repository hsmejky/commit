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
 * @param {{ toplevel: string, excludePath: string, tracked: string | boolean }} options
 *   `excludePath`: the common dir's `info/exclude` (M2 `gitPath`); `tracked`: the case-variant
 *   path the index holds under `.commit-plan`, such as `.Commit-Plan` (M3 `isTracked`), or
 *   `null`/`false` when it holds none, or `true` when the caller knows it is tracked but not
 *   which variant.
 * @returns {{ ok: true, provisional: { planId: string, runDir: string,
 *   write: (name: string, data: string | Uint8Array) => void,
 *   acquire: (options?: { now?: () => number }) => { ok: true, run: object, takeover: null }
 *     | { ok: false, code: 'held', message: string },
 *   discard: () => string | null } }
 *   | { ok: false, code: 'run-folder', message: string }}
 *   `runDir`: the folder, absolute and `path.resolve`d from the toplevel, with forward
 *   slashes (C:run-folder); `write(name, data)` writes `<planId>/<name>` atomically
 *   (temporary name, then rename; KD-R37: `state.json` is written before `acquire`);
 *   `acquire()` takes the run lock with no takeover (CHG-03b) and returns the run, whose
 *   `write` is the same and whose `release()` removes the lock and the folder;
 *   `discard()` deletes the folder (every outcome that takes no lock).
 *   Inside M12 a local `runDir` is `.commit-plan` itself (`runDirOf`); only this output
 *   field names the `<planId>/` folder, keeping C:plan's `runDir` (review-RUN-05 finding 8).
 */
export function create({ toplevel, excludePath, tracked }) {
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
  const write = (name, data) => writeAtomic(folder, name, data);
  const acquire = ({ now = Date.now } = {}) => acquireLock(runDir, planId, folder, now);
  return { ok: true, provisional: { planId, runDir: folder.split(path.sep).join('/'), write, acquire, discard } };
}

// Every write of a run file (`state.json`, `plan.json`, `hunks.txt`) goes to a temporary name
// in the run folder, then a rename into place, so no reader sees a half-written file
// (C:run-folder "Versioned"). The Windows file-in-use retry of the rename is RUN-09's.
function writeAtomic(folder, name, data) {
  const target = path.join(folder, name);
  const temp = path.join(folder, `${name}.tmp`);
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, target);
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

// M12 `acquire` without a takeover (CHG-03b, C:plan step 7): `{ planId, created }` written to
// a temporary file in `.commit-plan/` and hard-linked into place as `.commit-plan/lock`
// (`linkSync` never overwrites, so no reader sees a lock without its content). On a link
// failure the temporary file is removed (best-effort: the original error always wins, review-
// CHG-03b finding 1); once the link has succeeded the lock is in place regardless of what
// happens to its temporary file, so that removal is best-effort too and a leftover goes to
// the sweep (RUN-07, C:run-folder "leftover lock temporary files") rather than failing an
// acquire whose lock already stands. A link that fails with `EEXIST` is a race lost to
// another run's lock (RUN-06): `held`, naming that lock, and nothing of it is touched. Any
// other link error throws for now: RUN-09 maps the Windows `EPERM`/`EBUSY` retries and the
// probe.
function acquireLock(runDir, planId, folder, now) {
  const temp = insideRunDir(runDir, lockTempName(planId));
  const lock = insideRunDir(runDir, 'lock');
  fs.writeFileSync(temp, JSON.stringify({ planId, created: new Date(now()).toISOString() }), { flag: 'wx' });
  try {
    fs.linkSync(temp, lock);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The lock was never linked: a leftover temp here is not even a lock-shaped file the
      // sweep targets, but it is harmless and the original link error is what matters.
    }
    if (err.code === 'EEXIST') return held(runDir, now);
    throw err;
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Leftover lock temporary file: the sweep's (RUN-07), not this call's to fail over.
  }
  return { ok: true, run: ownRun(runDir, planId, folder), takeover: null };
}

/**
 * The `held` refusal text (C:cli-and-exit-codes, failure shape): the holder's start time
 * (`created`, local `HH:MM`) and how long ago it was last active (`touched`, the lock's
 * mtime, against the injected clock). An unparseable lock, or one whose `planId` is not in
 * the minted form, gets the unreadable-lock text instead; a lock gone again by the time it is
 * read names no holder.
 *
 * @param {{ planId: string | null, created: string | null, touched: number } | null} holder
 *   `null` when no lock could be read.
 * @param {number} nowMs
 * @returns {string}
 */
export function heldMessage(holder, nowMs) {
  if (holder === null) return 'another /commit run is in progress';
  const started = holder.created === null ? Number.NaN : Date.parse(holder.created);
  if (holder.planId === null || Number.isNaN(started)) {
    return 'the /commit lock is unreadable (corrupt or not written by /commit)';
  }
  const date = new Date(started);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const idle = Math.max(0, Math.round((nowMs - holder.touched) / 1000));
  return `another /commit run is in progress (started ${hhmm}, last active ${idle} s ago)`;
}

// `acquire`'s lost race (RUN-06): reads the lock now in place, without following a link, to
// name its holder. A file-in-use error on that read names no holder rather than failing the
// refusal. The full `lock` failure fields (`planId`, `created`, `touched`) are RUN-07's.
function held(runDir, now) {
  let file = null;
  try {
    file = readLockFile(insideRunDir(runDir, 'lock'));
  } catch (err) {
    if (!(err instanceof InUse)) throw err;
  }
  const holder = file === null ? null : {
    planId: lockPlanId(file.bytes),
    created: lockCreated(file.bytes),
    touched: file.stats.mtimeMs,
  };
  return { ok: false, code: 'held', message: heldMessage(holder, now()) };
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

// The run `acquire` returns: `write` as before the lock, and `release()`, which removes the
// lock (only while it still holds `planId`) and the run folder, returning `{ notice, kept }`.
// `release` never throws: a removal error becomes a notice and never replaces the call's
// outcome or original error, like `discard`. On `busy` (the lock rename hit a file-in-use
// error, `releaseById`'s own `busy(true)` case) the lock was never removed: `kept: true`
// tells the caller to leave the folder alone too, so the lock and its folder stay consistent
// for the next `/commit` to find an ordinary held run (review-CHG-03b finding 2); any other
// removal error is the folder's (finding 10), reported with `discardNotice` as before.
function ownRun(runDir, planId, folder) {
  return {
    planId,
    write: (name, data) => writeAtomic(folder, name, data),
    release: () => {
      if (!isPlainDirectory(runDir)) return { notice: null, kept: false };
      let outcome;
      try {
        outcome = removeOwnRun(runDir, planId);
      } catch (err) {
        return { notice: discardNotice(planId, err.code || 'error'), kept: false };
      }
      if (outcome === 'busy') return { notice: lockKeptNotice(planId), kept: true };
      return { notice: null, kept: false };
    },
  };
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
