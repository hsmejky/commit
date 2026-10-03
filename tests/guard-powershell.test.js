'use strict';

// GRD-06: the guard on PowerShell commands, end to end (Seam 2) and through G1 `runHook`
// (Seam 3): the PowerShell tokenizer (C:guard step 2, PowerShell column) feeds the same
// classifier rows as Bash. The tokenizer's own readings are in tests/shell-tokenizer.test.js,
// its cross-check against the PowerShell parser in tests/guard-powershell-oracle.test.js.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
});

// C:guard's deny texts, spelled out (not read from the classifier's catalogue).
const ROUTE =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';
const PERSONAL_SKILL_LINE = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';
const TEXTS = {
  noVerify: '--no-verify is not allowed. Fix the hook or signing setup instead.',
  bare: `Direct git commit is blocked. ${ROUTE}\n${PERSONAL_SKILL_LINE}`,
  literalArguments: `Write git's arguments literally. ${ROUTE}\n${PERSONAL_SKILL_LINE}`,
  unknownOption: `Could not parse git options before 'commit'. ${ROUTE}\n${PERSONAL_SKILL_LINE}`,
  blanket: 'This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: '
    + `${ROUTE}\n${PERSONAL_SKILL_LINE}`,
  escape: 'This command mentions commit and holds a `e or `u{…} escape, which Windows PowerShell 5.1 and PowerShell 7 read differently. Keep them out of a command that mentions commit, or to commit: '
    + `${ROUTE}\n${PERSONAL_SKILL_LINE}`,
};

// The wrapper row (C:guard step 3) naming a token before `git` outside the prefix allowlist.
const wrapper = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'PowerShell',
    tool_input: { command },
    cwd: c.root,
  });
  return { ...runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) }) };
}

test('Seam 2: PowerShell `& git commit -m x` is denied end to end, exit 0', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { toolName: 'PowerShell', command: '& git commit -m x' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, denyJson(TEXTS.bare));
});

