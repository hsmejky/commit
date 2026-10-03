'use strict';

// GRD-16: the debug log, under COMMIT_GUARD_DEBUG=1, for a decision itself (as opposed to the
// fail-open and heartbeat-failure cases GRD-02 and GRD-15 already cover): `agent_id`,
// `decision`, the deny's `reason` (its catalogue row id, or a blanket deny's trigger kind;
// never message text) and the redacted command (the matched `git commit` segment's options,
// or a `plan` call's script-call form), each left out when unknown, on one stderr line, with
// stdout unaffected by the variable (C:guard Output; docs/spec/modules-shared-and-guard.md
// G1, G3; Q1, Q23; stories 20, 21).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { cases, precedence, everyRow } = require('./helpers/deny-catalogue-cases.js');

let runHook;
let claudeHome;

before(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-debug-log-'));
});

after(() => {
  fs.rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
});

const DEBUG = { COMMIT_GUARD_DEBUG: '1' };
const WORKER = 'commit:commit-worker';
const PLAN_ID = '0f8e3a52-6b1d-4c7e-9a2f-1d2c3b4a5e6f';

// The catalogue row ids C:guard Output names for `reason` (a blanket deny logs its G2 trigger
// kind instead, a lower-case word).
const ROW_IDS = new Set([
  'bare', 'amend', 'squash', 'noVerify', 'fixupKind', 'generic', 'wrapper', 'literalArguments',
  'literalSubcommand', 'config', 'unknownGlobalOption', 'handback',
]);
// The blanket deny trigger kinds (G2, C:guard parsing step 2).
const BLANKET_KINDS = new Set([
  'size', 'substitution', 'heredoc', 'here-string', 'comment', 'typographic-quote', 'nesting',
  'escape',
]);

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

// The one debug line's fields: exactly one newline-terminated JSON object.
function fieldsOf(stderr) {
  assert.ok(stderr.endsWith('\n'), stderr);
  assert.equal(stderr.indexOf('\n'), stderr.length - 1, stderr);
  return JSON.parse(stderr);
}

function debugFields(command, extra) {
  return fieldsOf(run(command, { env: DEBUG, extra }).stderr);
}

test('a plain deny (git commit -m x) logs decision, the row id and the matched options only, never the message text', () => {
  const plain = run('git commit -m secret');
  assert.equal(plain.stderr, '');

  const debugged = run('git commit -m secret', { env: DEBUG, extra: { agent_id: 'a1' } });
  assert.equal(debugged.stdout, plain.stdout);
  assert.deepEqual(fieldsOf(debugged.stderr), { agent_id: 'a1', decision: 'deny', reason: 'bare', command: '-m' });
  assert.doesNotMatch(debugged.stderr, /secret/);
});

// H1 (GRD-16 review): the generic and wrapper rows' texts name an argument or a token, so the
// log carries the row id instead, never the text.
const rowTable = [
  ['git commit --amend', { reason: 'amend', command: '--amend' }],
  ['git commit --squash=HEAD', { reason: 'squash', command: '--squash' }],
  ['git commit -n', { reason: 'noVerify', command: '-n' }],
  ['git commit --fixup=amend:HEAD', { reason: 'fixupKind', command: '--fixup' }],
  ['git commit -C HEAD', { reason: 'generic', command: '-C' }],
  ['xargs git commit -m x', { reason: 'wrapper', command: '-m' }],
  ['git commit -m $MSG', { reason: 'literalArguments', command: '-m' }],
  ['git $c commit -m x', { reason: 'literalSubcommand' }],
  ['git -c k=v commit --amend -m x', { reason: 'config', command: '--amend -m' }],
  ['git --unknown commit -q', { reason: 'unknownGlobalOption', command: '-q' }],
  ['env --argv0=git-commit git -m x', { reason: 'wrapper' }],
];
for (const [command, want] of rowTable) {
  test(`${JSON.stringify(command)} logs reason ${want.reason}`, () => {
    assert.deepEqual(debugFields(command), { decision: 'deny', ...want });
  });
}

