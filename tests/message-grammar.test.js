'use strict';

// M6 message grammar, Seam 3 (in-process, table-driven) against C:message-grammar.

const { test, before } = require('node:test');
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

before(async () => {
  ({ parse, lint, passesLowerCase } = await loadLib('message-grammar'));
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

  test(`lint ${JSON.stringify(message)} lints clean under scope: optional`, () => {
    assert.deepEqual(lint(message, config({ scope: 'optional' })), []);
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
// line each parse as a footer paragraph with the right tokens and values.

const footerTable = [
  {
    message: 'feat: x\n\nCloses #12',
    footer: [{ token: 'Closes', value: '12' }],
    body: [],
  },
  {
    message: 'feat: x\n\nRefs: abc',
    footer: [{ token: 'Refs', value: 'abc' }],
    body: [],
  },
  {
    message: 'feat: x\n\nBREAKING CHANGE: removes X\n  and Y',
    footer: [{ token: 'BREAKING CHANGE', value: 'removes X\nand Y' }],
    body: [],
  },
  {
    // MSG-04 AC: `parse` exposes the footer paragraph's entries in order.
    message: 'feat: x\n\nRefs: abc\nCloses #12',
    footer: [{ token: 'Refs', value: 'abc' }, { token: 'Closes', value: '12' }],
    body: [],
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
  assert.deepEqual(result.footer, [{ token: 'Closes', value: '12' }]);
});

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
