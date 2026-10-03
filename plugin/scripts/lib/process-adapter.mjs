// M2 Process adapter (docs/spec/modules-m1-m9.md, Q9, Q18): the only module that spawns
// processes. Mechanism only; it never decodes an asynchronous call's stdout.
//
// INT-01 built `toplevel` and an asynchronous `run`; GIT-01 adds `gitVersion`, the fixed
// short timeout of the two start-up `spawnSync` calls, typed start-up results (git missing,
// timed out) and `run`'s `timedOut` and `spawnedAt`. RUN-05 adds `gitPath`. GIT-05 adds the `GIT_*` environment
// hygiene, the config pins, `readOnly`, `index`, `history` and `input`; GIT-06 `git commit`'s
// own environment (`commit`); GIT-07 the deadline-driven timeout and process-tree kill.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** The fixed timeout of each start-up `spawnSync` call (`toplevel`, `gitVersion`). */
export const STARTUP_TIMEOUT_MS = 10_000;

/**
 * How long `run` waits, after killing a child whose `onStdout` consumer threw, for the
 * child to exit before rejecting anyway (a kill that never takes effect must not hang).
 */
export const KILL_BACKSTOP_MS = 5_000;

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

// The inherited variables `git commit` removes (M2, story 147, GIT-06): only the ones that
// redirect which repository, index, config or object store it uses. Every other variable,
// `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and the user's own `GIT_*` included, reaches the hooks.
const COMMIT_REMOVE = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS', 'GIT_ATTR_SOURCE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);
const COMMIT_REMOVE_PREFIXES = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

// Builds the environment of `git commit` (M2): the redirecting variables are removed,
// matched case-insensitively like `gitEnv`, and neither `GIT_LITERAL_PATHSPECS` nor the
// config pins are set, so the user's hooks run in the user's own git environment. `index`
// is the optional alternate index, as for every other call.
function commitEnv(env, { index } = {}) {
  if (!env) throw new Error('commitEnv: env is required');
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (COMMIT_REMOVE.has(upper) || COMMIT_REMOVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    out[key] = value;
  }
  if (index != null) out.GIT_INDEX_FILE = index;
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
 * `cmd` runs with `env` untouched. For git, except with `commit`, the call runs with the
 * hygiene of M2: every inherited `GIT_*` variable outside `GIT_ENV_KEEP_SET` is removed,
 * `GIT_LITERAL_PATHSPECS=1`, `core.quotePath=false` and `diff.suppressBlankEmpty=false` are
 * pinned, and the options below add the rest. With `commit` (the `git commit` spawn only)
 * just the redirecting variables are removed (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_COMMON_DIR`, `GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`, `GIT_CONFIG_PARAMETERS`,
 * `GIT_ATTR_SOURCE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`), nothing is
 * pinned and every other variable is kept for the user's hooks; `readOnly` and `history`
 * do not apply.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: object, now?: () => number, readOnly?: boolean,
 *   index?: string, history?: boolean, commit?: boolean, input?: string|Buffer }} options `cwd`: the toplevel
 *   for git; `env`: the injected process environment; `now`: the injected clock, read once
 *   when the child has spawned; `readOnly`: a read-only call, which gets
 *   `GIT_OPTIONAL_LOCKS=0` (never a staging call); `index`: an alternate index file
 *   (`GIT_INDEX_FILE`); `history`: a history read, which also pins
 *   `log.showSignature=false` and `i18n.logOutputEncoding=UTF-8`; `input`: written to the
 *   child's stdin, which is then closed (message input, path lists); without it stdin is
 *   ignored; `onStdout`: a consumer (M10's patch pass only, CHG-06) that gets each raw
 *   stdout chunk as it arrives, nothing being buffered here; if it throws, the child is
 *   killed (`SIGKILL`, the child only, same as `timeoutMs` below) instead of being left to
 *   run to completion, its stdout and stderr are no longer read, it gets no further chunk,
 *   and the call rejects with that error once the child has exited, without waiting for a
 *   process the child left holding its pipes, or `KILL_BACKSTOP_MS` after the kill if the
 *   child never exits;
 *   `timeoutMs` (GIT-12, the signing probe's fixed `ssh-add` timeout): past it the child is
 *   killed (`SIGKILL`, the child only) and the call resolves at once with `timedOut: true`
 *   and `code: null`, without waiting for a process the child left holding the pipes.
 *   GIT-07's deadline-driven timeout and process-tree kill replace this.
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string, timedOut: boolean,
 *   spawnedAt: number|null }>} `stdout` is the raw bytes, never decoded here, and empty with
 *   `onStdout`; `spawnedAt` is `null` without `now`. `timedOut` is `true` only past
 *   `timeoutMs`.
 */
export function run(cmd, args, { cwd, env, now, readOnly, index, history, commit, input, onStdout, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const isGit = path.basename(cmd, '.exe').toLowerCase() === 'git';
    let childEnv = env;
    if (isGit) childEnv = commit ? commitEnv(env, { index }) : gitEnv(env, { readOnly, index, history });
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
    let settled = false;
    let timer;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          code: null,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut: true,
          spawnedAt,
        });
      }, timeoutMs);
    }
    let consumerError = null;
    child.stdout.on('data', (chunk) => {
      if (onStdout === undefined) {
        stdout.push(chunk);
        return;
      }
      if (consumerError !== null) return;
      try {
        onStdout(chunk);
      } catch (err) {
        consumerError = err;
        abandon();
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // Left running, the child would keep producing output nobody reads; it is killed like
    // the `timeoutMs` path above instead of being waited for. Its pipes are destroyed too: a
    // process the child left holding them (the real git.exe behind Git for Windows'
    // `cmd\git.exe` launcher, a textconv filter) survives a kill of the child alone and
    // would otherwise keep `close` from ever firing, so the call settles on the child's own
    // exit. If even that never comes (the kill failed), the backstop rejects anyway.
    function abandon() {
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      // A non-ESRCH `kill` failure rejects synchronously through the `error` handler below,
      // which sets `settled` before this call returns; arming the backstop then would only
      // keep the event loop alive for `KILL_BACKSTOP_MS` with nothing left to do.
      if (!settled) {
        timer = setTimeout(() => {
          if (!settled) reject(consumerError);
          settled = true;
        }, KILL_BACKSTOP_MS);
      }
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(consumerError ?? err);
      settled = true;
    });
    child.on('exit', () => {
      if (consumerError === null) return;
      clearTimeout(timer);
      if (!settled) reject(consumerError);
      settled = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (consumerError !== null) {
        reject(consumerError);
        return;
      }
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
