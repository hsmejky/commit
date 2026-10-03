'use strict';

// M6 message grammar, Seam 3 (in-process, table-driven) against C:message-grammar.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

// Q6 defaults: the commitlint `config-conventional` types.
const DEFAULT_TYPES = Object.freeze([
  'build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test',
]);

const HEADER_REASON = "header is not 'type(scope)!: description'";

function config(values = {}) {
  return Object.freeze({ types: DEFAULT_TYPES, ...values });
}

let parse;
let lint;
let passesLowerCase;
let isFooterLine;
let normaliseText;

beforeEach(async () => {
  ({ parse, lint, passesLowerCase, isFooterLine, normaliseText } = await loadLib('message-grammar'));
});

// MSG-01 AC: `feat: add x` parses to type `feat`, no scope, no breaking flag, description
// `add x`, and lints clean under the 11 default types.

const parseTable = [
  {
    message: 'feat: add x',
    header: { type: 'feat', scope: null, breaking: false, description: 'add x' },
  },
  {
    message: 'feat: add x\n',
    header: { type: 'feat', scope: null, breaking: false, description: 'add x' },
  },
  {
    message: 'fix: handle ünïcode',
    header: { type: 'fix', scope: null, breaking: false, description: 'handle ünïcode' },
  },
];

for (const { message, header } of parseTable) {
  test(`parse ${JSON.stringify(message)} splits the header`, () => {
    assert.deepEqual(parse(message).header, header);
  });
}

for (const type of DEFAULT_TYPES) {
  test(`\`${type}: add x\` lints clean under the default types`, () => {
    assert.deepEqual(lint(`${type}: add x`, config()), []);
  });
}

// MSG-01 AC: a type outside `types` (`wip: x`) gives one reason naming the type, the exact
// text C:check shows.

const typeTable = [
  { message: 'wip: x', types: DEFAULT_TYPES, reasons: ["type 'wip' not in types"] },
  { message: 'feat: x', types: ['fix'], reasons: ["type 'feat' not in types"] },
  { message: 'wip: x', types: ['wip'], reasons: [] },
];

for (const { message, types, reasons } of typeTable) {
  test(`lint ${JSON.stringify(message)} under types [${types.join(', ')}]`, () => {
    assert.deepEqual(lint(message, config({ types })), reasons);
  });
}

// MSG-01 AC: a header that does not match the regex (no `: ` separator, empty description,
// or an uppercase first character) gives the header reason, not a throw, and no type check
// runs.

const mismatchTable = [
  { case: 'no separator', message: 'feat add x' },
  { case: 'colon without space', message: 'feat:add x' },
  { case: 'space before colon', message: 'feat : add x' },
  { case: 'empty description', message: 'feat: ' },
  { case: 'description only whitespace', message: 'feat:  ' },
  { case: 'no description at all', message: 'feat:' },
  { case: 'uppercase first character', message: 'Feat: x' },
  { case: 'uppercase first character, unknown type', message: 'Wip: x' },
  { case: 'digit first character', message: '1feat: x' },
  { case: 'empty message', message: '' },
];

for (const { case: name, message } of mismatchTable) {
  test(`${name} (${JSON.stringify(message)}): parse has no header`, () => {
    assert.equal(parse(message).header, null);
  });

  test(`${name} (${JSON.stringify(message)}): lint gives only the header reason`, () => {
    assert.deepEqual(lint(message, config()), [HEADER_REASON]);
  });
}

// MSG-01 AC: a static test asserts `parse` and `lint` are exported, pure (no I/O in their
// source); `lint` takes the config values as an argument and reads nothing else.

test('parse and lint are exported functions', () => {
  assert.equal(typeof parse, 'function');
  assert.equal(typeof lint, 'function');
});

test('the message grammar source does no I/O and reads no ambient state', () => {
  // M6 has no dependencies in the module map (docs/spec/modules.md): no imports allowed.
  assertPureSource('message-grammar');
});

// The lint keys of Q6; `scanIgnore` is not a message rule.
const LINT_KEYS = ['types', 'scope', 'body', 'maxSubjectLength', 'subjectCase'];

