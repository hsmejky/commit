'use strict';

// Process-seam harness (FND-04; docs/spec/testing-seams.md, Seam 1 and Seam 2).
//
// `createCase(t)` gives one test case its own temp root holding an OS home, a Claude home
// and a git repo with a fixed author, committer and dates, and removes the root when the
// case ends, pass or fail (`t.after`). `runEntry` spawns an entry point with argv, env and
// stdin in that case; `runCommit` (Seam 1) also requires stdout to be exactly one JSON
// object and reports its size in bytes for the stdout budgets; `runGuard` (Seam 2) feeds
// `PreToolUse` JSON on stdin and reads the heartbeat file from the case's Claude home.
//
// The spawned environment is built from an allowlist, not from the host's environment
// minus a blocklist: only what a process needs to start and find git and a temp directory
// is kept, and everything a case depends on (homes, `CLAUDE_*`, git identity and config
// isolation, locale) is set by the case. So no host git config, Claude setting, `GIT_*`,
// `CLAUDE_*`, `NODE_OPTIONS`, `EMAIL` or user name can reach the entry point.

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_SCRIPTS = path.join(__dirname, '..', '..', 'plugin', 'scripts');
const COMMIT_ENTRY = path.join(PLUGIN_SCRIPTS, 'commit.cjs');
const GUARD_ENTRY = path.join(PLUGIN_SCRIPTS, 'guard.cjs');

// Author and committer differ, and so do their dates, so a check that reads the wrong
// field fails.
const FIXED_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Commit Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Commit Test Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z',
});

// Host variables a spawned node or git process needs to start, find executables and a temp
// directory, matched case-insensitively (Windows spells `Path`, `SystemRoot`).
const HOST_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
]);

const DEFAULT_TIMEOUT_MS = 60_000;

