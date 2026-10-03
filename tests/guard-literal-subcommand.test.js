'use strict';

// GRD-12: fail closed on an unreadable subcommand or argument, through G1 `runHook` (Seam 3)
// and the real hook process (Seam 2), in both shells (C:guard Parsing step 4, Precedence,
// Deny messages; Q3). The first token after git's global options is the subcommand: one
// that is not literal (a `(` or `{` token, a token holding `$`, a backtick, `{`, `(` or a
// glob character, in PowerShell one holding `,` or `@`) may run `commit` at run time, so it
// is denied with the literal-subcommand row, whatever follows it. A non-literal token
// anywhere else among git's arguments gets the literal-arguments row.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

function hook(c, command, shell) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: shell === 'bash' ? 'Bash' : 'PowerShell',
    tool_input: { command },
    cwd: c.root,
  });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

// The decision's reason, or null for no output.
function reason(c, command, shell) {
  const { stdout, stderr } = hook(c, command, shell);
  assert.equal(stderr, '');
  if (stdout === '') return null;
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

const subcommandText = () => `Write the git subcommand literally. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

test('Seam 3: the literal-subcommand row has its catalogue text', () => {
  assert.equal(MESSAGES.literalSubcommand, subcommandText());
});

// [command, MESSAGES key, 'blanket' (the blanket rule denies it first), or null for no output].
const both = [
  // A subcommand that is not literal, in a command mentioning `commit`.
  ['git {commit,-m,x}', 'literalSubcommand'],
  ['git c*t -m x; echo commit', 'literalSubcommand'],
  ['git c?t -m x; echo commit', 'literalSubcommand'],
  ['git [c]ommit -m x; echo commit', 'literalSubcommand'],
  ['git $c -m x; echo commit', 'literalSubcommand'],
  // After known global options, as without them.
  ['git --no-advice {commit,-m,x}', 'literalSubcommand'],
  ['git --no-advice $c -m x; echo commit', 'literalSubcommand'],
  // An accepted false deny: the subcommand is not read, so `commit` elsewhere is enough.
  ['git $sub status; echo commit', 'literalSubcommand'],
  // Precedence: the literal-subcommand row ranks above the literal-arguments row, and the
  // `-c` row needs a `commit` subcommand.
  ['git -C $d $c; echo commit', 'literalSubcommand'],
  ['git -c k=v $c; echo commit', 'literalSubcommand'],
  // An unknown option keeps its own rule: every token after it must be literal.
  ['git --bogus $c -m x; echo commit', 'literalArguments'],
  // Non-literal arguments elsewhere keep the literal-arguments row.
  ['git commit --fixup $s', 'literalArguments'],
  ['git -C $dir commit -m x', 'literalArguments'],
  // `commit` matches case-insensitively.
  ['git COMMIT -m x', 'bare'],
  // A literal subcommand other than `commit`: its arguments are not read.
  ['git log --format=%h $x; echo commit', null],
  // The step 1 gap: no `commit` in the text.
  ['git $c -m x', null],
];

const bashOnly = [
  ['git @(commit) -m x', 'literalSubcommand'],
  ['git !(x) commit -m x', 'literalSubcommand'],
  ['git ( -m x; echo commit', 'literalSubcommand'],
  ['c=commit; git "$c" -m x', 'literalSubcommand'],
  ['c=commit; git --no-advice "$c" -m x', 'literalSubcommand'],
  ['c=commit; git --attr-source HEAD "$c" -m x', 'literalSubcommand'],
  // A variable holding an option, a literal `commit` after it.
  ['opt=--no-pager; git "$opt" commit -m x', 'literalSubcommand'],
  ['git {--no-pager,commit} -m x', 'literalSubcommand'],
  // Process substitution with no redirection target: its `(` is the subcommand.
  ['git < <(:) commit -m x', 'literalSubcommand'],
  ['git -C {.,commit} status', 'literalArguments'],
  ['git commit --fixup {HEAD,--no-verify}', 'literalArguments'],
  ['git -C "$dir" commit --no-edit', 'literalArguments'],
  // In Bash `,` is an ordinary character.
  ['git -C .,commit status', null],
  ['git log --format=%h,%s $x; echo commit', null],
  ['(git commit --no-edit)', null],
  // The documented gaps (C:guard steps 1 and 3).
  ['git $(echo com)mit', null],
  ['{git,commit,-m,x}', null],
  ['/usr/bin/gi? commit -m x', null],
  // The blanket rule (step 2) denies a substitution first.
  ['git `echo commit` -m x', 'blanket'],
  ['$(echo git) commit -m x', 'blanket'],
];

const powershellOnly = [
  ['git @a; echo commit', 'literalSubcommand'],
  ['git (commit) -m x', 'literalSubcommand'],
  ['git ,commit -m x', 'literalSubcommand'],
  ['git commit, -m x', 'literalSubcommand'],
  ['git co$\'m\'mit -m x', 'literalSubcommand'],
  // Windows PowerShell 5.1 drops `$null` and runs `git commit --no-verify -m x`.
  ['git $null commit --no-verify -m x', 'literalSubcommand'],
  ['git -C . --no-advice $null commit -m x', 'literalSubcommand'],
  // After known global options; a variable holding an option.
  ['git --no-advice @a; echo commit', 'literalSubcommand'],
  ['git --no-advice ,commit -m x', 'literalSubcommand'],
  ['$o=\'--no-pager\'; git $o commit -m x', 'literalSubcommand'],
  ['git --no-advice (,\'commit\') -m x', 'literalSubcommand'],
  // A comma after an option's value joins that value into an array (5.1 passes
  // `-C . commit`): the value is what is not literal.
  ['git -C . ,commit -m x', 'literalArguments'],
  ['git -C . , commit -m x', 'literalArguments'],
  ['git -C .,commit status', 'literalArguments'],
  ['git -C (Get-Location) commit -m x', 'literalArguments'],
  ['git commit -m ("-q") --no-verify', 'literalArguments'],
  ['git commit --fixup ("HEAD","--no-verify")', 'literalArguments'],
  ['git commit --fixup {HEAD --no-verify}', 'literalArguments'],
  ['git --% -c x.y=; commit -m x', 'literalArguments'],
  ['git \'--%\' commit -m x', 'literalArguments'],
  ['git --% commit --no-verify -m x', 'literalArguments'],
  ['git \'--%\' commit --no-verify -m x', 'literalArguments'],
  ['git commit --fixup @s', 'literalArguments'],
  ['git @(commit) -m x', 'blanket'],
  ['git commit --fixup $(\'HEAD\',\'--no-verify\')', 'blanket'],
  ['git commit --fixup @("HEAD","--no-verify")', 'blanket'],
  ['&{git commit --no-edit}', null],
  // The documented gaps (C:guard steps 1 and 3).
  ['git (\'com\'+\'mit\')', null],
  ['& (\'git\') commit -m x', null],
];

const table = [
  ...both.flatMap(([command, expected]) => [['bash', command, expected], ['powershell', command, expected]]),
  ...bashOnly.map(([command, expected]) => ['bash', command, expected]),
  ...powershellOnly.map(([command, expected]) => ['powershell', command, expected]),
];

for (const [shell, command, expected] of table) {
  test(`Seam 3: ${shell} ${JSON.stringify(command)} → ${expected ?? 'no output'}`, (t) => {
    const c = createCase(t, { repo: false });
    const actual = reason(c, command, shell);
    if (expected === null) assert.equal(actual, null);
    else if (expected === 'blanket') assert.match(actual ?? '', /holds a substitution/);
    else assert.equal(actual, MESSAGES[expected]);
  });
}

test('Seam 2: the real hook denies `git {commit,-m,x}` with the literal-subcommand text, exit 0', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'git {commit,-m,x}' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, subcommandText());
});
