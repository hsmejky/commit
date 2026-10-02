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
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

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
  assert.equal(result.stdout, denyJson(MESSAGES.bare));
});

// [command, expected message key or wrapper name (`wrapper:`), or null for no output].
const table = [
  // Quoting, the call operator and compound commands.
  ['git commit -m "a`"b"', 'bare'],
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
  ['git commit`u{00} --no-edit', 'bare'],
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
  // A script block passed to Start-Process is still read as `{`/`}` tokens: its commands are
  // classified (an accepted false deny for a denied form inside, C:guard step 3).
  ['Start-Process -ArgumentList { git commit --amend --no-edit }', null],
  ['Start-Process git -ArgumentList { git commit -m x }', 'bare'],
];

for (const [command, expected] of table) {
  test(`Seam 3: PowerShell ${JSON.stringify(command)} → ${expected ?? 'no output'}`, (t) => {
    const c = createCase(t, { repo: false });
    let stdout = '';
    if (expected !== null) {
      stdout = denyJson(expected.startsWith('wrapper:') ? wrapper(expected.slice('wrapper:'.length)) : MESSAGES[expected]);
    }
    assert.deepEqual(hook(c, command), { stdout, stderr: '' });
  });
}
