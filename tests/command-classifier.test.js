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
  [['echo', 'git', 'commit']],
  [['git', 'COMMIT', '-m', 'x']],
  [['/usr/bin/Git.exe', 'commit']],
  [['git', { redir: '2>&1', target: null }, 'commit']],
];
for (const parsed of denyTable) {
  test(`classify(${JSON.stringify(parsed)}) is the bare-commit deny`, () => {
    assert.deepEqual(classify(parsed, { shell: 'bash' }), { decision: 'deny', message: MESSAGES.bare, scriptCalls: [] });
  });
}

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
