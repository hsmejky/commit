'use strict';

// GRD-15: S1 heartbeat write. When any segment of a hook command is a script call to `plan`,
// the guard writes `{ ts, cwd, command }` to `<Claude home>/commit-guard/heartbeat.json`
// before deciding, through a temporary name renamed into place, with `command` redacted to
// the script-call form (Q23, C:guard Output "Heartbeat", docs/spec/modules-shared-and-guard.md
// S1 and G1).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCase, runGuard, GUARD_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const PLAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let heartbeat;
let runHook;
let MESSAGES;

beforeEach(async () => {
  heartbeat = await loadLib('heartbeat');
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES } = await loadLib('command-classifier'));
});

function guardDirEntries(claudeHome) {
  const dir = path.join(claudeHome, 'commit-guard');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

// --- Seam 2: the real hook process --------------------------------------------------------

const planForms = [
  { label: 'Bash, exempt double-quoted form', toolName: 'Bash', command: 'node "/opt/plug in/commit.cjs" plan --no-user', expected: 'commit.cjs plan --no-user' },
  { label: 'Bash, single-quoted path', toolName: 'Bash', command: "node '/opt/plugin/commit.cjs' plan --staged", expected: 'commit.cjs plan --staged' },
  { label: 'Bash, unquoted path', toolName: 'Bash', command: 'node /opt/plugin/commit.cjs plan', expected: 'commit.cjs plan' },
  { label: 'Bash, node.exe and a backslash path', toolName: 'Bash', command: 'node.exe "C:\\Program Files\\plugin\\commit.cjs" plan --split', expected: 'commit.cjs plan --split' },
  { label: 'Bash, after cd in a compound', toolName: 'Bash', command: 'cd sub && node "/opt/plugin/commit.cjs" plan --reword --dictated', expected: 'commit.cjs plan --reword --dictated' },
  { label: 'Bash, message text, $HOME and a planId', toolName: 'Bash', command: `node "/opt/plugin/commit.cjs" plan --take-over ${PLAN_ID} -m "secret text" $HOME --no-user`, expected: `commit.cjs plan --take-over ${PLAN_ID} --no-user` },
  { label: 'PowerShell, & and a double-quoted path', toolName: 'PowerShell', command: '& node "C:/Tools/plugin/commit.cjs" plan --no-user', expected: 'commit.cjs plan --no-user' },
  { label: 'PowerShell, single-quoted backslash path', toolName: 'PowerShell', command: "node 'C:\\plugin\\commit.cjs' plan --staged", expected: 'commit.cjs plan --staged' },
  { label: 'PowerShell, cut at a --% tail', toolName: 'PowerShell', command: 'node "C:/plugin/commit.cjs" plan --no-user --% ; git commit -m secret', expected: 'commit.cjs plan --no-user' },
];

for (const { label, toolName, command, expected } of planForms) {
  test(`Seam 2: a plan script call writes the heartbeat (${label})`, async (t) => {
    const c = createCase(t);
    const cwd = `${c.repoDir}${path.sep}raw//cwd`;
    const before = Date.now();
    const result = await runGuard(c, { toolName, command, cwd });
    const after = Date.now();
    assert.equal(result.exitCode, 0);
    assert.equal(result.heartbeatPath, path.join(c.claudeHome, 'commit-guard', 'heartbeat.json'));
    assert.ok(result.heartbeat, 'heartbeat written');
    assert.deepEqual(Object.keys(result.heartbeat), ['ts', 'cwd', 'command']);
    assert.equal(result.heartbeat.cwd, cwd);
    assert.equal(result.heartbeat.command, expected);
    assert.ok(Number.isInteger(result.heartbeat.ts));
    assert.ok(result.heartbeat.ts >= before && result.heartbeat.ts <= after);
    assert.deepEqual(guardDirEntries(c.claudeHome), ['heartbeat.json']);
  });
}

test('Seam 2: the redacted command is cut to 200 characters', async (t) => {
  const c = createCase(t);
  const command = `node "/opt/plugin/commit.cjs" plan${' --no-user'.repeat(40)}`;
  const result = await runGuard(c, { command });
  const full = `commit.cjs plan${' --no-user'.repeat(40)}`;
  assert.equal(result.heartbeat.command, full.slice(0, 200));
});

test('Seam 2: a denied compound command that also calls plan still writes the heartbeat', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'node "/opt/plugin/commit.cjs" plan && git commit -m x' });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.heartbeat.command, 'commit.cjs plan');
  assert.deepEqual(guardDirEntries(c.claudeHome), ['heartbeat.json']);
});

const noHeartbeat = [
  { label: 'a blanket-denied plan call', command: 'node "/opt/plugin/commit.cjs" plan # x', denied: true },
  { label: 'a check call', command: 'node "/opt/plugin/commit.cjs" check' },
  { label: 'a commit call', command: 'node "/opt/plugin/commit.cjs" commit' },
];

