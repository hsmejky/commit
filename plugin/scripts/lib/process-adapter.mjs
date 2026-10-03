// M2 Process adapter (docs/spec/modules-m1-m9.md, Q9, Q18): the only module that spawns
// processes. Mechanism only; it never decodes an asynchronous call's stdout.
//
// INT-01 built `toplevel` and an asynchronous `run`; GIT-01 adds `gitVersion`, the fixed
// short timeout of the two start-up `spawnSync` calls, typed start-up results (git missing,
// timed out) and `run`'s `timedOut` and `spawnedAt`. RUN-05 adds `gitPath`. GIT-05 adds the `GIT_*` environment
// hygiene, the config pins, `readOnly`, `index`, `history` and `input`; GIT-07 the
// deadline-driven timeout and process-tree kill.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** The fixed timeout of each start-up `spawnSync` call (`toplevel`, `gitVersion`). */
export const STARTUP_TIMEOUT_MS = 10_000;

/**
 * The inherited `GIT_*` variables every git call except `git commit` keeps (M2, story 147):
 * the ones that choose git itself, its config files and its credentials, never ones that
 * redirect what a call reads.
 */
export const GIT_ENV_KEEP_SET = Object.freeze([
  'GIT_EXEC_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH',
  'GIT_SSH_COMMAND', 'GIT_ASKPASS',
]);

const KEEP = new Set(GIT_ENV_KEEP_SET);

// The config every git call except `git commit` pins (Q9, Q11), and what history reads pin
// on top. They go in through `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (git 2.31+), the same
// command-line scope as `-c`, so the caller's argv stays as the caller wrote it; the
// inherited `GIT_CONFIG_COUNT` family is removed first, like every non-kept `GIT_*`.
const PINNED_CONFIG = [['core.quotePath', 'false'], ['diff.suppressBlankEmpty', 'false']];
const HISTORY_CONFIG = [['log.showSignature', 'false'], ['i18n.logOutputEncoding', 'UTF-8']];

// Builds the environment of one git call except `git commit` (M2): every inherited `GIT_*`
// variable outside the keep-set is removed, matched case-insensitively because Windows
// environment names are, then the pins are set. `index` is the optional alternate index.
function gitEnv(env, { readOnly = false, index, history = false } = {}) {
  if (!env) throw new Error('gitEnv: env is required');
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !KEEP.has(upper)) continue;
    out[key] = value;
  }
  out.GIT_LITERAL_PATHSPECS = '1';
  if (readOnly) out.GIT_OPTIONAL_LOCKS = '0';
  if (index != null) out.GIT_INDEX_FILE = index;
  const config = history ? [...PINNED_CONFIG, ...HISTORY_CONFIG] : PINNED_CONFIG;
  out.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return out;
}

