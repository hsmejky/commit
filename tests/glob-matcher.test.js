'use strict';

// M7 glob matcher, Seam 3 (in-process, table-driven) against C:scanignore-globs.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { libPath, loadLib } = require('./helpers/load-lib');
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
  // Row `?`: exactly one character except `/`.
  {
    pattern: 'a?.txt',
    match: ['ab.txt', 'a?.txt', 'a*.txt', 'a..txt'],
    noMatch: ['a/.txt', 'a.txt', 'abc.txt', 'b?.txt', 'ab.txtx', 'x/ab.txt'],
  },
  // `?` stands for one UTF-16 code unit, the unit comparison uses throughout: an astral
  // character (two code units) takes `??`.
  { pattern: 'a?.txt', match: [], noMatch: ['a\u{1F600}.txt'] },
  { pattern: 'a??.txt', match: ['a\u{1F600}.txt', 'a\u00e9x.txt'], noMatch: ['a\u00e9.txt'] },
  { pattern: '*?b?', match: ['xbz', 'ab?', 'aaabb'], noMatch: ['bz', 'ab', 'a/bz', 'abzz'] },
  // Row `**`: zero or more whole segments, as a whole segment only.
  {
    pattern: 'tests/**/key.pem',
    match: ['tests/key.pem', 'tests/a/key.pem', 'tests/a/b/key.pem'],
    noMatch: [
      'testskey.pem', 'tests/akey.pem', 'x/tests/key.pem', 'tests/a/key.pem/x', 'tests',
      'key.pem', 'tests/a/b/key.pemx',
    ],
  },
  { pattern: '**/key.pem', match: ['key.pem', 'a/key.pem', 'a/b/key.pem'], noMatch: ['akey.pem', 'a/key.pemx'] },
  {
    pattern: 'a/**/b/**/c',
    match: ['a/b/c', 'a/x/b/y/c', 'a/b/b/c', 'a/b/x/b/c', 'a/x/y/b/c'],
    noMatch: ['a/c', 'a/b', 'a/bc', 'a/x/c', 'b/c', 'a/b/c/x'],
  },
  {
    pattern: 'a/**/b/c/**/d',
    match: ['a/b/c/d', 'a/b/b/c/d', 'a/b/x/b/c/d', 'a/b/c/b/c/d'],
    noMatch: ['a/b/d', 'a/c/b/d', 'a/b/x/c/d'],
  },
  { pattern: 'a/**/*.pem', match: ['a/k.pem', 'a/x/y/k.pem'], noMatch: ['a.pem', 'a/k.pem/x', 'b/k.pem'] },
  // Row trailing `/`: everything under that directory, same as `dir/**`; so a trailing `**`
  // takes one or more segments, never the directory path itself.
  ...['tests/fixtures/', 'tests/fixtures/**'].map((pattern) => ({
    pattern,
    match: ['tests/fixtures/a/b.txt', 'tests/fixtures/a.txt', 'tests/fixtures/fixtures'],
    noMatch: ['tests/fixtures', 'tests/fixturesx/a.txt', 'tests/a.txt', 'x/tests/fixtures/a.txt'],
  })),
  { pattern: 'a/**/b/**', match: ['a/b/c', 'a/x/b/c/d'], noMatch: ['a/b', 'a/x/b', 'b/c'] },
  { pattern: 'src/*/', match: ['src/a/b.js', 'src/a/b/c.js'], noMatch: ['src/a', 'src/b.js'] },
  // Row leading `/`: stripped; patterns are always relative to the repo root.
  { pattern: '/docs/*.md', match: ['docs/a.md'], noMatch: ['x/docs/a.md', '/docs/a.md', 'docs/x/a.md'] },
  { pattern: '/tests/fixtures/', match: ['tests/fixtures/a.txt'], noMatch: ['tests/fixtures', 'x/tests/fixtures/a.txt'] },
  // SCN-03 AC: a broad but literal pattern (only one segment is a bare `**`) stays legal.
  { pattern: 'src/**', match: ['src/a.txt', 'src/a/b.txt'], noMatch: ['src', 'srcx/a.txt', 'x/src/a.txt'] },
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

