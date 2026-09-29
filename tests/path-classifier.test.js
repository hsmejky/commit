'use strict';

// M9 path classifier, Seam 3 (in-process, table-driven) against the hidden rules and
// hidden exceptions of C:untracked-files.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let hideFilter;

before(async () => {
  ({ hideFilter } = await loadLib('path-classifier'));
});

// Each row: a repo-relative path and its expected category.
const table = [
  // No dot segment.
  { path: 'src/index.js', category: 'candidate' },
  { path: 'README.md', category: 'candidate' },
  { path: 'src/file.with.dots.js', category: 'candidate' },

  // Hidden rule: a path segment starts with `.`.
  { path: '.DS_Store', category: 'hidden' },
  { path: '.idea/workspace.xml', category: 'hidden' },
  { path: '.vscode/settings.json', category: 'hidden' },

  // Hidden exceptions, one row each (C:untracked-files).
  { path: '.github/workflows/ci.yml', category: 'candidate' },
  { path: '.gitignore', category: 'candidate' },
  { path: '.gitattributes', category: 'candidate' },
  { path: '.editorconfig', category: 'candidate' },
  { path: '.env.example', category: 'candidate' },
  { path: '.env.sample', category: 'candidate' },
  { path: '.env.template', category: 'candidate' },
  { path: '.claude/commit.json', category: 'candidate' },
  { path: '.claude/settings.json', category: 'candidate' },
  { path: '.claude/CLAUDE.md', category: 'candidate' },
  { path: '.claude/agents/reviewer.md', category: 'candidate' },
  { path: '.claude/skills/deploy/SKILL.md', category: 'candidate' },
  { path: '.claude/commands/release.md', category: 'candidate' },
  { path: '.claude/hooks/check.sh', category: 'candidate' },
  { path: '.changeset/brave-cats-sing.md', category: 'candidate' },
  { path: '.husky/pre-commit', category: 'candidate' },
  { path: '.nvmrc', category: 'candidate' },
  { path: '.devcontainer/devcontainer.json', category: 'candidate' },
  { path: '.eslintrc', category: 'candidate' },
  { path: '.eslintrc.json', category: 'candidate' },
  { path: '.eslintignore', category: 'candidate' },
  { path: '.prettierrc', category: 'candidate' },
  { path: '.prettierrc.yaml', category: 'candidate' },
  { path: '.prettierignore', category: 'candidate' },
  { path: '.stylelintrc.json', category: 'candidate' },
  { path: '.markdownlint.json', category: 'candidate' },
  { path: '.commitlintrc.js', category: 'candidate' },
  { path: '.lintstagedrc', category: 'candidate' },
  { path: '.circleci/config.yml', category: 'candidate' },
  { path: '.gitlab/merge_request_templates/default.md', category: 'candidate' },
  { path: '.buildkite/pipeline.yml', category: 'candidate' },
  { path: '.gitea/workflows/ci.yml', category: 'candidate' },
  { path: '.forgejo/workflows/ci.yml', category: 'candidate' },
  { path: '.woodpecker/ci.yml', category: 'candidate' },
  { path: '.gitlab-ci.yml', category: 'candidate' },
  { path: '.travis.yml', category: 'candidate' },

  // `.env` and `.env.*` always hidden, except the three templates.
  { path: '.env', category: 'hidden' },
  { path: '.env.local', category: 'hidden' },
  { path: '.env.production', category: 'hidden' },
  { path: 'config/.env', category: 'hidden' },
  { path: 'config/.env.example', category: 'candidate' },
  // "Always": the `.env` rule wins over a directory exception.
  { path: '.github/.env', category: 'hidden' },
  { path: '.github/workflows/.env.ci', category: 'hidden' },
  { path: '.github/.env.example', category: 'candidate' },

  // Every other path under `.claude/` is hidden.
  { path: '.claude/settings.local.json', category: 'hidden' },
  { path: '.claude/todos/list.json', category: 'hidden' },
  { path: '.claude/commit.json.bak', category: 'hidden' },
  { path: '.claude/.env.example', category: 'hidden' },
  { path: '.claude/agents/.env', category: 'hidden' },

  // Case-sensitive on every OS. `.ENV` is not the `.env` rule: the dot rule still hides it
  // at the root, and inside an excepted directory it stays a candidate.
  { path: '.ENV', category: 'hidden' },
  { path: '.github/.ENV', category: 'candidate' },
  { path: '.Env.example', category: 'hidden' },
  { path: '.GITHUB/workflows/ci.yml', category: 'hidden' },
  { path: '.Claude/commit.json', category: 'hidden' },
  { path: '.claude/claude.md', category: 'hidden' },
  { path: '.ESLINTRC.json', category: 'hidden' },

  // A hidden directory segment anywhere in the path hides it.
  { path: 'src/.cache/x', category: 'hidden' },
  { path: 'a/b/.tmp/c/d.txt', category: 'hidden' },
  { path: '.cache/.gitignore', category: 'hidden' },
  { path: 'packages/app/.github/workflows/ci.yml', category: 'hidden' },
  { path: 'packages/app/.claude/commit.json', category: 'hidden' },
  // A file-name exception holds at any depth outside hidden directories.
  { path: 'src/.gitignore', category: 'candidate' },
  { path: 'packages/app/.eslintrc.json', category: 'candidate' },
  { path: 'src/.envrc', category: 'hidden' },

  // Near misses: segment-boundary and `.env.*` edges.
  // A near-miss directory name is not the exception itself, so the dot rule still applies.
  { path: '.githubx/a', category: 'hidden' },
  { path: '.claude/agents-old/a', category: 'hidden' },
  // `dir/**` excepts every path below it, dot-directories included; only the `.env` rule
  // can still hide a path there.
  { path: '.github/.cache/x', category: 'candidate' },
  // `.env.*` is hidden for any suffix, not only the three templates.
  { path: '.env.example.local', category: 'hidden' },
  // `.envrc` is not an `.env.*` name (no dot after `env`); the plain dot rule hides it.
  { path: '.envrc', category: 'hidden' },
];

test('hideFilter keeps input order within each list', () => {
  assert.deepEqual(hideFilter(['b.js', '.env', 'a.js', '.DS_Store', '.gitignore']), {
    candidates: ['b.js', 'a.js', '.gitignore'],
    hidden: ['.env', '.DS_Store'],
  });
});

test('hideFilter of no paths is two empty lists', () => {
  assert.deepEqual(hideFilter([]), { candidates: [], hidden: [] });
});

for (const { path, category } of table) {
  test(`hideFilter: ${JSON.stringify(path)} is ${category}`, () => {
    const expected = category === 'hidden'
      ? { candidates: [], hidden: [path] }
      : { candidates: [path], hidden: [] };
    assert.deepEqual(hideFilter([path]), expected);
  });
}

test('path-classifier.mjs is pure', () => {
  assertPureSource('path-classifier');
});
