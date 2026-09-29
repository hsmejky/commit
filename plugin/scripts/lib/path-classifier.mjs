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
