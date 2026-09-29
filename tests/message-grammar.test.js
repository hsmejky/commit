'use strict';

// M6 message grammar, Seam 3 (in-process, table-driven) against C:message-grammar.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath, loadLib } = require('./helpers/load-lib');

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

before(async () => {
  ({ parse, lint } = await loadLib('message-grammar'));
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
  const source = readFileSync(libPath('message-grammar'), 'utf8');
  const forbidden = [
    [/^\s*import\b/m, 'a static import'],
    [/\bimport\s*\(/, 'a dynamic import'],
    [/\brequire\s*\(/, 'require'],
    [/\bprocess\b/, 'process'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bDate\b/, 'the clock'],
    [/\bMath\.random\b/, 'randomness'],
    [/\bconsole\b/, 'console'],
  ];
  for (const [pattern, what] of forbidden) {
    assert.doesNotMatch(source, pattern, `message-grammar.mjs must not use ${what}`);
  }
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