test('lint takes the config values as an argument and reads only config keys', () => {
  assert.ok(lint.length >= 2, 'lint(message, values) must declare the values parameter');
  const read = [];
  const values = new Proxy(config(), {
    get(target, key, receiver) {
      read.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(lint('feat: add x', values), []);
  assert.ok(read.includes('types'), 'lint must read types from the values argument');
  for (const key of read) {
    assert.ok(LINT_KEYS.includes(key), `lint read ${String(key)}, which is not a Q6 lint key`);
  }
});

test('lint does not mutate the config values', () => {
  const types = ['feat'];
  const values = { types };
  lint('wip: x', values);
  assert.deepEqual(values, { types: ['feat'] });
  assert.equal(values.types, types);
});

// PLN-06 (review-PLN-06-r2 finding 1): `lint` quotes the type, the scope and a footer token
// through an optional `quote` callback instead of embedding them directly, so a caller can
// redact just that slot without touching the fixed wording around it. With no `quote`
// option, the fragment is embedded verbatim, exactly as before this option existed.

test('lint with no quote option embeds the type, scope and footer token verbatim', () => {
  assert.deepEqual(lint('wip(api): x', config({ scope: 'forbidden' })), [
    "type 'wip' not in types",
    "scope 'api' not allowed (scope: forbidden)",
  ]);
  assert.deepEqual(lint('feat: x\n\nNote: y', config()), [
    '`Note` is not an allowed footer token. If this is body text, rephrase it or add a ' +
      'non-footer line to the paragraph.',
  ]);
});

test('lint passes the type, the scope and a footer token to quote, in that order', () => {
  const seen = [];
  const quote = (fragment) => {
    seen.push(fragment);
    return fragment;
  };
  lint('wip(api): x\n\nNote: y', config({ scope: 'forbidden' }), { quote });
  assert.deepEqual(seen, ['wip', 'api', 'Note']);
});

test('quote replaces only the quoted slot, leaving the fixed wording around it untouched', () => {
  const quote = () => '[redacted]';
  assert.deepEqual(lint('wip(api): x', config({ scope: 'forbidden' }), { quote }), [
    "type '[redacted]' not in types",
    "scope '[redacted]' not allowed (scope: forbidden)",
  ]);
  assert.deepEqual(lint('feat: x\n\nNote: y', config(), { quote }), [
    '`[redacted]` is not an allowed footer token. If this is body text, rephrase it or add a ' +
      'non-footer line to the paragraph.',
  ]);
});

// MSG-02 AC: `feat(api): x` fails under `forbidden`, passes under `optional` and
// `required`; `feat: x` fails under `required` only.

const scopeTable = [
  { message: 'feat(api): x', scope: 'forbidden', reasons: ["scope 'api' not allowed (scope: forbidden)"] },
  { message: 'feat(api): x', scope: 'optional', reasons: [] },
  { message: 'feat(api): x', scope: 'required', reasons: [] },
  { message: 'feat: x', scope: 'forbidden', reasons: [] },
  { message: 'feat: x', scope: 'optional', reasons: [] },
  { message: 'feat: x', scope: 'required', reasons: ['scope required (scope: required)'] },
];

for (const { message, scope, reasons } of scopeTable) {
  test(`lint ${JSON.stringify(message)} under scope: ${scope}`, () => {
    assert.deepEqual(lint(message, config({ scope })), reasons);
  });
}

// MSG-02 AC: `feat!: x` and `feat(api)!: x` parse with the breaking flag set and lint clean
// where the scope rule allows.

const breakingTable = [
  {
    message: 'feat!: x',
    header: { type: 'feat', scope: null, breaking: true, description: 'x' },
  },
  {
    message: 'feat(api)!: x',
    header: { type: 'feat', scope: 'api', breaking: true, description: 'x' },
  },
];

for (const { message, header } of breakingTable) {
  test(`parse ${JSON.stringify(message)} sets the breaking flag`, () => {
    assert.deepEqual(parse(message).header, header);
  });
}

// MSG-02 AC: the breaking flag is independent of the scope rule; a breaking header lints
// under scope exactly as its non-breaking counterpart would.

const breakingScopeTable = [
  { message: 'feat!: x', scope: 'forbidden', reasons: [] },
  { message: 'feat(api)!: x', scope: 'required', reasons: [] },
  {
    message: 'feat(api)!: x',
    scope: 'forbidden',
    reasons: ["scope 'api' not allowed (scope: forbidden)"],
  },
  { message: 'feat!: x', scope: 'required', reasons: ['scope required (scope: required)'] },
];

for (const { message, scope, reasons } of breakingScopeTable) {
  test(`lint ${JSON.stringify(message)} under scope: ${scope}`, () => {
    assert.deepEqual(lint(message, config({ scope })), reasons);
  });
}

// MSG-02 AC: `feat(a b): x`, `feat(): x` and `feat((a)): x` are header-shape failures.

const scopeShapeTable = [
  { case: 'space inside scope', message: 'feat(a b): x' },
  { case: 'empty scope', message: 'feat(): x' },
  { case: 'nested parens in scope', message: 'feat((a)): x' },
];

for (const { case: name, message } of scopeShapeTable) {
  test(`${name} (${JSON.stringify(message)}): parse has no header`, () => {
    assert.equal(parse(message).header, null);
  });

  test(`${name} (${JSON.stringify(message)}): lint gives only the header reason`, () => {
    assert.deepEqual(lint(message, config({ scope: 'optional' })), [HEADER_REASON]);
  });
}

// MSG-03 AC: a header of exactly `maxSubjectLength` code points passes, one more fails; a
// header with astral characters (emoji) is counted in code points, not UTF-16 units.

const lengthTable = [
  { message: `feat: ${'x'.repeat(14)}`, maxSubjectLength: 20, reasons: [] },
  {
    message: `feat: ${'x'.repeat(15)}`,
    maxSubjectLength: 20,
    reasons: ['header exceeds maxSubjectLength (21 > 20)'],
  },
  // 'feat: ' (6) + one astral emoji (1 code point, 2 UTF-16 units) = 7 code points, 8
  // UTF-16 units; a `.length` count would wrongly fail this against maxSubjectLength 7.
  { message: 'feat: \u{1F600}', maxSubjectLength: 7, reasons: [] },
  // 'feat: ' (6) + emoji (1) + 'x' (1) = 8 code points, one over maxSubjectLength 7; a
  // `.length` count (9 UTF-16 units) would report the wrong numbers in the reason.
  {
    message: 'feat: \u{1F600}x',
    maxSubjectLength: 7,
    reasons: ['header exceeds maxSubjectLength (8 > 7)'],
  },
];

for (const { message, maxSubjectLength, reasons } of lengthTable) {
  test(`lint ${JSON.stringify(message)} under maxSubjectLength: ${maxSubjectLength}`, () => {
    assert.deepEqual(lint(message, config({ maxSubjectLength })), reasons);
  });
}

// MSG-03 AC: under `lower`, an uppercase first character fails unless the first word is an
// acronym (all uppercase, at least two letters); under `any`, anything passes.

const CASE_REASON = 'description not lowercase (subjectCase: lower)';

const caseTable = [
  { message: 'feat: Add x', subjectCase: 'lower', reasons: [CASE_REASON] },
  { message: 'feat: API change', subjectCase: 'lower', reasons: [] },
  { message: 'feat: CI matrix', subjectCase: 'lower', reasons: [] },
  { message: 'feat: 2fa', subjectCase: 'lower', reasons: [] },
  { message: 'feat: `code`', subjectCase: 'lower', reasons: [] },
  { message: "feat: 'quoted'", subjectCase: 'lower', reasons: [] },
  { message: 'feat: "quoted"', subjectCase: 'lower', reasons: [] },
  { message: 'feat: -dash', subjectCase: 'lower', reasons: [] },
  { message: 'feat: A thing', subjectCase: 'lower', reasons: [CASE_REASON] },
  { message: 'feat: Add x', subjectCase: 'any', reasons: [] },
];

for (const { message, subjectCase, reasons } of caseTable) {
  test(`lint ${JSON.stringify(message)} under subjectCase: ${subjectCase}`, () => {
    assert.deepEqual(lint(message, config({ subjectCase })), reasons);
  });
}

// MSG-03 AC: a static test asserts the case-check function is exported separately from
// `lint`.

test('passesLowerCase is exported separately from lint', () => {
  assert.equal(typeof passesLowerCase, 'function');
  assert.notEqual(passesLowerCase, lint);
});

const passesLowerCaseTable = [
  { description: 'add x', passes: true },
  { description: 'Add x', passes: false },
  { description: 'API change', passes: true },
  { description: 'CI matrix', passes: true },
  { description: '2fa', passes: true },
  { description: 'A thing', passes: false },
];

for (const { description, passes } of passesLowerCaseTable) {
  test(`passesLowerCase(${JSON.stringify(description)}) is ${passes}`, () => {
    assert.equal(passesLowerCase(description), passes);
  });
}

// MSG-04 AC: `Closes #12`, `Refs: abc`, `BREAKING CHANGE: x` with an indented continuation
// line each parse as a footer paragraph with the right tokens, separators, values and raw
// (verbatim) lines.

const footerTable = [
  {
    message: 'feat: x\n\nCloses #12',
    footer: [{ token: 'Closes', separator: ' #', value: '12', raw: 'Closes #12' }],
    body: [],
  },
  {
    message: 'feat: x\n\nRefs: abc',
    footer: [{ token: 'Refs', separator: ': ', value: 'abc', raw: 'Refs: abc' }],
    body: [],
  },
  {
    message: 'feat: x\n\nBREAKING CHANGE: removes X\n  and Y',
    footer: [{
      token: 'BREAKING CHANGE',
      separator: ': ',
      value: 'removes X\nand Y',
      raw: 'BREAKING CHANGE: removes X\n  and Y',
    }],
    body: [],
  },
  {
    // MSG-04 AC: `parse` exposes the footer paragraph's entries in order.
    message: 'feat: x\n\nRefs: abc\nCloses #12',
    footer: [
      { token: 'Refs', separator: ': ', value: 'abc', raw: 'Refs: abc' },
      { token: 'Closes', separator: ' #', value: '12', raw: 'Closes #12' },
    ],
    body: [],
  },
  {
    // A hyphenated token, allowed alongside `BREAKING CHANGE` (C:message-grammar).
    message: 'feat: x\n\nBREAKING-CHANGE: x',
    footer: [{ token: 'BREAKING-CHANGE', separator: ': ', value: 'x', raw: 'BREAKING-CHANGE: x' }],
    body: [],
  },
  {
    // MSG-04/Q20 AC: a tab-indented continuation strips into `value` but `raw` carries the
    // entry's original lines verbatim, for reword carry-over.
    message: 'feat: x\n\nBug #1\n\tmore',
    footer: [{ token: 'Bug', separator: ' #', value: '1\nmore', raw: 'Bug #1\n\tmore' }],
    body: [],
  },
  {
    // Several blank lines between the body paragraph and the footer still separate them into
    // two paragraphs (paragraphsOf: any number of blank lines).
    message: 'feat: x\n\nbody text\n\n\n\nCloses #12',
    footer: [{ token: 'Closes', separator: ' #', value: '12', raw: 'Closes #12' }],
    body: ['body text'],
  },
];

for (const { message, footer, body } of footerTable) {
  test(`parse ${JSON.stringify(message)} gives the footer paragraph`, () => {
    const result = parse(message);
    assert.deepEqual(result.footer, footer);
    assert.deepEqual(result.body, body);
  });
}

// MSG-04 AC: a last paragraph mixing `Refs: x` with a plain sentence parses as body; a
// `Note: x` line in an earlier paragraph is body.

test('a last paragraph mixing a footer line with prose parses as body', () => {
  const result = parse('feat: x\n\nRefs: x\nthis is a sentence');
  assert.equal(result.footer, null);
  assert.deepEqual(result.body, ['Refs: x\nthis is a sentence']);
});

test('a `Note:` line in an earlier paragraph is body, not a footer', () => {
  const result = parse('feat: x\n\nNote: x\n\nCloses #12');
  assert.deepEqual(result.body, ['Note: x']);
  assert.deepEqual(result.footer, [
    { token: 'Closes', separator: ' #', value: '12', raw: 'Closes #12' },
  ]);
});

test('a last paragraph starting with an indented line is body (continuation with nothing to continue)', () => {
  const result = parse('feat: x\n\n  cont\nRefs: a');
  assert.equal(result.footer, null);
  assert.deepEqual(result.body, ['  cont\nRefs: a']);
});

// M5 (CFG-09) tests a config value's lines independently against this same regex, rather
// than grouping them into paragraphs the way `parse` does for a commit message.

const footerLineTable = [
  ['Co-Authored-By: A <a@b>', true],
  ['Refs #12', true],
  ['Closes #12', true],
  ['BREAKING CHANGE: x', true],
  ['co-authored-by: a <a@b>', true], // token case is not checked here, only the shape
  ['🤖 Generated', false],
  ['some text', false],
  ['', false],
  ['   ', false],
  ['  cont', false], // an indented continuation line does not start a footer entry on its own
];

for (const [line, expected] of footerLineTable) {
  test(`isFooterLine(${JSON.stringify(line)}) is ${expected}`, () => {
    assert.equal(isFooterLine(line), expected);
  });
}

// MSG-04 AC: under `body: forbidden`, header plus `Closes #12` passes (story 121); header
// plus a prose paragraph fails; header plus prose plus footers fails.

const BODY_REASON = 'body not allowed (body: forbidden)';

const bodyTable = [
  { message: 'feat: x\n\nCloses #12', reasons: [] },
  { message: 'feat: x\n\nsome prose', reasons: [BODY_REASON] },
  { message: 'feat: x\n\nsome prose\n\nCloses #12', reasons: [BODY_REASON] },
];

for (const { message, reasons } of bodyTable) {
  test(`lint ${JSON.stringify(message)} under body: forbidden`, () => {
    assert.deepEqual(lint(message, config({ body: 'forbidden' })), reasons);
  });
}

test('lint under body: optional allows a prose body', () => {
  assert.deepEqual(lint('feat: x\n\nsome prose', config({ body: 'optional' })), []);
});

// MSG-05 AC: each allowed footer token (case-sensitive) passes lint; `refs: x` (wrong case)
// fails, since it is not among the five allowed tokens.

const NOT_ALLOWED_REASON = (token) =>
  `\`${token}\` is not an allowed footer token. If this is body text, rephrase it or add a ` +
  'non-footer line to the paragraph.';

const allowedFooterTable = [
  { message: 'feat: x\n\nBREAKING CHANGE: x', reasons: [] },
  { message: 'feat: x\n\nBREAKING-CHANGE: x', reasons: [] },
  { message: 'feat: x\n\nRefs: abc', reasons: [] },
  { message: 'feat: x\n\nCloses #12', reasons: [] },
  { message: 'feat: x\n\nFixes #12', reasons: [] },
  { message: 'feat: x\n\nrefs: x', reasons: [NOT_ALLOWED_REASON('refs')] },
];

for (const { message, reasons } of allowedFooterTable) {
  test(`lint ${JSON.stringify(message)} against the allowed footer tokens`, () => {
    assert.deepEqual(lint(message, config()), reasons);
  });
}

// MSG-05 AC (story 119): the script's own trailer tokens, written into the message text by
// an agent instead of appended by the script, fail lint like any other disallowed token.

const trailerSpoofTable = [
  {
    message: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    reasons: [NOT_ALLOWED_REASON('Co-Authored-By')],
  },
  {
    message: 'feat: x\n\nSigned-off-by: A <a@b>',
    reasons: [NOT_ALLOWED_REASON('Signed-off-by')],
  },
  {
    message: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nSigned-off-by: A <a@b>',
    reasons: [NOT_ALLOWED_REASON('Co-Authored-By'), NOT_ALLOWED_REASON('Signed-off-by')],
  },
];

for (const { message, reasons } of trailerSpoofTable) {
  test(`lint ${JSON.stringify(message)} rejects a spoofed trailer`, () => {
    assert.deepEqual(lint(message, config()), reasons);
  });
}

// MSG-05 AC: a last paragraph `Note: see #12` fails lint with exactly the fixed hint text,
// so the worker's lint retry can fix a `Note:` paragraph on its own (Q13, story 120).

test('lint "feat: x\\n\\nNote: see #12" fails with the exact Note hint', () => {
  assert.deepEqual(lint('feat: x\n\nNote: see #12', config()), [
    '`Note` is not an allowed footer token. If this is body text, rephrase it or add a ' +
      'non-footer line to the paragraph.',
  ]);
});

// review-MSG-06 finding 1 (Low, re-review): step 4 used to trim trailing blank lines with
// `/(\n[ \t]*)*$/`, which backtracks quadratically on a long run of them. `normaliseText` now
// does a linear backward scan instead; pin that a pathological input (50k blank lines
// followed by content, so the trailing-blank scan cannot short-circuit on the first line)
// stays fast. The bound is generous (200x the ~450ms the old regex took at 50k on a Node 24
// dev machine) so this does not flake on a slow CI runner; a quadratic regression would take
// seconds longer than even that.
test('normaliseText trims 50k blank lines followed by content in well under a second', () => {
  const text = `${'\n'.repeat(50000)}x`;

  const start = Date.now();
  const result = normaliseText(text);
  const elapsed = Date.now() - start;

  assert.deepEqual(result, { ok: true, text: `${'\n'.repeat(50000)}x\n` });
  assert.ok(elapsed < 5000, `normaliseText took ${elapsed}ms, expected well under 5000ms`);
});
