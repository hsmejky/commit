'use strict';

// GRD-04 review round 8: an extglob pattern where bash starts a command, and the body of a
// pattern read as one word in an argument (C:guard Parsing step 2). `then`, `do`, `else` and
// `elif` open a command's first position from any position, since bash takes them as
// reserved words after `]]`, `}`, `fi`, `done`, `esac` and (`do`) `for NAME` / `select NAME`.
// Defense in depth, independent of that position tracking: the body of every extglob pattern
// G2 reads as one word in an argument or a redirection target is also read as a command
// text, nested patterns included, and classified like any segment. Through G1 `runHook`
// (Seam 3), G2 `segments` and the real hook process (Seam 2).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let segments;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ segments } = await loadLib('shell-tokenizer'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: c.root,
  });
  return { ...runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) }) };
}

// The deny message of a row: `bare`, `wrapper <name>` or the generic row's flag.
function messageOf(row) {
  if (row === 'bare') return MESSAGES.bare;
  const tail = `${ROUTE}\n${PERSONAL_SKILL_LINE}`;
  if (row.startsWith('wrapper ')) return `git commit run by ${row.slice(8)} is not allowed: it can append arguments. ${tail}`;
  return `git commit ${row} is not allowed here. ${tail}`;
}

const sub = (x) => ['!(', { op: '(' }, x, { op: ')' }];

const tokenized = [
  // `then`, `do`, `else`, `elif` open a command's first position after an argument too.
  ['if [[ x ]] then !(x); fi', [['if', '[[', 'x', ']]', 'then', ...sub('x')], ['fi']]],
  ['for x do !(x); done', [['for', 'x', 'do', ...sub('x')], ['done']]],
  ['if { :; } else !(x); fi', [['if', '{', ':'], ['}', 'else', ...sub('x')], ['fi']]],
  ['echo elif !(x)', [['echo', 'elif', ...sub('x')]]],
  // A pattern body read as one word is also tokenized as a command text, its segments right
  // after the segment holding the word: split at its separators, nested patterns read at a
  // command's first position, quotes removed as there.
  ['echo a !(git commit -m x) b; c', [['echo', 'a', '!(git commit -m x)', 'b'], ['git', 'commit', '-m', 'x'], ['c']]],
  ['echo @(a|!(b|git commit)) x', [['echo', '@(a|!(b|git commit))', 'x'], ['a'], ['!(', { op: '(' }, 'b'], ['git', 'commit', { op: ')' }]]],
  ['echo x@(a)y@("git" commit)', [['echo', 'x@(a)y@(git commit)'], ['a'], ['git', 'commit']]],
  ['cat >@(git commit) f', [['cat', { redir: '>', target: '@(git commit)' }, 'f'], ['git', 'commit']]],
  ["echo @('git commit') @(git\\ commit)", [['echo', '@(git commit)', '@(git commit)'], ['git commit'], ['git commit']]],
];
for (const [command, expected] of tokenized) {
  test(`Seam 3: Bash segments(${JSON.stringify(command)})`, () => {
    assert.deepEqual(segments(command, 'bash'), expected);
  });
}

// Each committed without its pre-commit hook and with no guard output in Git Bash 5.3 with
// default options (`extglob` off) before the fix (review GRD-04 round 8, finding 1).
const reservedWordAfterCloser = [
  ['if [[ x ]] then !(git commit -n --allow-empty -m b); fi', '-n'],
  ['while [[ x ]] do !(git commit -n --allow-empty -m b); break; done', '-n'],
  ['until [[ ! x ]] do !(git commit -m x); break; done', 'bare'],
  ['if false; then :; elif [[ x ]] then !(git commit -m x); fi', 'bare'],
  ['if { :; } then !(git commit -m x); fi', 'bare'],
  ['while { :; } do !(git commit -m x); break; done', 'bare'],
  ['if if :; then :; fi then !(git commit -m x); fi', 'bare'],
  ['while while false; do :; done do !(git commit -m x); break; done', 'bare'],
  ['if case x in x) :;; esac then !(git commit -m x); fi', 'bare'],
  ['while case x in x) :;; esac do !(git commit -m x); break; done', 'bare'],
  ['if ! :; then if :; then :; fi; { :; } else !(git commit -m x); fi', 'bare'],
  ['set -- 1; for x do !(git commit -n --allow-empty -m b); done', '-n'],
  ['set -- 1; select x do !(git commit -m x); break; done <<<1', 'bare'],
  ['function f if [[ x ]] then !(git commit -m x); fi; f', 'bare'],
  ['coproc if [[ x ]] then !(git commit -m x); fi; wait', 'bare'],
];
// The body of a pattern in an argument, where position tracking plays no part: each is the
// row the body gets as a command. With `extglob` off bash rejects these patterns, and with it
// on matches file names: an accepted false deny wherever no command runs the body.
const patternBody = [
  ['echo a !(git commit -m x)', 'bare'],
  ['ls x @(a|git commit -n --allow-empty -m b)', '-n'],
  ['echo @(a;b&git commit -a)', '-a'],
  ['echo @(a|!(b|+(git commit -m x)))', 'bare'],
  ['echo x@(a)y@(b|git commit -a)', '-a'],
  ['echo @(a|"git" commit -m x)', 'bare'],
  ['echo @(xargs git commit --no-edit)', 'wrapper xargs'],
  ['cat >@(git commit -m x)', 'bare'],
  ['[[ $m == @(git commit -m x) ]]', 'bare'],
  ['case $m in @(git commit -a)) ;; esac', '-a'],
];
for (const [command, row] of [...reservedWordAfterCloser, ...patternBody]) {
  test(`Seam 3: ${JSON.stringify(command)} is denied with the ${row} row`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(messageOf(row)), stderr: '' });
  });
}

// A body holding no denied git invocation as a command, a quoted or escaped one, and a plain
// glob keep no output.
const noOutput = [
  'ls @(git commit --no-edit)',
  'echo @(a|git commit --fixup=HEAD)',
  "echo @('git commit -m x')",
  'echo @("git commit -m x")',
  'echo @(git\\ commit -m x)',
  "echo '@(git commit -m x)'",
  'ls !(*.txt) && git commit --no-edit',
  'rm @(git|svn) commit',
  'echo then commit',
];
for (const command of noOutput) {
  test(`Seam 3: ${JSON.stringify(command)} has no output`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: '', stderr: '' });
  });
}

test('Seam 2: a `!(` after `[[ … ]] then` is denied by the real hook process', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'if [[ x ]] then !(git commit -n --allow-empty -m b); fi' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, denyJson(messageOf('-n')));
});

test('Seam 2: a pattern body in an argument is denied by the real hook process', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'echo a @(b|!(git commit -n --allow-empty -m b))' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, denyJson(messageOf('-n')));
});
