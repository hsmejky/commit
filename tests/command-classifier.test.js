'use strict';

// GRD-03: the thinnest G3 at Seam 3 (docs/spec/modules-shared-and-guard.md G3; C:guard
// Parsing step 3, Deny messages): a blanket result is the blanket deny with no script calls,
// a `git` token followed by `commit` is the bare-commit deny, and no deny text names
// `/commit` (Q8).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let classify;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ classify, MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

const ROUTE_TEXT =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';
const PERSONAL_TEXT = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';

test('G3 is pure (no I/O, no ambient state, no imports)', () => {
  assertPureSource('command-classifier');
});

test('the route and the personal-skill line are C:guard\'s fixed texts', () => {
  assert.equal(ROUTE, ROUTE_TEXT);
  assert.equal(PERSONAL_SKILL_LINE, PERSONAL_TEXT);
});

test('the catalogue holds the bare-commit and blanket rows with their fixed texts', () => {
  assert.equal(MESSAGES.bare, `Direct git commit is blocked. ${ROUTE_TEXT}\n${PERSONAL_TEXT}`);
  assert.equal(
    MESSAGES.blanket,
    'This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: '
      + `${ROUTE_TEXT}\n${PERSONAL_TEXT}`,
  );
});

test('no deny text anywhere in the catalogue names /commit', () => {
  const texts = [ROUTE, PERSONAL_SKILL_LINE, ...Object.values(MESSAGES)];
  assert.ok(texts.length > 2);
  for (const text of texts) assert.ok(!text.includes('/commit'), text);
});

test('every catalogue message that holds the route ends with the personal-skill line', () => {
  for (const text of Object.values(MESSAGES)) {
    if (text.includes(ROUTE_TEXT)) assert.ok(text.endsWith(`\n${PERSONAL_TEXT}`), text);
  }
});

test('a blanket result is the blanket deny with no script calls', () => {
  assert.deepEqual(classify({ blanket: 'comment' }, { shell: 'bash' }), {
    decision: 'deny',
    message: MESSAGES.blanket,
    scriptCalls: [],
  });
});

const denyTable = [
  [['git', 'commit', '-m', 'x']],
  [['cd', 'x'], ['git', 'commit', '-m', 'x']],
  [['git', 'COMMIT', '-m', 'x']],
  [['/usr/bin/Git.exe', 'commit']],
  [['git', { redir: '2>&1', target: null }, 'commit']],
];
for (const parsed of denyTable) {
  test(`classify(${JSON.stringify(parsed)}) is the bare-commit deny`, () => {
    assert.deepEqual(classify(parsed, { shell: 'bash' }), { decision: 'deny', message: MESSAGES.bare, scriptCalls: [] });
  });
}

// A token before `git` outside the prefix allowlist (C:guard step 3) is a possible wrapper;
// its row outranks the bare row, so `echo git commit` (a documented false positive) is denied
// naming `echo`.
test('classify([["echo","git","commit"]]) is the wrapper row naming echo', () => {
  assert.deepEqual(classify([['echo', 'git', 'commit']], { shell: 'bash' }), {
    decision: 'deny',
    message: `git commit run by echo is not allowed: it can append arguments. ${ROUTE_TEXT}\n${PERSONAL_TEXT}`,
    scriptCalls: [],
  });
});

const noneTable = [
  [],
  [['git', 'status']],
  [['git'], ['commit', '-m', 'x']],
  [['git', { op: ')' }, 'commit']],
  [['git', { redir: '>', target: 'commit' }]],
  [['echo', 'commit']],
];
for (const parsed of noneTable) {
  test(`classify(${JSON.stringify(parsed)}) has no decision`, () => {
    assert.deepEqual(classify(parsed, { shell: 'bash' }), { decision: 'none', scriptCalls: [] });
  });
}

