// M2 Process adapter (docs/spec/modules-m1-m9.md, Q9, Q18): the only module that spawns
// processes. Mechanism only; it never decodes stdout.
//
// INT-01 builds the thinnest form the walking skeleton needs: `toplevel` (one short
// `spawnSync`) and an asynchronous `run`. GIT-01 adds `gitVersion` and the fixed short
// timeouts, GIT-05 the `GIT_*` environment hygiene and `-c` pins, GIT-07 the deadline-driven
// timeout and process-tree kill.

import { spawn, spawnSync } from 'node:child_process';

/**
 * Finds the repository's toplevel from a directory (`git rev-parse --show-toplevel`).
 *
 * @param {string} fromCwd the directory to ask from.
 * @param {{ env: object }} options `env`: the injected process environment.
 * @returns {string|null} the toplevel (git prints it with forward slashes), or `null` when
 *   `fromCwd` is not inside a working tree.
 */
export function toplevel(fromCwd, { env }) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: fromCwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.replace(/\r?\n$/, '');
}

/**
 * Runs one process asynchronously and collects its output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: object }} options `cwd`: the toplevel for git; `env`: the
 *   injected process environment.
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string }>} `stdout` is the
 *   raw bytes, never decoded here.
 */
export function run(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
