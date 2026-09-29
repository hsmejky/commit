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

// Whether the run-folder directory is a plain directory. A link (symlink or junction) or a
// non-directory is never followed: a release behind it deletes nothing (C:run-folder).
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
function lockHolder(runDir) {
  const lockPath = insideRunDir(runDir, 'lock');
  let stats;
  try {
    // Follows a link (read, never delete, follows it), so a link to a huge file or a FIFO is
    // caught the same as one in place directly.
    stats = fs.statSync(lockPath);
  } catch (err) {
    // No lock, a broken link, or a path component that is not a directory.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP') return null;
    throw err;
  }
  if (!stats.isFile() || stats.size > LOCK_MAX_BYTES) return null;
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    // The lock vanished between the stat and the read.
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let content;
  try {
    content = JSON.parse(text);
  } catch {
    return null;
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  return isValidPlanId(content.planId) ? content.planId : null;
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
 *   rename found nothing; `busy`: a file-in-use error on the rename or the read.
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
  } catch {
    // A new file already in place (`EEXIST`), or one that cannot be linked back (in use, a
    // directory, vanished): the private copy is kept, never forced over `from`.
    return { outcome: readInUse ? 'busy' : 'conflict' };
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

const BUSY_MESSAGE = 'another /commit call on this run is still running; try again once it has finished';

function busy() {
  return { ok: false, code: 'busy', message: BUSY_MESSAGE };
}

// `<planId>` checked with `lstat` right before its `call.lock` is touched: a link (a
// junction swapped in after the lock check) is never followed (review-RUN-01 finding 1).
function isRunFolder(folder) {
  try {
    const stats = fs.lstatSync(folder);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Takes the run's `call.lock` exclusively (Q22 "one call per run at a time"). No folder,
 * or a folder that is a link or not a directory, holds no call to guard: nothing is
 * written. A live `call.lock` → `busy`; a stale one is replaced through
 * `moveAsideVerified` (bytes plus mtime), then the create is retried.
 *
 * @returns {{ ok: true, path: string | null } | { ok: false, code: 'busy', message: string }}
 */
function takeCallLock(runDir, planId, { now, pid, host, isAlive }) {
  const folder = insideRunDir(runDir, planId);
  const callLock = insideRunDir(runDir, `${planId}/call.lock`);
  const content = JSON.stringify({ pid, host });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isRunFolder(folder)) return { ok: true, path: null };
    try {
      fs.writeFileSync(callLock, content, { flag: 'wx' });
      return { ok: true, path: callLock };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true, path: null };
      if (IN_USE.has(err.code)) return busy();
      if (err.code !== 'EEXIST') throw err;
    }
    let judged;
    try {
      judged = readLockFile(callLock);
    } catch (err) {
      if (err instanceof InUse) return busy();
      throw err;
    }
    if (judged === null) continue;
    if (!isCallLockStale({ bytes: judged.bytes, mtimeMs: judged.stats.mtimeMs, now: now(), host, isAlive })) {
      return busy();
    }
    if (!isRunFolder(folder)) return { ok: true, path: null };
    const aside = insideRunDir(runDir, `${planId}/call.lock.${crypto.randomUUID()}`);
    const { outcome } = moveAsideVerified({
      from: callLock,
      to: aside,
      verify: (bytes, stats) => stats.mtimeMs === judged.stats.mtimeMs
        && (bytes === null ? judged.bytes === null : judged.bytes !== null && bytes.equals(judged.bytes)),
    });
    if (outcome === 'moved' || outcome === 'conflict') fs.rmSync(aside, { recursive: true, force: true });
    if (outcome !== 'moved' && outcome !== 'gone') return busy();
  }
  return busy();
}

// `run.close()` for `release`: removes the call's own `call.lock`; `ENOENT`-tolerant (the
// folder deleted by the release itself or by a takeover) and never through a link.
function closeCallLock(runDir, planId) {
  if (!isRunFolder(insideRunDir(runDir, planId))) return;
  try {
    fs.rmSync(insideRunDir(runDir, `${planId}/call.lock`), { force: true });
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
  if (lockHolder(runDir) !== planId) return { ok: true, released: false };
  const call = takeCallLock(runDir, planId, { now, pid, host, isAlive });
  if (!call.ok) return call;
  try {
    const aside = insideRunDir(runDir, `lock.${crypto.randomUUID()}`);
    const { outcome } = moveAsideVerified({
      from: insideRunDir(runDir, 'lock'),
      to: aside,
      verify: (bytes) => lockPlanId(bytes) === planId,
    });
    if (outcome === 'busy') return busy();
    if (outcome !== 'moved') return { ok: true, released: false };
    // Folder first, then the renamed lock: a kill in between leaves a renamed lock whose
    // chain ends at a missing folder, which the next adopter counts done (C:run-folder).
    fs.rmSync(insideRunDir(runDir, planId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(aside, { force: true });
    return { ok: true, released: true };
  } finally {
    if (call.path !== null) closeCallLock(runDir, planId);
  }
}