for (const { label, command, denied } of noHeartbeat) {
  test(`Seam 2: ${label} writes no heartbeat`, async (t) => {
    const c = createCase(t);
    const result = await runGuard(c, { command });
    assert.equal(result.exitCode, 0);
    if (denied) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(result.heartbeat, null);
    assert.deepEqual(guardDirEntries(c.claudeHome), []);
  });
}

test('Seam 2: a guard crash (the library cannot load) writes no heartbeat for a plan call', async (t) => {
  const c = createCase(t);
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-nolib-'));
  t.after(() => fs.rmSync(isolatedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const isolatedGuard = path.join(isolatedDir, 'guard.cjs');
  fs.copyFileSync(GUARD_ENTRY, isolatedGuard);
  const result = await runGuard(c, { command: 'node "/opt/plugin/commit.cjs" plan' }, { script: isolatedGuard });
  assert.equal(result.stdout, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat, null);
  assert.deepEqual(guardDirEntries(c.claudeHome), []);
});

test('Seam 2: without CLAUDE_CONFIG_DIR the heartbeat lands under <OS home>/.claude', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  const result = await runGuard(c, { command: 'node "/opt/plugin/commit.cjs" plan' });
  const expectedPath = path.join(c.osHome, '.claude', 'commit-guard', 'heartbeat.json');
  assert.equal(result.heartbeatPath, expectedPath);
  assert.equal(result.heartbeat.command, 'commit.cjs plan');
  assert.ok(fs.existsSync(expectedPath));
});

test('Seam 2: a failed rename leaves no temporary file and no heartbeat, and no output', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'node "/opt/plugin/commit.cjs" plan' }, {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'heartbeat.json' },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat, null);
  assert.deepEqual(guardDirEntries(c.claudeHome), []);
});

// A broken Claude home: the path is an existing file, not a directory, so the write throws.
function fileClaudeHome(c) {
  const fileHome = path.join(c.root, 'claude-file');
  fs.writeFileSync(fileHome, 'not a directory');
  return fileHome;
}

