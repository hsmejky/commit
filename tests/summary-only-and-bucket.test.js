'use strict';

// M9 `summaryOnly` and `bucketOf`, Seam 3 (in-process, table-driven) against
// C:summary-only-files (reason order, size and line boundaries) and C:plan's `bucket`
// (hints only, Q11).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let summaryOnly;
let bucketOf;

beforeEach(async () => {
  ({ summaryOnly, bucketOf } = await loadLib('path-classifier'));
});

// Baseline stats: none of the rules fire.
const BASE_STATS = Object.freeze({ added: 1, deleted: 1, generated: false, size: 1 });

function stats(overrides) {
  return { ...BASE_STATS, ...overrides };
}

// One row per lockfile name (C:summary-only-files, rule 1): matches regardless of stats.
const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
];

for (const name of LOCKFILES) {
  test(`summaryOnly: ${name} is lockfile`, () => {
    assert.equal(summaryOnly(name, stats({})), 'lockfile');
  });

  test(`summaryOnly: nested ${name} is lockfile`, () => {
    assert.equal(summaryOnly(`vendor/deep/${name}`, stats({})), 'lockfile');
  });
}

test('summaryOnly: a lockfile name with every other rule also true still reports lockfile (order)', () => {
  assert.equal(
    summaryOnly('yarn.lock', stats({ generated: true, added: 5000, deleted: 5000, size: 999999 })),
    'lockfile',
  );
});

// Rule 2: minified (`*.min.*`).
test('summaryOnly: app.min.js is minified', () => {
  assert.equal(summaryOnly('src/app.min.js', stats({})), 'minified');
});

test('summaryOnly: .min.js (leading dot) is minified', () => {
  assert.equal(summaryOnly('.min.js', stats({})), 'minified');
});

test('summaryOnly: app.min.js.map is minified, not sourcemap (order: minified before sourcemap)', () => {
  assert.equal(summaryOnly('app.min.js.map', stats({})), 'minified');
});

test('summaryOnly: minified wins over generated, lines and size (order)', () => {
  assert.equal(
    summaryOnly('app.min.js', stats({ generated: true, added: 5000, deleted: 5000, size: 999999 })),
    'minified',
  );
});

test('summaryOnly: min.js (no leading dot before "min") is not minified', () => {
  assert.equal(summaryOnly('min.js', stats({})), null);
});

// Rule 3: sourcemap (`*.map`).
test('summaryOnly: app.js.map is sourcemap', () => {
  assert.equal(summaryOnly('dist/app.js.map', stats({})), 'sourcemap');
});

test('summaryOnly: sourcemap wins over generated, lines and size (order)', () => {
  assert.equal(
    summaryOnly('app.js.map', stats({ generated: true, added: 5000, deleted: 5000, size: 999999 })),
    'sourcemap',
  );
});

test('summaryOnly: .map.txt is not a sourcemap (must end with .map)', () => {
  assert.equal(summaryOnly('notes.map.txt', stats({})), null);
});

// Rule 4: generated (linguist-generated stat).
test('summaryOnly: generated stat true is generated', () => {
  assert.equal(summaryOnly('src/generated.js', stats({ generated: true })), 'generated');
});

test('summaryOnly: generated wins over lines and size (order)', () => {
  assert.equal(
    summaryOnly('src/generated.js', stats({ generated: true, added: 5000, deleted: 5000, size: 999999 })),
    'generated',
  );
});

test('summaryOnly: generated stat false is not generated', () => {
  assert.equal(summaryOnly('src/plain.js', stats({ generated: false })), null);
});

// Rule 5: lines, over 1000 changed lines (added + deleted).
test('summaryOnly: 1000 changed lines is not over (boundary)', () => {
  assert.equal(summaryOnly('src/big.js', stats({ added: 500, deleted: 500 })), null);
});

test('summaryOnly: 1001 changed lines is lines (boundary)', () => {
  assert.equal(summaryOnly('src/big.js', stats({ added: 500, deleted: 501 })), 'lines');
});

test('summaryOnly: lines wins over size (order)', () => {
  assert.equal(
    summaryOnly('src/big.js', stats({ added: 500, deleted: 501, size: 999999 })),
    'lines',
  );
});

// Rule 6: size, over 256 KB (262144 bytes).
test('summaryOnly: 262144 bytes is not over (boundary)', () => {
  assert.equal(summaryOnly('src/big.bin', stats({ size: 262144 })), null);
});

