'use strict';

// FND-07 (docs/roadmap/01-foundation.md): the privacy-guard test that fails when the CI
// runner's user name appears as a path segment in the FND-06 file set, plus its self-test
// (the same check run locally with the name set to `runner` and to `root`, since those are
// service-user exemptions everywhere else, M8 `scanText`, C:scan-patterns). FND-08 (below)
// adds the `local-path` scan (through the production scanner, with its exemptions) over the
// same file set, and every other scan pattern over test sources only (testing-modules.md
// "Other checks").
//
// Like every other scan pattern test in this repo (Q10 "Consequences": "a test builds such
// a string at run time"), no case below writes a literal `<separator><name><separator>`
// substring, or a literal secret token, in its own source: this file is itself part of the
// scanned file set (a test source). Path and token strings are built by concatenation so the
// raw source never holds the joined form.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCase } = require('./helpers/process-seam');
const { loadLib } = require('./helpers/load-lib');

const {
  isPrivacyScannedPath,
  listPrivacyFileSet,
  readFileSet,
  buildSegmentRegex,
  findSegmentHits,
  isTestSourcePath,
  scanFileEntriesForPatterns,
} = require('./helpers/privacy-guard');

const REPO_ROOT = path.join(__dirname, '..');

let scanText;

beforeEach(async () => {
  ({ scanText } = await loadLib('scanner'));
});

function fileSet() {
  const relPaths = listPrivacyFileSet(REPO_ROOT);
  return readFileSet(REPO_ROOT, relPaths);
}

test('the FND-06 file set: membership predicate', () => {
  const included = [
    'docs/decisions/q15-repository-layout.md',
    'docs/roadmap/01-foundation.md',
    'README.md',
    'package.json',
    'plugin/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'tests/privacy-guard.test.js',
    'tests/helpers/privacy-guard.js',
  ];
  for (const relPath of included) {
    assert.ok(isPrivacyScannedPath(relPath), `expected ${relPath} to be scanned`);
  }

  const excluded = [
    'tests/fixtures/some-fixture.txt',
    'tests/fixtures/nested/dir/file.md',
    '.claude/CLAUDE.md',
    'plugin/agents/commit-worker.md',
    'plugin/skills/commit/SKILL.md',
    'plugin/scripts/lib/scanner.mjs',
    'LICENSE',
  ];
  for (const relPath of excluded) {
    assert.ok(!isPrivacyScannedPath(relPath), `expected ${relPath} to be excluded`);
  }
});

test('the FND-06 file set, gathered from the real repo, excludes tests/fixtures/** and holds only scanned paths', () => {
  const relPaths = listPrivacyFileSet(REPO_ROOT);
  assert.ok(relPaths.length > 0);
  for (const relPath of relPaths) {
    assert.ok(!relPath.startsWith('tests/fixtures/'), relPath);
    assert.ok(isPrivacyScannedPath(relPath), relPath);
  }
  // No root README.md exists yet (REL-03b builds it); the predicate accepts it regardless
  // (see the membership-predicate test above).
  assert.ok(relPaths.includes('package.json'));
  assert.ok(relPaths.some((p) => p.startsWith('docs/')));
  assert.ok(relPaths.some((p) => p.startsWith('tests/') && !p.startsWith('tests/fixtures/')));
});