test('Seam 2: a Claude home that is a file fails the write; the allowed plan call stays allowed', async (t) => {
  const c = createCase(t);
  const fileHome = fileClaudeHome(c);
  const hook = { command: 'node "/opt/plugin/commit.cjs" plan', extra: { agent_id: 'a1' } };

  const debugged = await runGuard(c, hook, { env: { CLAUDE_CONFIG_DIR: fileHome, COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.stdout, '');
  assert.equal(debugged.exitCode, 0);
  assert.equal(debugged.heartbeat, null);
  assert.equal(
    debugged.stderr,
    '{"agent_id":"a1","decision":"none","command":"commit.cjs plan","heartbeat":"failed"}\n',
  );

  const plain = await runGuard(c, hook, { env: { CLAUDE_CONFIG_DIR: fileHome } });
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, '');
  assert.equal(plain.exitCode, 0);
  assert.equal(fs.readFileSync(fileHome, 'utf8'), 'not a directory');
});

test('Seam 2: a denied compound command with a plan call is still denied when the write fails', async (t) => {
  const c = createCase(t);
  const fileHome = fileClaudeHome(c);
  const hook = { command: 'node "/opt/plugin/commit.cjs" plan && git commit -m x', extra: { agent_id: 'a2' } };

  const debugged = await runGuard(c, hook, { env: { CLAUDE_CONFIG_DIR: fileHome, COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.exitCode, 0);
  assert.equal(JSON.parse(debugged.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    debugged.stderr,
    `${JSON.stringify({ agent_id: 'a2', decision: 'deny', reason: MESSAGES.bare, command: '-m', heartbeat: 'failed' })}\n`,
  );

  const plain = await runGuard(c, hook, { env: { CLAUDE_CONFIG_DIR: fileHome } });
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.stdout, debugged.stdout);
  assert.equal(plain.stderr, '');
  assert.equal(fs.readFileSync(fileHome, 'utf8'), 'not a directory');
});

// --- Seam 3: runHook with injected claudeHome and now, and S1 itself ----------------------

function tempHome(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-heartbeat-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function payload(command, extra = {}) {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/w/repo', ...extra });
}

test('Seam 3: runHook writes ts from the injected now and the raw cwd', (t) => {
  const claudeHome = tempHome(t);
  const result = runHook(payload('node "/p/commit.cjs" plan --no-user'), { env: {}, claudeHome, now: () => 1234567 });
  assert.deepEqual({ ...result }, { stdout: '', stderr: '' });
  const written = fs.readFileSync(heartbeat.heartbeatPath(claudeHome), 'utf8');
  assert.equal(written, '{"ts":1234567,"cwd":"/w/repo","command":"commit.cjs plan --no-user"}');
});

test('Seam 3: runHook writes the first plan call of several, and none without one', (t) => {
  const claudeHome = tempHome(t);
  runHook(payload('node "/p/commit.cjs" check; node "/p/commit.cjs" plan --staged; node "/p/commit.cjs" plan --split'), { env: {}, claudeHome, now: () => 1 });
  assert.equal(JSON.parse(fs.readFileSync(heartbeat.heartbeatPath(claudeHome), 'utf8')).command, 'commit.cjs plan --staged');

  const other = tempHome(t);
  runHook(payload('node "/p/commit.cjs" check && git status # commit'), { env: {}, claudeHome: other, now: () => 1 });
  runHook(payload('node "/p/commit.cjs" check'), { env: {}, claudeHome: other, now: () => 1 });
  assert.deepEqual(fs.readdirSync(other), []);
});

test('Seam 3: a missing or non-string cwd is stored as null', (t) => {
  const claudeHome = tempHome(t);
  runHook(payload('node "/p/commit.cjs" plan', { cwd: 42 }), { env: {}, claudeHome, now: () => 5 });
  assert.equal(JSON.parse(fs.readFileSync(heartbeat.heartbeatPath(claudeHome), 'utf8')).cwd, null);
});

test('Seam 3: runHook keeps the decision when the heartbeat write fails', (t) => {
  const claudeHome = path.join(tempHome(t), 'claude-file');
  fs.writeFileSync(claudeHome, 'x');
  const denied = runHook(payload('node "/p/commit.cjs" plan && git commit -m x'), { env: {}, claudeHome, now: () => 1 });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.stderr, '');
  const allowed = runHook(payload('node "/p/commit.cjs" plan'), { env: { COMMIT_GUARD_DEBUG: '1' }, claudeHome, now: () => 1 });
  assert.deepEqual(
    { ...allowed },
    { stdout: '', stderr: '{"decision":"none","command":"commit.cjs plan","heartbeat":"failed"}\n' },
  );
});

// GRD-15 review (round 2) L1: guard.cjs itself passes no Claude home when its own
// `os.homedir()` lookup throws (no portable way to force that on this host; see guard.cjs),
// relying on G1 to swallow the resulting `path.join(undefined, …)` throw the same way it
// swallows any other failed write.
test('Seam 3: runHook keeps a compound deny when claudeHome is undefined', () => {
  const denied = runHook(payload('node "/p/commit.cjs" plan && git commit -m x'), { env: {}, claudeHome: undefined, now: () => 1 });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.stderr, '');
  const allowed = runHook(payload('node "/p/commit.cjs" plan'), { env: { COMMIT_GUARD_DEBUG: '1' }, claudeHome: undefined, now: () => 1 });
  assert.deepEqual(
    { ...allowed },
    { stdout: '', stderr: '{"decision":"none","command":"commit.cjs plan","heartbeat":"failed"}\n' },
  );
});

test('Seam 3: redactCommand keeps only --flag words and planIds, cut at --% and at 200', () => {
  const { redactCommand } = heartbeat;
  assert.equal(redactCommand({ subcommand: 'plan', args: [] }), 'commit.cjs plan');
  assert.equal(
    redactCommand({ subcommand: 'plan', args: ['--take-over', PLAN_ID, '-m', 'secret', '$HOME', '--no-user', 'x'] }),
    `commit.cjs plan --take-over ${PLAN_ID} --no-user`,
  );
  assert.equal(redactCommand({ subcommand: 'plan', args: ['--intent=secret', '--Flag', PLAN_ID.toUpperCase(), '--', '-x'] }), 'commit.cjs plan');
  assert.equal(redactCommand({ subcommand: 'plan', args: ['--staged', '--%', '--no-user'] }), 'commit.cjs plan --staged');
  assert.equal(redactCommand({ subcommand: 'plan', args: Array(40).fill('--no-user') }).length, 200);
});

test('Seam 3: writeHeartbeat renames a pid-and-random temporary name in the same directory into place', (t) => {
  const claudeHome = tempHome(t);
  const renames = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    renames.push({ from, to, existed: fs.existsSync(from) });
    return realRename(from, to);
  };
  try {
    heartbeat.writeHeartbeat({ claudeHome, cwd: '/a', command: 'commit.cjs plan', now: () => 1 });
    heartbeat.writeHeartbeat({ claudeHome, cwd: '/b', command: 'commit.cjs plan', now: () => 2 });
  } finally {
    fs.renameSync = realRename;
  }
  const target = heartbeat.heartbeatPath(claudeHome);
  assert.equal(renames.length, 2);
  const pattern = new RegExp(`^heartbeat\\.json\\.${process.pid}\\.([0-9a-f]{16})\\.tmp$`);
  const randoms = renames.map(({ from, to, existed }) => {
    assert.equal(to, target);
    assert.equal(path.dirname(from), path.dirname(target));
    assert.ok(existed);
    const match = pattern.exec(path.basename(from));
    assert.ok(match, path.basename(from));
    return match[1];
  });
  assert.notEqual(randoms[0], randoms[1]);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['heartbeat.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ts: 2, cwd: '/b', command: 'commit.cjs plan' });
});

test('Seam 3: writeHeartbeat removes its temporary file and rethrows when the rename fails', (t) => {
  const claudeHome = tempHome(t);
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
  };
  try {
    assert.throws(() => heartbeat.writeHeartbeat({ claudeHome, cwd: '/a', command: 'commit.cjs plan', now: () => 1 }), /EIO/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(fs.readdirSync(path.join(claudeHome, 'commit-guard')), []);
});
