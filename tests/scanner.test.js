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
let compileGlob;

beforeEach(async () => {
  ({ scanText, scanUnits, PATTERNS, createScanner } = await loadLib('scanner'));
  ({ compileGlob } = await loadLib('glob-matcher'));
});

// A compiled `scanIgnore` matcher, as M4 would pass it (SCN-13).
function ignoreGlob(pattern) {
  const result = compileGlob(pattern);
  assert.equal(result.ok, true, `${pattern} compiles`);
  return result.matcher;
}

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

// Line cut at 4096 characters (SCN-12): every scanned line (diff line, symlink target,
// message line) is cut to its first 4096 UTF-16 code units before any regex runs. Padding is
// spaces, not word characters, so it never merges into the `github-token` row's own `\b`
// boundary; a github-token is enough to isolate the cut (SCN-05's pattern), per the slice.
const LINE_CUT = 4096;

// A line whose `github-token` starts `padLength` characters in: at `LINE_CUT - token.length`
// the token sits entirely inside the cut (line length exactly 4096, untouched); one more and
// the cut's last character falls one short of the token, so the minimum-length alternative
// can no longer match.
function paddedTokenLine(padLength) {
  return ' '.repeat(padLength) + githubToken('x');
}

test('scanUnits: a github-token entirely before the cut → hit', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length);
  const units = [textUnit('big.diff', [{ line: 1, text: line }])];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, [
    { patternId: 'github-token', path: 'big.diff', line: 1 },
  ]);
});

test('scanUnits: the same github-token shifted one character past the cut → missed', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length + 1);
  const units = [textUnit('big.diff', [{ line: 1, text: line }])];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, []);
});

test('scanUnits: the same cut applies to a symlink target, one before the cut → hit', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length);
  const units = [
    { path: 'link', oldPath: null, status: 'A', kind: 'symlink', addedLines: [{ line: 1, text: line }] },
  ];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, [
    { patternId: 'github-token', path: 'link', line: 1 },
  ]);
});

test('scanUnits: a symlink target one character past the cut → missed', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length + 1);
  const units = [
    { path: 'link', oldPath: null, status: 'A', kind: 'symlink', addedLines: [{ line: 1, text: line }] },
  ];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, []);
});

test('scanText: the same cut applies to a message line, one before the cut → hit', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length);
  assert.equal(
    scanText(line, { osUser: null }).filter((hit) => hit.patternId === 'github-token').length,
    1,
  );
});

test('scanText: a message line one character past the cut → missed', () => {
  const line = paddedTokenLine(LINE_CUT - githubToken('x').length + 1);
  assert.equal(
    scanText(line, { osUser: null }).filter((hit) => hit.patternId === 'github-token').length,
    0,
  );
});

