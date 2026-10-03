'use strict';

// GRD-14: the worker-only rule (C:guard Deny messages, Worker-only rule; Q25; story 39). As
// `commit:commit-worker`, a script call to `commit` or `release` is denied with the handback
// text; every other command the worker runs follows the normal rules, and the same call from
// any other agent, or none, is left alone.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const WORKER = 'commit:commit-worker';
const HANDBACK = 'The handback is for your caller: return the reply verbatim and stop.';
const PLAN_ID = '0f8e3a52-6b1d-4c7e-9a2f-1d2c3b4a5e6f';

let classify;
let segments;
let MESSAGES;
let HANDBACK_MESSAGE;

beforeEach(async () => {
  ({ classify, MESSAGES, HANDBACK_MESSAGE } = await loadLib('command-classifier'));
  ({ segments } = await loadLib('shell-tokenizer'));
});

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

// The quoted form every handback and worker runs (S2 `build`), in a Windows and a POSIX path.
const call = (subcommand, args = '') => `node "C:/Users/x/plugin/scripts/commit.cjs" ${subcommand}${args}`;
const posixCall = (subcommand, args = '') => `node "/opt/x/plugin/scripts/commit.cjs" ${subcommand}${args}`;

test('the handback text is the fixed C:guard text', () => {
  assert.equal(HANDBACK_MESSAGE, HANDBACK);
});

for (const toolName of ['Bash', 'PowerShell']) {
  for (const [subcommand, args] of [['commit', ` --plan-id ${PLAN_ID} yes`], ['release', ` --plan-id ${PLAN_ID}`]]) {
    for (const command of [call(subcommand, args), posixCall(subcommand, args)]) {
      test(`Seam 2 ${toolName}, worker: \`${command}\` is denied with the handback text`, async (t) => {
        const c = createCase(t);
        const result = await runGuard(c, { command, toolName, agentType: WORKER });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, denyJson(HANDBACK));
      });
    }
  }

  for (const subcommand of ['plan', 'check']) {
    test(`Seam 2 ${toolName}, worker: a \`${subcommand}\` script call gives no output`, async (t) => {
      const c = createCase(t);
      const result = await runGuard(c, { command: call(subcommand, ' --intent x'), toolName, agentType: WORKER });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
  }

  for (const agentType of ['general-purpose', 'commit-worker', 'other:commit-worker', undefined]) {
    test(`Seam 2 ${toolName}: the \`commit\` call with agent_type ${agentType ?? '(none)'} gives no output`, async (t) => {
      const c = createCase(t);
      const result = await runGuard(c, { command: call('commit', ` --plan-id ${PLAN_ID} yes`), toolName, agentType });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
  }

  test(`Seam 2 ${toolName}, worker: \`git commit -m x\` gets the ordinary bare deny, not the handback text`, async (t) => {
    const c = createCase(t);
    const result = await runGuard(c, { command: 'git commit -m x', toolName, agentType: WORKER });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, denyJson(MESSAGES.bare));
    assert.ok(!result.stdout.includes('handback'));
  });
}

// G3 `classify` directly (Seam 1 over G2's real output).
const decide = (command, shell = 'bash', ...agent) => {
  const agentType = agent.length === 0 ? WORKER : agent[0];
  return classify(segments(command, shell), { agentType, shell });
};

test('classify: a `commit` call in any segment of a compound command is denied for the worker', () => {
  for (const command of [
    `cd /repo && ${call('commit')}`,
    `${call('plan')}; ${call('release')}`,
    `echo a | ${call('commit')}`,
    `( ${call('commit')} )`,
    `time ${call('release')}`,
  ]) {
    const result = decide(command);
    assert.equal(result.decision, 'deny', command);
    assert.equal(result.message, HANDBACK, command);
  }
});

test('classify: the wide recogniser forms deny in PowerShell too (`&` call, `node.exe`, case)', () => {
  for (const command of [
    `& node "C:/x/commit.cjs" commit`,
    `& "C:/Program Files/nodejs/node.exe" "C:/x/COMMIT.CJS" release`,
    `Set-Location C:/repo; NODE C:/x/commit.cjs commit`,
  ]) {
    const result = decide(command, 'powershell');
    assert.equal(result.message, HANDBACK, command);
  }
});

test('classify: the worker\'s `plan`, `check` and `infer` calls and a non-script `commit` word are left alone', () => {
  for (const command of [call('plan'), call('check'), call('infer'), call('Commit'), 'node other.cjs commit', 'echo commit']) {
    assert.equal(decide(command).decision, 'none', command);
  }
});

test('classify: the rule applies to `commit:commit-worker` only, compared exactly', () => {
  for (const agentType of [undefined, '', 'Commit:Commit-Worker', 'commit-worker', 'commit:commit-worker ']) {
    assert.equal(decide(call('commit'), 'bash', agentType).decision, 'none', String(agentType));
  }
});

test('classify: a blanket-denied worker command gets its blanket row, not the handback text', () => {
  const result = decide(`${call('commit')} # x`);
  assert.equal(result.decision, 'deny');
  assert.equal(result.message, MESSAGES.blanket);
});

test('classify: a worker command holding both a `commit` call and a direct `git commit` gets the handback text', () => {
  // Precedence is not given by C:guard; the handback rule is checked first (the worker must
  // stop, Q25), so a direct commit next to it never hides the stop instruction.
  const result = decide(`git commit -m x; ${call('commit')}`);
  assert.equal(result.message, HANDBACK);
  assert.equal(decide('git commit -m x').message, MESSAGES.bare);
});

test('classify: a handback deny still reports every script call', () => {
  const result = decide(`${call('plan', ' --intent x')}; ${call('commit')}`);
  assert.deepEqual(result.scriptCalls.map((c) => c.subcommand), ['plan', 'commit']);
});
