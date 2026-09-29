'use strict';

// M8 scanner, Seam 3 (in-process, table-driven) against C:scan-patterns. The test source
// must hold no literal hit (Q10): token strings are built at run time or loaded from
// `tests/fixtures/scan-patterns/`, which the repo's own scan ignores.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readdirSync, readFileSync } = require('node:fs');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let scanText;
let scanUnits;
let PATTERNS;
let createScanner;

before(async () => {
  ({ scanText, scanUnits, PATTERNS, createScanner } = await loadLib('scanner'));
});

// A `ghp_` token built at run time, so this file's own text holds no hit.
function githubToken(fill = 'x') {
  return 'gh' + 'p_' + fill.repeat(36);
}

// A unit record as M10 produces it (only the fields M8 reads).
function textUnit(unitPath, addedLines) {
  return { path: unitPath, oldPath: null, status: 'M', kind: 'text', addedLines };
}

test('scanUnits: a github-token added line is one hit with pattern ID, path and line', () => {
  const token = githubToken();
  const units = [
    textUnit('src/config.js', [
      { line: 3, text: 'const a = 1;' },
      { line: 14, text: `const token = "${token}";` },
    ]),
  ];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'src/config.js', line: 14 }],
    skipped: [],
  });
  assert.ok(!JSON.stringify(result).includes(token), 'the result holds the matched value');
  assert.ok(!JSON.stringify(result).includes(token.slice(4)), 'the result holds part of the value');
});

// Fixture cases: `<id>.positive.txt` lines each hold exactly one hit of `<id>`,
// `<id>.negative.txt` lines hold none; `#` lines are comments. Rows are counted per ID, so
// another row also hitting a line (e.g. `generic-secret` on `GH_TOKEN=…`) changes nothing.
const FIXTURES = path.join(__dirname, 'fixtures', 'scan-patterns');

function fixtureLines(file) {
  return readFileSync(path.join(FIXTURES, file), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('#'));
}

for (const file of readdirSync(FIXTURES).sort()) {
  const match = /^(.+)\.(positive|negative)\.txt$/.exec(file);
  if (match === null) continue;
  const [, patternId, kind] = match;
  fixtureLines(file).forEach((line, index) => {
    test(`fixture ${file} case ${index + 1}: ${kind === 'positive' ? 'one hit' : 'no hit'}`, () => {
      const ofRow = scanText(line, { osUser: null }).filter((hit) => hit.patternId === patternId);
      assert.equal(ofRow.length, kind === 'positive' ? 1 : 0);
    });
  });
}

test('every fixture file names a pattern ID of the table, with both a positive and a negative', () => {
  const files = readdirSync(FIXTURES);
  for (const { id } of PATTERNS) {
    assert.ok(files.includes(`${id}.positive.txt`), `${id} has a positive fixture`);
    assert.ok(files.includes(`${id}.negative.txt`), `${id} has a negative fixture`);
  }
  const ids = new Set(PATTERNS.map(({ id }) => id));
  for (const file of files) {
    const match = /^(.+)\.(positive|negative)\.txt$/.exec(file);
    if (match !== null) assert.ok(ids.has(match[1]), `${file} names a pattern ID of the table`);
  }
});

test('scanText: UTF-16 offsets into the whole text, end exclusive', () => {
  const token = githubToken();
  // The emoji is two UTF-16 code units; the message spans lines.
  const before = 'feat: add \u{1F511} rotation\n\nold é token was ';
  const text = `${before}${token} here\n${token}`;

  const hits = scanText(text, { osUser: null });

  const secondStart = text.length - token.length;
  assert.deepEqual(hits, [
    { patternId: 'github-token', start: before.length, end: before.length + token.length },
    { patternId: 'github-token', start: secondStart, end: text.length },
  ]);
  for (const { start, end } of hits) assert.equal(text.slice(start, end), token);
  assert.ok(!JSON.stringify(hits).includes(token), 'the result holds the matched value');
});

test('scanText of a text with no hit is empty', () => {
  assert.deepEqual(scanText('fix: rotate the deploy key\n\nNo secret here.', { osUser: null }), []);
});

// Overlapping hits need two rows whose matches overlap; the built-in table holds one row
// for now, so these engine rules run over the real `github-token` row plus a test row.
function withAssignmentRow(notHit = null) {
  const githubRow = PATTERNS.find(({ id }) => id === 'github-token');
  const assignmentRow = { id: 'test-assignment', regex: /TOKEN=\S+/, notHit, source: 'test' };
  return createScanner([githubRow, assignmentRow]);
}

test('scanText: two overlapping hits stay two entries, ordered by start', () => {
  const token = githubToken();
  const text = `export GH_TOKEN=${token}`;

  const hits = withAssignmentRow().scanText(text, { osUser: null });

  const tokenStart = text.indexOf(token);
  assert.deepEqual(hits, [
    { patternId: 'test-assignment', start: text.indexOf('TOKEN='), end: text.length },
    { patternId: 'github-token', start: tokenStart, end: tokenStart + token.length },
  ]);
});

test('scanUnits: two rows hitting one line are two hits at that line', () => {
  const units = [textUnit('.env', [{ line: 1, text: `GH_TOKEN=${githubToken()}` }])];

  const { hits } = withAssignmentRow().scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(hits, [
    { patternId: 'test-assignment', path: '.env', line: 1 },
    { patternId: 'github-token', path: '.env', line: 1 },
  ]);
});

test('a row whose false-positive rule holds for the value is not a hit', () => {
  const placeholder = (match) => match[0].endsWith('=changeme');
  const hits = withAssignmentRow(placeholder).scanText('TOKEN=changeme\nTOKEN=s3cr3t-value', {
    osUser: null,
  });
  assert.deepEqual(hits, [{ patternId: 'test-assignment', start: 15, end: 33 }]);
});

test('a false-positive rule receives the full match, so it can read a capture group', () => {
  // The row's own value lives in a capture group, not the whole match (`KEY=<value>`).
  const captureRow = {
    id: 'test-capture',
    regex: /KEY=(\S+)/,
    notHit: (match) => match[1] === 'placeholder',
    source: 'test',
  };
  const scanner = createScanner([captureRow]);

  const hits = scanner.scanText('KEY=placeholder\nKEY=real-value', { osUser: null });

  assert.deepEqual(hits, [
    { patternId: 'test-capture', start: 16, end: 30 },
  ]);
});

test('scanUnits: hits in unit order, then line order; one hit per pattern and line', () => {
  const token = githubToken();
  const units = [
    textUnit('a.js', [{ line: 7, text: `x = ["${token}", "${githubToken('y')}"]` }]),
    textUnit('b.js', [
      { line: 2, text: 'nothing' },
      { line: 5, text: token },
      { line: 9, text: `  ${token}` },
    ]),
  ];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result.hits, [
    { patternId: 'github-token', path: 'a.js', line: 7 },
    { patternId: 'github-token', path: 'b.js', line: 5 },
    { patternId: 'github-token', path: 'b.js', line: 9 },
  ]);
  assert.ok(!JSON.stringify(result).includes(token), 'the result holds the matched value');
});

test('scanUnits of units with no hit reports no hits and no skipped files', () => {
  const units = [textUnit('README.md', [{ line: 1, text: 'See ghp_ prefixed tokens.' }])];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }), { hits: [], skipped: [] });
});

test('this test source holds no literal hit', () => {
  assert.deepEqual(scanText(readFileSync(__filename, 'utf8'), { osUser: null }), []);
});

test('scanner.mjs is pure', () => {
  assertPureSource('scanner');
});
