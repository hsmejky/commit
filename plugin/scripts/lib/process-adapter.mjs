// M2 Process adapter (docs/spec/modules-m1-m9.md, Q9, Q18): the only module that spawns
// processes. Mechanism only; it never decodes an asynchronous call's stdout.
//
// INT-01 built `toplevel` and an asynchronous `run`; GIT-01 adds `gitVersion`, the fixed
// short timeout of the two start-up `spawnSync` calls, typed start-up results (git missing,
// timed out) and `run`'s `timedOut` and `spawnedAt`. RUN-05 adds `gitPath`. GIT-05 adds the `GIT_*` environment
// hygiene, the config pins, `readOnly`, `index`, `history` and `input`; GIT-06 `git commit`'s
// own environment (`commit`); GIT-07 the deadline scope (`withDeadline`) and the
// process-tree kill.

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** The fixed timeout of each start-up `spawnSync` call (`toplevel`, `gitVersion`). */
export const STARTUP_TIMEOUT_MS = 10_000;

/**
 * The tree kill's grace (M2): how long `run` waits after the polite kill (POSIX `SIGTERM` to
 * the process group, Windows `taskkill /T`) before the forced one (`SIGKILL`, `taskkill /T
 * /F`), and again after that before settling anyway, so a kill that never takes effect
 * cannot hang the call.
 */
export const KILL_GRACE_MS = 5_000;

const KILL_POLL_MS = 25;

// The deadline scope of the current call (GIT-07): `withDeadline` below.
const deadlineScope = new AsyncLocalStorage();

/**
 * Runs `fn` inside a deadline scope (M2, M15 `deadline`): every `run` started inside it, at
 * any depth of awaits, takes `timeoutMs = scope.deadline - scope.now()` at its own start (the
 * smaller of that and its own explicit `timeoutMs`). A call whose budget is at or below 0 is
 * not spawned; a call the deadline (not its own explicit timeout) ends or skips sets
 * `scope.expired = true`, so the caller can tell a deadline timeout from any other failure.
 *
 * @template T
 * @param {{ deadline: number, now: () => number, expired?: boolean }} scope the call's
 *   deadline (epoch ms) and the injected clock; `expired` is set by `run`.
 * @param {() => T} fn
 * @returns {T}
 */
export function withDeadline(scope, fn) {
  if (typeof scope?.deadline !== 'number') throw new Error('withDeadline: deadline is required');
  if (typeof scope.now !== 'function') throw new Error('withDeadline: now is required');
  return deadlineScope.run(scope, fn);
}

// The call's effective timeout: the smaller of its explicit `timeoutMs` and the enclosing
// deadline scope's budget, with the scope returned only when its deadline is the binding one.
function callBudget(timeoutMs) {
  const explicit = timeoutMs ?? Infinity;
  const scope = deadlineScope.getStore();
  if (scope === undefined) return { ms: explicit, scope: undefined };
  const left = scope.deadline - scope.now();
  return left <= explicit ? { ms: left, scope } : { ms: explicit, scope: undefined };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// `SystemRoot` from the injected environment, matched case-insensitively (Windows names are).
function systemRoot(env) {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.toUpperCase() === 'SYSTEMROOT' && value) return value;
  }
  return 'C:\\Windows';
}

// Runs `taskkill` from the system directory (never `PATH`, docs/spec/constraints.md),
// bounded by the grace; a spawn error (no `taskkill` there) is swallowed: the grace below
// still bounds the call.
function taskkill(args, env) {
  return new Promise((resolve) => {
    const file = path.join(systemRoot(env), 'System32', 'taskkill.exe');
    let killer;
    const timer = setTimeout(done, KILL_GRACE_MS);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    try {
      killer = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      done();
      return;
    }
    killer.on('error', done);
    killer.on('exit', done);
  });
}

// Sends `signal` to the process group `-pid`; false when the group is gone (or unreachable).
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Polls (bounded by the grace) until the process group `-pid` is gone.
async function groupGone(pid) {
  for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
    if (!signalGroup(pid, 0)) return true;
    await sleep(KILL_POLL_MS);
  }
  return false;
}

