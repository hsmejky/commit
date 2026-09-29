// M9 Path classifier (C:untracked-files). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument. Every match is case-sensitive on every OS.

// The `.env` templates: the only `.env.*` names that are not hidden.
const ENV_TEMPLATES = Object.freeze(['.env.example', '.env.sample', '.env.template']);

// Hidden exceptions whose pattern holds a `/`: anchored at the repo root. `dir/**` excepts
// every path below `dir/`; any other entry excepts exactly that path.
const EXCEPTED_DIRS = Object.freeze([
  '.github', '.claude/agents', '.claude/skills', '.claude/commands', '.claude/hooks',
  '.changeset', '.husky', '.devcontainer',
  '.circleci', '.gitlab', '.buildkite', '.gitea', '.forgejo', '.woodpecker',
]);
const EXCEPTED_PATHS = Object.freeze([
  '.claude/commit.json', '.claude/settings.json', '.claude/CLAUDE.md',
]);

// Hidden exceptions without a `/`: file names, matched against the last path segment at
// any depth. A trailing `*` matches any rest of the name.
const EXCEPTED_NAMES = Object.freeze([
  '.gitignore', '.gitattributes', '.editorconfig',
  ...ENV_TEMPLATES,
  '.nvmrc',
  '.eslintrc*', '.eslintignore', '.prettierrc*', '.prettierignore', '.stylelintrc*',
  '.markdownlint*', '.commitlintrc*', '.lintstagedrc*',
  '.gitlab-ci.yml', '.travis.yml',
]);

/**
 * The `.env` rule: `.env` and `.env.*` are hidden wherever they are, even inside an
 * excepted directory, except the three templates.
 *
 * @param {string} name the last path segment
 * @returns {boolean}
 */
function isEnvFile(name) {
  return (name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATES.includes(name);
}

/**
 * @param {string} name
 * @param {string} pattern
 * @returns {boolean}
 */
function nameMatches(name, pattern) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isHidden(path) {
  const segments = path.split('/');
  const name = segments.pop();
  if (isEnvFile(name)) {
    return true;
  }
  if (EXCEPTED_PATHS.includes(path) || EXCEPTED_DIRS.some((dir) => path.startsWith(`${dir}/`))) {
    return false;
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    return true;
  }
  return name.startsWith('.') && !EXCEPTED_NAMES.some((pattern) => nameMatches(name, pattern));
}

/**
 * Split untracked or staged-new paths into the hidden ones and the candidates. Mode-free;
 * input order is kept within each list.
 *
 * @param {readonly string[]} paths repo-relative, forward slashes
 * @returns {{ candidates: string[], hidden: string[] }}
 */
export function hideFilter(paths) {
  const candidates = [];
  const hidden = [];
  for (const path of paths) {
    (isHidden(path) ? hidden : candidates).push(path);
  }
  return { candidates, hidden };
}

// C:summary-only-files rule 1: lockfile names, matched on the last path segment (any
// directory).
const LOCKFILES = Object.freeze([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
]);

// Rule 5 (`lines`) and rule 6 (`size`, Q19): exactly at the boundary is not over.
const LINES_CAP = 1000;
const SIZE_CAP_BYTES = 262144; // 256 KB

/**
 * The reason a file is summary-only, in C:summary-only-files order (first match wins).
 *
 * @param {string} path repo-relative, forward slashes
 * @param {{ added: number, deleted: number, generated: boolean, size: number }} stats
 *   `added`/`deleted`: changed-line counts from the diff (their sum is the `lines` rule).
 *   `generated`: the `linguist-generated` `.gitattributes` flag. `size`: the file's byte
 *   size (its new content; deletions use the old content's size), the `size` rule.
 * @returns {'lockfile'|'minified'|'sourcemap'|'generated'|'lines'|'size'|null}
 */
export function summaryOnly(path, stats) {
  const name = path.split('/').pop();
  if (LOCKFILES.includes(name)) {
    return 'lockfile';
  }
  if (name.includes('.min.')) {
    return 'minified';
  }
  if (name.endsWith('.map')) {
    return 'sourcemap';
  }
  if (stats.generated) {
    return 'generated';
  }
  if (stats.added + stats.deleted > LINES_CAP) {
    return 'lines';
  }
  if (stats.size > SIZE_CAP_BYTES) {
    return 'size';
  }
  return null;
}

// bucketOf: path-derived grouping hints only (Q11), never a grouping rule. Checked in this
// order: `test`, `ci`, `docs`, `build`, else `code`. `spec`/`specs` is deliberately not a
// test segment: unlike `test`/`tests`, it also names non-test directories (this repo's own
// `docs/spec`), so RSpec (`*_spec.rb`), Go (`*_test.go`) and pytest (`test_*.py`) files are
// caught by their name pattern instead, alongside `*.test.*`/`*.spec.*`.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__']);

const CI_DIRS = Object.freeze([
  '.github/workflows/', '.circleci/', '.gitlab/', '.buildkite/', '.gitea/workflows/',
  '.forgejo/workflows/', '.woodpecker/',
]);
const CI_NAMES = Object.freeze(['.gitlab-ci.yml', '.travis.yml', '.drone.yml', 'Jenkinsfile']);

const BUILD_NAMES = Object.freeze([
  ...LOCKFILES,
  'package.json', 'Cargo.toml', 'pyproject.toml', 'Gemfile', 'composer.json', 'go.mod',
  'Dockerfile', 'Makefile', 'tsconfig.json',
]);
const BUILD_CONFIG_SUFFIXES = Object.freeze(['.config.js', '.config.mjs', '.config.cjs', '.config.ts']);

/**
 * @param {string} path
 * @returns {boolean}
 */
function isTestPath(path) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  return segments.some((segment) => TEST_SEGMENTS.has(segment))
    || name.includes('.test.') || name.includes('.spec.')
    || name.endsWith('_spec.rb') || name.endsWith('_test.go')
    || (name.startsWith('test_') && name.endsWith('.py'));
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isCiPath(path) {
  const name = path.split('/').pop();
  return CI_DIRS.some((dir) => path.startsWith(dir)) || CI_NAMES.includes(name);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDocsPath(path) {
  const name = path.split('/').pop();
  return path === 'docs' || path.startsWith('docs/') || name.endsWith('.md') || name.endsWith('.mdx');
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isBuildName(name) {
  return BUILD_NAMES.includes(name) || BUILD_CONFIG_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * A path-derived grouping hint (C:plan `bucket`), never a grouping rule (Q11).
 *
 * @param {string} path repo-relative, forward slashes
 * @returns {'code'|'test'|'docs'|'ci'|'build'}
 */
export function bucketOf(path) {
  if (isTestPath(path)) {
    return 'test';
  }
  if (isCiPath(path)) {
    return 'ci';
  }
  if (isDocsPath(path)) {
    return 'docs';
  }
  if (isBuildName(path.split('/').pop())) {
    return 'build';
  }
  return 'code';
}
