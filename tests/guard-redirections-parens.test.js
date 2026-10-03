'use strict';

// GRD-08: redirections, parentheses and typographic quotes, through G2 `segments` and G1
// `runHook` (Seam 3), in both shells (C:guard Parsing step 2, blanket rule, heredoc and
// typographic quotes rows; Q3). A redirection is dropped with its target, `(` / `)` (Bash
// `<(` / `>(` read as `(`, PowerShell `{` / `}`) are tokens and every `git` token of a
// segment is classified, `<<<` is a plain redirection, typographic quotes are quotes in
// PowerShell and a blanket case in Bash. The PowerShell rows and the Bash redirection rows
// were checked against bash, pwsh and powershell.exe running a fake git that logs its argv.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let segments;
let MESSAGES;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ segments } = await loadLib('shell-tokenizer'));
  ({ MESSAGES } = await loadLib('command-classifier'));
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

// A redirection and its target are one token: one segment, the target never an argument
// (`> --no-verify` writes a file named `--no-verify`), and the `&` of `2>&1` splits nothing.
const redirections = [
  ['git commit -m x 2>&1', [['git', 'commit', '-m', 'x', { redir: '2>&1', target: null }]]],
  ['git commit -m x > log.txt', [['git', 'commit', '-m', 'x', { redir: '>', target: 'log.txt' }]]],
  ['git commit --no-edit > --no-verify', [['git', 'commit', '--no-edit', { redir: '>', target: '--no-verify' }]]],
];
for (const shell of ['bash', 'powershell']) {
  for (const [command, want] of redirections) {
    test(`G2: ${shell} ${JSON.stringify(command)} is one segment with the redirection as one token`, () => {
      assert.deepEqual(segments(command, shell), want);
    });
  }
}

test('G2: Bash `<<<` is a plain redirection with its target', () => {
  assert.deepEqual(segments('git commit -m x <<< y', 'bash'), [['git', 'commit', '-m', 'x', { redir: '<<<', target: 'y' }]]);
});

test('G2: Bash `git @(commit) -m x` keeps the extglob argument as one word, its body a segment of its own', () => {
  assert.deepEqual(segments('git @(commit) -m x', 'bash'), [['git', '@(commit)', '-m', 'x'], ['commit']]);
});

// [shell, command, MESSAGES key, or null for no output].
const table = [
  // Redirections.
  ['bash', 'git commit -m x 2>&1', 'bare'],
  ['bash', 'git commit -m x > log.txt', 'bare'],
  ['bash', 'git commit --no-edit 2>&1', null],
  ['bash', 'git commit --no-edit > --no-verify', null],
  ['bash', 'git commit --no-edit 2>--no-verify', null],
  ['powershell', 'git commit -m x 2>&1', 'bare'],
  ['powershell', 'git commit -m x > log.txt', 'bare'],
  ['powershell', 'git commit --no-edit 2>&1', null],
  ['powershell', 'git commit --no-edit > --no-verify', null],
  ['powershell', 'git commit --no-edit 2>--no-verify', null],
  // Parentheses, process substitution and script blocks: every `git` token is classified.
  ['bash', '(git commit -m x)', 'bare'],
  ['bash', '(git commit --no-edit)', null],
  ['bash', 'diff <(git commit -m x) f', 'bare'],
  ['powershell', '(git commit -m x)', 'bare'],
  ['powershell', '(git commit --no-edit)', null],
  ['powershell', 'git status (git commit -m x)', 'bare'],
  ['powershell', '&{git commit -m x}', 'bare'],
  ['powershell', '. {git commit -m x}', 'bare'],
  ['powershell', 'if ($true) {git commit -m x}', 'bare'],
  ['powershell', '&{git status} ; &{git commit -m x}', 'bare'],
  ['powershell', '&{git commit --no-edit}', null],
  ['powershell', '&{git commit --no-edit} > out.txt', null],
  // A heredoc is the blanket rule (documented false positive); `<<<` is a plain redirection.
  ['bash', "cat <<'EOF' > f\ngit commit -m x\nEOF", 'blanket'],
  ['bash', 'cat <<< "git commit -m x"', null],
  ['bash', 'git commit --no-edit <<< x', null],
  ['bash', 'git commit -m x <<< y', 'bare'],
  // Typographic quotes: a blanket case in Bash, quotes in PowerShell (U+201C-U+201E double,
  // U+2018-U+201B single).
  ['bash', 'git “commit” -m x', 'blanket'],
  ['bash', 'git ‘commit’ --no-edit', 'blanket'],
  ['powershell', 'git co‘’mmit -m x', 'bare'],
  ['powershell', 'git “commit” -m x', 'bare'],
  ['powershell', 'git “commit” --no-edit', null],
  ['powershell', 'git „commit” --no-edit', null],
  ['powershell', 'git ‘commit’ --no-edit', null],
  ['powershell', 'git ‛commit’ --no-edit', null],
  // Bash extglob in command position: a `(` token of its own.
  ['bash', '!(git commit -m x)', 'bare'],
  ['bash', '!(git commit --no-edit)', null],
];

for (const [shell, command, expected] of table) {
  test(`Seam 3: ${shell} ${JSON.stringify(command)} → ${expected ?? 'no output'}`, (t) => {
    const c = createCase(t, { repo: false });
    const stdout = expected === null ? '' : denyJson(MESSAGES[expected]);
    assert.deepEqual(hook(c, command, shell), { stdout, stderr: '' });
  });
}