// A probe row whose `notHit` records the length of `match.input` — the string a rule
// actually receives, after the cut — rather than the length of the original line. `[^]$`
// matches once, at the last character of that (possibly cut) string, so it fires once per
// line and never loops. This is structural: it proves the cut runs before any rule sees the
// line, unlike a wall-clock bound, which only proves something is fast today (SCN-12 review).
test('scanUnits: a multi-megabyte line is cut to 4096 characters before any rule runs', () => {
  // Kept under the SCN-13 1 MB added-content skip (else the unit would be skipped, and the
  // probe would never run at all), while staying 256x the 4096-character cut it tests. One
  // short of 1024 * 1024 ASCII bytes so the line's own added '\n' byte (SCN-13 fix) still
  // lands the unit's total at exactly the 1 MB limit, not one over it.
  const hugeLine = ' '.repeat(1024 * 1024 - 1);
  const seen = [];
  const probe = createScanner([
    {
      id: 'probe',
      regex: /[^]$/,
      notHit: (match) => {
        seen.push(match.input.length);
        return true;
      },
      source: 'test',
    },
  ]);
  const units = [textUnit('huge.txt', [{ line: 1, text: hugeLine }])];

  const started = Date.now();
  const { hits } = probe.scanUnits(units, { scanIgnore: [], osUser: null });
  const elapsedMs = Date.now() - started;

  assert.deepEqual(hits, []);
  assert.deepEqual(seen, [4096], 'the rule saw a line already cut to 4096 characters');
  // Loose smoke bound, not the point of the test: catches a gross regression (e.g. the cut
  // being skipped and a quadratic rule run over the full 20M characters) without being flaky.
  assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms scanning a 1M-character line, bound 2 s`);
});

// `private-key` body lookahead (scanner.mjs's `hasKeyBody`/`followingLines`): the lookahead
// line is cut to 4096 before the key-body regex runs, same as any scanned line. Built so the
// cut changes the outcome: the base64 run sits entirely past the cut, behind a run of spaces
// longer than 4096. Without the cut, trimming the (long) line would remove the leading spaces
// and reveal the base64 run; with the cut, the visible slice is space-only and trims to empty.
test('private-key: the body lookahead line is cut to 4096 before the key-body check runs', () => {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const bodyLine = ' '.repeat(5000) + 'A'.repeat(50);
  const units = [
    textUnit('key.pem', [
      { line: 1, text: header },
      { line: 2, text: bodyLine },
    ]),
  ];
  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, []);
});

// `scanText` offsets (SCN-12 review): the line before the hit is longer than the cut, so this
// checks that offset accumulation uses each line's real length, not its cut length, and that
// slicing the original (uncut) message at `start..end` still yields exactly the token.
test('scanText: the offset of a hit on the line after a line longer than 4096 is exact', () => {
  const longLine = 'x'.repeat(5000);
  const token = githubToken('x');
  const text = `${longLine}\n${token} here`;

  const hits = scanText(text, { osUser: null }).filter((hit) => hit.patternId === 'github-token');

  assert.equal(hits.length, 1);
  const { start, end } = hits[0];
  assert.equal(text.slice(start, end), token);
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
  // Word-shaped rule (finding 1, SCN-09 re-review): a trailing version digit still reads as a
  // real name reference, so these stay excluded.
  ['unquoted call with a trailing-digit callee', 'token = getV2()', false],
  ['unquoted call with a trailing-digit snake_case callee', 'token = fetchToken2()', false],
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

// `generic-secret` word-shaped rule (finding 1, SCN-09 re-review): the earlier call rule
// entropy-checked only the argument, so a secret standing in as the callee itself — with no
// argument, or with a well-shaped argument — was wrongly excluded as a call. Each case below
// puts the key and value in separate array elements, joined at run time, so this file's own
// source never holds the key and value contiguously (the "no literal hit" self-check below
// would otherwise flag it).
const CALLEE_BYPASS_CASES = [
  // [case, key, value]
  ['a digit inside the bare callee, no argument', 'SECRET', 'Xk9aQ2xL7mZ4pRkW8vT3()'],
  ['a digit inside the trailing segment of a dotted callee', 'token', 'a.Xk9aQ2xL7mZ4pRkW8vT3()'],
  ['a digit inside the leading segment of a dotted callee', 'token', 'Xk9aQ2xL7mZ4pRkW8vT3.x()'],
  ['a digit inside the callee, with a well-shaped argument', 'token', 'Xk9aQ2xL7mZ4(scope)'],
  ['a digit inside every segment of a dotted callee', 'token', 'Xk9a.Q2xL.7mZ4.pRkW.8vT3(a)'],
  ['a digit inside the callee after a leading $', 'token', '$Xk9aQ2xL7mZ4pRkW8vT3()'],
  ['a hex-shaped callee with digits throughout', 'token', 'f3a9c2e1b7d4a8f6c0e2b9d7a1c3e5f7()'],
  ['a digit inside the argument segment, well-shaped callee', 'token', 'fetchToken(a1b2c3)'],
];

for (const [name, key, value] of CALLEE_BYPASS_CASES) {
  test(`generic-secret call rule: ${name} → hit`, () => {
    const line = [key, value].join(' = ');
    const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
    assert.equal(hits.length, 1);
  });
}

// `generic-secret` call rule length boundary (finding 3, SCN-09 re-review): the cap is 40
// characters, so a 40-character call-shaped value is still excluded and a 41-character one is
// not. Built from a fixed pool of distinct letters, with no digit, so this isolates the length
// cap from the word-shaped rule (finding 1) and stays high-entropy once the cap rejects it.
const CALL_VALUE_LENGTH_POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

test('generic-secret call rule: a 40-character call-shaped value → no hit', () => {
  const value = CALL_VALUE_LENGTH_POOL.slice(0, 38) + '()';
  assert.equal(value.length, 40);
  const line = ['token', value].join(' = ');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 0);
});

test('generic-secret call rule: a 41-character call-shaped value → hit', () => {
  const value = CALL_VALUE_LENGTH_POOL.slice(0, 39) + '()';
  assert.equal(value.length, 41);
  const line = ['token', value].join(' = ');
  const hits = scanText(line, { osUser: null }).filter((h) => h.patternId === 'generic-secret');
  assert.equal(hits.length, 1);
});

test('this test source holds no literal hit', () => {
  assert.deepEqual(scanText(readFileSync(__filename, 'utf8'), { osUser: null }), []);
});

test('scanner.mjs is pure', () => {
  assertPureSource('scanner', { allowImports: ['./glob-matcher.mjs'] });
});

// SCN-13 unit-level rules ------------------------------------------------------------------

test('scanUnits: a binary unit is neither a hit nor skipped', () => {
  const token = githubToken('x');
  const units = [
    { path: 'image.png', oldPath: null, status: 'M', kind: 'binary', addedLines: [{ line: 1, text: token }] },
  ];

  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }), { hits: [], skipped: [] });
});

test('scanUnits: content outside addedLines is never scanned', () => {
  // M8 reads only `addedLines`; a unit that also carries removed-line data under another key
  // (as M10's own diff-side bookkeeping might) must not have that data reach the scanner.
  const token = githubToken('x');
  const units = [
    {
      path: 'src/config.js',
      oldPath: null,
      status: 'M',
      kind: 'text',
      addedLines: [],
      removedLines: [{ line: 3, text: token }],
    },
  ];

  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }), { hits: [], skipped: [] });
});

test('scanUnits: a unit with over 1 MB added is skipped with the exact reason, no hits', () => {
  const token = githubToken('x');
  const units = [
    textUnit('assets/big.json', [{ line: 1, text: 'x'.repeat(1024 * 1024 + 1) + token }]),
  ];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [],
    skipped: [{ path: 'assets/big.json', reason: 'added content over 1 MB' }],
  });
});

test('scanUnits: a unit with exactly 1 MB added is scanned, not skipped', () => {
  const token = githubToken('x');
  // Split across two added lines, so the token's own line stays well under the per-line
  // 4096-character cut (SCN-12) while the unit's total added length sits exactly at the 1 MB
  // boundary. Each line's own '\n' counts as one byte (SCN-13 fix), so the filler is two
  // bytes shorter than the naive `1024 * 1024 - token.length` to leave room for both.
  const filler = 'x'.repeat(1024 * 1024 - token.length - 2);
  const units = [
    textUnit('assets/exact.json', [
      { line: 1, text: filler },
      { line: 2, text: token },
    ]),
  ];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'assets/exact.json', line: 2 }],
    skipped: [],
  });
});

// A 3-byte-UTF-8, 1-UTF-16-code-unit character, used to prove the 1 MB skip limit counts
// UTF-8 bytes, not `.length` (UTF-16 code units) — the bug SCN-13's fix corrects.
const EURO = '€'; // '€'

// `byteLength` UTF-8 bytes of EURO characters, topped up with ASCII 'a' characters to reach
// an exact byte count (EURO's 3-byte width alone cannot land on every target). The result's
// `.length` (UTF-16 code units) is roughly a third of `byteLength`: measuring code units
// instead of bytes here would badly undercount it.
function nonAsciiOfByteLength(byteLength) {
  const euroCount = Math.floor(byteLength / 3);
  const remainder = byteLength - euroCount * 3;
  return EURO.repeat(euroCount) + 'a'.repeat(remainder);
}

// A unit with a non-ASCII filler line and a `github-token` line, each carrying its own '\n'
// byte, sized so the unit's total added content is exactly `totalBytes` UTF-8 bytes.
function nonAsciiUnit(unitPath, totalBytes) {
  const token = githubToken('x');
  const fillerBytes = totalBytes - token.length - 2; // both lines' own '\n', one byte each
  const filler = nonAsciiOfByteLength(fillerBytes);
  return textUnit(unitPath, [
    { line: 1, text: filler },
    { line: 2, text: token },
  ]);
}

test('scanUnits: non-ASCII content one byte under the 1 MB limit is scanned, not skipped', () => {
  const units = [nonAsciiUnit('assets/under.json', 1024 * 1024 - 1)];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'assets/under.json', line: 2 }],
    skipped: [],
  });
});

test('scanUnits: non-ASCII content exactly at the 1 MB limit is scanned, not skipped', () => {
  const units = [nonAsciiUnit('assets/boundary.json', 1024 * 1024)];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'assets/boundary.json', line: 2 }],
    skipped: [],
  });
});

test('scanUnits: non-ASCII content one byte over the 1 MB limit is skipped, no hits', () => {
  const units = [nonAsciiUnit('assets/over.json', 1024 * 1024 + 1)];

  const result = scanUnits(units, { scanIgnore: [], osUser: null });

  assert.deepEqual(result, {
    hits: [],
    skipped: [{ path: 'assets/over.json', reason: 'added content over 1 MB' }],
  });
});

test('scanUnits: a symlink unit whose target is a home path is a hit', () => {
  const units = [
    {
      path: 'link',
      oldPath: null,
      status: 'A',
      kind: 'symlink',
      addedLines: [{ line: 1, text: '/ho' + 'me/alice/app' }],
    },
  ];

  assert.deepEqual(scanUnits(units, { scanIgnore: [], osUser: null }).hits, [
    { patternId: 'local-path', path: 'link', line: 1 },
  ]);
});

test('scanUnits: a secret in a unit matched by a scanIgnore glob is not a hit', () => {
  const token = githubToken('x');
  const units = [textUnit('tests/fixtures/sample.js', [{ line: 1, text: token }])];

  const result = scanUnits(units, { scanIgnore: [ignoreGlob('tests/fixtures/**')], osUser: null });

  assert.deepEqual(result, { hits: [], skipped: [] });
});

test('scanUnits: a scanIgnore glob that does not match the unit path still scans it', () => {
  const token = githubToken('x');
  const units = [textUnit('src/config.js', [{ line: 1, text: token }])];

  const result = scanUnits(units, { scanIgnore: [ignoreGlob('tests/fixtures/**')], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'src/config.js', line: 1 }],
    skipped: [],
  });
});

test('scanUnits: a rename is matched against its new path, not its old path (C:scanignore-globs)', () => {
  const token = githubToken('x');
  const units = [
    {
      path: 'src/a.js',
      oldPath: 'tests/fixtures/a.js',
      status: 'R',
      kind: 'text',
      addedLines: [{ line: 1, text: token }],
    },
  ];

  const result = scanUnits(units, { scanIgnore: [ignoreGlob('tests/fixtures/**')], osUser: null });

  assert.deepEqual(result, {
    hits: [{ patternId: 'github-token', path: 'src/a.js', line: 1 }],
    skipped: [],
  });
});

test('scanUnits: any matching scanIgnore matcher in the list drops the unit', () => {
  const token = githubToken('x');
  const units = [textUnit('docs/notes.md', [{ line: 1, text: token }])];

  const result = scanUnits(units, {
    scanIgnore: [ignoreGlob('tests/fixtures/**'), ignoreGlob('docs/**')],
    osUser: null,
  });

  assert.deepEqual(result, { hits: [], skipped: [] });
});