test('the FND-06 file set, gathered in a temp repo: untracked doc counted, design-review and fixtures excluded', (t) => {
  const c = createCase(t, { claudeConfigDir: false, projectDir: null });

  c.writeFile('docs/tracked.md', 'a tracked doc\n');
  c.git(['add', 'docs/tracked.md']);
  c.git(['commit', '-q', '-m', 'docs']);

  // A run-time-built path (never a literal joined form in this file's own source, Q10):
  // an untracked doc holding it must be listed (FND-06's untracked, non-ignored half of
  // the file set) and caught by the segment matcher.
  const plantedPath = '/home/' + 'runner' + '/work';
  c.writeFile('docs/untracked.md', `see ${plantedPath} for details\n`);

  // Untracked but excluded via `.git/info/exclude` (the Q15/FND-06 amendment's
  // `docs/design-review*.md` convention): must never be listed, even though it holds the
  // same planted path.
  c.writeFile('docs/design-review-x.md', `see ${plantedPath} for details\n`);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), 'docs/design-review*.md\n');

  // tests/fixtures/** is excluded from the file set outright (FND-06), even though it is
  // under tests/ and holds the same planted path.
  c.writeFile('tests/fixtures/y.md', `see ${plantedPath} for details\n`);

  const relPaths = listPrivacyFileSet(c.repoDir);
  assert.deepEqual(relPaths, ['docs/tracked.md', 'docs/untracked.md']);

  const hits = findSegmentHits('runner', readFileSet(c.repoDir, relPaths));
  assert.deepEqual(hits.map((hit) => hit.path), ['docs/untracked.md']);
});

test('the segment matcher: a bare word is never caught, only a path segment is', () => {
  const regex = buildSegmentRegex('runner');
  assert.ok(!regex.test('the runner is fine'));
  assert.ok(!regex.test('a runner-up'));
  assert.ok(!regex.test('runners'));
  assert.ok(regex.test('/home/' + 'runner' + '/project'));
});

// Path shapes, each parameterized by the name under test so the source never spells out
// `/home/<name>/` (or any other joined form) literally.
const PATH_SHAPES = [
  (name) => '/home/' + name + '/work/commit/commit',
  (name) => '/Users/' + name + '/work',
  (name) => 'C:\\Users\\' + name + '\\work',
  (name) => '/var/lib/' + name + '/cache',
];

test('the segment matcher catches every path shape, with no service-user or length exemption', () => {
  // Unlike Q10's `local-path` OS-user-segment rule (C:scan-patterns), which skips
  // placeholders, service users (`node`, `root`, `runner`, ...) and names under 4
  // characters, this test-owned matcher applies none of those exemptions: `runner` and
  // `root` (service users) and `ab` (2 characters) are all caught as a segment.
  for (const buildPath of PATH_SHAPES) {
    for (const name of ['runner', 'root', 'ab']) {
      const regex = buildSegmentRegex(name);
      const line = buildPath(name);
      assert.ok(regex.test(line), `expected "${name}" to match "${line}"`);
    }
  }
});

test('the segment matcher is case-insensitive', () => {
  const regex = buildSegmentRegex('runner');
  assert.ok(regex.test('/HOME/' + 'RUNNER' + '/work'));
  assert.ok(regex.test('C:\\Users\\' + 'Runner' + '\\work'));
});

test('findSegmentHits reports path and line number for each matching line', () => {
  const needle = '/home/' + 'runner' + '/x';
  const hits = findSegmentHits('runner', [
    { path: 'docs/a.md', content: 'first line\nsee ' + needle + ' for details\nlast line' },
    { path: 'docs/b.md', content: 'nothing here' },
  ]);
  assert.deepEqual(hits, [{ path: 'docs/a.md', line: 2, text: 'see ' + needle + ' for details' }]);
});

// `os.userInfo()` throws in a container whose uid has no passwd entry; fall back to the
// environment variable the OS actually sets (`USER` on POSIX, `USERNAME` on Windows).
function currentOsUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME;
  }
}

// The CI test (FND-07 AC1): the current OS user name, as a path segment, must not appear
// anywhere in the FND-06 file set. This is the actual enforcement; it runs on every CI leg
// (where the OS user is the runner's own account) and locally (the developer's own
// account), over docs, README, the manifests and test sources alike.
test('privacy guard: the current OS user name is not a path segment anywhere in the file set', () => {
  const name = currentOsUserName();
  const hits = findSegmentHits(name, fileSet());
  assert.deepEqual(
    hits,
    [],
    `found the OS user name "${name}" as a path segment: ${JSON.stringify(hits)}`,
  );
});

