'use strict';

// M8 scanner, Seam 3 (in-process, table-driven) against C:scan-patterns. The test source
// must hold no literal hit (Q10): token strings are built at run time or loaded from
// `tests/fixtures/scan-patterns/`, which the repo's own scan ignores.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readdirSync, readFileSync } = require('node:fs');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let scanText;
let scanUnits;
let PATTERNS;
let createScanner;

beforeEach(async () => {
  ({ scanText, scanUnits, PATTERNS, createScanner } = await loadLib('scanner'));
});

// A `ghp_` token built at run time, so this file's own text holds no hit. Callers pass the
// fill explicitly: assigning a call with no argument would itself read as a `generic-secret`
// value, while the quote in `githubToken('x')` ends the unquoted value too early.
function githubToken(fill = 'x') {
  return 'gh' + 'p_' + fill.repeat(36);
}

// A unit record as M10 produces it (only the fields M8 reads).
function textUnit(unitPath, addedLines) {
  return { path: unitPath, oldPath: null, status: 'M', kind: 'text', addedLines };
}

test('scanUnits: a github-token added line is one hit with pattern ID, path and line', () => {
  const token = githubToken('x');
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

// Multi-line cases: each `<id>/<positive|negative>-<name>.txt` is one case, scanned whole as
// the added lines of one unit and as a commit message; a positive holds exactly one hit of
// `<id>`, a negative none (the `private-key` body rule looks past the header's line).
for (const entry of readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const patternId = entry.name;
  for (const file of readdirSync(path.join(FIXTURES, patternId)).sort()) {
    const match = /^(positive|negative)-.+\.txt$/.exec(file);
    if (match === null) continue;
    const expected = match[1] === 'positive' ? 1 : 0;
    const lines = readFileSync(path.join(FIXTURES, patternId, file), 'utf8').split(/\r?\n/);

    test(`fixture ${patternId}/${file} as added lines: ${expected ? 'one hit' : 'no hit'}`, () => {
      const units = [textUnit('key.pem', lines.map((text, index) => ({ line: index + 1, text })))];
      const { hits } = scanUnits(units, { scanIgnore: [], osUser: null });
      assert.equal(hits.filter((hit) => hit.patternId === patternId).length, expected);
    });

    test(`fixture ${patternId}/${file} as a message: ${expected ? 'one hit' : 'no hit'}`, () => {
      const hits = scanText(`chore: rotate the key\n\n${lines.join('\n')}`, { osUser: null });
      assert.equal(hits.filter((hit) => hit.patternId === patternId).length, expected);
    });
  }
}

test('private-key: a header hit reports the header line, not the body line', () => {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const units = [
    textUnit('key.pem', [
      { line: 10, text: header },
      { line: 11, text: 'Proc-Type: 4,ENCRYPTED' },
      { line: 12, text: 'A'.repeat(64) },
    ]),
  ];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, [
    { patternId: 'private-key', path: 'key.pem', line: 10 },
  ]);
});

test('private-key: the body rule reads added lines of the same unit only', () => {
  // Both units share a path: the isolation is per unit object, not merely per distinct path.
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const units = [
    textUnit('key.pem', [{ line: 1, text: header }]),
    textUnit('key.pem', [{ line: 1, text: 'A'.repeat(64) }]),
  ];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, []);
});

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

// The contract's own regex table, scanned as added lines of a unit, is no hit for any row:
// the illegal-character rule keeps `local-path` from matching its own regexes (Q10).
test('the regex table of C:scan-patterns scanned as added lines is no hit', () => {
  const contract = path.join(__dirname, '..', 'docs', 'contracts', 'scan-patterns.md');
  const addedLines = readFileSync(contract, 'utf8')
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.startsWith('|'));
  assert.ok(addedLines.length > PATTERNS.length, 'the table rows were read');

  const result = scanUnits([textUnit('docs/contracts/scan-patterns.md', addedLines)], {
    scanIgnore: [],
    osUser: null,
  });

  assert.deepEqual(result.hits, []);
});

