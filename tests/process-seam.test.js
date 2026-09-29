'use strict';

// FND-04 (docs/roadmap/01-foundation.md): self-tests of the process-seam harness in
// tests/helpers/process-seam.js, the helper every Seam 1 and Seam 2 case builds on
// (docs/spec/testing-seams.md). The entry points driven here are stubs in
// tests/fixtures/process-seam/, not the shipped scripts, so the harness is proven before
// commit.cjs and guard.cjs exist.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FIXED_IDENTITY,
  createCase,
  runEntry,
  runCommit,
  runGuard,
} = require('./helpers/process-seam.js');

const STUBS = path.join(__dirname, 'fixtures', 'process-seam');
const PRINT_ENV = path.join(STUBS, 'print-env.cjs');
const ECHO = path.join(STUBS, 'echo.cjs');
const STUB_GUARD = path.join(STUBS, 'stub-guard.cjs');
const CLEANUP_PROBE = path.join(STUBS, 'cleanup-probe.js');
const HANG_WITH_GRANDCHILD = path.join(STUBS, 'hang-with-grandchild.cjs');

// Sets hostile values on this test process's own environment for one case and restores
// them afterwards, so the case proves nothing from the host reaches the spawned process.
function withHostEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// --- AC 1: fixed author, committer and dates through plain git ---------------------------