const secretTable = [
  ['git commit "my secret release notes"', /secret/],
  ['git commit -q "fix: secret thing"', /secret/],
  ['git commit -m x secret/path.txt', /secret/],
  ['xargs secret-words git commit -m x', /secret/],
  ['git commit -m x $SECRET_NAME', /SECRET/],
  ['git -c secret.key=v commit -m x', /secret/],
  [`git commit ${'x'.repeat(5000)}`, /xxx/],
];
for (const [command, pattern] of secretTable) {
  test(`${JSON.stringify(command.slice(0, 60))} logs no argument, value or message text`, () => {
    const fields = debugFields(command);
    assert.equal(fields.decision, 'deny');
    assert.ok(ROW_IDS.has(fields.reason), fields.reason);
    assert.doesNotMatch(JSON.stringify(fields), pattern);
  });
}

test('an option-shaped token holding spaces is never logged as an option', () => {
  const fields = debugFields('git commit --amen "--secret words here"');
  assert.deepEqual(fields, { decision: 'deny', reason: 'generic', command: '--amen' });
});

// H1 (GRD-16 re-review): whether a token is an option is judged on the whole token (C:guard
// Output's option-token grammar), never on each letter of a short bundle, so message text
// passed as a `-`-led argument never reaches the log one letter at a time.
const optionTokenTable = [
  ['git commit -m "feat: x" "- added secret foo"', '-m'],
  ['git commit "-hello world"', undefined],
  ['git commit -q "-fix the secret bug"', '-q'],
  ['git commit --mess "-secret words"', '--mess'],
  ['git commit --m "-secret"', '--m'],
  ['git -c a=b commit "-hello world"', undefined],
  ['git commit -m "x" "-q.secret"', '-m'],
  ['git commit -m"feat: secret thing"', '-m'],
  ['git commit -am"secret notes"', '-a -m'],
  ['git commit -qm "secret" --amend', '-q -m --amend'],
  ['git commit -S"key secret" --amend', '-S --amend'],
  ['git commit --message="secret words" -n', '--message -n'],
  ['git commit --mess=secret -n', '--mess -n'],
  ['git commit -F secret.txt -n', '-F -n'],
  ['git commit -m x -- -secret', '-m'],
  // M1 (GRD-16 round 3): a short bundle logs only when each letter up to its first
  // value-taking one is a `git commit` short option, so no prefix of free text leaks.
  ['git commit -m "feat: x" "-removed secret"', '-m'],
  ['git commit -m "feat: x" "-Refactored the secret module"', '-m'],
  ['git commit "-abc secret words"', undefined],
  ['git commit -q "-plaintexthunter2 is the key"', '-q'],
  ['git commit -q "-0"', '-q'],
  ['git commit -nm "secret"', '-n -m'],
  // Accepted limit: a token git itself reads as an option group (`-s -e -c` + value).
  ['git commit -q "-secret words"', '-q -s -e -c'],
];
for (const toolName of ['Bash', 'PowerShell']) {
  for (const [command, want] of optionTokenTable) {
    test(`${toolName}: ${JSON.stringify(command)} logs command ${JSON.stringify(want)}`, () => {
      const fields = debugFields(command, { tool_name: toolName });
      assert.equal(fields.decision, 'deny');
      if (toolName === 'Bash') assert.equal(fields.command, want);
      assert.doesNotMatch(fields.command ?? '', /secret|hello|world|added|fix|key|notes|txt/);
    });
  }
}

