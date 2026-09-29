'use strict';

// SCN-04 (docs/roadmap/05-scanner.md): a platform oracle (testing-modules.md, "Platform
// oracles in CI only") cross-checking the supported `scanIgnore` glob subset (M7,
// C:scanignore-globs) against git's own `:(glob)` pathspec matching, over a fixture tree
// built fresh in a temp repo at run time. Runs in the normal `npm test`, so it runs on every
// CI leg, including the git 2.34 `ubuntu:22.04` container job (FND-03): the pathspec
// behaviors this file exercises (glob magic, `**`, the directory-prefix fallback, the
// absolute-path rejection of a leading `/`) are long-standing, not new to any recent git
// release, so this file is deliberately version-agnostic like tests/temporary-index.test.js
// (PRE-09): it names no git version and skips nothing.
//
// Excluded rows (C:scanignore-globs deliberately differs from git, confirmed below rather
// than merely assumed):
//   1. `?` against a non-ASCII character: git's wildmatch is byte-oriented (UTF-8), ours
//      compares UTF-16 code units. A BMP character (2 UTF-8 bytes, 1 UTF-16 unit) or an
//      astral character (4 UTF-8 bytes, 2 UTF-16 units) needs a different `?` count in each.
//   2. A pattern ending in `/`: git's `:(glob)` wildmatch never matches a trailing literal
///     `/` against a file path (file paths never end in `/`), so any pattern combining a
//      wildcard elsewhere with a trailing `/` (e.g. `src/*/`) matches nothing in git while
//      ours expands it to "everything under that directory". A *purely literal* trailing-`/`
//      pattern happens to still match the same set in git, but only via a different
//      mechanism (the directory-prefix fallback below, not glob expansion), so trailing `/`
//      is excluded as a category rather than validated case by case (safer across git
//      versions too).
//   3. A leading `/`: git's pathspec machinery reads a literal leading `/` as an attempt at
//      an absolute filesystem path outside the repository and fails the command outright;
//      ours strips it and roots the pattern at the repo top.
//   4. A literal (wildcard-free) pattern that names an existing directory: git's pathspec
//      matching falls back to matching everything under that directory (the same fallback a
//      trailing `/` also reaches), independently of glob magic; our literal ("anything
//      else") row matches only that exact whole path, so it matches nothing (the directory
//      itself is never a file).
//
// GIT_LITERAL_PATHSPECS is deliberately never set here: manual verification (see the roadmap
// slice's report) showed it disables pathspec magic outright, including `:(glob)` itself, so
// `:(glob)tests/*.json` would then be read as a literal (and non-existent) path named
// ":(glob)tests/*.json" rather than as a glob pattern. `withoutInheritedGitVars` still drops
// it if the host happens to export it.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');

let compileGlob;
let matches;

beforeEach(async () => {
  ({ compileGlob, matches } = await loadLib('glob-matcher'));
});

const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: 'Commit Test',
  GIT_AUTHOR_EMAIL: 'commit-test@example.com',
  GIT_COMMITTER_NAME: 'Commit Test',
  GIT_COMMITTER_EMAIL: 'commit-test@example.com',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
};

// Q9-style isolation (mirrors tests/temporary-index.test.js): every inherited `GIT_*`
// variable is dropped before the fixed identity and config isolation are added back
// explicitly, so nothing the host or CI runner exports (including a stray
// GIT_LITERAL_PATHSPECS) can change how these pathspecs are read.
function withoutInheritedGitVars(env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('GIT_')) filtered[key] = value;
  }
  return filtered;
}

function makeRepo() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-glob-oracle-'));
  const emptyConfig = path.join(homeDir, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const repoDir = path.join(homeDir, 'repo');
  fs.mkdirSync(repoDir);
  const env = {
    ...withoutInheritedGitVars(process.env),
    ...FIXED_IDENTITY,
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
  };
  return { homeDir, repoDir, env };
}

function gitRaw(repoDir, env, args) {
  return spawnSync('git', args, { cwd: repoDir, env, encoding: 'utf8' });
}