// Resolves true once `child` has exited, or false after the grace.
function exitedWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// The tree kill of M2; never rejects. POSIX: the child leads its own process group
// (`detached`), so `SIGTERM` to the group, then `SIGKILL` after the grace, reaches every
// process the child started that did not leave the group. Windows: `taskkill /T`, then
// `taskkill /T /F` after the grace. A child that already exited is not looked up by pid on
// Windows (the pid may already name an unrelated process); on POSIX its group is still
// signalled, since a group outlives its leader while any member runs.
async function killTree(child, env) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await taskkill(['/T', '/PID', String(child.pid)], env);
    if (await exitedWithin(child, KILL_GRACE_MS)) return;
    await taskkill(['/T', '/F', '/PID', String(child.pid)], env);
    await exitedWithin(child, KILL_GRACE_MS);
    return;
  }
  if (!signalGroup(child.pid, 'SIGTERM') || await groupGone(child.pid)) return;
  // review-GIT-07 finding Low-4: `groupGone`'s `kill(-pgid, 0)` still succeeds while any
  // group member is an unreaped zombie (an orphan reparented to an init that does not reap),
  // which would poll the full grace on every such kill. `SIGKILL` cannot be caught or
  // ignored, so once it is delivered the direct child's own `exit` is enough to settle on.
  if (signalGroup(child.pid, 'SIGKILL')) await exitedWithin(child, KILL_GRACE_MS);
}

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
 * `commit` cannot be combined with `readOnly`, `history` or `index`: none of the three
 * applies to `git commit`'s own environment, so a caller that set any of them alongside
 * `commit` almost certainly meant a different, non-commit call. `run` throws synchronously
 * (before spawning anything) rather than silently drop them.
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
 *   stdout chunk as it arrives, nothing being buffered here; if it throws, the process
 *   tree is killed (as for the timeout below) instead of being left to run to completion,
 *   its stdout and stderr are no longer read, it gets no further chunk, and the call rejects
 *   with that error once the tree kill has finished;
 *   `timeoutMs` (an explicit cap, such as the signing probe's fixed `ssh-add` timeout): the
 *   call's timeout is the smaller of it and, inside `withDeadline`, the scope's
 *   `deadline - now()` read at the call's start (GIT-07). At or below 0 the call is not
 *   spawned and resolves `timedOut: true`, `code: null`, `spawnedAt: null`; past it the
 *   process tree is killed (POSIX: `SIGTERM` to the child's process group, `SIGKILL` after
 *   `KILL_GRACE_MS`; Windows: `taskkill /T`, then `/T /F` after the same grace, `taskkill`
 *   from `%SystemRoot%\System32`) and the call resolves `timedOut: true`, `code: null`,
 *   without waiting for a process that escaped the tree and still holds the pipes;
 *   `beforeKill` (M10 `commitGuarded` only, CHG-23): a synchronous callback run once, right
 *   before the tree kill of a timeout starts (not for an `onStdout` failure); a throw is ignored.
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string, timedOut: boolean,
 *   spawnedAt: number|null }>} `stdout` is the raw bytes, never decoded here, and empty with
 *   `onStdout`; `spawnedAt` is `null` without `now`. `timedOut` is `true` only past (or
 *   at a spent) timeout.
 */
export function run(cmd, args, { cwd, env, now, readOnly, index, history, commit, input, onStdout, timeoutMs, beforeKill }) {
  if (commit && (readOnly || history || index != null)) {
    throw new Error('run: commit cannot be combined with readOnly, history or index');
  }
  const budget = callBudget(timeoutMs);
  if (budget.ms <= 0) {
    // A spent budget (M15: a cleanup call at or below 0 counts as `timed-out`): not spawned.
    if (budget.scope !== undefined) budget.scope.expired = true;
    return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true, spawnedAt: null });
  }
  return new Promise((resolve, reject) => {
    const isGit = path.basename(cmd, '.exe').toLowerCase() === 'git';
    let childEnv = env;
    if (isGit) childEnv = commit ? commitEnv(env, { index }) : gitEnv(env, { readOnly, index, history });
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      // POSIX: the child leads its own process group, so the tree kill reaches its children.
      detached: process.platform !== 'win32',
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
    // Settles the call now (no later event changes it), stops reading the pipes, kills the
    // tree and then calls `finish`. The pipes are destroyed first: a process that escaped the
    // tree kill (a POSIX one in its own session) and still holds them would otherwise keep
    // `close` from ever firing.
    function stopTree(finish) {
      clearTimeout(timer);
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      killTree(child, env).then(finish);
    }
    if (budget.ms !== Infinity) {
      timer = setTimeout(() => {
        if (budget.scope !== undefined) budget.scope.expired = true;
        if (beforeKill !== undefined) {
          try {
            beforeKill();
          } catch {
            // the kill must go ahead
          }
        }
        stopTree(() => resolve({
          code: null,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut: true,
          spawnedAt,
        }));
      }, budget.ms);
    }
    child.stdout.on('data', (chunk) => {
      if (onStdout === undefined) {
        stdout.push(chunk);
        return;
      }
      if (settled) return;
      try {
        onStdout(chunk);
      } catch (err) {
        // Left running, the child would keep producing output nobody reads: the tree is
        // killed like the timeout path above, and the call rejects with the consumer's error.
        stopTree(() => reject(err));
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
      settled = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
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