// H1 sweep: no word of the message text ever appears in the logged command, whichever way the
// text reaches the command line, neither whole nor letter by letter (L1, GRD-16 round 3: a run
// of logged short flags read back as letters is never part of a message word), and the logged
// command holds only option-grammar tokens. A text git itself reads as an option group
// (`--secret`, `-secret words`) is left out: the log names its options like any other's.
const messageTexts = [
  '- added secret foo', '-hello world', '-fix the secret bug', '--secret words',
  '-m secret', 'feat: secret thing', '-q.secret', '-am secret', '--x=secret words', '-x,secret',
  '-S secret', '-uvwxyz secret', '-0 secret', '-ñsecret words', '-removed secret',
  '-Refactored the secret module', '-abc secret words', '-plaintexthunter2 is the key',
];
const OPTION_SHAPE = /^(-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9-]*)$/;
// The letters of each run of consecutive logged short flags (`-q -r -e -m --amend` gives
// `qrem`), so a message prefix logged one letter at a time shows up as text again.
const shortFlagRuns = (command) =>
  command.split(' ').map((token) => (/^-[^-]$/.test(token) ? token[1] : ' ')).join('').split(' ');
const messageTemplates = [
  (m) => `git commit "${m}"`,
  (m) => `git commit -q "${m}"`,
  (m) => `git commit -m "feat: x" "${m}"`,
  (m) => `git commit -m "${m}"`,
  (m) => `git commit -m"${m}"`,
  (m) => `git commit -am"${m}"`,
  (m) => `git commit -F "${m}"`,
  (m) => `git commit --message="${m}"`,
  (m) => `git commit --message "${m}"`,
  (m) => `git commit --mess "${m}"`,
  (m) => `git commit --m "${m}"`,
  (m) => `git commit --amen "${m}"`,
  (m) => `git -c a=b commit "${m}"`,
  (m) => `xargs git commit -q "${m}"`,
  (m) => `git commit -q "${m}" $X`,
  (m) => `git commit -- "${m}"`,
];
for (const toolName of ['Bash', 'PowerShell']) {
  test(`${toolName}: no message word ever appears in the logged command`, () => {
    for (const text of messageTexts) {
      const words = text.match(/[\p{L}\p{N}]{3,}/gu);
      for (const template of messageTemplates) {
        const command = template(text);
        const fields = debugFields(command, { tool_name: toolName });
        const logged = fields.command ?? '';
        if (logged !== '') {
          for (const token of logged.split(' ')) assert.match(token, OPTION_SHAPE, `${command} -> ${logged}`);
        }
        const runs = shortFlagRuns(logged).filter((run) => run.length >= 2);
        for (const word of words) {
          assert.ok(!logged.includes(word), `${command} -> ${logged}`);
          for (const run of runs) assert.ok(!word.includes(run), `${command} -> ${logged}`);
        }
      }
    }
  });
}

test('a plan script call with no deny logs decision "none" and the script-call form, no reason', () => {
  const debugged = run('node "/opt/plugin/commit.cjs" plan --staged', { env: DEBUG });
  assert.equal(debugged.stdout, '');
  assert.deepEqual(fieldsOf(debugged.stderr), { decision: 'none', command: 'commit.cjs plan --staged' });
});

test('a deny also holding a plan call logs the matched options, not the script-call form', () => {
  assert.deepEqual(
    debugFields('node "/opt/plugin/commit.cjs" plan && git commit -m x'),
    { decision: 'deny', reason: 'bare', command: '-m' },
  );
});

test('a worker handback deny logs reason handback and no command', () => {
  const command = `node "/opt/x/plugin/scripts/commit.cjs" commit --plan-id ${PLAN_ID} yes`;
  assert.deepEqual(debugFields(command, { agent_type: WORKER }), { decision: 'deny', reason: 'handback' });
});

