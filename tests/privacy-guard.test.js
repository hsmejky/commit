'use strict';

// FND-07 (docs/roadmap/01-foundation.md): the privacy-guard test that fails when the CI
// runner's user name appears as a path segment in the FND-06 file set, plus its self-test
// (the same check run locally with the name set to `runner` and to `root`, since those are
// service-user exemptions everywhere else, M8 `scanText`, C:scan-patterns). FND-08 adds the
// `local-path` scan and every other scan pattern on top of this file set; this file only
// covers the segment matcher and self-test (testing-modules.md "Other checks").
//
// Like every other scan pattern test in this repo (Q10 "Consequences": "a test builds such
// a string at run time"), no case below writes a literal `<separator><name><separator>`
// substring in its own source: this file is itself part of the scanned file set (a test
// source), and the matcher below applies no exemption. Path strings are built by
// concatenation so the raw source never holds the joined form.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCase } = require('./helpers/process-seam');

const {
  isPrivacyScannedPath,
  listPrivacyFileSet,
  readFileSet,
  buildSegmentRegex,
  findSegmentHits,
} = require('./helpers/privacy-guard');

const REPO_ROOT = path.join(__dirname, '..');

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
