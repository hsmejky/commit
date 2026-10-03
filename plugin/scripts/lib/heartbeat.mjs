// S1 Heartbeat (docs/spec/modules-shared-and-guard.md; Q23; C:guard Output "Heartbeat").
//
// The guard writes `{ ts, cwd, command }` to `<Claude home>/commit-guard/heartbeat.json` when
// a segment of the hook command is a script call to `plan`, before deciding, so `plan` can
// tell whether the guard ran. The write goes to a temporary name in the same directory,
// carrying the pid and a random part, and is renamed into place: a reader never sees a
// partial file and parallel hooks never share a temporary name. `command` is stored redacted
// (the script-call form only), so arguments a caller passed do not persist in the Claude
// home. GRD-17 adds the reading side: `guardState` judges `active` versus `not-seen` for
// `plan`, over the pure `samePathTree`, and `resolveClaudeHome`, which both entry points call
// so guard and `plan` find the Claude home the same way (C:guard). A shared leaf: the guard
// and `plan` both load it, and it imports no other module of the library.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The heartbeat's directory under the Claude home. */
export const HEARTBEAT_DIR = 'commit-guard';

/** The heartbeat's file name inside HEARTBEAT_DIR. */
export const HEARTBEAT_FILE = 'heartbeat.json';

/** The redacted command's length cap, in characters (C:guard Output). */
export const COMMAND_LIMIT = 200;

// The words the redacted form keeps (GRD-13 review note on GRD-15): `--flag` words (no `=`,
// so a `--name=value` word cannot carry a value along) and planId values, lowercase UUIDs.
// Everything else, message text and unexpanded variables included, is dropped; a PowerShell
// `--%` ends the arguments, since its tail is raw text for the shell.
const FLAG_WORD = /^--[a-z0-9][a-z0-9-]*$/;
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STOP_PARSING = '--%';

/**
 * The heartbeat file's path under a Claude home.
 *
 * @param {string} claudeHome
 * @returns {string}
 */
export function heartbeatPath(claudeHome) {
  return path.join(claudeHome, HEARTBEAT_DIR, HEARTBEAT_FILE);
}

/**
 * The redacted script-call form stored in the heartbeat and the debug log:
 * `commit.cjs <subcommand> <flags>`, without the script path or any other segment, keeping
 * only `--flag` words and planIds up to a PowerShell `--%`, cut to COMMAND_LIMIT characters.
 *
 * @param {{ subcommand: string, args: string[] }} call an S2 `recognise` result.
 * @returns {string}
 */
export function redactCommand({ subcommand, args }) {
  const kept = [];
  for (const arg of args) {
    if (arg === STOP_PARSING) break;
    if (FLAG_WORD.test(arg) || PLAN_ID.test(arg)) kept.push(arg);
  }
  return ['commit.cjs', subcommand, ...kept].join(' ').slice(0, COMMAND_LIMIT);
}

/**
 * Writes the heartbeat atomically: creates `<claudeHome>/commit-guard` when missing, writes
 * a temporary file named `heartbeat.json.<pid>.<random>.tmp` next to the target and renames
 * it into place. On any failure the temporary file is removed and the error rethrown (the
 * guard's fail-open catches it).
 *
 * @param {{ claudeHome: string, cwd: string|null, command: string, now: () => number }} input
 * @returns {void}
 */
export function writeHeartbeat({ claudeHome, cwd, command, now }) {
  const target = heartbeatPath(claudeHome);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `${HEARTBEAT_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const text = JSON.stringify({ ts: now(), cwd, command });
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** How long a heartbeat counts as fresh, in milliseconds (Q23: under 15 minutes old). */
export const FRESH_MS = 15 * 60 * 1000;

// A heartbeat is well under 1 kB; a larger file is not one the guard wrote.
const READ_LIMIT = 64 * 1024;

/**
 * The Claude home (glossary): `CLAUDE_CONFIG_DIR` when set and non-empty, else `.claude` in
 * the OS home. Both entry points resolve it through this one function (C:guard Heartbeat:
 * "guard and `plan` resolve it the same way"). `homedir` is only called on the fallback, so
 * a throwing OS-home lookup never matters while `CLAUDE_CONFIG_DIR` is set.
 *
 * @param {Record<string, string|undefined>} env
 * @param {() => string} homedir the OS home lookup (`os.homedir`).
 * @returns {string}
 */
export function resolveClaudeHome(env, homedir) {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

// `\` → `/`, case-folded when asked, trailing separators dropped (a root such as `/` or `C:/`
// becomes `''` or `c:`, which the prefix test below still treats as containing everything).
function normalise(value, caseFold) {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseFold ? slashed.toLowerCase() : slashed;
}

/**
 * Whether two already-realpathed paths are the same, or one lies inside the other, compared
 * by whole path components after `\` → `/` (and case folding when `caseFold`, true on
 * Windows and macOS). Pure.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ caseFold: boolean }} options
 * @returns {boolean}
 */
export function samePathTree(a, b, { caseFold }) {
  const x = normalise(a, caseFold);
  const y = normalise(b, caseFold);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// Reads the heartbeat file without ever blocking: opened non-blocking where the platform has
// the flag (a FIFO in its place then opens at once), checked to be a regular file on the open
// descriptor, and no larger than READ_LIMIT. Returns the parsed object, or `null` for anything else.
function readHeartbeat(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > READ_LIMIT) return null;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return value !== null && typeof value === 'object' ? value : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `plan`'s view of the guard (Q23, C:guard Heartbeat): `active` when the heartbeat under
 * `claudeHome` has a numeric `ts` less than FRESH_MS from `now()` (either way, so a clock
 * stepped back a little still counts but a far-future stamp never stays fresh) and an
 * absolute string `cwd` that, realpathed, is inside the realpathed `toplevel` or contains it
 * (`samePathTree`, case-folded on Windows and macOS); `not-seen` otherwise: no file, not a
 * regular file, not JSON, a `null` or missing `cwd`, a `cwd` that no longer exists, another
 * repo, an old stamp. Never throws.
 *
 * @param {{ claudeHome: string|undefined, toplevel: string, now: () => number }} input
 * @returns {'active' | 'not-seen'}
 */
export function guardState({ claudeHome, toplevel, now }) {
  try {
    const beat = readHeartbeat(heartbeatPath(claudeHome));
    if (beat === null) return 'not-seen';
    const { ts, cwd } = beat;
    if (typeof ts !== 'number' || !(Math.abs(now() - ts) < FRESH_MS)) return 'not-seen';
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return 'not-seen';
    const caseFold = process.platform === 'win32' || process.platform === 'darwin';
    const matched = samePathTree(fs.realpathSync.native(cwd), fs.realpathSync.native(toplevel), { caseFold });
    return matched ? 'active' : 'not-seen';
  } catch {
    return 'not-seen';
  }
}