// GRD-04 at G3 directly: where `commit`'s arguments end and which are not literal, per
// shell (C:guard step 4), and the prefix allowlist before `git` (step 3: in PowerShell it is
// empty, but a `(` or `{` still open at `git` starts a new command, so `if (…) { git … }`,
// `&{ git … }` and `. { git … }` fit). The PowerShell rows are reached through `runHook` once
// its tokenizer lands (GRD-06).
const commitArgTable = [
  ['bash', [['git', 'commit', '--no-edit', { op: ')' }, '-m', 'x']], 'none'],
  ['powershell', [['git', 'commit', '--no-edit', { op: '}' }, '-m', 'x']], 'none'],
  ['powershell', [['git', 'commit', '--no-edit', { op: 'cut' }, '-m', 'x']], 'none'],
  ['powershell', [['git', 'commit', { op: 'cut' }, '--no-edit']], 'bare'],
  ['powershell', [['git', 'commit', '--fixup', '@s']], 'literalArguments'],
  ['powershell', [['git', 'commit', '--no-edit', 'a,b']], 'literalArguments'],
  ['powershell', [['git', 'commit', '--no-edit', '--%']], 'literalArguments'],
  ['powershell', [['git', 'commit', '--fixup', { op: '(' }, 'HEAD', { op: ')' }]], 'literalArguments'],
  ['bash', [['git', 'commit', '--fixup', '@~1']], 'none'],
  ['bash', [['git', 'commit', '--no-edit', 'a,b']], 'generic:a,b'],
  ['powershell', [['if', { op: '(' }, '$ok', { op: ')' }, { op: '{' }, 'git', 'commit', '--no-edit', { op: '}' }]], 'none'],
  ['powershell', [['if', { op: '(' }, 'Test-Path', 'a', { op: ')' }, { op: '{' }, 'git', 'commit', '--no-edit', { op: '}' }]], 'none'],
  ['powershell', [['foreach', { op: '(' }, '$f', 'in', '$a', { op: ')' }, { op: '{' }, 'git', 'commit', '--no-edit', { op: '}' }]], 'none'],
  ['powershell', [['.', { op: '{' }, 'git', 'commit', '--no-edit', { op: '}' }]], 'none'],
  ['powershell', [['&', { op: '{' }, 'git', 'commit', '--no-edit', { op: '}' }]], 'none'],
  ['powershell', [['xargs', 'git', 'commit', '--no-edit']], 'wrapper:xargs'],
  ['powershell', [['&', 'xargs', 'git', 'commit', '--no-edit']], 'wrapper:&'],
  ['powershell', [['&', { op: '(' }, 'xargs', { op: ')' }, 'git', 'commit', '--no-edit']], 'wrapper:&'],
  ['powershell', [['&', 'git', 'commit', '--no-edit']], 'wrapper:&'],
  ['powershell', [['.', 'git', 'commit', '--no-edit']], 'wrapper:.'],
  ['powershell', [['env', 'git', 'commit', '--no-edit']], 'wrapper:env'],
  ['powershell', [['if', { op: '(' }, '$ok', { op: ')' }, { op: '{' }, 'xargs', 'git', 'commit', '--no-edit', { op: '}' }]], 'wrapper:xargs'],
  ['bash', [['nice', 'git', 'commit', '--no-edit']], 'none'],
  ['bash', [['xargs', 'git', 'commit', '-m', 'x']], 'wrapper:xargs'],
];
for (const [shell, parsed, expected] of commitArgTable) {
  test(`classify(${JSON.stringify(parsed)}, ${shell}) → ${expected}`, () => {
    const message = expected === 'none' ? undefined
      : expected.startsWith('generic:') ? `git commit ${expected.slice(8)} is not allowed here. ${ROUTE_TEXT}\n${PERSONAL_TEXT}`
        : expected.startsWith('wrapper:')
          ? `git commit run by ${expected.slice(8)} is not allowed: it can append arguments. ${ROUTE_TEXT}\n${PERSONAL_TEXT}`
          : MESSAGES[expected];
    const want = message === undefined ? { decision: 'none', scriptCalls: [] } : { decision: 'deny', message, scriptCalls: [] };
    assert.deepEqual(classify(parsed, { shell }), want);
  });
}
