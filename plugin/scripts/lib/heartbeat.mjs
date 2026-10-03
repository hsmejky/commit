// S1 Heartbeat (docs/spec/modules-shared-and-guard.md; Q23; C:guard Output "Heartbeat").
//
// The guard writes `{ ts, cwd, command }` to `<Claude home>/commit-guard/heartbeat.json` when
// a segment of the hook command is a script call to `plan`, before deciding, so `plan` can
// tell whether the guard ran. The write goes to a temporary name in the same directory,
// carrying the pid and a random part, and is renamed into place: a reader never sees a
// partial file and parallel hooks never share a temporary name. `command` is stored redacted
// (the script-call form only), so arguments a caller passed do not persist in the Claude
// home. A shared leaf: the guard and `plan` both load it, and it imports no other module of
// the library.

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
