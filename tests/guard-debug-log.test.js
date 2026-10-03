'use strict';

// GRD-16: the debug log, under COMMIT_GUARD_DEBUG=1, for a decision itself (as opposed to the
// fail-open and heartbeat-failure cases GRD-02 and GRD-15 already cover): `agent_id`,
// `decision`, the deny reason (or, for a blanket deny, the trigger kind) and the redacted
// command (the matched `git commit` segment's options, or a `plan` call's script-call form),
// each left out when unknown, on one stderr line, with stdout unaffected by the variable
// (C:guard Output; docs/spec/modules-shared-and-guard.md G1, G3; Q1, Q23; stories 20, 21).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let MESSAGES;
let claudeHome;

before(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-debug-log-'));
});

after(() => {
  fs.rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES } = await loadLib('command-classifier'));
});

function hook(command, extra = {}) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/w/repo',
    ...extra,
  });
}

// A real, writable Claude home: no test here exercises a failed heartbeat write (GRD-15
// already covers that), so a `plan` call's heartbeat always succeeds and never adds
// `heartbeat: "failed"` to the fields under test.
function run(command, { env = {}, extra = {} } = {}) {
  return runHook(hook(command, extra), { env, claudeHome, now: () => 1 });
}

test('a plain deny (git commit -m x) logs decision, reason and the matched options only, never the message text', () => {
  const plain = run('git commit -m secret');
  assert.equal(plain.stderr, '');

  const debugged = run('git commit -m secret', { env: { COMMIT_GUARD_DEBUG: '1' }, extra: { agent_id: 'a1' } });
  assert.equal(debugged.stdout, plain.stdout);
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { agent_id: 'a1', decision: 'deny', reason: MESSAGES.bare, command: '-m' });
  assert.doesNotMatch(debugged.stderr, /secret/);
});

test('--amend without --no-edit logs the amend row as reason and --amend as the command', () => {
  const debugged = run('git commit --amend', { env: { COMMIT_GUARD_DEBUG: '1' } });
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'deny', reason: MESSAGES.amend, command: '--amend' });
});

test('a plan script call with no deny logs decision "none" and the script-call form, no reason', () => {
  const debugged = run('node "/opt/plugin/commit.cjs" plan --staged', { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.stdout, '');
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'none', command: 'commit.cjs plan --staged' });
});

test('a deny also holding a plan call logs the matched options, not the script-call form', () => {
  const debugged = run('node "/opt/plugin/commit.cjs" plan && git commit -m x', { env: { COMMIT_GUARD_DEBUG: '1' } });
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'deny', reason: MESSAGES.bare, command: '-m' });
});

test('a blanket deny (an unparsed substitution) logs the trigger kind as reason, no command', () => {
  const debugged = run('git commit -m "$(x)"', { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(JSON.parse(debugged.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'deny', reason: 'substitution' });
});

test('an allowed command with no git commit and no plan call logs only the decision', () => {
  const debugged = run('echo this is not a commit', { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.stdout, '');
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'none' });
});

test('a literal-arguments deny (no safe options to redact) logs the catalogue reason with no command key', () => {
  const plain = run('git commit -m $MSG');
  assert.equal(JSON.parse(plain.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const debugged = run('git commit -m $MSG', { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.stdout, plain.stdout);
  const fields = JSON.parse(debugged.stderr.trim());
  assert.deepEqual(fields, { decision: 'deny', reason: MESSAGES.literalArguments });
});

test('the command cuts the redacted options to 200 characters', () => {
  const longFlags = Array.from({ length: 40 }, (_, i) => `--author=x${i}`).join(' ');
  const debugged = run(`git commit ${longFlags}`, { env: { COMMIT_GUARD_DEBUG: '1' } });
  const fields = JSON.parse(debugged.stderr.trim());
  assert.equal(fields.decision, 'deny');
  assert.ok(fields.command.length <= 200);
});

test('without the variable, stdout is identical and stderr is always empty', () => {
  for (const command of [
    'git commit -m x',
    'git commit --amend',
    'node "/opt/plugin/commit.cjs" plan',
    'echo this is not a commit mention',
    'git commit -m "$(x)"',
  ]) {
    const plain = run(command);
    const debugged = run(command, { env: { COMMIT_GUARD_DEBUG: '1' } });
    assert.equal(plain.stderr, '');
    assert.equal(plain.stdout, debugged.stdout);
  }
});