// [command, expected message key or wrapper name (`wrapper:`), or null for no output].
const table = [
  // Quoting, the call operator and compound commands.
  // Windows PowerShell 5.1 passes an embedded `"` unescaped, so git splits the argument there.
  ['git commit -m "a`"b"', 'literalArguments'],
  ["git commit --fixup ':/!-\\\" --no-verify'", 'literalArguments'],
  // 5.1 quotes an argument with whitespace; a trailing `\` then escapes the closing quote.
  ["git commit --fixup 'x y\\' 'p --no-verify'", 'literalArguments'],
  // 5.1 drops an empty argument, so these run `git commit --no-verify`.
  ["git '' commit --no-verify", 'literalArguments'],
  ['git "" commit --fixup HEAD --no-verify', 'literalArguments'],
  ["& git '' commit --no-verify", 'literalArguments'],
  ["git commit --fixup HEAD ''", 'literalArguments'],
  ['& git commit -m x', 'bare'],
  ['cd x; git status && git commit -m x', 'bare'],
  ["Get-Item a | ForEach-Object { git commit -m 'x' }", 'bare'],
  // A here-string, a trailing comment and a block comment: the blanket rule (documented
  // false positives).
  ["@'\ngit commit -m x\n'@ | Set-Content f.txt", 'blanket'],
  ['git commit --no-edit # done', 'blanket'],
  ['<# git commit -m x #> git status', 'blanket'],
  // A NUL ends the token's value and git's arguments (a `cut` token).
  ['git commit`0x -m x', 'bare'],
  ['git "commit`0" --no-edit', 'bare'],
  ['git commit`0 --no-edit', 'bare'],
  // `e and `u{…} read differently in 5.1 and 7: the escape blanket row.
  ['git commit`u{00} --no-edit', 'escape'],
  ['git commit --fixup ":/`u{0}" --no-verify', 'escape'],
  ['git commit --fixup :/`u{0} --no-verify', 'escape'],
  ['git commit -m "a`e"', 'escape'],
  ["git commit -m '`e'", 'literalArguments'],
  // A raw NUL character cuts the native command line the same way (pwsh and 5.1 pass `commit`).
  ['git commit\0x -m x', 'bare'],
  ['git "commit\0x" -m x', 'bare'],
  // The tokens after a NUL stay in the segment: a nested command still runs.
  ['Write-Output x`0 (git commit -m x)', 'bare'],
  ['if ("x`0") {git commit -m x}', 'bare'],
  ['git commit --no-edit`0 (git commit -m x)', 'bare'],
  // Possible wrappers (C:guard step 3).
  ["'-n' | xargs git commit --no-edit", 'wrapper:xargs'],
  ['xar`gs git commit --no-edit', 'wrapper:xargs'],
  ["& 'xargs' git commit --no-edit", 'wrapper:xargs'],
  ["& ('xargs') git commit --no-edit", 'wrapper:('],
  ['. git commit --no-edit', 'wrapper:.'],
  // The bracket reset and the `&` call operator of the prefix allowlist.
  ['if ($ok) { git commit --no-edit }', null],
  ['if (Test-Path a) { git commit --no-edit }', null],
  ['& git commit --no-edit', null],
  // A script block passed as data is still read as `{`/`}` tokens: its commands are
  // classified (an accepted false deny for a denied form inside, C:guard step 3).
  ['Write-Output { git commit --amend --no-edit }', null],
  ['saps git commit -m x', 'wrapper:saps'],
  // GRD-11: the `-ArgumentList` after the outer `git` reads as an unknown git option followed
  // by a `commit` token, a row above the wrapper row.
  ['Start-Process git -ArgumentList { git commit -m x }', 'unknownOption'],
  // Start-Process builds git's arguments from its own parameters: denied like `sudo git commit`.
  ['Start-Process git -ArgumentList "commit --fixup HEAD"', 'wrapper:Start-Process'],
  ['saps git commit,--fixup,HEAD', 'wrapper:saps'],
  // A row above the wrapper row keeps precedence (C:guard Precedence).
  ['saps git commit --no-verify', 'noVerify'],
  ['start git -ArgumentList commit', 'unknownOption'],
  ["Start-Process -FilePath git.exe -ArgumentList 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ['& Microsoft.PowerShell.Management\\Start-Process git commit', 'wrapper:Microsoft.PowerShell.Management\\Start-Process'],
  // A Start-Process word anywhere in a command that mentions commit denies it (C:guard
  // step 3): an assignment, `return`, a dot-source or a nested command in front of it, and a
  // target hidden in `-Name:value`, a grouping expression, a variable or a trimmed name.
  ["$p = Start-Process -Wait -NoNewWindow git 'commit --no-verify -m x' -PassThru", 'wrapper:Start-Process'],
  ["$p=Start-Process git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["$p += saps git 'commit --fixup HEAD'", 'wrapper:saps'],
  ["[object]$p = Start-Process git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["$null = Start-Process git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["return Start-Process git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  [". saps git 'commit --fixup HEAD'", 'wrapper:saps'],
  ["if ($true) { $p = saps git 'commit --fixup HEAD' }", 'wrapper:saps'],
  ["Start-Process -Wait -NoNewWindow -FilePath:git -ArgumentList 'commit --no-verify -m x'", 'wrapper:Start-Process'],
  ["Start-Process -FilePath:'git' -ArgumentList 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ['Start-Process -FilePath:"git.exe" -ArgumentList \'commit --fixup HEAD\'', 'wrapper:Start-Process'],
  ["Start-Process -f:git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ['saps -FilePath:git.exe commit,--no-verify,-m,x', 'wrapper:saps'],
  ["Microsoft.PowerShell.Management\\Start-Process -FilePath:git -ArgumentList:'commit --amend --no-edit --no-verify'", 'wrapper:Microsoft.PowerShell.Management\\Start-Process'],
  ["Start-Process 'git ' 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["Start-Process git.exe. 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["Start-Process -FilePath ('git') 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["$a='git'; Start-Process $a 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  ["& ('Start-Process') git 'commit --fixup HEAD'", 'wrapper:Start-Process'],
  // Accepted false denies: no target is read, the word alone denies.
  ['start https://github.com/o/r/commit/abc', 'wrapper:start'],
  ['Start-Process -ArgumentList { git commit --amend --no-edit }', 'wrapper:Start-Process'],
  // Another cmdlet whose name starts the same way is no Start-Process word.
  ['Start-Sleep 1; git commit --amend --no-edit', null],
  // .NET Process.Start runs a string like iex: a documented gap (KD-S80).
  ["[Diagnostics.Process]::Start('git','commit --no-verify -m x').WaitForExit()", null],
  // A redirection target's escape is the blanket kind `escape` too (C:guard step 2).
  ['git commit --amend --no-edit > "x`u{0}"', 'escape'],
  // An interpreter of a string (iex, Invoke-Expression) is a documented gap, like `eval`.
  ["iex 'git commit -m x'", null],
  // GRD-07: a backtick-newline (CRLF too) is joined before splitting, and dropped from the
  // mention text even inside a word (PowerShell itself keeps that newline in the word: an
  // accepted false deny, oracle class `escaped-newline-in-word`); an unterminated quote is
  // the rest of its line as one quoted token, and scanning continues on the next line.
  ['git `\ncommit -m x', 'bare'],
  ['git `\r\ncommit -m x', 'bare'],
  ['git com`\nmit -m x', 'bare'],
  ['git com`\r\nmit -m x', 'bare'],
  ['git commit -m "unterminated', 'bare'],
  ["git commit -m 'unterminated", 'bare'],
  ['Write-Output "x\ngit commit -m x', 'bare'],
  ["Write-Output 'x\ngit commit -m x", 'bare'],
];

for (const [command, expected] of table) {
  test(`Seam 3: PowerShell ${JSON.stringify(command)} → ${expected ?? 'no output'}`, (t) => {
    const c = createCase(t, { repo: false });
    let stdout = '';
    if (expected !== null) {
      stdout = denyJson(expected.startsWith('wrapper:') ? wrapper(expected.slice('wrapper:'.length)) : TEXTS[expected]);
    }
    assert.deepEqual(hook(c, command), { stdout, stderr: '' });
  });
}
