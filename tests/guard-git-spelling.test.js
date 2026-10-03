'use strict';

// GRD-10: detecting `git` in every spelling, through G1 `runHook` (Seam 3), in both shells
// (C:guard Parsing step 3; Q3). A `git` token is found by its basename, `git` or `git.exe`
// compared case-insensitively, after the `&` call operator too, once its path is normalised
// Win32-style in both shells: split on `/` and `\`, each component's trailing spaces and
// dots dropped, empty and `.` components dropped, `..` dropping the one before it, the
// basename the last component left; the dashed `git-commit` (any directory, optional `.exe`) is
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
  // Trailing spaces and dots are dropped first: Windows trims them from a program's name
  // (PowerShell 5.1 and 7 run git for `'git '` and for a path ending `git.exe.`); in Bash
  // the same rows are accepted false denies.
  ['powershell', `& 'git ' commit -m x`, 'bare'],
  ['powershell', `& 'git.exe  ' commit -m x`, 'bare'],
  ['powershell', `& 'git ' commit --no-edit`, null],
  ['powershell', r`& "C:\Git\cmd\git.exe." commit -m x`, 'bare'],
  ['powershell', r`& "C:\Git\cmd\GIT.EXE. ." commit -m x`, 'bare'],
  ['powershell', `& 'git-commit ' -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\git-core\git-commit.exe .' -m x`, 'bare'],
  ['bash', `'git ' commit -m x`, 'bare'],
  ['bash', `'git. ' commit --no-edit`, null],
  // The path is normalised first, Win32-style in both shells: `.` and empty components are
  // dropped, `..` drops the component before it (PowerShell 5.1 and 7 run git for each row
  // below, Git Bash for `git.exe/.`, `git/.` and `git.exe/`); on Linux the same reading is
  // an accepted false deny.
  ['powershell', r`& 'C:\Program Files\Git\cmd\git.exe\.' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe/.' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe\x\..' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe\.\.' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe\x \..' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\x\..\git.exe' commit -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe\x\..' commit --no-edit`, null],
  ['powershell', r`& 'C:\Git\git-core\git-commit.exe\.' -m x`, 'bare'],
  ['powershell', r`& 'C:\Git\cmd\git.exe\..' commit -m x`, null],
  ['bash', '"/c/Program Files/Git/cmd/git.exe/." commit -m x', 'bare'],
  ['bash', '/mingw64/bin/git/. commit -m x', 'bare'],
  ['bash', r`"C:\Program Files\Git\cmd\git.exe\." commit -m x`, 'bare'],
  ['bash', '/mingw64/bin/git.exe/ commit -m x', 'bare'],
  ['bash', '/usr/lib/git-core/git-commit/. -m x', 'bare'],
  ['bash', '/usr/bin/git/.. commit -m x', null],
  // The dashed `git-commit`:`commit` straight away, its arguments through the allowlist.
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
  // An argv[0] option of `exec` or `env` before a `git` token may name it `git-commit`, which
  // git runs as `commit` (Linux bash ran `(exec -agit-commit git --allow-empty -m e)`): such
  // a `git` token not followed by `commit` denies with the wrapper row naming `exec` or
  // `env`. A `git-commit` or `commit` token is classified as usual, its rows ranking first.
  ['bash', '(exec -agit-commit git -m x)', () => wrapper('exec')],
  ['bash', '(exec -a"git-commit" git -m x)', () => wrapper('exec')],
  ['bash', '(exec -cagit-commit git -m x)', () => wrapper('exec')],
  ['bash', 'exec -a git-commit git --no-edit', generic('git')],
  ['bash', 'exec -la x /usr/bin/git commit --no-edit', () => wrapper('exec')],
  ['bash', 'env --argv0=git-commit git -m x', () => wrapper('env')],
  ['bash', 'env -agit-commit git -m x', () => wrapper('env')],
  ['bash', 'env -i -agit-commit /usr/bin/git -m x', () => wrapper('env')],
  ['bash', 'command /usr/bin/env --a=git-commit git -m x', () => wrapper('/usr/bin/env')],
  ['bash', 'env -a x git commit --no-edit', () => wrapper('-a')],
  ['bash', 'env -i git log --grep=commit', null],
  // Accepted false denies: any argv[0] value, a cluster holding `a` with another meaning.
  ['bash', 'exec -a x git log --grep=commit', () => wrapper('exec')],
  ['bash', 'env -uname git log --grep=commit', () => wrapper('env')],
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