test('a case repo commits through plain git with the fixed author, committer and dates', (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'first']);
  c.writeFile('b.txt', 'b\n');
  c.git(['add', 'b.txt']);
  c.git(['commit', '-q', '-m', 'second']);

  // %at/%ct (epoch seconds) rather than %aI/%cI: git before 2.45 prints the UTC offset as
  // `+00:00` instead of `Z`, which the ubuntu:22.04 git-2.34 CI job runs.
  const log = c.git(['log', '--format=%an|%ae|%at|%cn|%ce|%ct']).trim().split('\n');
  const expected = [
    FIXED_IDENTITY.GIT_AUTHOR_NAME,
    FIXED_IDENTITY.GIT_AUTHOR_EMAIL,
    '1704067200',
    FIXED_IDENTITY.GIT_COMMITTER_NAME,
    FIXED_IDENTITY.GIT_COMMITTER_EMAIL,
    '1704153600',
  ].join('|');
  assert.deepEqual(log, [expected, expected]);
  assert.equal(c.git(['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
});

// --- AC 2: the spawned process sees only what the case sets ------------------------------

test('the spawned entry point sees only the case OS home, Claude home and project dir', async (t) => {
  const hostile = createCase(t, { repo: false });
  const hostileGitConfig = path.join(hostile.root, 'host.gitconfig');
  fs.writeFileSync(hostileGitConfig, '[user]\n\tname = Host Leak\n\temail = host@example.com\n');
  fs.mkdirSync(path.join(hostile.root, 'xdg', 'git'), { recursive: true });
  fs.writeFileSync(path.join(hostile.root, 'xdg', 'git', 'config'), '[user]\n\tname = Xdg Leak\n');
  withHostEnv(t, {
    CLAUDE_CONFIG_DIR: path.join(hostile.root, 'host-claude'),
    CLAUDE_PROJECT_DIR: path.join(hostile.root, 'host-project'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    GIT_CONFIG_GLOBAL: hostileGitConfig,
    GIT_CONFIG_PARAMETERS: "'user.name'='Param Leak'",
    GIT_AUTHOR_NAME: 'Host Author',
    GIT_DIR: path.join(hostile.root, 'host-git-dir'),
    XDG_CONFIG_HOME: path.join(hostile.root, 'xdg'),
    EMAIL: 'host-email@example.com',
    NODE_OPTIONS: '--no-warnings',
    COMMIT_GUARD_DEBUG: '1',
  });

  const c = createCase(t);
  const { json, exitCode } = await runCommit(c, ['--flag', 'value'], { script: PRINT_ENV });
  assert.equal(exitCode, 0);

  assert.equal(json.homedir, c.osHome);
  assert.equal(json.env.HOME, c.osHome);
  assert.equal(json.env.USERPROFILE, c.osHome);
  assert.equal(json.env.CLAUDE_CONFIG_DIR, c.claudeHome);
  assert.equal(json.env.CLAUDE_PROJECT_DIR, c.repoDir);
  assert.equal(json.cwd, c.repoDir);
  assert.deepEqual(json.argv, ['--flag', 'value']);

  // Only the variables the case sets, none inherited from the host.
  assert.deepEqual(json.claudeKeys, ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']);
  assert.deepEqual(json.gitKeys, [...Object.keys(FIXED_IDENTITY), 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].sort());
  // On Windows libuv re-inserts USERNAME (with HOMEDRIVE, HOMEPATH and a few more) into
  // every child environment; it names the OS user, which `os.userInfo()` gives anyway and
  // the fault-injection preload removes where a case needs no OS user (testing-seams.md).
  const absent = ['EMAIL', 'NODE_OPTIONS', 'XDG_CONFIG_HOME', 'COMMIT_GUARD_DEBUG', 'USER', 'LOGNAME'];
  if (process.platform !== 'win32') absent.push('USERNAME');
  for (const key of absent) {
    assert.equal(json.env[key], undefined, `${key} leaked into the spawned process`);
  }

  // No host git config or git identity: the only config git reads is the repo's own.
  assert.equal(json.gitAuthorIdent, `${FIXED_IDENTITY.GIT_AUTHOR_NAME} <${FIXED_IDENTITY.GIT_AUTHOR_EMAIL}> 1704067200 +0000`);
  for (const line of json.gitConfigOrigins) {
    assert.match(line, /^file:\.git\/config\t/, `unexpected git config source: ${line}`);
  }
});

test('without a Claude config dir the Claude home falls back to .claude in the OS home', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  assert.equal(c.claudeHome, path.join(c.osHome, '.claude'));
  const { json } = await runCommit(c, [], { script: PRINT_ENV });
  assert.equal(json.env.CLAUDE_CONFIG_DIR, undefined);
  assert.deepEqual(json.claudeKeys, ['CLAUDE_PROJECT_DIR']);
});

test('a case can override or remove single env variables for one spawn', async (t) => {
  const c = createCase(t);
  const { json } = await runCommit(c, [], {
    script: PRINT_ENV,
    env: { CLAUDE_PROJECT_DIR: undefined, COMMIT_GUARD_DEBUG: '1' },
  });
  assert.deepEqual(json.claudeKeys, ['CLAUDE_CONFIG_DIR']);
  assert.equal(json.env.COMMIT_GUARD_DEBUG, '1');
});

// --- AC 3: Seam 1 stdout shape and size; Seam 2 stdin and heartbeat -----------------------

test('the Seam 1 helper returns the single JSON object, exit code, stderr and stdout size', async (t) => {
  const c = createCase(t);
  const stdout = '{"ok":true,"n":"é"}\n';
  const result = await runCommit(c, [stdout, '3', 'to stderr'], { script: ECHO });
  assert.deepEqual(result.json, { ok: true, n: 'é' });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'to stderr');
  assert.equal(result.stdout, stdout);
  assert.equal(result.stdoutBytes, Buffer.byteLength(stdout, 'utf8'));
});

for (const [label, stdout] of [
  ['empty stdout', ''],
  ['text that is not JSON', 'not json'],
  ['two JSON objects', '{"a":1}\n{"b":2}\n'],
  ['a JSON array', '[{"a":1}]'],
  ['a JSON scalar', '42'],
  ['JSON null', 'null'],
]) {
  test(`the Seam 1 helper fails a case whose stdout is ${label}, reporting its length`, async (t) => {
    const c = createCase(t);
    await assert.rejects(runCommit(c, [stdout, '0'], { script: ECHO }), (err) => {
      assert.ok(err instanceof assert.AssertionError, 'an assertion failure');
      assert.match(err.message, /exactly one JSON object/);
      assert.match(err.message, new RegExp(`stdout length ${Buffer.byteLength(stdout)} bytes`));
      return true;
    });
  });
}

test('the Seam 2 helper feeds PreToolUse JSON on stdin and reads the heartbeat from the temp Claude home', async (t) => {
  const c = createCase(t);
  const command = 'node "$CLAUDE_PLUGIN_ROOT/scripts/commit.cjs" plan --split';
  const result = await runGuard(c, { command, agentType: 'commit:commit-worker' }, { script: STUB_GUARD });
  assert.equal(result.exitCode, 0);
  const seen = JSON.parse(result.stdout);
  assert.deepEqual(seen, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: c.repoDir,
    agent_type: 'commit:commit-worker',
  });
  assert.equal(result.heartbeat.command, command);
  assert.equal(result.heartbeat.cwd, c.repoDir);
  assert.ok(fs.existsSync(path.join(c.claudeHome, 'commit-guard', 'heartbeat.json')));
});