test('a blanket deny (an unparsed substitution) logs the trigger kind as reason, no command', () => {
  const debugged = run('git commit -m "$(x)"', { env: DEBUG });
  assert.equal(JSON.parse(debugged.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(fieldsOf(debugged.stderr), { decision: 'deny', reason: 'substitution' });
});

test('an allowed command with no git commit and no plan call logs only the decision', () => {
  const debugged = run('echo this is not a commit', { env: DEBUG });
  assert.equal(debugged.stdout, '');
  assert.deepEqual(fieldsOf(debugged.stderr), { decision: 'none' });
});

test('a matched segment with no options leaves `command` out', () => {
  assert.deepEqual(debugFields('git commit'), { decision: 'deny', reason: 'bare' });
  assert.deepEqual(debugFields('git commit "msg"'), { decision: 'deny', reason: 'generic' });
});

test('the command cuts the redacted options to 200 characters', () => {
  const debugged = run(`git commit ${'--author=x '.repeat(40)}`, { env: DEBUG });
  const fields = fieldsOf(debugged.stderr);
  assert.equal(fields.decision, 'deny');
  assert.equal(fields.command, Array(40).fill('--author').join(' ').slice(0, 200));
  assert.equal(fields.command.length, 200);
});

// M1 (GRD-16 review): building the decision's debug line is kept apart from the decision, so
// a throw there falls back to a smaller line and never turns a deny into fail-open.
test('a throw while building the debug line keeps the deny and logs the decision alone', (t) => {
  const plain = run('git commit -m x', { extra: { agent_id: 'a1' } });
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', function (value, ...rest) {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'reason')) throw new Error('boom');
    return stringify.call(JSON, value, ...rest);
  });
  const debugged = run('git commit -m x', { env: DEBUG, extra: { agent_id: 'a1' } });
  t.mock.restoreAll();
  assert.equal(debugged.stdout, plain.stdout);
  assert.notEqual(debugged.stdout, '');
  assert.deepEqual(fieldsOf(debugged.stderr), { agent_id: 'a1', decision: 'deny' });
});

// M2 (GRD-16 review): AC2 over the whole deny catalogue fixture table, the worker-only cases
// and a PowerShell set, in both shells: stdout is the same with and without the variable,
// stderr is empty without it and exactly one JSON line with it, and a deny's reason is a row
// id or a blanket trigger kind.
const handbackCommands = ['commit', 'release'].flatMap((subcommand) => [
  `node "C:/Users/app/plugin/scripts/commit.cjs" ${subcommand} --plan-id ${PLAN_ID}`,
  `node "/opt/x/plugin/scripts/commit.cjs" ${subcommand} --plan-id ${PLAN_ID}`,
]);
const powershellCommands = [
  'saps git commit -m x',
  "Start-Process git 'commit --fixup HEAD'",
  'Start-Process git -ArgumentList { git commit -m x }',
  'saps git commit,--fixup,HEAD',
  "git '' commit -m x",
  'git commit -m @s',
  'git commit --no-edit a,b',
  'if ($ok) { git commit --amend }',
  'git commit -m "x`u{41}"',
];
const sweep = [
  ...cases.map(([command]) => command),
  ...precedence.map(([command]) => command),
  ...everyRow,
  ...handbackCommands,
  ...powershellCommands,
  'git commit --amend --no-edit',
  'node "/opt/plugin/commit.cjs" plan',
  'echo this is not a commit mention',
  'git commit -m "$(x)"',
];
for (const toolName of ['Bash', 'PowerShell']) {
  test(`${toolName}: stdout is identical with and without the variable over the deny catalogue`, () => {
    for (const command of sweep) {
      for (const agentType of [undefined, WORKER]) {
        const extra = { tool_name: toolName, agent_id: 'a1', ...(agentType ? { agent_type: agentType } : {}) };
        const plain = run(command, { extra });
        const debugged = run(command, { env: DEBUG, extra });
        assert.equal(plain.stderr, '', command);
        assert.equal(debugged.stdout, plain.stdout, command);
        const fields = fieldsOf(debugged.stderr);
        if (plain.stdout === '') continue;
        assert.equal(fields.decision, 'deny', command);
        assert.equal(typeof fields.reason, 'string', command);
        assert.ok(ROW_IDS.has(fields.reason) || BLANKET_KINDS.has(fields.reason), `${command}: ${fields.reason}`);
      }
    }
  });
}
