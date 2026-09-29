'use strict';

// M7 glob matcher, Seam 3 (in-process, table-driven) against C:scanignore-globs.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let compileGlob;
let matches;

before(async () => {
  ({ compileGlob, matches } = await loadLib('glob-matcher'));
});

function compiled(pattern) {
  const result = compileGlob(pattern);
  assert.equal(result.ok, true, `${pattern} compiles`);
  return result.matcher;
}

// C:scanignore-globs rows `*` and "anything else" (literal). SCN-01 AC: `tests/*.json`
// matches `tests/a.json`, not `tests/x/a.json`; `a+b.txt` matches itself only;
// `Tests/a.json` does not match `tests/*.json` (case-sensitive on every OS). The other rows
// pin the whole-path match and `*` as any run of characters within one segment, none
// included.
const table = [
  {
    pattern: 'tests/*.json',
    match: ['tests/a.json', 'tests/.json', 'tests/a.b.json'],
    noMatch: [
      'tests/x/a.json', 'Tests/a.json', 'tests/a.JSON', 'tests/a.json/b', 'x/tests/a.json',
      'tests/a.jsonx', 'tests', 'tests/',
    ],
  },
  {
    pattern: 'a+b.txt',
    match: ['a+b.txt'],
    noMatch: [
      'aab.txt', 'aaab.txt', 'A+B.txt', 'a+b.txtx', 'xa+b.txt', 'x/a+b.txt', 'a+b.txt/x',
      'a+bxtxt', '',
    ],
  },
  { pattern: 'docs/(x)^$|.md', match: ['docs/(x)^$|.md'], noMatch: ['docs/x.md', 'docs/(x)^$|.mdx'] },
  { pattern: '*.json', match: ['a.json', '.json'], noMatch: ['a/b.json', 'a.json/', 'json'] },
  { pattern: '*/*.md', match: ['docs/a.md', 'x/.md'], noMatch: ['a.md', 'docs/x/a.md'] },
  { pattern: 'src/*.test.*', match: ['src/a.test.js', 'src/.test.'], noMatch: ['src/a.test', 'src/atest.js'] },
  {
    pattern: 'a*b*c',
    match: ['abc', 'aXbYc', 'abbc', 'abcbc'],
    noMatch: ['ac', 'acb', 'abcx', 'a/b/c', 'ab/c'],
  },
  { pattern: 'a*bc*c', match: ['abcc', 'aXbcYc'], noMatch: ['abc', 'abcb'] },
  { pattern: 'ab*ba', match: ['abba', 'abXba'], noMatch: ['aba', 'ab', 'ba'] },
  { pattern: '*a*a*', match: ['aa', 'xaya', 'aaa'], noMatch: ['a', 'xay', ''] },
  { pattern: '*.PEM', match: ['KEY.PEM'], noMatch: ['key.pem', 'KEY.pem'] },
];

for (const { pattern, match, noMatch } of table) {
  for (const path of match) {
    test(`${pattern} matches ${JSON.stringify(path)}`, () => {
      assert.equal(matches(compiled(pattern), path), true);
    });
  }
  for (const path of noMatch) {
    test(`${pattern} does not match ${JSON.stringify(path)}`, () => {
      assert.equal(matches(compiled(pattern), path), false);
    });
  }
}

test('one compiled matcher serves many paths', () => {
  const matcher = compiled('tests/*.json');
  assert.deepEqual(
    ['tests/a.json', 'tests/x/a.json', 'tests/b.json'].map((path) => matches(matcher, path)),
    [true, false, true],
  );
});

test('the glob matcher source does no I/O and reads no ambient state', () => {
  // M7 has no dependencies in the module map (docs/spec/modules.md): no imports allowed.
  assertPureSource('glob-matcher');
});