// Runs one named start-up git call synchronously under the fixed short timeout. Both
// start-up calls are read-only.
function startupGit(args, { cwd, env }) {
  const result = spawnSync('git', args, {
    cwd,
    env: gitEnv(env, { readOnly: true }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: STARTUP_TIMEOUT_MS,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') return { status: 'missing' };
    if (result.error.code === 'ETIMEDOUT') return { status: 'timed-out' };
    // A non-ENOENT, non-timeout spawn error (e.g. EACCES: git exists but cannot be executed)
    // is as unusable as a missing git, so it becomes the same `env` refusal instead of an
    // unhandled throw surfacing as `internal` (GIT-01 review finding 4).
    return { status: 'unreadable', output: result.error.message };
  }
  return { status: 'ran', code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Finds the repository's toplevel from a directory (`git rev-parse --show-toplevel`).
 *
 * @param {string} fromCwd the directory to ask from.
 * @param {{ env: object }} options `env`: the injected process environment.
 * @returns {{ status: 'ok', toplevel: string } | { status: 'none' }
 *   | { status: 'missing' } | { status: 'timed-out' }
 *   | { status: 'unreadable', output: string }} `toplevel` as git prints it (forward
 *   slashes); `none` when `fromCwd` is not inside a working tree; `missing` when no git can
 *   be spawned; `unreadable` for a non-ENOENT, non-timeout spawn error (e.g. EACCES).
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
 * @returns {{ status: 'ok', output: string } | { status: 'failed', code: number|null, output: string }
 *   | { status: 'missing' } | { status: 'timed-out' }
 *   | { status: 'unreadable', output: string }} `output` is the first line, trimmed; `failed`
 *   now also carries `output` (git's stderr, or stdout if stderr is empty).
 */
export function gitVersion({ cwd, env }) {
  const result = startupGit(['--version'], { cwd, env });
  if (result.status !== 'ran') return result;
  if (result.code !== 0) {
    return { status: 'failed', code: result.code, output: (result.stderr || result.stdout || '').trim() };
  }
  return { status: 'ok', output: result.stdout.split(/\r?\n/)[0].trim() };
}

/**
 * Resolves paths inside the git directory with one `git rev-parse --git-path` call (RUN-05:
 * `info/exclude`, which git resolves to the common dir, so every linked worktree shares it).
 *
 * @param {string[]} names the paths to resolve, such as `info/exclude`.
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<string[]>} one absolute path per name, in order (git prints a path
 *   relative to `cwd` for the main worktree's own git directory; it is resolved here).
 * @throws {Error} when git exits non-zero or prints a different number of lines.
 */
export async function gitPath(names, { cwd, env, now }) {
  const args = ['rev-parse'];
  for (const name of names) args.push('--git-path', name);
  const result = await run('git', args, { cwd, env, now, readOnly: true });
  const lines = result.stdout.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
  if (result.code !== 0 || lines.length !== names.length) {
    throw new Error(`git rev-parse --git-path failed (${result.code}): ${result.stderr}`);
  }
  return lines.map((line) => path.resolve(cwd, line));
}

/**
 * Runs one process asynchronously and collects its output.
 *
 * `cmd` is matched against `git` by basename, case-insensitively and with an `.exe` suffix
 * stripped, so a resolved or absolute git path still gets the hygiene below; every other
 * `cmd` runs with `env` untouched. For git (every call so far; `git commit`'s own
 * environment is GIT-06's) the call runs with the hygiene of M2: every inherited `GIT_*`
 * variable outside `GIT_ENV_KEEP_SET` is removed, `GIT_LITERAL_PATHSPECS=1`,
 * `core.quotePath=false` and `diff.suppressBlankEmpty=false` are pinned, and the options
 * below add the rest.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: object, now?: () => number, readOnly?: boolean,
 *   index?: string, history?: boolean, input?: string|Buffer }} options `cwd`: the toplevel
 *   for git; `env`: the injected process environment; `now`: the injected clock, read once
 *   when the child has spawned; `readOnly`: a read-only call, which gets
 *   `GIT_OPTIONAL_LOCKS=0` (never a staging call); `index`: an alternate index file
 *   (`GIT_INDEX_FILE`); `history`: a history read, which also pins
 *   `log.showSignature=false` and `i18n.logOutputEncoding=UTF-8`; `input`: written to the
 *   child's stdin, which is then closed (message input, path lists); without it stdin is
 *   ignored.
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string, timedOut: boolean,
 *   spawnedAt: number|null }>} `stdout` is the raw bytes, never decoded here; `spawnedAt`
 *   is `null` without `now`. `timedOut` stays `false` until GIT-07 adds the call's timer.
 */
export function run(cmd, args, { cwd, env, now, readOnly, index, history, input }) {
  return new Promise((resolve, reject) => {
    const isGit = path.basename(cmd, '.exe').toLowerCase() === 'git';
    const childEnv = isGit ? gitEnv(env, { readOnly, index, history }) : env;
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) {
      // A child that exits without reading all of its stdin closes the pipe (EPIPE); the
      // call's result is then its exit code and stderr, not a write error.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
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
