# Untracked files

Source: `git ls-files --others --exclude-standard` (gitignored files are never seen). In
`split` and `staged` mode the **staged-new** paths go through the same rules: every path the
real index adds relative to HEAD (`git diff --cached --no-renames --name-only --diff-filter=A
-z`; on an unborn HEAD every path in the real index), gitignored or not (a force-added file is
listed). In `split` they count toward the caps together with the untracked candidates, and a
staged-new path that is hidden or falls in a collapsed directory goes to `plan.stagedExcluded`
instead of `untracked`. In `staged` only the hidden rule applies: a hidden staged-new path
refuses the run with `staged-hit`; the count cap does not apply, since the set is not grouped
(Q10, Q11). `plan` runs these rules once and stores the resulting lists in the state file;
later subcommands use the stored lists (Q11).

| Category | Rule | Worker sees it |
| --- | --- | --- |
| hidden | a path segment starts with `.`, unless it is a hidden exception; `.env` and `.env.*` always, except the three templates below | no (count and 5 names in `plan`) |
| candidate | everything else, with `binary: true\|false` | yes |

Hidden exceptions: `.github/**`, `.gitignore`, `.gitattributes`, `.editorconfig`,
`.env.example`, `.env.sample`, `.env.template`, `.claude/commit.json`,
`.claude/settings.json`, `.claude/CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`,
`.claude/commands/**`, `.claude/hooks/**`; committed tooling dotfiles (story 153):
`.changeset/**`, `.husky/**`, `.nvmrc`, `.devcontainer/**`; lint and format rc files
`.eslintrc*`, `.eslintignore`, `.prettierrc*`, `.prettierignore`, `.stylelintrc*`,
`.markdownlint*`, `.commitlintrc*`, `.lintstagedrc*`; CI directories and files
`.circleci/**`, `.gitlab/**`, `.buildkite/**`, `.gitea/**`, `.forgejo/**`,
`.woodpecker/**`, `.gitlab-ci.yml`, `.travis.yml`.
Any other path under `.claude/`, including `settings.local.json`, is hidden.

Count cap (`split`), over candidates and staged-new paths together; a collapsed group is
neither planned nor scanned. Its untracked candidates are reported in `untracked.collapsed`
(`{ dir, count, bytes }`) and its staged-new paths in `stagedExcluded` (`{ dir, count,
reason: "collapsed" }`), each counting only its own kind: a directory holding only
staged-new paths appears in `stagedExcluded` alone, one holding both appears in both.

1. A **new directory** is one that holds no path at HEAD (the tracked directories come from
   `git ls-tree -r -d --name-only HEAD`; on an unborn HEAD every directory is new). Each
   new path belongs to its topmost new ancestor directory, if any, else it is **loose**
   (its parent directory exists at HEAD).
2. More than 50 in one topmost new directory → that directory is collapsed.
3. More than 50 loose files directly at the repo root → collapsed as `"dir": "."` ("N
   untracked files at repo root"). Loose files in any other directory are never collapsed
   by this step.
4. Still more than 200 in total → collapse the largest remaining new directories until the
   total is at most 200; if loose files alone still exceed it, collapse them per parent
   directory (`"dir": "src/icons"`, its direct files only), largest first.

Ties break by path (byte-wise). Tests: `packages/new-lib/` with 60 new files next to one new
file in the tracked `packages/app/src/` → only `packages/new-lib` collapsed; 51 new files in
the tracked `db/migrations/` → none collapsed; 51 new root files → `"."`; 300 files staged
into a new `dist/` by `git add -A` → collapsed, in `stagedExcluded`; a 60-file new
directory under `--staged` → no collapse.

All globs and names match case-sensitively on every OS.