// The self-test (FND-06, FND-07 AC2 and AC3): runs the same check locally with the name
// set to `runner` and to `root`, over the same FND-06 file set as AC1 (docs, README, the
// manifests and test sources alike, not a narrower subset), so a doc or test source that
// quotes such a path fails locally too, not only on a CI leg whose own user happens to be
// named that.
for (const name of ['runner', 'root']) {
  test(`privacy guard self-test (${name}): passes on today's docs`, () => {
    const hits = findSegmentHits(name, fileSet());
    assert.deepEqual(hits, [], `found "${name}" as a path segment: ${JSON.stringify(hits)}`);
  });

  test(`privacy guard self-test (${name}): fails on a planted literal path (built at run time, not committed)`, () => {
    const planted = [
      { path: 'docs/planted-fixture.md', content: `see /home/${name}/project/notes.md for details` },
      { path: 'docs/planted-fixture-2.md', content: `C:\\Users\\${name}\\project\\notes.md` },
    ];
    const hits = findSegmentHits(name, planted);
    assert.ok(hits.length >= 2, `expected the planted "${name}" paths to be caught`);
  });
}

// FND-08 (docs/roadmap/01-foundation.md; C:scan-patterns; testing-modules.md "Other
// checks"): the privacy-guard test's scan part. `local-path` runs, through M8's own
// `scanText`, over the same FND-06 file set as FND-07 (docs, README, manifests and test
// sources); every other scan pattern runs over test sources only, since docs and contracts
// legitimately quote example tokens and paths in prose (C:scan-patterns itself documents
// `local-path`'s fixed shapes with literal examples).

// A name that is neither a `local-path` placeholder/service user nor the current OS user,
// built from fragments so this file's own source never holds the joined form (Q10).
function nonExemptName() {
  return 'j' + 'doe1';
}

test('local-path (AC1): a home-directory path with a non-exempt user name is caught on every OS shape, planted at run time', () => {
  const name = nonExemptName();
  const shapes = [
    'C:' + '\\Users\\' + name + '\\work', // Windows
    '/Users/' + name, // macOS
    '/home/' + name, // Linux
  ];
  for (const text of shapes) {
    const hits = scanText(text, { osUser: null });
    assert.ok(
      hits.some((hit) => hit.patternId === 'local-path'),
      `expected a local-path hit for "${text}"`,
    );
  }
});

test('local-path (AC1): a service-user or placeholder name is not caught on any OS shape', () => {
  for (const name of ['node', 'runner', 'root', 'example']) {
    const shapes = ['C:' + '\\Users\\' + name + '\\work', '/Users/' + name, '/home/' + name];
    for (const text of shapes) {
      const hits = scanText(text, { osUser: null }).filter((hit) => hit.patternId === 'local-path');
      assert.deepEqual(hits, [], `expected no local-path hit for "${text}"`);
    }
  }
});

test('every other scan pattern (AC2): a test source holding a literal token fails, a token built at run time does not', () => {
  // Simulates a test source file's raw content: a literal, joined secret token (as if a
  // developer had typed it directly rather than building it at run time). The token itself
  // is built here from fragments so this file's own source never holds the joined form.
  const literalToken = 'gh' + 'p_' + 'x'.repeat(36);
  const plantedContent = "const token = '" + literalToken + "';\n";
  const literalHits = scanFileEntriesForPatterns(
    scanText,
    [{ path: 'tests/planted.test.js', content: plantedContent }],
    { osUser: null },
  );
  assert.ok(
    literalHits.some((hit) => hit.patternId === 'github-token'),
    'expected the literal token to be caught',
  );

  // The same token, but as a real test source would hold it: built by a call at run time, so
  // the raw source text never holds the joined token.
  const runtimeBuiltContent =
    "function githubToken(fill) { return 'gh' + 'p_' + fill.repeat(36); }\n" +
    "const token = githubToken('x');\n";
  const runtimeHits = scanFileEntriesForPatterns(
    scanText,
    [{ path: 'tests/safe.test.js', content: runtimeBuiltContent }],
    { osUser: null },
  );
  assert.deepEqual(runtimeHits, [], `expected no hit on run-time-built content: ${JSON.stringify(runtimeHits)}`);
});

