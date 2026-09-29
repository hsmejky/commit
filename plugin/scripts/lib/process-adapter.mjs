// M2 Process adapter (docs/spec/modules-m1-m9.md, Q9, Q18): the only module that spawns
// processes. Mechanism only; it never decodes an asynchronous call's stdout.
//
// INT-01 built `toplevel` and an asynchronous `run`; GIT-01 adds `gitVersion`, the fixed
// short timeout of the two start-up `spawnSync` calls, typed start-up results (git missing,
// timed out) and `run`'s `timedOut` and `spawnedAt`. GIT-05 adds the `GIT_*` environment
// hygiene and `-c` pins, GIT-07 the deadline-driven timeout and process-tree kill.

import { spawn, spawnSync } from 'node:child_process';

/** The fixed timeout of each start-up `spawnSync` call (`toplevel`, `gitVersion`). */
export const STARTUP_TIMEOUT_MS = 10_000;

// Runs one named start-up git call synchronously under the fixed short timeout.
function startupGit(args, { cwd, env }) {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: STARTUP_TIMEOUT_MS,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') return { status: 'missing' };
    if (result.error.code === 'ETIMEDOUT') return { status: 'timed-out' };
    throw result.error;
  }
  return { status: 'ran', code: result.status, stdout: result.stdout };
}

/**
 * Finds the repository's toplevel from a directory (`git rev-parse --show-toplevel`).
 *
 * @param {string} fromCwd the directory to ask from.
 * @param {{ env: object }} options `env`: the injected process environment.
 * @returns {{ status: 'ok', toplevel: string } | { status: 'none' }
 *   | { status: 'missing' } | { status: 'timed-out' }} `toplevel` as git prints it (forward
 *   slashes); `none` when `fromCwd` is not inside a working tree; `missing` when no git can
 *   be spawned.
 */
export function toplevel(fromCwd, { env }) {
  const result = startupGit(['rev-parse', '--show-toplevel'], { cwd: fromCwd, env });
  if (result.status !== 'ran') return result;
  if (result.code !== 0) return { status: 'none' };
  return { status: 'ok', toplevel: result.stdout.replace(/\r?\n$/, '') };
}

/**
 * Reads git's version line (`git --version`).
 *
 * @param {{ cwd: string, env: object }} options `cwd`: the call's working directory;
 *   `env`: the injected process environment.
 * @returns {{ status: 'ok', output: string } | { status: 'failed', code: number|null }
 *   | { status: 'missing' } | { status: 'timed-out' }} `output` is the first line, trimmed.
 */
export function gitVersion({ cwd, env }) {
  const result = startupGit(['--version'], { cwd, env });
  if (result.status !== 'ran') return result;
  if (result.code !== 0) return { status: 'failed', code: result.code };
  return { status: 'ok', output: result.stdout.split(/\r?\n/)[0].trim() };
}

/**
 * Runs one process asynchronously and collects its output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel for
 *   git; `env`: the injected process environment; `now`: the injected clock, read once when
 *   the child has spawned.
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string, timedOut: boolean,
 *   spawnedAt: number|null }>} `stdout` is the raw bytes, never decoded here; `spawnedAt`
 *   is `null` without `now`. `timedOut` stays `false` until GIT-07 adds the call's timer.
 */
export function run(cmd, args, { cwd, env, now }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let spawnedAt = null;
    child.on('spawn', () => {
      spawnedAt = typeof now === 'function' ? now() : null;
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut: false,
        spawnedAt,
      });
    });
  });
}