function git(repoDir, env, args) {
  const result = gitRaw(repoDir, env, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function write(repoDir, relPath) {
  const full = path.join(repoDir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
}

// The fixture tree: one directory with a file of the same name prefix (`tests/fixtures/` the
// directory vs. `tests/fixtures.txt` the file), dotfiles (a file and a dotted directory),
// deep nesting, a path with spaces, and non-ASCII names (a BMP accented character and an
// astral character, each needing a different `?` count in git's bytes than in our UTF-16
// units).
const FIXTURES = [
  'tests/a.json', 'tests/.json', 'tests/a.b.json', 'tests/x/a.json',
  'tests/fixtures/a.txt', 'tests/fixtures/a/b.txt', 'tests/fixtures/fixtures',
  'tests/fixtures.txt',
  'key.pem', 'tests/key.pem', 'tests/a/key.pem',
  'a+b.txt', 'ab.txt',
  'abc', 'aXbYc', 'abbc', 'abcbc', 'ac', 'acb', 'abcx',
  'aa', 'aaa', 'xaya',
  'docs/a.md', 'x/docs/a.md',
  'a/b/c', 'a/x/b/y/c',
  '.dotfile', '.dot/dir/file.txt',
  'dir with spaces/file one.txt',
  'src/a/b.js', 'src/a/b/c.js', 'src/b.js',
  'aé.txt', // BMP: 1 UTF-16 unit, 2 UTF-8 bytes
  'a\u{1F600}.txt', // astral: 2 UTF-16 units, 4 UTF-8 bytes
];

let repoDir;
let env;
let allPaths;

before(() => {
  const built = makeRepo();
  repoDir = built.repoDir;
  env = built.env;

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  for (const relPath of FIXTURES) write(repoDir, relPath);
  git(repoDir, env, ['add', '-A']);
  git(repoDir, env, ['commit', '-q', '-m', 'fixtures']);

  allPaths = git(repoDir, env, ['-c', 'core.quotePath=false', 'ls-files', '-z'])
    .split('\0')
    .filter(Boolean);
  assert.equal(allPaths.length, FIXTURES.length, 'every fixture landed in the index');
});

after(() => {
  fs.rmSync(path.dirname(repoDir), { recursive: true, force: true });
});

function ourMatchSet(pattern) {
  const compiled = compileGlob(pattern);
  assert.equal(compiled.ok, true, `${pattern} compiles`);
  return allPaths.filter((candidate) => matches(compiled.matcher, candidate)).sort();
}

function gitMatchSet(pattern) {
  const stdout = git(repoDir, env, [
    '-c', 'core.quotePath=false', 'ls-files', '-z', '--', `:(glob)${pattern}`,
  ]);
  return stdout.split('\0').filter(Boolean).sort();
}

// --- Cross-checked rows: our matcher and git's `:(glob)` pathspec must agree exactly -------

const ROWS = [
  'tests/*.json',
  'a+b.txt',
  'a*b*c',
  '*a*a*',
  // `a?.txt` and `a??.txt` are deliberately not full-set rows here: the fixture tree also
  // holds non-ASCII names (below), against which `?` diverges (excluded row 1); the specific
  // divergence is demonstrated directly in that test instead of a whole-set comparison.
  'tests/**/key.pem',
  '**/key.pem',
  'a/**/b/**/c',
  'tests/**',
  'tests/fixtures/**',
  'tests/fixtures*', // the directory/file-same-prefix row: matches only the file
  '.dot*/*/*.txt',
  '.dotfile',
  'dir with spaces/*',
  'src/*/*.js',
];

for (const pattern of ROWS) {
  test(`glob oracle: ${JSON.stringify(pattern)} gives the same match set as git`, () => {
    assert.deepEqual(ourMatchSet(pattern), gitMatchSet(pattern));
  });
}

// --- Excluded rows: each disagreement is demonstrated, not merely asserted ------------------

test('excluded: `?` against a BMP non-ASCII character (git counts bytes, we count UTF-16 units)', () => {
  // 1 code unit in ours, 2 UTF-8 bytes in git: `a?.txt` matches the file for us, not for git.
  assert.ok(ourMatchSet('a?.txt').includes('aé.txt'));
  assert.ok(!gitMatchSet('a?.txt').includes('aé.txt'));
});

test('excluded: `?` against an astral non-ASCII character (git counts bytes, we count UTF-16 units)', () => {
  // 2 code units in ours, 4 UTF-8 bytes in git: `a??.txt` matches the file for us, not git.
  assert.ok(ourMatchSet('a??.txt').includes('a\u{1F600}.txt'));
  assert.ok(!gitMatchSet('a??.txt').includes('a\u{1F600}.txt'));
});

test('excluded: a pattern ending in `/` combined with a wildcard elsewhere', () => {
  // Ours expands `src/*/` to "everything under `src/<anything>`" (same as `src/*/**`); git's
  // wildmatch requires the path itself to literally end in `/`, which no file path does.
  const ours = ourMatchSet('src/*/');
  assert.deepEqual(ours, ['src/a/b.js', 'src/a/b/c.js']);
  assert.deepEqual(gitMatchSet('src/*/'), []);
});

test('excluded: a leading `/` (git reads it as an absolute filesystem path, not repo-root)', () => {
  const compiled = compileGlob('/docs/*.md');
  assert.equal(compiled.ok, true);
  assert.deepEqual(
    allPaths.filter((candidate) => matches(compiled.matcher, candidate)),
    ['docs/a.md'],
  );

  const result = gitRaw(repoDir, env, ['ls-files', '-z', '--', ':(glob)/docs/*.md']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid path/);
});

test('excluded: a literal pattern naming an existing directory (git\'s directory-prefix fallback)', () => {
  // `tests/fixtures` names a directory, not a file: ours (whole-path literal match) matches
  // nothing; git falls back to matching everything git ls-files would list under it.
  assert.deepEqual(ourMatchSet('tests/fixtures'), []);
  assert.deepEqual(gitMatchSet('tests/fixtures'), [
    'tests/fixtures/a.txt', 'tests/fixtures/a/b.txt', 'tests/fixtures/fixtures',
  ]);
});

