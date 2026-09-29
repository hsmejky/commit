// M12 Run (docs/spec/modules-m10-m13.md, Q9, Q22, C:run-folder): everything under the run
// folder. Effectful (filesystem); it spawns nothing.
//
// RUN-01 builds the tracer bullet: the minted `planId` form, the check that keeps every
// deletion strictly inside the run-folder directory, and `releaseById`. RUN-02 adds the
// `call.lock` a matching `release` takes before it deletes anything (`busy`); later RUN
// slices add `Run.create`, `peek`, `acquire`, `open`, `close`, the typed state and the sweep.

import fs from 'node:fs';
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

/**
 * Ends the run `planId` names (`release`, C:commit-release): reads the lock first; when it
 * holds `planId`, removes the lock and deletes the run folder, otherwise does nothing (the
 * run has already ended, or was taken over and the lock is someone else's, Q22).
 *
 * @param {{ toplevel: string, planId: string }} options
 * @returns {{ ok: true, released: boolean }} `released: false` for the no-op.
 * @throws {Error} on an unexpected filesystem error.
 */
export function releaseById({ toplevel, planId }) {
  const runDir = runDirOf(toplevel);
  if (!isValidPlanId(planId) || !isPlainDirectory(runDir)) return { ok: true, released: false };
  if (lockHolder(runDir) !== planId) return { ok: true, released: false };
  fs.rmSync(insideRunDir(runDir, 'lock'), { force: true });
  fs.rmSync(insideRunDir(runDir, planId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { ok: true, released: true };
}
