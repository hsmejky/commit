'use strict';

// GRD-11: git's global options before the subcommand, through G1 `runHook` (Seam 3) and the
// real hook process (Seam 2), in both shells (C:guard Parsing step 4, Precedence, Deny
// messages; Q3, Q4). The known global options are skipped, a value-taking one with its value
// (joined with `=` for the long ones, or the next token); the first token after them is the
// subcommand. `-c` and `--config-env` before `commit` deny for any key; an unknown option
// followed later by a `commit` token denies; every token read among the global options must
// be literal. These rows rank above the `commit` argument rows (C:guard Precedence).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;

let runHook;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command, shell) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: shell === 'bash' ? 'Bash' : 'PowerShell',
    tool_input: { command },
    cwd: c.root,
  });
  return { ...runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) }) };
}

// The fixed texts of the two GRD-11 rows (C:guard Deny messages).
const configText = () => `git -c … commit is not allowed. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;
const unknownText = () => `Could not parse git options before 'commit'. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;
const wrapper = (name) => () => `git commit run by ${name} is not allowed: it can append arguments. ${ROUTE}
${PERSONAL_SKILL_LINE}`;
const generic = (flag) => () => `git commit ${flag} is not allowed here. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

test('Seam 3: the two GRD-11 rows have their catalogue texts', () => {
  assert.equal(MESSAGES.config, configText());
  assert.equal(MESSAGES.unknownGlobalOption, unknownText());
});

// [command, MESSAGES key or a function giving the message, or null for no output]; each row
// is run in both shells.
const both = [
  // Known global options are skipped; a skipped option is not a matched row of its own, so
  // the `commit` arguments decide (the bare row, the allowlist, the specific rows).
  ['git -C dir commit -m x', 'bare'],
  ['git --no-pager -P commit -m x', 'bare'],
  ['git --git-dir=x commit -m x', 'bare'],
  ['git --git-dir x commit -m x', 'bare'],
  ['git --work-tree=x --namespace=n commit -m x', 'bare'],
  ['git --work-tree x --namespace n commit -m x', 'bare'],
  ['git -p --paginate --bare --no-replace-objects commit -m x', 'bare'],
  ['git --literal-pathspecs --glob-pathspecs --noglob-pathspecs commit -m x', 'bare'],
  ['git --icase-pathspecs --no-optional-locks commit -m x', 'bare'],
  ['git -C dir COMMIT -m x', 'bare'],
  ['git -C dir commit --no-edit', null],
  ['git --git-dir=.git --work-tree=. commit --no-edit', null],
  ['git -C dir commit --amend', 'amend'],
  ['git -C dir commit -a', generic('-a')],
  // A value is never read as the subcommand or as an option.
  ['git -C commit status', null],
  ['git -C x status commit', null],
  ['git --git-dir commit log', null],
  ['git -C -c commit -m x', 'bare'],
  ['git -C dir', null],
  // `-c` and `--config-env` before `commit`, for any key, in either spelling.
  ['git -c k=v commit --no-edit', 'config'],
  ['git -c user.name=x commit -m x', 'config'],
  ['git --config-env=k=E commit --no-edit', 'config'],
  ['git --config-env k=E commit --no-edit', 'config'],
  ['git -C dir -c k=v commit --no-edit', 'config'],
  ['git -c k=v -C dir commit', 'config'],
  ['git -c k=v Commit -m x', 'config'],
  // Remembered but harmless for another subcommand.
  ['git -c k=v log --grep commit', null],
  ['git --config-env=k=E log --grep commit', null],
  // An unknown option followed later by a `commit` token.
  ['git --unknown commit', 'unknownGlobalOption'],
  ['git --frob commit --no-edit', 'unknownGlobalOption'],
  ['git --exec-path=x commit --no-edit', 'unknownGlobalOption'],
  ['git -Cdir commit -m x', 'unknownGlobalOption'],
  ['git --NO-PAGER commit -m x', 'unknownGlobalOption'],
  ['git -C dir --bogus x commit', 'unknownGlobalOption'],
  ['git --bogus status commit', 'unknownGlobalOption'],
  ['git --bogus log --grep COMMIT', 'unknownGlobalOption'],
  ['git --bogus log; echo commit', null],
  ['git --version; echo commit', null],
  // Precedence: these rows run before the `commit` argument rows (GRD-05), the `-c` row first.
  ['git -c k=v commit --amend', 'config'],
  ['git -c k=v commit -n', 'config'],
  ['git -c k=v commit --squash=HEAD', 'config'],
  ['git --config-env=k=E commit --no-verify', 'config'],
  ['git --bogus commit --squash=HEAD', 'unknownGlobalOption'],
  ['git --unknown commit --amend', 'unknownGlobalOption'],
  ['git --bogus commit -n', 'unknownGlobalOption'],
  ['git -c k=v --bogus commit', 'config'],
  ['xargs git -c k=v commit --no-edit', 'config'],
  ['xargs git --bogus commit --no-edit', 'unknownGlobalOption'],
  ['xargs git -C dir commit --no-edit', wrapper('xargs')],
  // Every token read among the global options must be literal (C:guard step 4).
  ['git -C $dir commit -m x', 'literalArguments'],
  ['git -C "$dir" commit --no-edit', 'literalArguments'],
  ['git --git-dir=$d commit --no-edit', 'literalArguments'],
  ['git -C $dir log; echo commit', 'literalArguments'],
  ['git --unknown$x commit', 'literalArguments'],
  // After an unknown option the tokens are only searched for `commit`: which is a value or the
  // subcommand is not known, so none is read as anything else.
  ['git --bogus $x commit', 'unknownGlobalOption'],
  ['git --bogus $x; echo commit', null],
  ['git -C dir commit --fixup $s', 'literalArguments'],
  ['git -c $k commit --no-edit', 'config'],
  ['git -c k=v -C $dir commit', 'config'],
  // A `commit` token past the end of git's arguments is not read.
  ['git -C dir status; commit', null],
  ['git --bogus status | commit', null],
];

const table = [
  ...both.flatMap(([command, expected]) => [['bash', command, expected], ['powershell', command, expected]]),
  ['bash', 'git -C {.,commit} status', 'literalArguments'],
  ['bash', 'git -C .,commit status', null],
  ['powershell', 'git -C .,commit status', 'literalArguments'],
  ['powershell', 'git -C (Get-Location) commit -m x', 'literalArguments'],
  ['powershell', "git -C '' x commit -m x", 'literalArguments'],
  ['powershell', "git -C . '' commit -m x", 'literalArguments'],
  ['powershell', "git '' -C . commit -m x", 'literalArguments'],
  ['powershell', 'git -C @a commit -m x', 'literalArguments'],
  ['powershell', "git '--%' commit -m x", 'literalArguments'],
  ['powershell', 'git --% -c x.y=; commit -m x', 'literalArguments'],
  ['bash', "git -C '' commit -m x", 'bare'],
  // PowerShell splits an unquoted `-C.` into `-C` and `.` (5.1 and 7 commit here); the guard
  // reads one unknown option, followed by `commit`.
  ['powershell', 'git -C. commit -m x', 'unknownGlobalOption'],
  ['powershell', 'git -C.commit status', null],
];

for (const [shell, command, expected] of table) {
  test(`Seam 3: ${shell} ${JSON.stringify(command)} → ${typeof expected === 'function' ? 'deny' : expected ?? 'no output'}`, (t) => {
    const c = createCase(t, { repo: false });
    let stdout = '';
    if (typeof expected === 'function') stdout = denyJson(expected());
    else if (expected !== null) stdout = denyJson(MESSAGES[expected]);
    assert.deepEqual(hook(c, command, shell), { stdout, stderr: '' });
  });
}

// The seed cases whose decision rests on GRD-11, with the row each gets.
const SEEDS = new Map([
  ['b-global-C-c', 'config'],
  ['p-global-c', 'config'],
  ['b-no-pager', 'bare'],
  ['b-gitdir', null],
  ['b-unknown-global', 'unknownGlobalOption'],
  ['b-C-var', 'literalArguments'],
  ['b-opt-value-var-quoted', 'literalArguments'],
  ['b-brace-opt-value', 'literalArguments'],
  ['p-paren-opt-value', 'literalArguments'],
  ['p-comma-value', 'literalArguments'],
]);
for (const [id, expected] of SEEDS) {
  test(`Seam 3: seed ${id} → ${expected ?? 'no output'}`, (t) => {
    const s = seedCases.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(s.decision, expected === null ? 'none' : 'deny');
    const c = createCase(t, { repo: false });
    const stdout = expected === null ? '' : denyJson(MESSAGES[expected]);
    assert.deepEqual(hook(c, s.command, s.shell), { stdout, stderr: '' });
  });
}

test('Seam 2: the real hook denies `git -c k=v commit --no-edit` and `git --unknown commit`, exit 0', async (t) => {
  const c = createCase(t);
  for (const [command, expected] of [['git -c k=v commit --no-edit', configText()], ['git --unknown commit', unknownText()]]) {
    const result = await runGuard(c, { command });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, expected);
  }
});
