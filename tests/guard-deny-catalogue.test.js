'use strict';

// GRD-05: the specific rows of the deny catalogue, each with its fixed text, and their
// precedence over the generic and bare rows, through G1 `runHook` (Seam 3) and the real hook
// process (Seam 2) (C:guard Deny messages, Precedence, Parsing step 5; Q4, Q18, Q20;
// stories 27, 28, 30, 32).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');
const { noVerifyText } = require('./helpers/no-verify-text.js');
const {
  amendText,
  cases,
  MESSAGES_LITERAL,
  precedence,
  everyRow,
} = require('./helpers/deny-catalogue-cases.js');

let runHook;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;
let SHORT_WITH_VALUE;
let LONG_WITH_VALUE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE, SHORT_WITH_VALUE, LONG_WITH_VALUE } = await loadLib('command-classifier'));
});

function hook(c, command) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: c.root,
  });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

// The deny reason for a command, or null when it has no output.
function reasonOf(c, command) {
  const { stdout, stderr } = hook(c, command);
  assert.equal(stderr, '');
  if (stdout === '') return null;
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

for (const [command, expected] of cases) {
  test(`Seam 3: ${JSON.stringify(command)} is denied with its row's text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.equal(reasonOf(c, command), expected);
  });
}

test('Seam 3: the amend text routes rewording to the worker and never suggests `--amend --no-edit`', (t) => {
  const c = createCase(t, { repo: false });
  const reason = reasonOf(c, 'git commit --amend');
  assert.ok(reason.startsWith('To reword the last commit: Spawn the commit:commit-worker agent'), reason);
  assert.ok(reason.includes('Ask it to reword. To add changes, make a new commit the same way.'));
  assert.ok(!reason.includes('--no-edit'));
  assert.ok(!reason.includes('--amend'));
});

for (const [command, expected] of precedence) {
  test(`Seam 3: precedence: ${JSON.stringify(command)} is denied on the higher row`, (t) => {
    const c = createCase(t, { repo: false });
    const want = expected === MESSAGES_LITERAL ? MESSAGES.literalArguments : expected;
    assert.equal(reasonOf(c, command), want);
  });
}

test('Seam 3: precedence: `--amend -m x`, `-n -m x` and `--squash -m x` never give the bare text', (t) => {
  const c = createCase(t, { repo: false });
  for (const command of ['git commit --amend -m x', 'git commit -n -m x', 'git commit --squash -m x']) {
    assert.ok(!reasonOf(c, command).includes('Direct git commit is blocked'), command);
  }
});

test('Seam 3: fail-closed: no value-taking option other than --fixup stays allowed beside --no-edit --amend or --fixup=x', (t) => {
  const c = createCase(t, { repo: false });
  const options = [
    ...[...SHORT_WITH_VALUE].map((letter) => `-${letter}`),
    ...LONG_WITH_VALUE,
  ].filter((flag) => flag !== '--fixup');
  for (const flag of options) {
    for (const neighbours of ['--no-edit --amend', '--fixup=x']) {
      const command = `git commit ${neighbours} ${flag} v`;
      assert.notEqual(reasonOf(c, command), null, command);
    }
  }
});

test('Seam 3: every message holding the route ends with the personal-skill line; the others do not', (t) => {
  const c = createCase(t, { repo: false });
  const seen = new Set();
  for (const command of everyRow) {
    const reason = reasonOf(c, command);
    assert.notEqual(reason, null, command);
    seen.add(reason);
    if (reason.includes(ROUTE)) assert.ok(reason.endsWith(`\n${PERSONAL_SKILL_LINE}`), command);
    else assert.ok(!reason.includes(PERSONAL_SKILL_LINE), command);
  }
  for (const message of Object.values(MESSAGES)) {
    assert.ok(message.includes(ROUTE), 'every fixed catalogue text holds the route');
    assert.ok(message.endsWith(`\n${PERSONAL_SKILL_LINE}`));
  }
  // The -n row is the one row without the route.
  assert.ok(!reasonOf(c, 'git commit -n').includes(ROUTE));
  assert.equal(seen.size, everyRow.length, 'each command gets a text of its own');
});

test('Seam 3: no specific row names `/commit`', (t) => {
  const c = createCase(t, { repo: false });
  for (const command of everyRow) assert.ok(!reasonOf(c, command).includes('/commit'), command);
});

test('Seam 2: the real hook denies `--amend -m x` with the amend text and `-n` with its own, exit 0', async (t) => {
  const c = createCase(t);
  for (const [command, expected] of [['git commit --amend -m x', amendText], ['git commit -n -m x', noVerifyText('-n')]]) {
    const result = await runGuard(c, { command });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.heartbeat, null);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, expected);
  }
});