test('scanText: UTF-16 offsets into the whole text, end exclusive', () => {
  const token = githubToken('x');
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
  const token = githubToken('x');
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
  const token = githubToken('x');
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

// `local-path` OS-user segment (SCN-11): the OS user name as a whole path segment in any
// path. Paths the fixed shapes would catch are built at run time, so this file holds no hit.
function localPathHits(text, osUser) {
  return scanText(text, { osUser }).filter(({ patternId }) => patternId === 'local-path');
}

const OS_USER_SEGMENT_CASES = [
  // [case, osUser, text, hit]
  ['a name of 4 or more characters in any path', 'jdoe1', '/srv/jdoe1/x', true],
  ['a Windows path with backslashes', 'jdoe1', 'D:\\work\\jdoe1\\repo', true],
  ['a name compared case-insensitively', 'jdoe1', '/srv/JDoe1/x', true],
  ['a name holding a space', 'Jane Fixture', 'D:\\work\\Jane Fixture\\repo', true],
  ['a longer segment is not the name', 'jdoe1', '/srv/jdoe12/x', false],
  ['a segment without a trailing separator', 'jdoe1', 'see /srv/jdoe1', false],
  ['the name inside a word, not a segment', 'jdoe1', 'jdoe1 and x-jdoe1-y', false],
  ['a service user: dev', 'dev', '/srv/dev/x', false],
  ['a service user: runner', 'runner', '/srv/runner/x', false],
  ['a service user compared case-insensitively', 'Runner', '/srv/Runner/x', false],
  ['a 3-character name that is not a service user', 'bob', '/srv/bob/x', false],
  ['an OS user holding an illegal character', 'jdoe(1)', '/srv/jdoe(1)/x', false],
  ['no OS user', null, '/srv/jdoe1/x', false],
];

for (const [name, osUser, text, hit] of OS_USER_SEGMENT_CASES) {
  test(`local-path OS-user segment: ${name} → ${hit ? 'hit' : 'no hit'}`, () => {
    assert.equal(localPathHits(text, osUser).length, hit ? 1 : 0);
  });
}

test('local-path OS-user segment: the hit spans the separator and the name', () => {
  const text = 'cd /srv/jdoe1/x';
  assert.deepEqual(localPathHits(text, 'jdoe1'), [
    { patternId: 'local-path', start: 7, end: 13 },
  ]);
});

test('local-path with osUser null: the fixed shapes still hit', () => {
  const home = '/ho' + 'me/jdoe-fixture/app';
  const drive = 'C:' + '\\Users\\jdoe-fixture\\src';
  assert.equal(localPathHits(home, null).length, 1);
  assert.equal(localPathHits(drive, null).length, 1);
});

test('scanUnits: a line both a fixed shape and the OS-user segment match is one hit', () => {
  const units = [textUnit('Dockerfile', [{ line: 4, text: 'WORKDIR /ho' + 'me/jdoe1/app' }])];
  const { hits } = scanUnits(units, { scanIgnore: [], osUser: 'jdoe1' });
  assert.deepEqual(hits, [{ patternId: 'local-path', path: 'Dockerfile', line: 4 }]);
});

test('scanText: a path matched by both a fixed shape and the OS-user segment gives two overlapping spans', () => {
  const text = 'WORKDIR /ho' + 'me/jdoe1/app';
  assert.deepEqual(localPathHits(text, 'jdoe1'), [
    { patternId: 'local-path', start: 8, end: 19 },
    { patternId: 'local-path', start: 13, end: 19 },
  ]);
});

// `generic-secret` entropy rule (SCN-09): Shannon entropy in bits per character, a hit from
// 3.5. 11 equally frequent characters give log2(11) ≈ 3.46, 12 give log2(12) ≈ 3.58.
const ENTROPY_CASES = [
  // [case, value, hit]
  ['11 distinct characters, twice', 'abcdefghijk'.repeat(2), false],
  ['12 distinct characters', 'abcdefghijkl', true],
  ['12 distinct characters, quoted', '"abcdefghijkl"', true],
  ['one repeated character', 'q'.repeat(40), false],
];

for (const [name, value, hit] of ENTROPY_CASES) {
  test(`generic-secret entropy: ${name} → ${hit ? 'hit' : 'no hit'}`, () => {
    const line = ['API_KEY', value].join('=');
    const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
    assert.equal(hits.length, hit ? 1 : 0);
  });
}

// `generic-secret` call rule (fix for SCN-09): an unquoted value that is a call is not a hit,
// since it reads a secret rather than holding one; the quoted branch is unaffected. Each case
// below is a full line, not built at run time, since every one is a negative (no hit either
// way, so no literal secret shape reaches the source).
const CALL_CASES = [
  // [case, line, hit]
  ['unquoted call with no arguments', 'const token = fetchAccessToken();', false],
  ['unquoted snake_case call', 'password = get_password_from_env()', false],
  ['unquoted dotted method call with an argument', 'token = self._fetch_token(scope)', false],
];

for (const [name, line, hit] of CALL_CASES) {
  test(`generic-secret call rule: ${name} → ${hit ? 'hit' : 'no hit'}`, () => {
    const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
    assert.equal(hits.length, hit ? 1 : 0);
  });
}

test('generic-secret call rule: an unquoted non-call value with a dotted key still hits', () => {
  const line = ['config.apiKey', 'FAKE9aQ2xL7mZ4pR'].join('=');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('generic-secret call rule: a quoted call-shaped value still hits', () => {
  const line = ['token', '"fetchToken(abc123XYZ)"'].join(' = ');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('generic-secret call rule: an unquoted JWT-shaped value still hits', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'FAKEsignatureAbC123'].join('.');
  const line = ['AUTH_TOKEN', jwt].join('=');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('generic-secret call rule: an unquoted dotted non-call value still hits', () => {
  const line = ['token', 'config.apiKeyValue'].join(' = ');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('generic-secret call rule: a call whose identifier-shaped argument itself looks like a secret still hits', () => {
  const argument = 'Xk9aQ2xL7mZ4pRkW8vT3';
  const line = ['SECRET', `abc(${argument})`].join(' = ');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('generic-secret call rule: a call-shaped value too long to be a real call still hits', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'FAKEsignatureAbC123'].join('.');
  const line = ['AUTH_TOKEN', `${jwt}(x)`].join('=');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('this test source holds no literal hit', () => {
  assert.deepEqual(scanText(readFileSync(__filename, 'utf8'), { osUser: null }), []);
});

test('scanner.mjs is pure', () => {
  assertPureSource('scanner');
});
