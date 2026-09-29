'use strict';

// GRD-03: the first deny, end to end (Seam 2) and through G1 `runHook` (Seam 3): Bash
// `git commit -m x` in its segment-separated forms, the documented false positives, and the
// blanket rule over every blanket seed case of either shell (C:guard Output, Parsing steps
// 1-3, Deny messages; Q3, Q8, Q24).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;

let runHook;
let mentionsCommit;
let MESSAGES;

beforeEach(async () => {
  ({ runHook, mentionsCommit } = await loadLib('hook-io'));
  ({ MESSAGES } = await loadLib('command-classifier'));
});

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command, toolName = 'Bash') {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
    cwd: c.root,
  });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

test('Seam 2: Bash `git commit -m x` is denied with the routing text and the personal-skill line, exit 0', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'git commit -m x' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.heartbeat, null);
  assert.equal(result.stdout, denyJson(MESSAGES.bare));
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith('Direct git commit is blocked. Spawn the commit:commit-worker agent'));
  assert.ok(reason.endsWith('\nIf a personal commit skill sent you here, remove it (see the commit plugin README).'));
});

const bareDenies = [
  'git commit -m x',
  'cd x && git commit -m x',
  'a; git commit -m x',
  'a | git commit -m x',
  'a & git commit -m x',
  'a\ngit commit -m x',
  "git co''mmit -m x",
  'git commit -m "a\\"b"',
  'echo git commit',
  "echo $'\\'' ; git commit -m x",
  "git $'commit' -m x",
  "git $'commit\\0x' -m x",
  "git $'commit\\x00' -m x",
  "git $'commit\\u0000' -m x",
  "git co$'m'mit -m x",
  'git com\\\nmit -m x',
];
for (const command of bareDenies) {
  test(`Seam 3: Bash ${JSON.stringify(command)} is denied with the bare-commit text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual({ ...hook(c, command) }, { stdout: denyJson(MESSAGES.bare), stderr: '' });
  });
}

test('Seam 3: the comment form `# git commit -m x` is denied by the blanket rule', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual({ ...hook(c, '# git commit -m x') }, { stdout: denyJson(MESSAGES.blanket), stderr: '' });
});

test('Seam 3: `echo "$(date)" && git status` has no output (no `commit`, step 1)', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual({ ...hook(c, 'echo "$(date)" && git status') }, { stdout: '', stderr: '' });
});

// Every blanket seed case: denied with the blanket message when it mentions `commit`, no
// output otherwise; never a heartbeat.
for (const s of seedCases.filter((x) => x.segments.length === 0)) {
  const toolName = s.shell === 'bash' ? 'Bash' : 'PowerShell';
  test(`Seam 3: blanket seed ${s.id} (${toolName}) → ${s.decision}`, (t) => {
    const c = createCase(t, { repo: false });
    const expected = s.decision === 'deny' ? denyJson(MESSAGES.blanket) : '';
    assert.equal(mentionsCommit(s.command), s.decision === 'deny');
    assert.deepEqual({ ...hook(c, s.command, toolName) }, { stdout: expected, stderr: '' });
    assert.equal(fs.existsSync(path.join(c.claudeHome, 'commit-guard')), false);
  });
}