// SCN-03: config errors (C:scanignore-globs errors, Q6, Q10, M7). One fixture per error;
// `compileGlob` returns the M7 failure shape `{ ok: false, code: 'config' }` and builds no
// matcher. SCN-02 review: a bare `/`, `//` and `a//b` produce an empty segment, folded into
// the same error family (C:scanignore-globs amended).
const configErrors = [
  { label: '`**` inside a segment', pattern: 'a**b' },
  { label: 'braces', pattern: 'a{b,c}.txt' },
  { label: 'a character class', pattern: 'a[bc].txt' },
  { label: 'a leading `!`', pattern: '!a.txt' },
  { label: 'a backslash', pattern: 'a\\b.txt' },
  { label: 'an empty pattern', pattern: '' },
  { label: 'a `..` segment', pattern: 'a/../b.txt' },
  { label: 'no literal character: `**`', pattern: '**' },
  { label: 'no literal character: `**/*`', pattern: '**/*' },
  { label: 'no literal character: `**/?*`', pattern: '**/?*' },
  { label: 'no literal character: `*/**`', pattern: '*/**' },
  { label: 'no literal character: `/**`', pattern: '/**' },
  { label: 'an empty segment: `/`', pattern: '/' },
  { label: 'an empty segment: `//`', pattern: '//' },
  { label: 'an empty segment: `a//b`', pattern: 'a//b' },
];

for (const { label, pattern } of configErrors) {
  test(`${label} (${JSON.stringify(pattern)}) is a config error`, () => {
    const result = compileGlob(pattern);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'config');
    assert.equal('matcher' in result, false);
  });
}

test('one compiled matcher serves many paths', () => {
  const matcher = compiled('tests/*.json');
  assert.deepEqual(
    ['tests/a.json', 'tests/x/a.json', 'tests/b.json'].map((path) => matches(matcher, path)),
    [true, false, true],
  );
});

// Linear time (M7). Each case is a worst case for a backtracking matcher: many wildcard
// pieces that all fit early, then a last piece that fits nowhere, so a backtracker retries
// every placement of every piece (exponential), and a matcher that retries even one piece
// at every place is quadratic in the path: about 5e11 steps at this size, over a minute
// even when the inner scan is a native `indexOf`. The leftmost scan takes milliseconds; the
// bound leaves slow CI runners a wide margin. Each case runs in a worker killed at a
// deadline, so a blowup fails instead of hanging.
const LONG = 1_000_000;
const BOUND_MS = 2_000;
const DEADLINE_MS = 20_000;

const worstCases = [
  { name: 'many `*` pieces in one long segment', pattern: `${'*a'.repeat(40)}*b*`, path: 'a'.repeat(LONG) },
  { name: 'many `*?` pieces in one long segment', pattern: `${'*a?'.repeat(40)}*b?*`, path: 'a'.repeat(LONG) },
  {
    name: 'many `**` segments over a long path',
    pattern: `${'**/a/'.repeat(40)}**/b/**`,
    path: `${'a/'.repeat(LONG / 2)}c`,
  },
];

function timeInWorker(pattern, path) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then(({ compileGlob, matches }) => {
      const { matcher } = compileGlob(workerData.pattern);
      const started = performance.now();
      const result = matches(matcher, workerData.path);
      parentPort.postMessage({ result, ms: performance.now() - started });
    });`;
  const url = pathToFileURL(libPath('glob-matcher')).href;
  const worker = new Worker(source, { eval: true, workerData: { url, pattern, path } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`no result within ${DEADLINE_MS} ms`));
    }, DEADLINE_MS);
    worker.once('message', (message) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

for (const { name, pattern, path } of worstCases) {
  test(`linear time: ${name}`, async () => {
    const { result, ms } = await timeInWorker(pattern, path);
    assert.equal(result, false);
    assert.ok(ms < BOUND_MS, `took ${ms.toFixed(1)} ms, bound ${BOUND_MS} ms`);
  });
}

test('the glob matcher source does no I/O and reads no ambient state', () => {
  // M7 has no dependencies in the module map (docs/spec/modules.md): no imports allowed.
  assertPureSource('glob-matcher');
});
