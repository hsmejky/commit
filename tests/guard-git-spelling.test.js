'use strict';

// GRD-10: detecting `git` in every spelling, through G1 `runHook` (Seam 3), in both shells
// (C:guard Parsing step 3; Q3). A `git` token is found by its basename (after the last `/`
// or `\`, in both shells), `git` or `git.exe` compared case-insensitively, after the `&`
// call operator too; the dashed `git-commit` (any directory, optional `.exe`) is
// `git commit` with its arguments checked against the allowlist. Rows were checked against
// bash (Git Bash), pwsh and powershell.exe running a fake git and git-commit that log argv.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

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

const r = String.raw;
// The wrapper row (C:guard step 3) naming a token before `git` outside the prefix allowlist.
const wrapper = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;
// The `--no-verify` row and the generic row naming a flag (C:guard Deny messages).
const noVerify = () => '--no-verify is not allowed. Fix the hook or signing setup instead.';
const generic = (flag) => () => `git commit ${flag} is not allowed here. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

// [shell, command, MESSAGES key or a function giving the message, or null for no output].
const table = [
  // `git` at any path, in any case, after `&`.
  ['bash', '/usr/bin/git commit -m x', 'bare'],
  ['powershell', '/usr/bin/git commit -m x', 'bare'],
  ['bash', 'GIT.EXE commit -m x', 'bare'],
  ['powershell', 'GIT.EXE commit -m x', 'bare'],
  ['bash', 'Git commit -m x', 'bare'],
  ['powershell', r`& "C:\Program Files\Git\cmd\git.exe" commit -m x`, 'bare'],
  ['powershell', r`& "C:\Program Files\Git\cmd\git.exe" commit --no-edit`, null],
  ['powershell', r`& 'C:\Git\cmd\GIT' commit -m x`, 'bare'],
  ['powershell', r`C:\Git\cmd\git.exe commit -m x`, 'bare'],
  ['powershell', r`.\git commit -m x`, 'bare'],
  // A Bash-quoted Windows path: its basename is read after the last `\` too.
  ['bash', r`"C:\Program Files\Git\cmd\git.exe" commit -m x`, 'bare'],
  ['bash', r`"C:\Program Files\Git\cmd\git.exe" commit --no-edit`, null],
  ['bash', r`'C:\Git\cmd\GIT' commit -m x`, 'bare'],
  ['bash', r`C:\\Git\\cmd\\git.exe commit -m x`, 'bare'],
  // The dashed `git-commit`: `commit` straight away, its arguments through the allowlist.
  ['bash', 'git-commit -m x', 'bare'],
  ['powershell', 'git-commit -m x', 'bare'],
  ['bash', '/usr/lib/git-core/git-COMMIT.exe -m x', 'bare'],
  ['powershell', '/usr/lib/git-core/git-COMMIT.exe -m x', 'bare'],
  ['powershell', r`& "C:\Program Files\Git\mingw64\libexec\git-core\git-commit.exe" -m x`, 'bare'],
  ['bash', 'git-commit --no-edit', null],
  ['powershell', 'git-commit --no-edit', null],
  ['bash', 'git-commit --amend --no-edit -q', null],
  ['bash', 'git-commit --fixup=HEAD~1', null],
  ['bash', 'git-commit --no-edit --no-verify', noVerify],
  ['bash', 'git-commit --no-edit --author=x', generic('--author')],
  ['bash', 'git-commit "$m"', 'literalArguments'],
  ['bash', 'echo x && git-commit -m x', 'bare'],
  ['bash', '(git-commit -m x)', 'bare'],
  ['bash', 'xargs git-commit --no-edit', () => wrapper('xargs')],
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