test('summaryOnly: 262145 bytes is size (boundary)', () => {
  assert.equal(summaryOnly('src/big.bin', stats({ size: 262145 })), 'size');
});

// Binary units carry no numstat counts (git reports `-\t-`), normalised to added: 0,
// deleted: 0; only `size` can still apply.
test('summaryOnly: a binary unit (added: 0, deleted: 0) can still trigger size', () => {
  assert.equal(
    summaryOnly('assets/big.bin', stats({ added: 0, deleted: 0, size: 262145 })),
    'size',
  );
});

// No rule matches.
test('summaryOnly: an ordinary small file is not summary-only', () => {
  assert.equal(summaryOnly('src/index.js', stats({})), null);
});

// `bucketOf`: one row per bucket, plus precedence rows where more than one rule could apply.
const bucketTable = [
  // code: the fallback, nothing else matches.
  { path: 'plugin/scripts/lib/path-classifier.mjs', bucket: 'code' },
  { path: 'src/index.js', bucket: 'code' },

  // test: a path segment named test/tests/__tests__.
  { path: 'tests/summary-only-and-bucket.test.js', bucket: 'test' },
  { path: 'src/__tests__/foo.js', bucket: 'test' },
  // test: a `*.test.*` or `*.spec.*` name, with no test/tests segment.
  { path: 'src/foo.spec.ts', bucket: 'test' },
  { path: 'src/foo.test.tsx', bucket: 'test' },
  // test: RSpec, Go and pytest name conventions, with no test/tests segment.
  { path: 'app/models/user_spec.rb', bucket: 'test' },
  { path: 'pkg/foo_test.go', bucket: 'test' },
  { path: 'src/test_foo.py', bucket: 'test' },
  // `spec`/`specs` alone is not a test segment (this repo's own `docs/spec` is docs, not
  // test): RSpec-style files are caught by the `*_spec.rb` name pattern above, not the
  // segment.
  { path: 'spec/foo.rb', bucket: 'code' },
  { path: 'docs/spec/notes.txt', bucket: 'docs' },

  // ci: a known CI directory, or a known root CI file name.
  { path: '.github/workflows/ci.yml', bucket: 'ci' },
  { path: '.circleci/config.yml', bucket: 'ci' },
  { path: '.gitlab/merge_request_templates/default.md', bucket: 'ci' },
  { path: '.buildkite/pipeline.yml', bucket: 'ci' },
  { path: '.gitea/workflows/ci.yml', bucket: 'ci' },
  { path: '.forgejo/workflows/ci.yml', bucket: 'ci' },
  { path: '.woodpecker/ci.yml', bucket: 'ci' },
  { path: '.gitlab-ci.yml', bucket: 'ci' },
  { path: '.travis.yml', bucket: 'ci' },
  { path: '.drone.yml', bucket: 'ci' },
  { path: 'Jenkinsfile', bucket: 'ci' },

  // docs: under docs/, or a *.md / *.mdx name.
  { path: 'docs/contracts/plan.md', bucket: 'docs' },
  { path: 'README.md', bucket: 'docs' },
  { path: 'guide.mdx', bucket: 'docs' },

  // build: a known package manifest, lockfile or build-tool config name.
  { path: 'package.json', bucket: 'build' },
  { path: 'package-lock.json', bucket: 'build' },
  { path: 'yarn.lock', bucket: 'build' },
  { path: 'Cargo.toml', bucket: 'build' },
  { path: 'pyproject.toml', bucket: 'build' },
  { path: 'go.mod', bucket: 'build' },
  { path: 'Dockerfile', bucket: 'build' },
  { path: 'Makefile', bucket: 'build' },
  { path: 'webpack.config.js', bucket: 'build' },
  { path: 'vite.config.ts', bucket: 'build' },

  // Precedence: test beats ci, ci beats docs, docs beats build.
  { path: 'tests/.github/workflows/ci.yml', bucket: 'test' },
  { path: '.github/workflows/README.md', bucket: 'ci' },
  { path: 'docs/package.json', bucket: 'docs' },
];

for (const { path, bucket } of bucketTable) {
  test(`bucketOf: ${JSON.stringify(path)} is ${bucket}`, () => {
    assert.equal(bucketOf(path), bucket);
  });
}

test('path-classifier.mjs is pure', () => {
  assertPureSource('path-classifier');
});