test('the Seam 2 helper reads no heartbeat when the guard wrote none, and passes raw stdin', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { stdin: '{not json' }, { script: STUB_GUARD });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'unreadable input');
  assert.equal(result.heartbeat, null);
});

test('the Seam 2 helper reads the heartbeat from the OS-home fallback when no Claude config dir is set', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  const result = await runGuard(c, { toolName: 'PowerShell', command: 'commit.cjs plan' }, { script: STUB_GUARD });
  assert.equal(JSON.parse(result.stdout).tool_name, 'PowerShell');
  assert.equal(result.heartbeat.command, 'commit.cjs plan');
  assert.ok(fs.existsSync(path.join(c.osHome, '.claude', 'commit-guard', 'heartbeat.json')));
});

// --- AC 4: temp directories are removed after each case, also on failure ----------------

test('temp directories are removed after each case, also when the case fails', async (t) => {
  const c = createCase(t, { repo: false });
  const record = path.join(c.root, 'roots.txt');
  const result = await runEntry(c, CLEANUP_PROBE, [], {
    nodeArgs: ['--test', '--test-reporter=tap'],
    env: { SEAM_PROBE_RECORD: record },
  });
  assert.notEqual(result.exitCode, 0, `the probe's failing case must fail the run:\n${result.stdout}`);
  assert.match(result.stdout, /^not ok \d+ - a failing case/m);
  assert.match(result.stdout, /^ok \d+ - a passing case/m);
  const roots = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean);
  assert.equal(roots.length, 2);
  for (const root of roots) {
    assert.equal(fs.existsSync(root), false, `case root still exists: ${root}`);
  }
});

// --- A timeout kills the whole process tree, not just the direct child -------------------

// True if `pid` still denotes a live process. On Linux this also treats a zombie (`/proc/
// <pid>/stat` state `Z`) as gone: the ubuntu:22.04 CI container runs its steps under a
// `tail -f /dev/null` PID 1 with no `--init`, which never reaps a SIGKILLed orphan, so the
// grandchild here stays a zombie and `process.kill(pid, 0)` would otherwise keep succeeding
// against it forever even though it is already dead.
function isAlive(pid) {
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return false; // no /proc entry: already reaped and gone
    }
    // Format: "<pid> (<comm>) <state> ...". <comm> can itself contain ')', so anchor on the
    // last one rather than the first.
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[0];
    if (state === 'Z') return false; // zombie: dead, just unreaped by this container's PID 1
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a timed-out run kills the direct child\'s grandchild too', async (t) => {
  const c = createCase(t, { repo: false });
  const pidFile = path.join(c.root, 'grandchild.pid');
  // Generous timeout: the stub must start node, spawn its own grandchild and write the pid
  // file before it hangs, which a loaded CI box (especially Windows) can be slow to do; a
  // short timeout risks the tree being killed before the pid file even exists.
  const timeoutMs = 5000;
  await assert.rejects(
    runEntry(c, HANG_WITH_GRANDCHILD, [pidFile], { timeoutMs }),
    new RegExp(`did not exit within ${timeoutMs} ms`),
  );
  // Poll rather than read once: even with the generous timeout above, a slow disk could still
  // have the write land just after the kill fires.
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
  // The kill is sent right after the timeout fires; give the OS a moment to tear the
  // grandchild down before checking it is gone (also generous for a loaded CI container).
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
  assert.equal(isAlive(grandchildPid), false, 'grandchild still running');
});