// Kills a timed-out child's whole process tree, not just the direct child: a grandchild
// (e.g. git) can otherwise hold the case's cwd open, which is an EBUSY on Windows cleanup
// and, via inherited pipes, keeps the run looking alive.
function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
    return;
  }
  try {
    // Negative pid: the whole process group the detached child leads.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function hostBaseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (HOST_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

// Applies per-spawn overrides; a key set to `undefined` is removed.
function mergeEnv(base, overrides) {
  const env = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Creates one case: `<root>/home` (OS home), a Claude home, and `<root>/repo` (a git repo on
 * `main`, unless `repo: false`). The root is resolved to its real path, so paths compare
 * equal to what a child sees (macOS `/private/var`, Windows 8.3 short names).
 *
 * @param {import('node:test').TestContext} t the case; its `after` hook removes the root.
 * @param {object} [options]
 * @param {boolean} [options.repo=true] create and `git init` the repo directory.
 * @param {boolean} [options.claudeConfigDir=true] set `CLAUDE_CONFIG_DIR` to `<root>/claude`;
 *   when false it stays unset and the Claude home is `<OS home>/.claude`.
 * @param {string|null} [options.projectDir] `CLAUDE_PROJECT_DIR`; defaults to the repo,
 *   `null` leaves it unset.
 * @param {Record<string, string|undefined>} [options.env] extra variables for every spawn.
 */
function createCase(t, options = {}) {
  const { repo = true, claudeConfigDir = true, projectDir, env: extraEnv } = options;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-seam-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const osHome = path.join(root, 'home');
  const claudeHome = claudeConfigDir ? path.join(root, 'claude') : path.join(osHome, '.claude');
  const repoDir = path.join(root, 'repo');
  const globalConfig = path.join(root, 'empty.gitconfig');
  fs.mkdirSync(osHome);
  // In fallback mode (no CLAUDE_CONFIG_DIR) the Claude home is not pre-created: a real guard
  // or commit entry point creates it lazily (e.g. when writing the heartbeat), and a case
  // should not assume it exists before that.
  if (claudeConfigDir) fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(globalConfig, '');

  const project = projectDir === undefined ? repoDir : projectDir;
  const env = mergeEnv({
    ...hostBaseEnv(),
    HOME: osHome,
    USERPROFILE: osHome,
    TZ: 'UTC',
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeHome } : {}),
    ...(project === null ? {} : { CLAUDE_PROJECT_DIR: project }),
    ...FIXED_IDENTITY,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    LC_ALL: 'C',
  }, extraEnv);

  const c = {
    root,
    osHome,
    claudeHome,
    repoDir,
    env,
    /** Runs git in the repo with the case env; returns stdout, throws on a non-zero exit. */
    git(args, gitOptions = {}) {
      const result = spawnSync('git', args, {
        cwd: gitOptions.cwd || repoDir,
        env: mergeEnv(env, gitOptions.env),
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
      }
      return result.stdout;
    },
    /** Writes a file relative to the repo, creating parent directories. */
    writeFile(relPath, content) {
      const target = path.join(repoDir, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
  };

  if (repo) {
    fs.mkdirSync(repoDir);
    c.git(['init', '-q', '-b', 'main', '.']);
  }
  return c;
}

/**
 * Spawns `node [nodeArgs] <script> [argv]` in the case and collects its output.
 *
 * @param {ReturnType<typeof createCase>} c
 * @param {string} script entry point path.
 * @param {string[]} [argv]
 * @param {object} [options]
 * @param {string} [options.stdin=''] written to stdin, which is then closed.
 * @param {Record<string, string|undefined>} [options.env] per-spawn overrides (`undefined` removes).
 * @param {string[]} [options.nodeArgs] node options before the script (e.g. `--import`).
 * @param {string} [options.cwd] defaults to the repo, or the root when there is none.
 * @param {number} [options.timeoutMs=60000] the whole process tree is killed and the call
 *   rejects, after the child closes, past it.
 * @returns {Promise<{ stdout: string, stdoutBytes: number, stderr: string, exitCode: number|null, signal: string|null }>}
 */
function runEntry(c, script, argv = [], options = {}) {
  const {
    stdin = '', env, nodeArgs = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const workDir = cwd || (fs.existsSync(c.repoDir) ? c.repoDir : c.root);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, script, ...argv], {
      cwd: workDir,
      env: mergeEnv(c.env, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: the child leads its own process group, so a timeout kill can reach a
      // grandchild (e.g. git) that the direct SIGKILL would otherwise miss.
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${path.basename(script)} did not exit within ${timeoutMs} ms`));
        return;
      }
      const stdoutBuffer = Buffer.concat(stdout);
      resolve({
        stdout: stdoutBuffer.toString('utf8'),
        stdoutBytes: stdoutBuffer.length,
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
      });
    });
    // A child that exits without reading stdin closes the pipe; that is not a failure here.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Seam 1: runs the commit entry point (or `options.script`) and fails the case unless stdout
 * is exactly one JSON object. `stdoutBytes` is stdout's raw byte size (not the UTF-8 size of
 * the decoded string, which would hide an invalid byte sequence), for the size budgets.
 *
 * @param {ReturnType<typeof createCase>} c
 * @param {string[]} argv
 * @param {Parameters<typeof runEntry>[3] & { script?: string }} [options]
 */
async function runCommit(c, argv = [], options = {}) {
  const { script = COMMIT_ENTRY, ...spawnOptions } = options;
  const result = await runEntry(c, script, argv, spawnOptions);
  const { stdoutBytes } = result;
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new assert.AssertionError({
      message: `stdout is not exactly one JSON object (stdout length ${stdoutBytes} bytes, `
        + `exit ${result.exitCode}):\n${result.stdout.slice(0, 2000)}\nstderr:\n${result.stderr.slice(0, 2000)}`,
      actual: result.stdout,
      expected: 'one JSON object',
      operator: 'runCommit',
    });
  }
  return { ...result, json };
}

/**
 * Seam 2: runs the guard entry point (or `options.script`) with a `PreToolUse` payload on
 * stdin and reads `<Claude home>/commit-guard/heartbeat.json` afterwards (`null` if absent).
 *
 * @param {ReturnType<typeof createCase>} c
 * @param {object} hook
 * @param {string} [hook.command] `tool_input.command`.
 * @param {string} [hook.toolName='Bash'] `Bash` or `PowerShell`.
 * @param {string} [hook.cwd] defaults to the repo.
 * @param {string} [hook.agentType] `agent_type`, omitted when unset.
 * @param {object} [hook.extra] further top-level payload fields (e.g. `agent_id`).
 * @param {string} [hook.stdin] raw stdin instead of the built payload.
 * @param {Parameters<typeof runEntry>[3] & { script?: string }} [options]
 */
async function runGuard(c, hook = {}, options = {}) {
  const { script = GUARD_ENTRY, ...spawnOptions } = options;
  const stdin = hook.stdin !== undefined ? hook.stdin : JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: hook.toolName || 'Bash',
    tool_input: { command: hook.command },
    cwd: hook.cwd || c.repoDir,
    ...(hook.agentType ? { agent_type: hook.agentType } : {}),
    ...hook.extra,
  });
  const result = await runEntry(c, script, [], { ...spawnOptions, stdin });
  // Resolved from the env actually used for this spawn, not the case's own claudeHome: a
  // per-spawn CLAUDE_CONFIG_DIR (or HOME/USERPROFILE) override must be honored the same way
  // the real guard's own `process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')`
  // would resolve it.
  const spawnEnv = mergeEnv(c.env, spawnOptions.env);
  const claudeHome = spawnEnv.CLAUDE_CONFIG_DIR
    || path.join(spawnEnv.HOME || spawnEnv.USERPROFILE, '.claude');
  const heartbeatPath = path.join(claudeHome, 'commit-guard', 'heartbeat.json');
  const heartbeat = fs.existsSync(heartbeatPath)
    ? JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'))
    : null;
  return { ...result, heartbeat, heartbeatPath };
}

module.exports = {
  COMMIT_ENTRY,
  GUARD_ENTRY,
  FIXED_IDENTITY,
  createCase,
  runEntry,
  runCommit,
  runGuard,
};
