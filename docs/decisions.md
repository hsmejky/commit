# Design decisions

Architecture decision records for `commit`. Each entry gives the context, the decision, the
alternatives that were rejected, and the consequences. Q1–Q16 come from the original design
review; later entries record decisions made during implementation.

Decisions and reasons only.

## Contents

- [Q1 Skill plus a deterministic script](#q1-skill-plus-a-deterministic-script)
- [Q2 Model invocation stays on](#q2-model-invocation-stays-on)
- [Q3 Guard hook against direct git commit](#q3-guard-hook-against-direct-git-commit)
- [Q4 Hook allowlist, no env switch](#q4-hook-allowlist-no-env-switch)
- [Q5 Configurable rules, inferred from history](#q5-configurable-rules-inferred-from-history)
- [Q6 Config layers and keys](#q6-config-layers-and-keys)
- [Q7 commit-config skill](#q7-commit-config-skill)
- [Q8 Naming](#q8-naming)
- [Q9 Script interface](#q9-script-interface)
- [Q10 Secret and local-path scan](#q10-secret-and-local-path-scan)
- [Q11 Atomic commits by functionality](#q11-atomic-commits-by-functionality)
- [Q12 Planner subagent and model](#q12-planner-subagent-and-model)
- [Q13 Hook performance and trailers](#q13-hook-performance-and-trailers)
- [Q14 Per-repo opt-out](#q14-per-repo-opt-out)
- [Q15 Repository layout](#q15-repository-layout)
- [Q16 One confirmation at most](#q16-one-confirmation-at-most)
- [Open verification items](#open-verification-items)

## Q1 Skill plus a deterministic script

- **Context.** A prompt-only commit skill does untracked categorisation, regex secret scanning
  and split detection "by eye". Secret scanning is a safety gate and must not be best effort.
- **Decision.** One zero-dependency Node script (Node 18+) does the deterministic work; the
  skill does judgement (type, subject, grouping). Tests use `node:test`.
- **Rejected.** A prompt-only skill with no tests beyond the manifest.
- **Consequences.** The scan is testable and repeatable; Claude reads a compact report instead
  of scanning a full diff itself.

## Q2 Model invocation stays on

- **Context.** With `disable-model-invocation: true`, "commit this" never reaches the skill and
  the harness's built-in commit flow runs instead, which is what the plugin replaces.
- **Decision.** Auto-invocation on, with a short description (about 200 characters): triggers
  plus one sentence. Details live in SKILL.md.
- **Rejected.** Explicit `/commit` only.
- **Consequences.** A few dozen tokens of description per session.

## Q3 Guard hook against direct git commit

- **Context.** Description-based triggering is probabilistic; in practice the agent often
  commits without the skill unless told to use it.
- **Decision.** A tuned description plus a `PreToolUse` hook, matcher `Bash|PowerShell`, that
  denies a direct `git commit` and tells the agent to use the skill. The skill commits through
  the script, which calls git via `child_process`, so the hook does not see it as a direct
  commit. Detection covers `git.exe`, `& git`, `git -C <path>`, `git -c k=v` and compound
  commands (`&&`, `;`, `|`). False positives such as `echo "git commit"` are accepted; a deny
  costs one turn.
- **Rejected.** Description tuning alone; the hook alone.
- **Consequences.** The agent cannot bypass the skill. The hook sees only agent tool calls, so
  commits made by hand in a terminal are unaffected.

## Q4 Hook allowlist, no env switch

- **Context.** Some legitimate commits are outside the skill's scope: finishing a merge or
  rebase, an amend or fixup the user asked for.
- **Decision.** The hook lets `git commit` through with `--no-edit`, `--amend`, `--fixup`,
  `--squash`, or `-C`/`-c <commit>`. It blocks only commits that write a new message (`-m`,
  `-F`, no flags). `git revert`, `cherry-pick` and `merge` do not call `git commit` and are not
  affected.
- **Rejected.** A global env switch (`COMMIT_GUARD=off`).
- **Consequences.** The emergency brake is `/plugin disable`.

## Q5 Configurable rules, inferred from history

- **Context.** The default style (no scope, no body, no footer) suits some repos; others
  require a scope or want a body.
- **Decision.** Rules are configurable, and a separate skill infers a config from git history.
  Co-Authored-By follows Claude Code's own settings (`attribution.commit`, falling back to the
  deprecated `includeCoAuthoredBy`) across user, project and local settings.
- **Rejected.** Hard-coded opinionated rules; reading `commitlint.config.*` (executing
  third-party JS config).
- **Consequences.** Without an attribution setting, commits carry the harness default footer.

## Q6 Config layers and keys

- **Decision.** Two layers: user `~/.claude/commit.json` overridden per key by repo
  `.claude/commit.json`. Keys:
  - `types`: array of Conventional Commits types
  - `scope`: `"forbidden" | "optional" | "required"`
  - `body`: `"forbidden" | "optional"`
  - `maxSubjectLength`: number
  - `subjectCase`: `"lower" | "any"`
  - `scanIgnore`: array of path globs (Q10)
  - `plannerModel`: `"sonnet" | "haiku" | "inherit"` (Q12)

  An unknown key is an error. Defaults: the eleven standard types, no scope, no body, 72
  characters, lowercase.
- **Rejected.** Repo only; a third local layer (commit style is shared by nature).
- **Consequences.** The repo is the team's source of truth; the user layer covers repos
  without a config.

## Q7 commit-config skill

- **Decision.** A separate skill `commit-config`, `disable-model-invocation: true`. The script's
  `infer` subcommand reads the last 200 non-merge commits and measures the share in
  Conventional Commits format, types used, share with a scope, share with a body, p95 subject
  length and subject case. Thresholds:
  - scope `required` at 90% or more, `optional` at 10% or more, else `forbidden`
  - body `optional` at 10% or more, else `forbidden`
  - `maxSubjectLength` = p95 rounded up to 72 or 100
  - `types` = standard types that were used, plus non-standard ones at 5% or more

  Claude shows the proposal with the numbers, asks whether to write it at repo or user level,
  and writes only after confirmation. Below 20 commits or below 50% Conventional Commits it
  proposes nothing and recommends the defaults.
- **Rejected.** A `/commit init` subcommand (mixes two modes in one prompt and enlarges the
  auto-loaded description).

## Q8 Naming

- **Decision.** `commit` everywhere: repository, marketplace, plugin and the main skill; the
  second skill is `commit-config`. Install with `commit@commit`.
- **Rejected.** A distinctive plugin name such as `commit-guard`; `conventional-commit`.
- **Consequences.** A clash with another plugin's `/commit` resolves through namespacing
  (`/commit:commit`).

## Q9 Script interface

- **Decision.** Subcommands of the shared script:
  - `plan` (read-only, JSON): clean flag, pre-staged set, tracked-modified files, untracked
    files by category (code/doc, config, hidden count), merged config and its source,
    attribution trailer, scan hits, file buckets and hunks, the last 10 subjects.
  - `commit --subject … [--body …]`: lints the message against the config and exits non-zero
    with a concrete reason on violation, runs a final scan of the index, appends the trailer
    per attribution settings, and commits with `git commit -F -` (message on stdin, no shell
    escaping, safe in PowerShell).
  - `stage --hunks <ids>` (Q11) and `infer` (Q7).

  Claude does the staging with `git add` / `git restore --staged`.
- **Rejected.** The script doing the staging itself via `git commit --only -- <files>`, which
  discards partially staged hunks and duplicates git.
- **Consequences.** Nothing is committed without passing lint and scan, even if the prompt's
  rules are ignored. Prompt rules only help get it right the first time.

## Q10 Secret and local-path scan

- **Decision.**
  - Scan only added lines of the staged diff; skip binary files.
  - Exceptions: `scanIgnore` globs in the config (reviewable in a PR) and an inline
    `commit-scan: allow` marker.
  - No CLI override flag; an agent would add it to itself on refusal.
  - `plan` reports hits and the skill unstages affected files, printing `path:line — pattern`;
    `commit` refuses on a hit as a backstop.
  - Patterns: AWS access key, GitHub token, Slack token, generic secret assignment, connection
    string with credentials, private key header, local user paths including forward-slash and
    any-case drive-letter variants.
- **Rejected.** Using gitleaks when installed (breaks zero-deps and behaves differently per
  machine).
- **Consequences.** This repo's own fixtures with fake secrets live under `tests/fixtures/`, and
  the repo config lists that in `scanIgnore`.

## Q11 Atomic commits by functionality

- **Context.** Splitting by top-level directory flags almost every change in a layout where
  code, tests and docs live in separate folders. The goal is atomic commits by functionality,
  across folders, which is semantic.
- **Decision.** Grouping is Claude's job. The script supplies buckets (`code`, `test`, `docs`,
  `ci`, `build`) as hints only. Hunk-level staging: `plan` returns hunks with IDs
  (`file#n`, range, short content hash); `stage --hunks` builds a patch from the chosen hunks
  and runs `git apply --cached`, refusing when a hash is stale. Per group: reset the index,
  stage, commit. A pre-staged set is respected as-is and never regrouped. Delivered in two
  slices: file-level grouping first, hunk-level staging second.
- **Rejected.** A top-level-directory split rule; dropping split detection.
- **Consequences.** Tests must cover adjacent hunks, new, deleted and renamed files, and binary
  files (whole file only).

## Q12 Planner subagent and model

- **Context.** The main cost of reading a diff in the main thread is not the model price: the
  diff stays in context for every later turn.
- **Decision.** The plugin ships an agent `commit-planner` (`model: sonnet`, tools `Bash` and
  `Read`). It reads the `plan` output and the diff and returns compact JSON: groups with type,
  subject, optional body, hunks or files, and a one-line reason. The main thread never reads
  the diff. On a lint rejection the error goes back to the planner, one retry. `plannerModel`
  overrides the model.
- **Rejected.** `model:` in the skill frontmatter (switches the main session model and does not
  help with context); `context: fork` for the whole skill (cannot ask for confirmation);
  Haiku by default (grouping is semantic and lint cannot catch a bad split).
- **Consequences.** Roadmap: an eval set of fixture diffs with known correct splits to measure
  Haiku against Sonnet. Version 1.0.0 waits on that eval.

## Q13 Hook performance and trailers

- **Context.** The hook runs on every shell tool call in every repo where the plugin is
  enabled.
- **Decision.** Use a hook `if` condition (`Bash(git *)`, `PowerShell(git *)`) if it reliably
  catches compound commands; otherwise match without `if` and exit early in the script when the
  command does not contain `commit`. Reliable detection beats saved milliseconds. The lint
  rejects any trailer (such as `Co-Authored-By:`) in the body; only the script adds trailers.
- **Consequences.** A harness instruction to add a footer has no path into the message.

## Q14 Per-repo opt-out

- **Decision.** Use Claude Code's built-in `enabledPlugins` (`"commit@commit": false` in a
  project's `.claude/settings.local.json`). No code, a README section only.
- **Rejected.** A `guard` config key with a local config layer; path-based excludes in the user
  config.
- **Consequences.** Opting out disables the whole plugin in that repo, skill included.

## Q15 Repository layout

- **Decision.**

  ```
  .claude-plugin/marketplace.json
  .claude/CLAUDE.md
  .github/workflows/test.yml          ubuntu + windows × Node 18/22/24
  plugin/.claude-plugin/plugin.json
  plugin/scripts/commit.js            shared by skills, agent and hook
  plugin/scripts/guard.js
  plugin/hooks/hooks.json
  plugin/agents/commit-planner.md
  plugin/skills/commit/SKILL.md (+ REFERENCE.md)
  plugin/skills/commit-config/SKILL.md
  docs/architecture.md, decisions.md, roadmap.md, testing.md
  tests/*.test.js, LICENSE (MIT), README.md
  ```

  Tests build git repos in temp directories at run time (fixed author and dates via env).
  Minimum git version 2.23. A privacy-guard test keeps local paths and usernames out of docs,
  README and manifests. Start at version 0.1.0.
- **Consequences.** The plugin applies its own rules to itself.

## Q16 One confirmation at most

- **Decision.** The planner receives tracked changes plus untracked `code/doc` and `config`
  candidates (hidden files never). It places untracked files into groups marked as new, or
  into a `not included` list with a reason. The user sees one block and answers
  `yes / edit / one`. No confirmation at all when there is one group, no untracked file is
  included and nothing was flagged by the scan. A pre-staged set skips grouping and commits
  without a prompt.
- **Rejected.** Always asking; never including untracked files without an explicit request.

## Open verification items

- Whether a hook `if` condition catches compound commands (`cd x && git commit`,
  `& git commit`). Decides between Q13's two variants.
- That a `!`-prefixed command in the prompt does not trigger the hook (manual check).