// AC3's two compositions, named so a regression (narrowing `local-path`'s scope to tests, or
// widening the token scan to docs) breaks a planted case below, not only the real-repo run
// (review-FND-08 finding 5).
function findLocalPathHits(scanTextFn, entries, osUser) {
  return scanFileEntriesForPatterns(scanTextFn, entries, { osUser }).filter(
    (hit) => hit.patternId === 'local-path',
  );
}

function findTokenHits(scanTextFn, entries) {
  const testEntries = entries.filter((entry) => isTestSourcePath(entry.path));
  return scanFileEntriesForPatterns(scanTextFn, testEntries, { osUser: null }).filter(
    (hit) => hit.patternId !== 'local-path',
  );
}

// AC2 coverage, per pattern (review-FND-08 finding 4): the planted case above shows only
// `github-token`. Each other pattern's own positive fixture is read at run time and planted
// as a test source, so the guard path (not just the scanner) is shown to report every
// pattern ID, without duplicating any fixture's literal text in this file's own source (Q10).
const SCAN_PATTERN_FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'scan-patterns');

function fixturePositiveLines(patternId) {
  return fs
    .readFileSync(path.join(SCAN_PATTERN_FIXTURES_DIR, `${patternId}.positive.txt`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('#'));
}

for (const file of fs.readdirSync(SCAN_PATTERN_FIXTURES_DIR).sort()) {
  const match = /^(.+)\.positive\.txt$/.exec(file);
  if (match === null || match[1] === 'local-path') continue;
  const patternId = match[1];

  test(`every other scan pattern (AC2): a test source holding a literal ${patternId} fixture line is caught`, () => {
    for (const line of fixturePositiveLines(patternId)) {
      const hits = scanFileEntriesForPatterns(
        scanText,
        [{ path: 'tests/planted.test.js', content: `${line}\n` }],
        { osUser: null },
      );
      assert.ok(
        hits.some((hit) => hit.patternId === patternId),
        `expected a ${patternId} hit for fixture line "${line}"`,
      );
    }
  });
}

test('privacy guard (AC3): local-path finds no un-exempted path anywhere in the FND-06 file set', () => {
  const osUser = currentOsUserName();
  const hits = findLocalPathHits(scanText, fileSet(), osUser);
  assert.deepEqual(hits, [], `found local-path hits: ${JSON.stringify(hits)}`);
});

test('privacy guard (AC3): every other scan pattern finds no literal token in test sources', () => {
  const hits = findTokenHits(scanText, fileSet());
  assert.deepEqual(hits, [], `found scan-pattern hits in test sources: ${JSON.stringify(hits)}`);
});

test('findLocalPathHits (AC3 wiring): a doc entry with a home path is caught', () => {
  const name = nonExemptName();
  const entries = [
    { path: 'docs/example.md', content: 'see ' + '/home/' + name + '/project for details' },
  ];
  const hits = findLocalPathHits(scanText, entries, null);
  assert.deepEqual(hits.map((hit) => hit.path), ['docs/example.md']);
});

test('findTokenHits (AC3 wiring): a doc entry with a token is ignored, a tests/ entry with the same token is caught', () => {
  const literalToken = 'gh' + 'p_' + 'x'.repeat(36);
  const entries = [
    { path: 'docs/example.md', content: "const token = '" + literalToken + "';\n" },
    { path: 'tests/planted.test.js', content: "const token = '" + literalToken + "';\n" },
  ];
  const hits = findTokenHits(scanText, entries);
  assert.deepEqual(hits.map((hit) => hit.path), ['tests/planted.test.js']);
});
