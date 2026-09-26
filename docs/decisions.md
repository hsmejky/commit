# Design decisions

Architecture decision records for `commit`. Each entry gives the context, the decision, the
alternatives that were rejected, and the consequences. Q1–Q16 come from the original design
review; the entries were refined over ten design reviews on 2026-09-26 (the reports are
kept out of history, Q15). Q24 (token budget) moved the run into one worker agent and
supersedes Q12 in part; Q25 fixes the worker protocol. Data shapes, grammars and
classification tables live in [`contracts.md`](contracts.md).

## Contents

- [Q1 Skill plus a deterministic script](#q1-skill-plus-a-deterministic-script)
- [Q2 Model invocation on the worker agent](#q2-model-invocation-on-the-worker-agent)
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
- [Q17 Commits from a subagent](#q17-commits-from-a-subagent)
- [Q18 Failures, repo hooks and signing](#q18-failures-repo-hooks-and-signing)
- [Q19 Large diffs](#q19-large-diffs)
- [Q20 Reword via amend](#q20-reword-via-amend)
- [Q21 Repo states](#q21-repo-states)
- [Q22 Concurrent runs](#q22-concurrent-runs)
- [Q23 Guard heartbeat](#q23-guard-heartbeat)
- [Q24 Token budget](#q24-token-budget)
- [Q25 Worker protocol](#q25-worker-protocol)
- [Non-goals](#non-goals)
- [Public surface](#public-surface)
- [Open verification items](#open-verification-items)

## Q1 Skill plus a deterministic script

- **Context.** A prompt-only commit skill does untracked categorisation, regex secret scanning
  and split detection "by eye". On the plugin path, secret scanning is a gate and must not be
  best effort.
- **Decision.** One zero-dependency Node script (Node 22+) does the deterministic work; the
  `commit-worker` agent does judgement (type, subject, grouping, Q24). Tests use
  `node:test`. Node is a documented hard requirement: the native Claude Code installer does
  not ship it.
- **Rejected.** A prompt-only skill with no tests beyond the manifest. A guard written in pure
  shell to survive a missing Node (needs sh and PowerShell twins, doubling the test surface).
- **Consequences.** The scan is testable and repeatable; Claude reads a compact report instead
  of scanning a full diff itself. Without Node the hook fails non-blocking and the guard is
  off; the worker fails loudly on its first `plan`, and its prompt tells it to reply that
  Node is missing and the guard is off too. `plan` reports the Node and git versions and
  whether the guard actually ran (Q23); `COMMIT_GUARD_DEBUG=1` makes the guard log each
  decision to stderr.

## Q2 Model invocation on the worker agent

- **Context.** With nothing model-invoked, "commit this" never reaches the plugin and the
  harness's built-in commit flow runs instead, which is what the plugin replaces.
- **Decision.** Revised by Q24. The `commit-worker` agent carries the auto-invocation: a
  short description (at most 200 characters, a CI size test). Its clauses, in the order
  they are kept (a draft of all six is about 185 characters):
  1. "follow the reply's `callerRule`": the only trusted text behind the handback protocol
     (Q25); never cut.
  2. The triggers: without them the description never fires.
  3. The `intent` field: it also scopes what a `split` run commits (Q16), so without it
     the worker plans every change in the tree.
  4. "edit no files until it replies" (Q25): `diff-changed` is the backstop, at the cost
     of a whole run.
  5. The `interactive` field (Q17): without it a subagent still follows `ifNoUser`, one
     call dearer.
  6. "don't read the diff first" (commit-worker spike): cost only.

  When the prompt slice has to shorten, it cuts from the bottom. "The reply is final" is
  not a clause: the base `callerRule` says it on every reply (Q25). The
  `/commit` skill has `disable-model-invocation: true`: it is loaded only when the user
  types `/commit`, and it does the same spawn. Its arguments map to the worker input, and
  SKILL.md never adds an `intent` of its own, whatever the session did before:

  | Typed | Worker input |
  | --- | --- |
  | `/commit` | no `intent`: every change is planned (Q16) |
  | `/commit <text>` | `intent: <text>` |
  | `/commit reword` | `reword: true` |
  | `/commit reword <text>` | `reword: <text>` (dictated; text that fails lint reaches `lintFailed`, Q20) |

  An explicit `/commit` is the user asking to commit what is in the tree, the caller Q16
  describes as "omits it". Fixture (Q17's eval set): Claude implemented X, the user
  hand-edited Y, then typed `/commit` → both planned, Y not in `not included`.
- **Rejected.**
  - SKILL.md filling in `intent` from the session's recent work: the user's own hand edit
    goes to `not included` ("not part of the intent"), and with one group and no new file
    nothing asks, so X is committed alone and Y is silently left behind.
  - A model-invoked `/commit` skill (the design before Q24): its description and
    SKILL.md sit in the main context, and it adds a main-thread call before the spawn.
  - Explicit `/commit` only: the model would fall back to plain `git commit` and meet the
    guard every time.
- **Consequences.** A few dozen tokens of agent description per session. The commit-worker
  spike saw 7 of 7 commit requests spawn the worker from its description (open
  verification items); the dogfood runs measure the real rate and the deny share (Q24).

## Q3 Guard hook against direct git commit

- **Context.** Description-based triggering is probabilistic; in practice the agent often
  commits without the plugin unless told to use it.
- **Decision.** A tuned description plus a `PreToolUse` hook, matcher `Bash|PowerShell`, that
  denies a direct `git commit` and tells the agent to spawn the `commit-worker` agent (Q24;
  messages in [contracts](contracts.md#guard)). The message never offers `/commit`: the
  model cannot invoke it (Q2), and it is the user's entry point. The worker commits through
  the script, which calls git via `child_process`, so the hook does not see it as a direct
  commit. The hook fires for subagent tool calls as well.
  - Detection tokenises the command ([contracts](contracts.md#guard)) with the quoting rules
    of the shell named in `tool_name` (Bash: `\` escapes, `'…'` literal; PowerShell: `` ` ``
    escapes, `''` inside `'…'`, here-strings), segments split on `&&`, `||`, `;`, `|`, `&`
    and newlines; `git` / `git.exe` at any path,
    with or without the `&` call operator; git global options (`-C`, `-c`, `--git-dir`,
    `--work-tree`, `--no-pager`, `-P`, …) skipped before the subcommand. An unknown global
    option followed by a `commit` token is denied (fail closed).
  - Output: a `deny` decision with a fixed message, or nothing. The hook never returns
    `allow`, so the user's permission prompts still apply. A crash or unreadable hook input
    exits 0 with no output (fail open): a guard bug must not block every shell call.
  - False positives such as `echo "git commit"` are accepted; a deny costs one turn.
- **Rejected.**
  - Description tuning alone; the hook alone.
  - Git-native enforcement (a `pre-commit` / `commit-msg` hook, e.g. via `core.hooksPath`).
    It would also hit manual commits, needs a per-repo install, and clashes with husky and
    other hook managers.
- **Consequences.** The hook **steers** the agent to the worker; it is not a security boundary.
  Lint and scan are a gate only on the plugin path. Accepted gaps:
  - Every allowed form (`--no-edit`, `--amend --no-edit`, `--fixup=<commit>`, Q4) commits the
    current index unscanned: `git add . && git commit --amend --no-edit` gets past lint and
    scan.
  - Aliases (`git ci`), `git -c alias.x=commit x`.
  - Commands run through another interpreter: `sh -c`, `bash -c`, `cmd /c`, `pwsh -c`,
    `xargs git commit`, scripts that wrap git.
  - Command substitution (`$(…)`, backticks); `GIT_DIR` / `GIT_WORK_TREE` redirection;
    config injected through env prefixes (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
    `GIT_CONFIG_VALUE_<n>`).

  The hook sees only agent tool calls. Commits made by hand in a terminal, and `!`-prefixed
  prompt commands (verified 2026-09-26: they do not fire `PreToolUse`), are unaffected; they
  are the human-only channel Q10 relies on.

## Q4 Hook allowlist, no env switch

- **Context.** Some legitimate commits are outside the plugin's scope: finishing a merge, a
  fixup the user asked for. A non-interactive agent hangs on any form that opens an editor.
- **Decision.** A strict allowlist; every other form of `git commit` is denied, and the deny
  message names the offending flag. Short flags are expanded before matching (`-am` →
  `-a -m`, `-mfoo` → `-m foo`) and `--opt=value` is split.

  | Form | Extra flags allowed |
  | --- | --- |
  | `--no-edit` | `--amend`, `-q` |
  | `--fixup=<commit>` (plain only) | `-q` |

  Denied therefore: bare `git commit`; anything with `-m`, `-F`, `--message` or `--file`;
  `--amend` / `--squash` without `--no-edit`; `-c <commit>`, `-C <commit>` and
  `--reuse-message`; `--fixup=amend:` and `--fixup=reword:` (both open an editor); `-n` /
  `--no-verify`, `--no-gpg-sign`, `--allow-empty`, `--allow-empty-message`, `-a`, `-t`,
  pathspecs and `--`. Also denied: the git global options `-c <k=v>` and `--config-env`
  before `commit`, whatever the key. `core.hooksPath`, `commit.gpgsign`, `gpg.program` and
  `user.signingkey` each undo a `--no-verify` / `--no-gpg-sign` ban, and a key list would
  always miss one.

  `git revert`, `cherry-pick` and `merge` do not call `git commit` and are not affected. A
  merge with resolved conflicts is finished with `git commit --no-edit` (Q21).
- **Rejected.**
  - A global env switch (`COMMIT_GUARD=off`): the agent can set it itself.
  - "`--no-edit` with any other flags": lets `--no-verify` and `--no-gpg-sign` through,
    which the plugin path forbids (Q18).
  - Allowing `-a` with `--no-edit`: widens the unscanned path for no need; a merge finishes
    without it.
  - `-C <commit>` / `--reuse-message`, with or without `--amend`: without `--amend` it makes a
    new commit whose content is unscanned and whose message is unlinted, with no use case
    in this question's context; with `--amend`, `--no-edit` already covers keeping the
    message.
  - Denying only `-c core.hooksPath=…` and `-c commit.gpgsign=…`: see above.
- **Consequences.** The emergency brake is `/plugin disable`. Rewording goes through the
  worker (Q20). The deny message for `--amend` without `--no-edit` leads with the worker and
  never suggests `--amend --no-edit`, which commits the index unscanned (Q3): "To reword the
  last commit: spawn the commit:commit-worker agent (…). Ask it to reword. To add
  changes, make a new commit the same way." Folding content into an existing commit has no
  plugin path (see [Non-goals](#non-goals)).

## Q5 Configurable rules, inferred from history

- **Context.** The default style (no scope, no body, no footer) suits some repos; others
  require a scope or want a body.
- **Decision.** Rules are configurable, and a separate skill infers a config from git history.
  The attribution trailer follows Claude Code's own settings:
  - Layers, highest first: managed (`managed-settings.json` at the OS path), project
    `.claude/settings.local.json`, project `.claude/settings.json`, user
    `~/.claude/settings.json`. The first layer that defines a key wins. "Project" is the
    directory the harness reads project settings from: `CLAUDE_PROJECT_DIR` when the script
    sees it, else the git toplevel. The two differ when Claude runs in a monorepo subfolder
    (open verification item).
  - Two passes: `attribution.commit` across all layers first, then `includeCoAuthoredBy`
    across all layers. `attribution` wins even when the deprecated key sits in a higher
    layer, matching the harness.
  - `attribution.commit` set: its trailer-shaped lines are used; an empty string means no
    trailer. Other lines (a 🤖 line, blank lines) are dropped with a warning in
    `plan.warnings`, so `body: forbidden` still holds.
  - otherwise `includeCoAuthoredBy: false`: no trailer.
  - otherwise: the fixed trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.

  `plan` reports the trailer and the layer it came from. The script appends it with its own
  footer parser (Q13): into the footer paragraph when the message ends in one, otherwise as
  a new paragraph.
- **Rejected.**
  - Hard-coded opinionated rules; reading `commitlint.config.*` (executes third-party JS).
  - Reproducing the harness default footer: it contains the model name, which the script
    cannot know. Having the worker pass the model name in reopens the path Q13 closes.
  - Appending `attribution.commit` verbatim: a multi-line value becomes body text.
  - `git interpret-trailers --trailer` for appending (Q13).
- **Consequences.** Without an attribution setting the trailer omits the model name. The
  trailer is produced deterministically; no agent-supplied text reaches it. Settings passed
  on the command line (`claude --settings <file>`) are invisible to the script; the README
  says so.

## Q6 Config layers and keys

- **Context.** Commit style is shared by a team, but repos without a config still need
  personal defaults.
- **Decision.** Two layers: user `~/.claude/commit.json` overridden per key by repo
  `.claude/commit.json` (at the git toplevel). Override is per key and replaces the value,
  arrays included.

  | Key | Values | Layer |
  | --- | --- | --- |
  | `types` | non-empty array of lowercase types, each `^[a-z][a-z0-9-]*$` | either |
  | `scope` | `"forbidden" \| "optional" \| "required"` | either |
  | `body` | `"forbidden" \| "optional"` | either |
  | `maxSubjectLength` | integer 20–200, code points of the whole header (`type(scope)!: description`) | either |
  | `subjectCase` | `"lower" \| "any"`, see [contracts](contracts.md#message-grammar) | either |
  | `scanIgnore` | array of path globs (Q10) | repo only |

  - Unknown key: warning (stderr and `plan.warnings`), ignored.
  - Unknown value for a known key (a future `body: "required"`):
    warning, and the key falls back to the next layer, then the default.
  - A key in the wrong layer: warning, ignored.
  - Wrong JSON type (`maxSubjectLength: "72"`), a number out of range or not an integer
    (`0`, `72.5`), an empty `types` array (every commit would fail lint), a malformed
    `types` entry, or unparseable JSON: error.
  - `scanIgnore` is read from the repo config at HEAD (Q10), every other repo key from the
    working tree; `plan` reports its source as `repo@HEAD`.

  Defaults: the commitlint `config-conventional` types (build, chore, ci, docs, feat, fix,
  perf, refactor, revert, style, test), no scope, no body, 72 code points, lowercase. The
  worker's model is not a config key (Q24).
- **Rejected.**
  - Repo only; a third local layer (commit style is shared by nature).
  - Unknown key or value as an error: one teammate on a newer plugin would break every commit
    for teammates on older versions.
  - A `version` key: additive keys and values plus warnings cover forward compatibility.
  - `body: "required"`: forced bodies produce filler on trivial commits, and `infer` has no
    signal that would justify it.
  - A `plannerModel` / `workerModel` key (dropped after the commit-worker spike,
    2026-09-26): the Agent call's `model` parameter does override the agent's frontmatter,
    but the caller that makes the call never reads `commit.json`, so the key would need a
    read in the main thread on every commit, and a handback's `respawn` would lose it. A
    personal cost choice in the repo layer was wrong anyway. Roadmap: Haiku through the
    frontmatter default once the eval allows it (Q12).
- **Consequences.** The repo is the team's source of truth; the user layer covers repos
  without a config. Paths and key names are public surface.

## Q7 commit-config skill

- **Context.** Writing a config by hand means guessing at a team's conventions; the history
  already records them.
- **Decision.** A separate skill `commit-config`, `disable-model-invocation: true`. The script's
  `infer` subcommand reads the last 200 non-merge commits. A commit counts as Conventional
  Commits only when its header matches the lint's header grammar (lowercase type, so `WIP:`
  and `Update:` do not count). The Conventional Commits share is taken over all 200; every
  other share is taken over the Conventional Commits ones only. A footer paragraph (Q13
  grammar) does not count as a body. Thresholds:
  - scope `required` at 90% or more, `optional` at 10% or more, else `forbidden`
  - body `optional` at 10% or more, else `forbidden`
  - `subjectCase` `lower` when 90% or more of descriptions pass the lint's `lower` rule,
    else `any`
  - `maxSubjectLength` = p95 header length in code points, rounded up to 72 or 100; above
    100, rounded up to the next multiple of 10 and flagged in the proposal; clamped to 200
    (the key's maximum, Q6) and flagged
  - `types` = all 11 standard types, plus non-standard ones at 5% or more. Non-standard types
    under 5% are dropped and listed with their counts (`wip: 3`), so the user can add them.

  `infer` lints the commits it read against the proposed config and reports `wouldFail`
  (N of the Conventional Commits ones among the last 200, so it shows the threshold loss
  only; the non-Conventional-Commits count is reported next to it). Claude shows the proposal
  with the numbers ([contracts](contracts.md#infer)), asks whether to write it at repo or user
  level, and writes only after confirmation. Below 20 commits it proposes nothing and
  recommends the defaults. Below 50% Conventional Commits it proposes nothing, says the repo is
  out of scope, and points to the opt-out (Q14).
- **Rejected.**
  - A `/commit init` subcommand (mixes two modes in one prompt and enlarges the auto-loaded
    description).
  - Only the standard types that were used: a repo that never had a `revert` or `perf` commit
    would fail lint on its first one, although the type is standard.
- **Consequences.** Non-Conventional-Commits repos are explicitly unsupported (see
  [Non-goals](#non-goals)). `infer` and lint share the header, case and footer functions, so
  they agree on what each rule means. The thresholds are lossy on purpose: up to 5% of
  headers exceed a p95 length, up to 10% break a 90% `lower` or `required` rule, and
  non-standard types under 5% are dropped. `wouldFail` shows that cost before the config is
  written.

## Q8 Naming

- **Context.** The plugin replaces the harness's commit flow; the name should say so.
- **Decision.** `commit` everywhere: repository, marketplace, plugin and the main skill; the
  second skill is `commit-config`. Install with `commit@commit`.
- **Rejected.** A distinctive plugin name such as `commit-guard`; `conventional-commit`.
- **Consequences.** A clash with another plugin's `/commit` resolves through namespacing
  (`/commit:commit`). `commit@commit` is public surface. A personal
  `~/.claude/skills/commit` (verified visible alongside the plugin in subagents) is, after
  Q24, the only resident commit **skill**, so it takes every "commit this" ahead of the
  worker's agent description. Removing it is a **required** README install step, with that
  reason. Nothing detects it: the guard's deny messages end with a fixed line ("If a
  personal commit skill sent you here, remove it (see the commit plugin README)",
  [contracts](contracts.md#guard)), and `plan` has no warning for it (it runs inside the
  worker, so it would warn only after the costly deny path). The author removes their own
  before implementation; the commit-worker spike and the 1.0.0 dogfood gate (Q24) run on a
  machine without one, or the trigger measurements are contaminated.

## Q9 Script interface

- **Context.** Messages contain newlines, quotes, backticks and non-ASCII text; passing them as
  arguments breaks in PowerShell. The run happens inside the `commit-worker` agent (Q24); the
  main thread sees only the worker's reply and, when a human is needed, runs one
  script-built command (Q25).
- **Decision.** Subcommands of the shared script (shapes in [contracts](contracts.md)). Every
  run keeps its files in one run folder, `<toplevel>/.commit-plan/<planId>/`
  ([contracts](contracts.md#run-folder)): the state file, the hunk text, the temporary index
  (Q11) and the worker plan. Before it creates the folder the first time, the script
  appends a `/.commit-plan/` line to `$(git rev-parse --git-common-dir)/info/exclude`
  (Node writes it, so no prompt), so it never shows up as an untracked file; the hidden
  rule (Q16) would keep it from the worker anyway. Each worktree gets its own folder,
  since it sits in the worktree's top level. `plan` and `plan --hunks` print its
  absolute path as `runDir` (forward slashes), and every file path they print is absolute,
  because `Read` and `Write` need absolute paths and the worker's cwd is not fixed.
  - `plan [--reword [--dictated] | --staged | --split] [--take-over <planId>] [--no-user]`:
    run by the
    worker. Computes file lists, buckets, untracked candidates, merged config and sources,
    attribution, scan results, repo state, signing, environment and the last 10 subjects;
    no hunks and no diff content. Stdout is compact: `plan`'s own fields (`planId`,
    `runDir`, `mode`) within 1 kB, plus a `reply` (≤ 2 kB, and ≤ 4 kB of `text`, Q24)
    when the worker's part ends
    here, or the in-process `plan --hunks` output (≤ 20 000 characters, below) under
    `hunks`; the full output goes to
    `plan.json` in the run folder, which the worker does not read. After the state and
    signing checks (and, with `--reword`, the unborn, merge commit and pushed checks, Q20)
    it mints the `planId` and creates the run folder, because the `split` scan needs the
    temporary index (Q11) in it. When there is work to do it records `HEAD`, stores the
    untracked-candidate, staged-new and index-only lists (Q11), mints the unit IDs with the
    `id → hash` map and the scan map from the very diff it scanned (Q10), stores the
    notices for the reply (guard, signing, warnings) and whether the run has a user
    (`--no-user`, Q17), and takes the run lock (Q22). Having taken it, it goes straight on
    as `plan --hunks` in the same process and prints that output, which saves the worker
    one call on every first spawn (spike: six worker calls for a one-group run, five with
    this). Every outcome without a lock leaves
    no folder behind: refusals before the folder never create one, the rest delete it
    before `plan` exits. What takes the lock:

    | Outcome | Exit | Lock, `planId` |
    | --- | --- | --- |
    | refused repo state (Q21) | 6 `state` | none |
    | signing not ready (Q18) | 6 `signing` | none |
    | `--staged` and the index diff has a pattern hit, or the index holds a staged-new path the hidden rule excludes (Q10, Q11) | 6 `staged-hit` | none |
    | clean tree (nothing plannable, Q16) | 0, `planId: null`, reply `nothing` | none |
    | index and other changes both present, no mode flag | 0, `planId: null`, `modeChoice` handback | none |
    | work to do | 0 | taken |
    | `--reword` succeeds | 0 | taken, also on a clean tree |
    | `--reword` on a pushed HEAD, an unborn HEAD or a merge commit (Q20) | 6 `pushed`, `state` | none |

    Mode: `--reword` (Q20) is needed because a reword usually runs on a clean tree; it also
    runs the pushed and unborn checks before the worker reads any diff. Without a flag,
    `plan` never picks `staged` itself: an empty index gives `split`, an index that holds
    every change also gives `split` (the same set, grouped; a user who wants one commit
    answers `one`, Q16), and an index plus other changes gives a `modeChoice` handback
    (Q25): "N files are staged, M other changes: commit only the staged ones, or group all
    changes within the task?" (with an `intent`, `split` plans only what it covers, Q16),
    whose answers respawn the worker with `mode: staged` or `mode: split`. So
    `staged` is reached only when a human picked it. The handback carries counts only, no
    file lists. A worker without a user runs `plan --split --no-user` (or `--reword
    --no-user`) and never gets a `modeChoice` (Q17). `--take-over <planId>` replaces a live
    lock, and only the one the user was asked about (Q22). A `respawn` that `plan` builds
    repeats the flags of the `plan` call that produced it, besides its own answer: the
    `lock` handback of a `plan --staged` carries `mode: staged` next to `takeOver`, and a
    `modeChoice` produced under `--take-over <planId>` carries `takeOver: <planId>` next to
    `mode`. Without that, `modeChoice`, then `lock`, then `take over` looped: the takeover
    respawn had no mode, got `modeChoice` again (which takes no lock), and the next answer
    had no `takeOver`, so it met the same live lock. `--reword` is the exception: the
    caller adds its own `reword` line (Q25), which also carries a dictated text the script
    never sees.
  - `plan --hunks --plan <planId>`: run inside `plan` on the first spawn, and by the worker
    on every respawn with `resume`. Writes the hunk bodies (within the Q19 cap) to `hunks.txt`
    in the run folder and prints a compact index (ID, path, kind, range, line count, line
    offset in `hunks.txt`); the worker `Read`s the file in pages. Besides the index it repeats
    only what the worker needs from `plan` (`runDir`, `mode`, the lint config, counts,
    `recentSubjects`), not the file lists, which the index covers. The whole output has a
    budget of 20 000 characters of stdout; above it the full index goes to `hunks.json` (one
    entry per line) and stdout carries only counts and the path. It resets the state file's
    lint-failure counter (Q18). It never mints IDs: every run for the `planId`, the first one
    included (then every respawn for `edit` or `one`), re-diffs, and re-emits `plan`'s IDs when
    the hash set equals the map `plan` stored, or refuses with exit 6 `diff-changed` ("files
    changed since plan, run `/commit` again"). So the diff the worker sees is the one `plan`
    scanned: a file edited between the two calls, a hit that moved to another line, or an
    untracked file that grew past the skip limit cannot slip in between. HEAD must still be the
    recorded one, else exit 6 `head-moved`. The mode comes from the state file: `split`
    rebuilds the temporary index from the stored lists (Q11), `staged` diffs the index only
    (pre-staged set), `reword` shows HEAD's own diff (Q20). When a script call fails, the
    worker writes nothing and returns the failure's `reply` (Q25).
  - `check --plan <planId> [--commit]`: reads the worker plan from `plan.groups.json` in the
    run folder; lints every group's message, validates hunk IDs and paths, requires every
    unit to be placed exactly once (`split` only; the single group of a `staged` or `reword`
    run holds every unit implicitly), and **computes** `confirm` (Q16). On success it stores
    the validated groups in the state file: per group the resolved units (hunk IDs, or paths
    in the file-level slice), the normalised message and whether the attribution applies
    (Q20). It clears the stored groups before it validates, so a failed `check` after `edit`
    leaves nothing committable, and it refuses (`usage`) once any group is committed: a
    re-plan after a partial commit would renumber groups over units already in HEAD. Zero
    groups is a valid `split` outcome: `check` then releases the lock itself. With
    `--commit` (the worker always passes it) and `confirm: null`, it goes straight on as
    `commit --all` in the same process; with `confirm` set it commits nothing and returns a
    `confirm` handback, except in a run without a user, where Q17 applies.
  - `commit --plan <planId> --all`: commits every group not yet committed, in order, and
    stops at the first failure (Q18). Per group it checks HEAD and `index.lock` (before
    touching the index, since `reset` and `apply` need the lock too), matches the group's
    hashes against the temporary index (Q11) **before** it touches the real index, then
    resets the real index, stages the group's units, checks that the staged diff is exactly
    the group (Q18), scans the index (backstop), appends the trailers and runs
    `git commit --cleanup=verbatim -F -`. Before each group it refreshes the lock's
    `touched` (Q22). The call has one 540-second budget (Q18): a later group starts only
    while at least 480 s are left, else the call stops cleanly with a `continue` handback
    that runs the same command again. Units and message come from the state file, never from
    an agent's arguments, so only what `check` validated can be committed, unless the agent
    edits the state file (the run folder is agent-writable; Q3: the plugin steers, it is not
    a security boundary). The scan backstop still holds, because it rescans the index and
    reads `scanIgnore` from HEAD. Per mode:
    - `split`: rebuild the temporary index from the lists `plan` stored (Q11) and match,
      then reset, stage, verify, commit.
    - `staged`: the pre-staged set is group 1 and is committed as-is, without reset or
      stage, after checking that the index's hash set still matches the map.
    - `reword`: no match, no reset, no stage, no staged-diff check, no scan; `--amend --only`.
  - `release --plan <planId>`: drops the run lock and deletes the run folder (the `no`
    answer of a handback, Q25).
  - `infer` (Q7).

  A reword with dictated text reads no diff: the worker gets the text in its input
  (`reword: <text>`) and runs `plan --reword --dictated`, which skips the in-process
  `plan --hunks` (HEAD's hunk index, up to 20 000 characters, would reach the worker for
  nothing). It writes the text as a one-group worker plan with `"source": "user"` to
  `plan.groups.json` with the `Write` tool and runs `check --commit`, so `commit` has a
  single input path and the main thread makes no extra call. A lint failure of
  `"source": "user"` text ends the worker's part at once (Q18, Q20).

  No subcommand reads stdin. `plan.groups.json` is written with the `Write` tool, which always
  writes UTF-8, and is read as bytes and normalised before lint: UTF-8 BOM stripped, UTF-16
  decoded when it carries a BOM, CRLF and lone CR turned into LF, trailing blank lines
  trimmed. Invalid UTF-8 is a lint error. Every command the worker runs, and every `run`
  command in a handback, is a single `node … commit.js …` call, so the README's allow rules
  (Q16) match it in Bash and PowerShell alike.

  Every git call runs with `GIT_LITERAL_PATHSPECS=1` in its environment, so a path such as
  `[id].tsx`, `*.js` or `:foo` names exactly that file, and with its `cwd` set to the
  toplevel (`git rev-parse --show-toplevel`, resolved once from wherever the tool ran), so
  `diff.relative` and a `cd sub && node …` call cannot narrow what it sees (Q11).

  Every subcommand writes one JSON object to stdout, on failure too, and exits with a code
  that tells the causes apart (0 ok, 1 usage or internal, 2 lint, 3 scan, 4 git commit
  failed, 5 timeout, 6 refused). Every output that ends the worker's part carries the
  script-built `reply` (Q25).
- **Rejected.**
  - The script doing the staging itself via `git commit --only -- <files>`, which discards
    partially staged hunks and duplicates git.
  - `plan --hunks` minting the `planId` and taking the lock: every respawn would be refused
    by the first spawn's lock, and a dictated reword, which skips `plan --hunks`, would have
    no `planId` at all.
  - Taking the lock in `check`: two runs could both plan in the window before it.
  - Re-minting hunk IDs on every re-plan and having the worker re-map the old plan by hash:
    pushes bookkeeping into the LLM.
  - The first `plan --hunks` minting the map, unchecked against `plan`'s scan: a file
    edited in between reached the grouping unscanned; a hit mapped by line
    landed on the wrong unit once lines shifted; an untracked file that grew past 1 MB was
    neither scanned nor `skipped`, so it was committed without a scan or a human.
  - `plan` storing only its hash set, with `plan --hunks` still mapping scan items to units:
    two places that cut the same diff into units. `plan --hunks` rescanning its own diff: a
    second scan, and `plan`'s reported hits could disagree with the ones that count.
  - A separate `stage --plan <planId> <id>…` and a message on `commit`'s stdin: an agent
    could stage IDs and commit a message that `check` never validated, and the file-level
    slice would need a path → ID map the agent never sees. It also costs one more tool call
    per group.
  - One `commit --group <n>` call per group (the design before Q24): one tool call per
    group, and on the `yes` path each one a main-thread call at full context.
  - `--subject` / `--body` arguments: they bring back the shell-escaping problem.
  - The worker plan on `check`'s stdin (quoted heredoc in Bash, `$OutputEncoding = …;`
    plus a here-string in PowerShell): the PowerShell form is a compound command that no
    `node *commit.js*` allow rule matches, so it prompted on every run, and Windows
    PowerShell 5.1 without the prefix turned non-ASCII into `?` undetectably. The earlier
    objection to a file (temp file, cleanup) no longer holds: the run folder and its
    housekeeping exist anyway.
  - Hunks on stdout as one JSON object: the Bash tool cuts output at about 30 000
    characters and `Read` cuts lines over 2000 characters, so the worker would see a
    silently truncated diff (Q19).
  - The run folder under the git dir (`$(git rev-parse --git-path commit-plan)`, the
    design before the commit-worker spike): the harness treats every path under `.git` as a
    sensitive file, so the worker's `Write` of `plan.groups.json` asks for approval on every
    run, and no allow rule (`Edit(…)` or `Write(…)`) lifts it (spike, 2026-09-26). Not under
    `.claude/`: writes there may be treated as sensitive by the harness, and the path
    collides with the hidden exceptions (Q16). Under `~/.claude/`: needs a per-repo key, and
    the worker's `Read` outside the project prompts for permission. Since the spike, allow
    rules are a required install step anyway (Q16), so a `Read(~/.claude/commit-runs/**)`
    plus `Edit(…)` pair might lift that prompt; the pending allow-rule spike tests it
    (open verification items). The working-tree location stays unless that spike shows a
    home folder asks nothing and is not treated as a sensitive path. Its costs, weighed and
    accepted: `git clean -fdx` deletes a run mid-run (the next step refuses with "this run
    has already ended"); a file watcher that watches `json` (nodemon by default) restarts
    on the state-file writes (the README names `.commit-plan/` for watcher ignore lists);
    a Docker build context or a cloud-synced folder may pick up the folder during a run.
    A secret no longer sits in it: a unit with a pattern hit gets no body in `hunks.txt`
    (Q10), and the file it came from is in the working tree anyway.
  - The worker plan on `check`'s stdin through a Bash heredoc, to avoid the `Write`: the
    anchored `Bash(node "…/commit.js" *)` allow rule does not match a heredoc command, so it
    prompted (spike), and the PowerShell objection below still holds.
  - A paged hunk output (`plan --hunks --page n`): pagination bookkeeping in the LLM, and
    every string still escaped. A stdout cap in characters instead of lines: about 400 diff
    lines would fit, so most runs would go summary-only.
- **Consequences.** Nothing is committed through the plugin without passing lint and scan,
  even if the prompt's rules are ignored. Prompt rules only help get it right the first
  time. The diff and the worker plan never enter the main context. The CLI, its exit
  codes, its JSON, the handback and the run folder are internal (see
  [Public surface](#public-surface)).

## Q10 Secret and local-path scan

- **Context.** Secrets and local paths must not reach history through the plugin. Exceptions are
  needed (test fixtures), but the agent can write any file it can scan.
- **Decision.**
  - What is scanned: `plan` scans the index diff in `staged` mode, else the working-tree
    diff against HEAD plus the full content of untracked candidates that were not collapsed
    (Q16). `commit` scans the index diff as a backstop. `check` scans every group's
    normalised message with the same patterns: a hit is a lint error ("message contains
    `local-path`"), which the retry or an `edit` fixes, so a token or path quoted from the
    diff, or pasted into a reword, does not reach history either. Only added lines; binary
    files skipped. A tracked file whose added lines exceed 1 MB, or an untracked file over
    1 MB, is not scanned and is reported as skipped (Q19). A file with a `filter` attribute
    (Git LFS, git-crypt, `nbstripout`) is scanned in the cleaned form `git diff` shows,
    which is what enters history: an LFS pointer, ciphertext (usually binary, so skipped),
    a stripped notebook.
  - Patterns and their false-positive rules are fixed in
    [contracts](contracts.md#scan-patterns). `local-path` also matches the current OS user
    name as a path segment in any path shape, but only a name of 4 or more characters that
    is not a well-known service user (`node`, `ubuntu`, `runner`, `vscode`, …). The same
    service users are placeholders for the fixed `/home/<name>`, `/Users/<name>` and
    `C:\Users\<name>` regexes, so `/home/node/app` in a Dockerfile is not a hit. A hit reports
    the pattern ID and location, never the matched value.
  - Exceptions: `scanIgnore` globs only, read from the repo config **at HEAD**
    (`git show HEAD:.claude/commit.json`), not the working tree. The glob dialect is fixed in
    [contracts](contracts.md#scanignore-globs) (the matcher is hand-written, zero deps).
    Matching is case-sensitive on every OS. A diff that changes `scanIgnore` is flagged.
  - `plan` cuts the diff it scanned into units (Q9), maps every scan item to the unit that
    holds it and stores the map in the state file, so `check` decides per unit. Every
    `plan --hunks` must see the same hash set, so the map cannot drift from the diff the
    worker groups. What each item does:

    | Item | Rule in `check` | `humanOnly` (Q16, Q17) | `commit` backstop |
    | --- | --- | --- | --- |
    | pattern hit | the unit must be in `notIncluded`; in a group it is a lint error ("h4 has scan hit `github-token`; move it to notIncluded") | never: the unit is always left out, and the report names it with the `!git add <path> && git commit -m "<message>"` line to commit it by hand (a `!` command has no terminal, so a bare `git commit` could hang on an editor; the guard does not see `!` commands) | **blocks** |
    | skipped file | may be included | when the unit is included | does not block |
    | `scanIgnore` change | may be included | when the unit that changes `.claude/commit.json` is included; it takes effect from the next commit | does not block |

    A hit is therefore a notice, not a question: nothing unscanned-and-flagged can be
    committed through the plugin, so a subagent commits the rest and passes the notice to its
    parent: notices are part of the reply's `text`, which every caller relays verbatim
    (Q25). The backstop cannot fire on the plugin path unless the files changed after
    `plan` (the hash checks in `plan --hunks` and `commit` catch that first); it stays as
    defence in depth.

    Pre-staged set with a hit (`plan --staged`): a set is committed as-is and cannot leave
    the unit out, so `plan` refuses with exit 6 `staged-hit` before any lock or grouping:
    "unstage `<file>` and run `/commit` again, or commit by hand". The same refusal covers a
    staged-new path that the **hidden** rule excludes (Q11): "`.env.local` is staged but
    hidden — unstage it or commit by hand". The reason that applies the hidden rule in
    `split` (staging a file does not get it past it; agents stage too) holds for `staged` as
    well, and the user who picked `staged` saw counts only (Q9). The **collapse** rule does
    not apply in `staged`: it keeps junk out of the worker's grouping, the set is not
    grouped, and only a human reaches `staged`. A 60-file `git add packages/new-lib` set is
    scanned like the rest of the index diff and committed; its new files are listed, not
    asked about (Q16).
  - The worker's prompt forbids adding `scanIgnore` entries unless the user asks.
  - A unit with a pattern hit gets no body in `hunks.txt` (`body: "none"`, its `scan` IDs
    in the index): it goes to `notIncluded` whatever it holds, so the secret reaches
    neither the run folder nor the worker's context
    ([contracts](contracts.md#plan---hunks)).
- **Rejected.**
  - Using gitleaks when installed (breaks zero-deps and behaves differently per machine).
  - A CLI override flag: an agent would add it to itself on refusal. The same holds for any
    flag, env variable or file the agent can reach; the only human-only channel is a manual
    commit.
  - Reading `scanIgnore` from the working tree: as agent-writable as a flag.
  - An inline `commit-scan: allow` marker. A changed or added line is always new, so a
    marker "already at HEAD" can only ever cover lines moved verbatim; that does not justify
    a public token and a content-matching rule.
  - Measuring the skip limit by file size: a dependency bump in a large lockfile would need a
    human on every update and could never be committed by a subagent.
  - Matching every OS user name: a user named `dev`, `app` or `src` would hit almost every
    path.
  - Any scan item anywhere in the run making the confirmation `humanOnly`: a 2 MB untracked
    file the worker leaves out would block every subagent commit in the repo until it is
    ignored.
  - A hit as `humanOnly` even when left out: the hit cannot reach history either way, and
    the subagent could commit nothing in the run.
  - A hidden staged-new path in `staged` as a `humanOnly` trigger instead of a refusal:
    `split` sends the same path to "commit by hand", and a question would make the plugin a
    path for `.env.local` after all.
  - Refusing a collapsed staged-new directory in `staged` like a hidden one: the concern is
    noise, not secrets, and the human staged it on purpose; the refusal sent them to a
    manual commit for no safety gain. A `humanOnly` trigger for it: only a human reaches
    `staged` anyway.
  - Treating a filtered file like a binary one (not scanned): `nbstripout` and similar
    filters commit text that the scan can check, and the cleaned form is exactly what
    history gets.
- **Consequences.** This repo's own fixtures with fake secrets live under `tests/fixtures/`, and
  the repo config lists that in `scanIgnore`. Since `scanIgnore` is read at HEAD,
  `.claude/commit.json` must be committed before the first commit that adds
  `tests/fixtures/`; `/to-issues` puts that commit first. The docs need no entry: the
  regex table in `contracts.md` does not match itself, because a user segment holding a
  character no OS allows in a user name (`[`, `^`, `(`, …) is not a hit, and example paths
  in the docs use the `<you>` placeholder (`C:/Users/<you>/…`), never `…` as the user
  segment. The privacy-guard test (Q15) runs the `local-path` pattern over the docs, so a
  bad example fails CI before it can fail a commit. Test sources (`tests/*.test.js`) are
  scanned like any other file, so they never hold a literal hit: a test builds such a string
  at run time (`'ghp' + '_' + 'x'.repeat(36)`) or loads it from `tests/fixtures/`, and the
  privacy-guard test runs every scan pattern over them too. Accepted noise: a real person's
  home path in a Dockerfile or CI file still needs a human, which is the point. A new exception
  takes effect only after the commit that adds it, which a human has confirmed; files matching
  it in the same run are still scanned under the HEAD rules. Accepted gap: the content of an
  LFS-tracked file goes to the LFS server on push, and the scan sees only its pointer; a secret
  in an LFS-tracked `*.json` is not caught. The README says so. Roadmap: `scanIgnore` entries
  of the form `{ "path": "<glob>", "pattern": "<id>" }` to silence one pattern per path
  (additive); new pattern IDs for common high-signal prefixes: `sk_live_` / `rk_live_`
  (Stripe), `glpat-` (GitLab), `npm_`, `AIza` (Google), `sk-proj-` (OpenAI), `xapp-` (Slack app
  tokens). IDs are additive public surface.

## Q11 Atomic commits by functionality

- **Context.** Splitting by top-level directory flags almost every change in a layout where
  code, tests and docs live in separate folders. The goal is atomic commits by functionality,
  across folders, which is semantic.
- **Decision.** Grouping is Claude's job. The script supplies buckets (`code`, `test`, `docs`,
  `ci`, `build`) as hints only. Hunk-level staging:
  - `plan` mints opaque unit IDs (`h1…hN`) from the diff it scans (Q9, Q10), and
    `plan --hunks` returns the hunks under those IDs. Each unit has a content `hash` over the
    path, the hunk's `-` / `+` lines without context, and an occurrence index for identical
    hunks in one file. Context is left out on purpose: it changes once a neighbouring hunk is
    committed.
  - Identical hunks (same path, same `-` / `+` lines) must have the same placement: all in
    one group, or all in `notIncluded`. `check` rejects anything else ("h3 and h5 are
    identical; place them together") and the worker's lint retry fixes it. So the
    occurrence index is only used while every copy is uncommitted, and it never shifts.
  - The `id → hash` map is kept in the state file of the run folder (Q9); `planId` is only
    its key.
  - Untracked files go through a **temporary index**, so they diff like tracked ones and the
    user's index is never touched. One function builds the diff for `plan --hunks`, the
    `plan` scan and `commit` in `split` mode:
    1. Copy the real index to `git-index` in the run folder and `git reset -q` the copy
       (`GIT_INDEX_FILE`), so it matches HEAD and keeps its stat cache. On an unborn HEAD the
       copy starts empty.
    2. `git add -N` into the copy: the untracked candidates, and the **staged-new** paths,
       i.e. every path the real index adds relative to HEAD (`git diff --cached --no-renames
       --name-only --diff-filter=A -z`; on an unborn HEAD, every path in the real index).
       Step 1 dropped the staged-new paths from the copy, and `ls-files --others` does not
       list them because the real index tracks them, so without this they would be in
       neither list and vanish. Staged-new paths go through the same hidden and collapse
       rules as untracked files ([contracts](contracts.md#untracked-files)), counted
       together with the candidates. Hidden files and collapsed directories are never added,
       and neither is a stored path missing from the working tree (`git add -N` would fail
       on it): the hash match decides what its absence means.
    3. Run the pinned diff (below) against the copy.

    `plan` computes the two lists (candidates, staged-new paths that pass the rules) once and
    stores them in the state file, each staged-new path with an `ignored` flag
    (`git check-ignore`). `plan --hunks` and `commit` rebuild the copy from the **stored**
    lists and never recompute them: `commit` resets the real index first, so afterwards no
    path is staged-new any more, and a force-added gitignored path (`git add -f
    build/config.js`) is not listed by `ls-files --others --exclude-standard` either. It
    would vanish, and every such run would end in `diff-changed`. A stored path deleted
    after `plan` changes the hash set, so it is `diff-changed`; an untracked file created
    after `plan` is in neither list and is left for the next run.

    A new file becomes an ordinary `A` unit with a real hunk and an ordinary hash. A plain
    `mv` (not `git mv`) is paired into one `R` unit by git's own `-M`, with the same rules in
    `plan` and `commit`, so the old and new path cannot land in different groups. A `git mv`
    is the same case: step 1 turns it into a deleted old path, step 2 adds the new path.

    A staged-new path that the hidden or collapse rule excludes (`git add -f .env.local`, an
    agent's `git add -A` over 300 files in `dist/`) is not a unit: the worker never sees it,
    and `check` adds it to `not included` ("`.env.local` was staged but is hidden — commit by
    hand; committing this plan unstages it", "N staged new files in dist/ — commit by hand;
    committing this plan unstages them"). The unstaging happens in `commit`'s reset, so
    `check`'s note says what confirming will do; after `no` or zero groups the index is
    untouched and the path stays staged. A staged-new **unit** that the worker puts in
    `notIncluded` gets the same note, and when it is gitignored (`ignored`) also "…and
    .gitignore then hides it from `git status`". `commit`'s final output lists every
    pre-staged path the run leaves unstaged (Q18). Nothing is dropped silently, and staging a
    file does not get it past the hidden rule (agents stage too, Q16). In `staged` mode a
    hidden staged-new path makes `plan --staged` refuse with `staged-hit` (Q10): a set is
    committed as-is and cannot leave it out. The collapse rule does not apply in `staged`.

    **Index-only content** (`split`): the real index can hold a version that is in neither
    HEAD nor the working tree: `git add x && rm x`, a staged edit later reverted in the
    working tree, or `git add -p` followed by more edits. `commit`'s reset drops it, and it
    survives only as a dangling blob. `plan` stores every path whose index entry differs
    from both HEAD and the working tree (`git diff --cached --name-only` ∩
    `git diff --name-only`, both `-z --no-renames`) and that has an index entry as
    `indexOnly`, with the index blob ID (a `git rm --cached` loses nothing).
    `check` adds a notice per path ("x: the staged version differs from your working tree;
    committing this plan discards it — recover with `git cat-file -p <blob>`"), and
    `commit`'s `unstaged` output lists these paths whether or not they still differ from
    HEAD (Q18). Nothing is refused and nothing is asked: the path reaches `split` only
    through a mode choice or a subagent's `--split` (an index that differs from the working
    tree always means "index plus other changes", Q9), and the blob stays recoverable until
    `git gc` prunes it (two weeks by default). A staged-new path missing from the working
    tree is not a unit (step 2), so it cannot turn every run into a false `diff-changed`.
  - `commit`, for each group, rebuilds the temporary index from the stored lists, recomputes the
    diff and matches the group's hashes, all without touching the real index (the copy is
    built from HEAD plus the lists, not from the real index). A missing hash refuses the
    run: "diff changed since plan, run `/commit` again", and the user's index is as they
    left it. Only then does it reset the real index, build the patch from the **current**
    hunks (current ranges) and run `git apply --cached --whitespace=nowarn` on it (Q18).
  - Every diff the script runs uses pinned options: `--no-ext-diff --no-color --no-textconv
    --no-relative -U3 --inter-hunk-context=0 --indent-heuristic -M --diff-algorithm=myers
    --ignore-submodules=dirty --src-prefix=a/ --dst-prefix=b/` and `-c core.quotePath=false
    -c diff.suppressBlankEmpty=false`, from the toplevel (Q9). `--whitespace=nowarn` keeps
    `apply.whitespace=error|fix` from rejecting or changing what was planned and scanned.
    Left to the user's config because the script does not depend on it: `diff.orderFile`
    (every list is sorted by the script itself, Q19).
  - Whole-file units, staged with `git add -A -- <paths>` (literal pathspecs, Q9; both paths
    of a rename) and never split across groups:

    | Change | Hash input |
    | --- | --- |
    | new, deleted, binary, summary-only file | path + `-` / `+` lines (binary: path + blob IDs) |
    | **renamed** file | old and new path + `-` / `+` lines |
    | mode change (`chmod +x`), with or without content edits | path + old and new mode + `-` / `+` lines |
    | symlink added, changed or type change (`T`) | path + old and new target |
    | submodule pointer (gitlink) | path + old and new commit ID |
    | file with a `filter` attribute (`git check-attr filter`: LFS, git-crypt, `nbstripout`) | path + `-` / `+` lines of the cleaned form (binary: path + blob IDs) |

    A mode change goes whole-file even with content edits: a hunk patch without the mode
    header drops the mode change silently on `git apply --cached`. A filtered file goes
    whole-file because `git apply --cached` writes the cleaned blob without running the
    filter: for LFS the pointer lands in the index but the object never reaches
    `.git/lfs/objects`, so the push has nothing to upload. `git add` runs the filter, and
    the staged diff then equals the cleaned diff that was hashed and scanned. A symlink
    target is scanned as an added line; a gitlink is not scanned.
    `--ignore-submodules=dirty` keeps a submodule's own working tree (edits, untracked
    build output) out of the diff: a pointer change is a unit whatever the dirt, and
    `git add` stages the pointer only. Dirt without a pointer change is not a unit: `plan`
    lists it in `dirtySubmodules` (the submodule paths that
    `git diff --ignore-submodules=none --name-only` lists and the pinned diff does not),
    and `check` adds it to `not included` ("libs/x has uncommitted changes inside —
    commit inside the submodule first"). Dirt alone leaves the
    tree `clean` (Q16).
  - Changes that `-U3` merges into one hunk stay one unit.

  One `commit --all` call commits the groups in order; per group: reset the index, stage,
  commit. A pre-staged set
  (`staged` mode, Q9) is committed as-is and never regrouped; other unstaged changes are left
  untouched and reported (`N unstaged files left — run /commit again`). In `--split` mode a
  pre-staged set is reset like any other index and planned with the rest; a staged new file
  stays a unit and a `git mv` rename comes back as the same `R` unit through step 2 of the
  temporary index. Delivered in two slices: file-level
  grouping first, hunk-level staging second. In the file-level slice `check` resolves the
  worker's paths to units itself; an `R` unit is named by its **new** path only, in `files`
  and in `notIncluded` alike ("use the new path src/b.js for the rename of src/a.js").
- **Rejected.**
  - A top-level-directory split rule; dropping split detection.
  - Hunk IDs of the form `file#n`: they collide with paths containing `#`, spaces or commas.
  - A whole-diff check per group: the diff changes after the first group is
    committed, so every multi-group run would refuse.
  - Splitting a rename across groups (rename in one, later edits in another): much more code
    for a rare case.
  - Matching identical hunks without the occurrence index ("take the first k remaining"):
    can stage the copy at the wrong place, so an intermediate commit changes the wrong
    function without any error.
  - Refusing mode-only changes, symlinks or submodule pointers: all are ordinary commits.
  - Hashing new files straight from their content, outside git's diff: a plain `mv` stays
    `D` plus a new file, and the worker could put the halves in different groups.
  - `git add -N` on the real index: changes the user's index, and an aborted run leaves
    intent-to-add entries that make the next run a pre-staged set.
  - Listing new paths with `ls-files --others --exclude-standard` against the reset copy
    (one rule for staged and untracked): a force-added gitignored file is excluded by
    `--exclude-standard`, so it would still vanish silently.
  - Letting staged-new paths bypass the hidden and collapse rules because someone staged
    them: an agent's `git add -A` would push `.idea/` or `dist/` into the grouping.
  - Recomputing the candidate and staged-new lists in `commit`: its own reset has already
    unstaged the staged-new paths.
  - Resetting the real index before the hash match: the most likely `diff-changed` (a typo
    fixed while reading the confirmation) threw away the user's staging with nothing
    committed.
  - Turning index-only content into a `modeChoice` or a refusal under `--split`: the common
    case is `git add -p` plus more edits, where nothing of value is lost, and the user or
    subagent already chose to plan everything. The blob ID makes the rare real loss
    recoverable.
  - Relying on `diff.interHunkContext` and `diff.indentHeuristic` being shared by every call
    in one run: true, but they decide what a unit is, and pinning them makes the tests
    independent of the runner's config.
  - Requiring a submodule with a dirty working tree in `not included`: `git diff` also calls
    a submodule dirty when it only holds untracked files, so a pointer update next to build
    output inside could never be committed, although `git add <submodule>` commits the
    pointer fine.
- **Consequences.** Tests must cover a multi-group run where later hunks of a partly committed
  file shift, changes merged into one hunk, identical hunks in one file (same group, and
  split or one copy in `notIncluded` → `check` error), new, deleted and renamed files, a
  plain `mv` paired into `R`, a new file committed in a later group, a `git mv` and a
  `git add newfile` under `--split` (and on an unborn HEAD), a force-added hidden file and a
  staged collapsed directory under `--split` (→ `not included`), a force-added hidden file
  under `--staged` (→ `staged-hit`) and a staged 60-file new directory under `--staged`
  (→ scanned and committed), a force-added gitignored file that is not hidden committed in
  group 2 (stored lists), a staged-new unit left in `notIncluded` (unstaged note),
  index-only content under `--split` (`git add x && rm x` → no unit, no `diff-changed`,
  notice and `unstaged` entry with the blob; a staged edit reverted in the working tree →
  the same; `git add -p` plus more edits → the same), a file edited between `plan` and the
  first `plan --hunks` (→ `diff-changed`, nothing committed), `diff-changed` on group 1
  (→ the real index untouched, `unstaged: null`), binary files (whole file only), mode-only
  and mode-plus-content changes, symlinks, submodule pointers, a pointer change in a
  submodule with untracked files inside (committed), dirt without a pointer change (report
  line, tree `clean`), a trailing-whitespace hunk under `apply.whitespace=error`, a file
  with a clean filter (a `sed`-based `filter.<x>.clean` in the test repo: whole-file unit,
  staged with the filter applied, scanned in its cleaned form), `diff.relative=true` with
  `plan` run from a subfolder (changes outside it still listed), and
  `diff.interHunkContext=10` (units unchanged).

## Q12 Planner subagent and model

- **Status.** Superseded in part by [Q24](#q24-token-budget) (2026-09-26). The context
  below is refuted by measured data: the diff is a negligible share of a commit's cost, and
  each main-thread API call the caller-driven flow adds costs far more than the diff it
  keeps out. What changed: the planner becomes `commit-worker`, one agent that runs the
  whole run (`plan`, grouping, `check`, commit) and is spawned by the model or by
  `/commit`; the caller no longer runs `plan`, `check` or `commit` except the `run` command
  of a handback answer (Q25); lint retries loop inside the worker, a user's `edit` or `one`
  respawns it; the frontmatter is `model: sonnet`, and the model key is dropped (Q6, after
  the commit-worker spike). What stands: the single-author rule, the diff never entering
  the main context, the choice of Sonnet over Haiku by default, and the Haiku eval. The
  failure reply below was replaced by Q25's script-built `reply` (`status: "failed"`) and
  its no-guess rule. The rest of this entry records the design as of the seventh review;
  its `planner.json` is now `plan.groups.json` ([contracts](contracts.md#worker-plan)).
- **Context.** The main cost of reading a diff in the main thread is not the model price: the
  diff stays in context for every later turn.
- **Decision.** The plugin ships an agent `commit-planner` (frontmatter `model: inherit`, tools
  `Bash`, `Read` and `Write`). The caller runs `plan`, then spawns the planner with the
  `planId`, a mode, the script path and a one-to-three sentence intent summary (what was
  changed and why). The intent is `null` when the caller does not know it (`/commit` in a
  fresh session); the planner then infers it from the diff alone.
  - Script path: an agent file, unlike a skill, gets no base directory, so the caller passes
    `script`, the absolute path of `commit.js` from the skill's base directory, with forward
    slashes (`C:/Users/<you>/…/commit.js`), which Node, Git Bash and PowerShell all accept. If
    `${CLAUDE_PLUGIN_ROOT}` turns out to expand in an agent file, it replaces `script`
    (open verification item).
  - The planner runs `plan --hunks --plan <planId>`, which prints the absolute `runDir` and
    `hunksFile` (Q9), `Read`s `hunks.txt` in pages (Q19), and uses `Read` on a working-tree
    file only for summary-only files and for hunks past the cap (Q19).
  - It writes the planner output ([contracts](contracts.md#planner-output)) to
    `<runDir>/planner.json` with `Write`, and returns only `done` and a one-line
    summary. The caller never reads the diff or the planner JSON; it runs `check`, whose
    output carries everything the confirmation needs (Q16).
  - Failure reply: when a script call exits non-zero (`plan --hunks` refused with
    `diff-changed`, `head-moved` or `lock`, or a `usage` / `internal` error), the planner
    writes nothing and replies `failed: <kind> <message>`, with the script's message. The
    caller relays the message and does not run `check`. It is not a failed attempt: no
    retry planner, since the same call would be refused again. `diff-changed` and
    `head-moved` have already ended the run (lock released, folder deleted); after any other
    kind the caller runs `release`, a no-op when the lock is not this run's.

  Modes (fixed by `plan` in the state file):
  - `split` (default): groups with header, optional body, hunks or files, and a one-line
    reason; a `not included` list.
  - `staged` (pre-staged set, Q16): index diff only, exactly one group covering the set; only
    the message is the planner's.
  - `reword` (Q20): HEAD's own diff and message, exactly one group; only the message.

  The caller runs `check`, which lints every group and computes `confirm`. On a lint error a
  **new** planner is spawned with the same `planId` and the `check` errors; it reads the
  previous plan from `planner.json` itself and overwrites it. One retry, then Q18. Hunk IDs
  stay valid across re-plans (Q9). A missing or unparseable `planner.json` is a lint error
  and counts as a failed attempt; after the retry the caller runs `release`.

  `plannerModel` maps onto the Agent call: `"sonnet"` and `"haiku"` are passed as `model`;
  `"inherit"` omits `model`, so the frontmatter `inherit` applies.
- **Rejected.**
  - `model:` in the skill frontmatter (switches the main session model and does not help with
    context); `context: fork` for the whole skill (cannot ask for confirmation).
  - Haiku by default (grouping is semantic and lint cannot catch a bad split).
  - Frontmatter `model: sonnet` with `"inherit"` meaning "omit `model`": omission falls back to
    the frontmatter, so "inherit" would not be reachable.
  - The planner running its own `git diff`: it follows the user's git config
    (`diff.external`, `diff.context`, `diff.noprefix`, colour), so its hunks may not match the
    script's.
  - The planner deciding `confirm` itself: whether a human is asked must not depend on an LLM.
  - The caller writing the pre-staged message from the file list: breaks the single-author
    rule and gives poor messages for a set the user staged.
  - Retrying through `SendMessage` to the same planner: depends on it staying alive.
  - Returning the planner JSON as the agent's reply: the caller would have to copy it into
    `check`'s input, which brought back stdin (Q9), and it would sit in the main context.
  - Only `done` as a reply, with a refusal left to `check`: after a `diff-changed` the
    planner's `Write` re-creates the deleted run folder as an orphan, `check` then reports
    `lock` ("taken over", the wrong cause), and the missing-`planner.json` rule spawns a
    retry that hits the same refusal.
- **Consequences.** Roadmap: an eval set of fixture diffs with known correct splits to measure
  Haiku against Sonnet. Version 1.0.0 waits on that eval.

## Q13 Hook performance and trailers

- **Context.** The hook runs on every shell tool call in every repo where the plugin is
  enabled. Separately, the harness asks the agent to add a footer, which must not reach the
  message through the agent.
- **Decision.**
  - Use a hook `if` condition (`Bash(git *)`, `PowerShell(git *)`, plus `Bash(node
    *commit.js*)` and `PowerShell(node *commit.js*)` for the heartbeat, Q23; these only decide
    when the hook runs and grant nothing, unlike the anchored allow rules, Q16) if it reliably
    catches compound commands; otherwise match without `if` and exit early in the script when
    the command does not contain `commit`. Reliable detection beats saved milliseconds.
  - Footers use the Conventional Commits footer grammar, implemented by the script's own
    parser ([contracts](contracts.md#message-grammar)): the last paragraph, every line either
    `Token: value` or `Token #value`, where the token is `BREAKING CHANGE` or has no spaces;
    indented lines continue the previous footer. A `Note: …` line in an earlier paragraph,
    or next to non-footer lines, is body text.
  - The agent may write only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes` and
    `Fixes` footers. Any other token (`Co-Authored-By`, `Signed-off-by`, …) fails lint; only
    the script adds those (Q5, Q20). `!` in the header is allowed. A last paragraph such as
    `Note: see #12` parses as a footer with a disallowed token, so the lint error says what to
    do: "`Note` is not an allowed footer token. If this is body text, rephrase it or add a
    non-footer line to the paragraph." The worker's lint retry can fix it on its own.
  - A footer-only final paragraph is not a body, so it is allowed under `body: forbidden`.
- **Rejected.**
  - Rejecting every trailer: makes `BREAKING CHANGE:`, `Refs:` and `Closes #n` impossible.
  - `git interpret-trailers`. Spike on git 2.54 (2026-09-26): `--parse` ignores
    `BREAKING CHANGE: …` and `Closes #12`; a paragraph mixing `Refs:` with `BREAKING CHANGE:`
    is not parsed at all; `trailer.separators=':#'` rewrites `Closes #12` to `Closes: 12`;
    `--trailer` after a `BREAKING CHANGE` paragraph starts a new paragraph.
- **Consequences.** A harness instruction to add a footer has no path into the message. Lint,
  append (Q5) and `infer` (Q7) share one footer parser.

## Q14 Per-repo opt-out

- **Context.** Some repos have their own commit conventions or tooling, and the plugin should
  stay out of them.
- **Decision.** Use Claude Code's built-in `enabledPlugins` (`"commit@commit": false` in a
  project's `.claude/settings.local.json`). No code, a README section only.
- **Rejected.** A `guard` config key with a local config layer; path-based excludes in the user
  config.
- **Consequences.** Opting out disables the whole plugin in that repo, worker and skills
  included. It is the recommended path for non-Conventional-Commits repos (Q7).

## Q15 Repository layout

- **Context.** The layout must keep one script shared by skills, agent and hook, and let the
  plugin dogfood its own rules.
- **Decision.**

  ```
  .claude-plugin/marketplace.json
  .claude/CLAUDE.md
  .claude/commit.json                 repo config; scanIgnore: tests/fixtures/**
  .github/workflows/test.yml          ubuntu + windows + macos × Node 22/24, + ubuntu-22.04 (git 2.34)
  plugin/.claude-plugin/plugin.json
  plugin/scripts/commit.js            shared by skills, agent and hook
  plugin/scripts/guard.js
  plugin/hooks/hooks.json
  plugin/agents/commit-worker.md       the run (Q24, Q25)
  plugin/skills/commit/SKILL.md       /commit: spawn only
  plugin/skills/commit-config/SKILL.md
  docs/architecture.md, contracts.md, decisions.md, roadmap.md, testing.md
  tests/*.test.js, tests/fixtures/
  LICENSE (MIT), README.md
  ```

  Tests build git repos in temp directories at run time (fixed author and dates via env).
  Minimum git version 2.34 (SSH signing, Q18). The main CI matrix tests whatever git the
  runners ship; one extra job on `ubuntu-22.04`, whose system git is 2.34.1, tests the
  minimum. A privacy-guard test keeps local paths and usernames out of docs, README,
  manifests and test sources (Q10). Design review reports stay out of history: they quote
  the bugs they found, local paths included, and `decisions.md` already records what they
  changed. They are written next to the docs (`docs/design-review*.md`, where the review
  skill puts them) and kept out by a `docs/design-review*.md` line in the clone's
  `.git/info/exclude`, so a `git add docs` or a `split` run never sees them and later
  rounds are covered without a new rule. Start at version 0.1.0.
- **Rejected.**
  - Node 18 or 20 as the minimum: both are end-of-life, and Claude Code's npm install
    already requires Node 22.
  - Git 2.23 as the minimum: untested in CI, and SSH signing needs 2.34.
  - Committing the review reports under `docs/`: every report would have to pass the
    privacy guard, and each round's quotes of old bugs would need rewriting.
  - Moving the reports out of the working tree: the next round writes into `docs/` again.
    A `.gitignore` entry: it would publish a rule about files nobody else has.
- **Consequences.** The plugin applies its own rules to itself. macOS in CI covers the
  case-insensitive filesystem against case-sensitive glob matching (Q10).

## Q16 One confirmation at most

- **Context.** Asking on every commit is noise; never asking lets bad splits and stray files
  through.
- **Decision.**
  - Untracked files fall into two categories ([contracts](contracts.md#untracked-files),
    tests there):
    `hidden` (never shown to the worker) and `candidate` (shown, with a `binary` flag).
    Gitignored files are never seen. The collapse rule targets junk directories (`dist/`,
    `coverage/`), which are **new**: no path under them exists at HEAD. So it counts per
    topmost new directory: one that holds no HEAD path, under a parent that does
    (`git ls-tree -r -d --name-only HEAD` gives the tracked directories; every directory is
    new on an unborn HEAD). More than 50 candidates (plus staged-new paths, Q11) in one such
    directory collapse it into a summary: the worker cannot include it, and `check` lists
    it in `not included` ("N untracked files in dist/ — add to .gitignore or commit by
    hand"). New files directly in a tracked directory ("loose" files: 51 migrations in an
    existing `db/migrations/`, icons in `assets/icons/`) are never collapsed per directory.
    Files at the repo root are the exception and count as one directory, `"."` ("N
    untracked files at repo root"): 50 new root files are almost always junk. More than 200
    in total → the largest new directories collapse until the total is at most 200; if
    loose files alone still exceed it, they collapse per parent directory, largest first.
    Example: in a layout where all code sits under `packages/`, scaffolding
    `packages/new-lib/` (60 files) collapses only `packages/new-lib/`; the one new file of
    an unrelated feature in `packages/app/src/` stays a candidate.
  - The tree is `clean` when nothing plannable is left: no tracked change and no candidate.
    Hidden-only or collapsed-only untracked files are clean (`planId: null`, no lock); `plan`
    still reports their counts. The same holds for staged-new paths the hidden or collapse
    rule excludes (Q11): with nothing else, the tree is clean, the index is left as it is,
    and `plan` names them ("`.env.local` is staged but hidden — commit by hand"). A
    submodule with dirt but no pointer change is clean too, and reported (Q11).
  - The worker places every unit exactly once: into a group, or into `not included` with a
    reason (a whole path, or single hunks in the hunk-level slice). `check` rejects an
    unplaced unit as a lint error ("h7 (src/c.js) not placed; put it in a group or in
    notIncluded"), and the retry fixes it, so no change is left out without a stated reason.
  - **The intent scopes a `split` run.** With an `intent`, a unit the intent clearly does
    not cover goes to `not included` with the reason "not part of the intent"; a unit that
    plausibly belongs to the change (its test, its docs, a lockfile it updated) stays
    planned. Without an `intent` (`/commit` with no text, Q2) everything is planned. A
    caller whose user asks to commit everything says so in the intent, or omits it. The
    rule is the same with and without a user: the left-out units show up in the report's
    "Not included" and in the tree state ("N files left: …"), are left in the working tree
    untouched (a pre-staged one is unstaged by `split`'s reset and listed in `unstaged`,
    Q11), and the next `/commit` plans them. They are not a trigger. `staged` commits the
    set the user picked and `reword` has one commit, so neither is scoped. This matches the
    baseline Q24 measured (`git add <its files> && git commit` commits only the agent's own
    change) and keeps an unrelated, possibly half-finished edit, or a parallel
    implementer's files in a shared working tree (Q22), out of an agent's commit.
  - Zero groups is a valid `split` outcome (everything is a hit, or
    deliberately left out): `check` returns `groups: []` and releases the lock itself, and
    the reply reports "nothing committed" with the reasons.
  - `check` computes `confirm` from the triggers below. Otherwise the commit goes through
    without a prompt.
  - The user sees one block, built by the script from `check`'s output and carried in the
    `confirm` handback (Q25): per group the header, body and files (with a hunk count per
    file in the hunk-level slice; at most 20 files per group, then "+N more"), then `not
    included` with reasons, then the scan notices. The worker has returned by then; the
    caller asks with `AskUserQuestion` and acts on the answer. The options are `yes`,
    `one` and `no`, with `one` only in a `split` run with more than one group (anywhere
    else it would respawn a worker to reach the same plan; `yes` and `no` still meet
    `AskUserQuestion`'s minimum of two); `edit` has no option of its own, since
    `AskUserQuestion` has no text
    field on an option: the question says "To change it, type your changes under Other",
    and text typed under Other is the `edit` answer (Q25):
    - `yes`: the caller runs the handback's `commit --plan <planId> --all` verbatim; for
      Q10 items, with the meaning given in Q10. No worker is spawned.
    - `edit <free text>` (e.g. "merge 2 and 3", "subject of 1: …"): the caller respawns the
      worker with `resume: <planId>` and the text; it reads the previous plan from
      `plan.groups.json`, and `hunks.txt` only when the grouping changes, runs `check`
      again, and a new block comes back. Repeatable.
    - `one`: the same respawn with `edit: one` ("single group, all included files"); the
      worker writes the header; the new block is confirmed once more.

    Both rest on a deterministic rule, not on the triggers: the respawned worker's separate
    `plan --hunks` call marks the run `resumed` in the state file, and `check` in an
    interactive `resumed` run always sets `confirm` (reason `edited plan`), in every mode.
    Without it, "merge 1 and 2" on a run with no new file gives one group and no trigger,
    and `check --commit` would commit a header the user, who was in the middle of
    reviewing, never saw. `resumed` is never set without a user: a caller without one
    never answers `edit` or `one` (Q17).
    - `no`: the caller runs the handback's `release`; nothing is committed, the index is
      untouched.
  - Triggers per mode ([contracts](contracts.md#confirmation-triggers)):

    | Mode | `confirm` when |
    | --- | --- |
    | `split` | more than one group; a new file (untracked or status `A`) in any group; an **included** skipped file or `scanIgnore` change (`humanOnly`) |
    | `staged` | the set holds a skipped file or a `scanIgnore` change (`humanOnly`). A new file in the set was staged by the user on purpose; it is listed in the report, not asked about, however many there are (the collapse rule does not apply in `staged`, Q10). A set with a pattern hit, or with a staged-new path the hidden rule excludes, never gets here (`staged-hit`, Q10) |
    | `reword` | never on the first spawn. The user asked for it explicitly; the new header is reported afterwards and can be reworded again |
    | any mode | the run is `resumed` (after `edit`, `one` or a lint `retry`), interactive only |

    A pattern hit is never a trigger: its unit is always left out (Q10) and the report names
    it. A binary new file is not a trigger of its own: "new file" covers it, and `binary`
    only changes the reason text (`new binary file logo.png`).
  - A pre-staged set skips grouping: the worker writes the message only (`staged` mode).
    `staged` is reached only when the user picks it: when the index and other changes are
    both present, the user picks the mode first; an index that holds every change is
    planned as `split` (Q9).
- **Rejected.**
  - Always asking; never including untracked files without an explicit request.
  - Separate `config` and `code/doc` categories: they behaved identically.
  - Treating every non-empty index as a set the user staged on purpose: agents stage too
    (`git mv`, `git rm`, `git add`). One `git mv` followed by five edits would give a
    rename-only commit, split from the edits that belong with it.
  - Telling the agent never to stage by hand (probabilistic), or treating an index of only
    renames and deletions as `split` (still misses an agent's `git add`).
  - An index that holds every change, with nothing else, as `staged`: an agent's
    `git add -A` followed by `/commit` would give one commit with no grouping and no
    confirmation, the most common way agents stage. `split` covers exactly the same set;
    the cost is one `one` answer for a user who staged everything meaning one commit.
  - Always `split`, ignoring pre-staging: throws away a user's `git add -p` selection.
  - A silently dropped unit reported as "not placed by the worker" instead of a lint error:
    no reason is given, and a subagent would confirm it by itself.
  - The worker releasing the lock after zero groups: one more call its prompt could miss.
  - A `yes` that respawns the worker to commit: an agent prefix to run one command (Q24).
  - An `edit` that commits at once when the edited plan hits no trigger, with `yes`
    implied: the user asked for a change mid-review, so the changed plan is what they
    have not seen.
  - Setting `resumed` from the worker input (`resume` in the prompt): the script never
    sees the prompt, and a prompt rule would make the second look probabilistic.
  - Collapsing per top-level directory: in a layout with all code under `src/`,
    `packages/` or `apps/`, one scaffolded package or a batch of 51 migrations collapsed
    the whole tree, the unrelated feature file in it included, and a subagent could commit
    nothing. `ls-files --others --directory` (wholly untracked directories): it does not
    see staged-new paths, which the rule must count too (Q11).
  - Planning every change whatever the intent (the design before the tenth review): a TDD
    step spawned with `interactive: false` committed the user's unrelated uncommitted
    edits with it, a regression against the baseline. Out-of-intent units as a separate
    group in interactive runs only: two rules for one judgement, and a group the user
    has to spot and answer `edit` for. Leaving out everything not named in the intent: a
    test or lockfile of the same change would be left behind.
- **Consequences.** The common case (one group, tracked files only) costs zero confirmation
  prompts. Permission prompts are separate: the first spawn makes three calls that need
  permission, `plan` (with `plan --hunks` in the same process, Q9), the worker's `Write` of
  `plan.groups.json` and `check --commit`; a `resume` respawn adds its separate
  `plan --hunks`; the caller's `run` command after a handback is one more. The guard never
  returns `allow` (Q3). Without allow rules each of them asks
  for approval (spike: in a headless run all were denied; in an interactive one the
  background worker's prompts, for `node …commit.js` and for the `Write` of
  `plan.groups.json`, surfaced in the main session and held the worker until answered). The
  README therefore makes two allow rules a
  **required** install step, not a convenience:
  `Bash(node "<home>/.claude/plugins/cache/commit/commit/*/scripts/commit.js" *)` with the
  user's own absolute home (plus the matching `PowerShell(…)` rule), and
  `Edit(**/.commit-plan/**)` for the run folder (Q9). With both, a run needed no approval
  at all (spike, Windows, Bash tool: the quoted path, the `*` version segment and the
  `<marketplace>/<plugin>/<version>` cache layout all matched). Each script call is a single
  `node … commit.js …` command, so one rule per shell covers all of them (Q9). A bare
  `node *commit.js*` would match **any** file named `commit.js`: an agent that writes
  `./commit.js` and runs it would get arbitrary code run without a prompt. The anchored
  path is outside the project, so writing there prompts. The README gives only the
  anchored rule and says why. `Edit(**/.commit-plan/**)` lets an agent write any file in a
  `.commit-plan` folder without a prompt; running one still needs a `Bash` approval, which
  the anchored rule does not give. Accepted.

## Q17 Commits from a subagent

- **Context.** A common workflow: the main thread spawns an implementer subagent, and that
  subagent commits. Verified 2026-09-26: in a subagent the `Skill` tool works and nested
  `Agent` calls work, but `AskUserQuestion` is not available, not even as a deferred tool. Hook
  input carries `agent_id` and `agent_type` for subagent calls.
- **Decision.** Revised by Q24 and Q25.
  - Same flow everywhere: the implementer spawns `commit:commit-worker` nested under it (from the
    agent description, or because its workflow skill names it), passing the intent.
  - Knowing whether a user can be asked: `AskUserQuestion` is absent from the caller's tool
    list **and** from the deferred-tool list in its system reminders (spike: absent in both
    for a subagent, absent from a headless `-p` session's tools; the docs say it is removed
    from every subagent). No ToolSearch call:
    it costs one more call in a large context. That covers a subagent and a headless run
    (`claude -p`, the Agent SDK, CI) alike; both take the subagent path. In a headless run
    "return to the parent" means the final report. A main interactive session where the
    user denied or disallowed `AskUserQuestion` (`permissions.deny`, `--disallowedTools`)
    takes the subagent path too. Accepted gap; the README says so.
  - Two ways to run without a user; both are safe:
    - `interactive: false` in the worker input (the cheap path, one call fewer). The worker
      runs `plan --split --no-user` (or `--reword --no-user`), so it never asks for a mode
      and never passes `--take-over` (Q22; the automatic takeover of a lock untouched for
      15 minutes applies like to any run). `check --commit` then commits a confirmation that
      is not `humanOnly` without asking: the worker's grouping is confirmed by nobody else.
      After two failed lints (one on dictated text) `check` releases the lock and the
      reply carries the errors (Q18).
    - `interactive` omitted: the worker returns handbacks as for a user, and the caller
      follows the handback's `ifNoUser` (Q25): `yes` for a plain confirmation (the
      implementer, who knows the task, has seen the grouping), `no` plus hand-back for
      `humanOnly` and a `lintFailed`, `split` for a mode choice, `wait` for a lock.
      One call more per confirmation, in the implementer's context.
  - `humanOnly` is never answered without a user: nothing is committed, the lock is
    released (by `check` with `--no-user`, by the `no` answer otherwise), and the reply's
    `text` goes verbatim to the parent, which shows it to the user; the user then runs
    `/commit`, which plans afresh. The `handedBack` handback has no answers, so nothing in
    it points at the ended run. Scan-hit notices (Q10) are passed on the same way, but do
    not stop the commit: every notice is part of `text`, and every reply's `callerRule`
    says a subagent puts `text` verbatim in its final report (Q25), on `committed` and
    `nothing` replies too.
- **Rejected.**
  - An inline mode where the subagent plans itself: a second code path to test. The intent
    summary recovers most of what the implementer knows.
  - Inline planning only when the caller runs on Sonnet or Haiku: hook input has no model
    field, and `model: inherit` makes self-reported models vary, so the branch would be
    probabilistic and double the test paths.
  - A plan file handed from the subagent to the main thread (`/commit --plan <file>`): more
    surface for a rare path; re-planning is cheap.
  - The guard rewriting `commit.js plan` via `updatedInput` to inject the caller kind from
    `agent_id`: deterministic, but makes the hook mutate commands for low stakes, since a
    pattern hit is blocked by the backstop in every context (Q10).
  - A plain-text question as fallback when `AskUserQuestion` is missing: the caller cannot
    tell a main session with the tool denied from a headless run, where nobody would answer.
  - Reading the caller kind from the heartbeat's `agent_id` (Q23): one heartbeat file per
    machine, overwritten by parallel runs, so the answer could belong to another run.
  - The `interactive: false` worker making one `edit` of its own before `yes` (the first
    Q24 draft): a second planning pass by the same agent with no new information.
  - Keeping the lock through a `humanOnly` hand-back, so the parent's user could answer the
    live handback: parallel implementers (the case Q22 exists for) would be refused with
    `lock` for up to 15 minutes while the question travels up.
  - ToolSearch `select:AskUserQuestion` to detect a user: one more call at full context.
- **Consequences.** The agent-confirmed path cannot commit a pattern hit. With
  `interactive: false`, grouping in subagent commits is judged by the agent that proposed
  it; a caller that wants to judge it itself omits `interactive` and pays one call. A wrong
  self-check about the user affects only the non-blocking Q10 items. A file a subagent's run
  leaves out (hit, oversized, collapsed, not part of the intent, Q16) does not stop it from
  committing the rest. Eval fixtures (Q12's set, run on every worker model): an unrelated
  modified file next to the intended change, spawned with an `intent` and
  `interactive: false` (→ the unrelated file in `not included`, "not part of the intent",
  left in the working tree, the rest committed); the same tree without an `intent` (→ both
  planned); a test file and a lockfile of the intended change (→ planned with it); a hand
  edit by the user next to Claude's change, run through a bare `/commit` (→ both planned,
  Q2).

## Q18 Failures, repo hooks and signing

- **Context.** A multi-group run can fail halfway: the scan backstop, the repo's own git hooks
  (pre-commit, a commitlint `commit-msg` with different rules), or commit signing, where a
  TTY pinentry hangs a non-interactive `child_process` call.
- **Decision.**
  - `check` lints every group before the first commit, so a lint failure never leaves a run
    half done.
  - Stop at the first failing group. Commits already made stay; they are local and the user
    can `git reset HEAD~n`. `commit --all` (and `check --commit`, which runs it) reports the
    groups it committed, the failed group and the ones not committed, and exits with the
    failed group's cause (Q9).
  - `split`: each group runs in three phases: (a) the refusals (`lock`, `usage`,
    `head-moved`, `index-lock`); (b) rebuild the temporary index, diff and match the group's
    hashes (`diff-changed`), which never touches the real index; (c) reset the real index,
    stage, verify, scan, commit. A failure in (a) or (b) leaves the real index exactly as it
    was. A failure in (c) runs `git reset -q` (index only), so the remaining changes are
    unstaged again and the working tree is untouched. The state file records
    `indexReset: true` the first time (c) starts. Once set, the output that ends the run
    (last group, or any failure, including (b) of a later group) lists as `unstaged` the
    pre-staged paths still not in HEAD, and every `indexOnly` path (Q11) with its blob,
    each with its `ignored` flag; the report says "your earlier staging was reset: …" (a
    gitignored one "…is no longer shown by `git status`", an index-only one "…staged
    version discarded, recover with `git cat-file -p <blob>`"). Before that, `unstaged` is
    `null` and the report says the index is untouched. `staged` and `reword`: the index is
    left as it is (a reword never touches the user's staged changes, Q20). The run lock is
    released and the run folder deleted.
  - Verify (c): after staging, the index diff against HEAD (pinned options) must hold
    exactly the group's hashes. Otherwise (a whole-file unit or a filtered file changed
    between the match and `git add`) → reset, exit 6 `diff-changed`. It replaces the old
    empty-index check: the commit holds what was confirmed, byte for byte.
  - Report (the reply's `text`, Q25): the committed groups as `sha subject`, the failed
    group and its reason, the groups not committed, and the files left out by pattern hits
    (Q10).
  - Per cause (exit code, Q9):
    - Lint → the worker fixes `plan.groups.json` from the errors and runs `check` once more,
      inside the same spawn (Q24). `check` counts the failures in the state file, and
      `plan --hunks`, which every spawn runs first, resets the count; so the second failure
      in one spawn is decided by the script, not by the worker's prompt. On it `check`
      returns a `lintFailed` handback (Q25): the rejected messages and the errors, with
      the options `retry` (a respawn with `resume` and `edit: fix these lint errors: …`, so
      a fresh worker sees the errors) and `no` (release), and `edit <free text>` typed
      under Other (a respawn with `resume`; repeatable; also covers dictated text such as
      "subject of 1: …"). `yes` and `one` are not offered: neither fixes a lint error.
      `AskUserQuestion` needs at least two options, which `retry` and `no` give. With
      `--no-user`, `check` releases the lock and the reply carries the errors.
    - Lint on dictated text (`"source": "user"`, Q20): the **first** failure already ends
      the worker's part, with the same handback (or, with `--no-user`, the same failed
      reply). The script knows `source`, so no prompt rule is needed: the worker never
      rewrites the user's words unseen and commits them unattributed.
    - Scan backstop → stop and show the hits.
    - `git commit` failed (exit 4) → stop, show git's output verbatim, no retry, never
      `--no-verify`. A `prepare-commit-msg` hook that adds trailers is accepted: lint runs
      before git.
    - Exit 4 or timeout (exit 5), but git made the commit anyway (a hanging `post-commit`
      hook, a signing prompt answered at the last second): after either, `commit` reads
      HEAD. If it moved from the expected SHA, the output carries the new `sha` and the
      report says "committed as `<sha>`, but git did not exit cleanly / in time". The run
      still ends there; the group counts as committed in the report.
    - `diff-changed` on group n+1 after the repo's own hooks rewrote files during group n's
      `git commit` (husky + lint-staged + prettier): `commit` computes the diff's hash set
      right before and right after its `git commit` call and records in the state file
      whether "after" differs from "before" minus group n's own hashes (a successful commit
      always takes those out of the diff, so comparing the raw sets would flag every
      multi-group run). The next group's `diff-changed` then says "files changed during
      the commit of group n — a repo hook (lint-staged, a formatter) likely rewrote them;
      run /commit again" instead of "files changed since plan". Supporting such hooks
      mid-run (re-planning automatically) is out of scope.
    - `head-moved` → stop: "HEAD moved since plan (commit made elsewhere?), run /commit
      again". `commit` compares HEAD with the SHA the state file expects (recorded by `plan`,
      updated after each committed group), so neither a reword's `--amend` nor a group lands
      on a commit the run never saw.
  - Exit 4 does not name a cause. `git commit` exits 1 for a hook rejection, a signing
    failure, an `index.lock` collision and "nothing to commit" alike, and its stderr is
    localised, so the script does not parse it. The causes it can know are checked before
    git runs: an existing `index.lock` → exit 6 `index-lock` ("another git process is running
    in this repo"), checked before the index is reset or staged, since `reset` and `apply`
    take the lock too and would otherwise fail unmapped and leave the index half staged; a
    staged diff that is not exactly the group (not checked in `reword`, which usually runs
    on a clean tree; `staged` compares the index with the map instead) → exit 6
    `diff-changed`; a locked signing key → caught by `plan`.
  - `git commit` always runs with `--cleanup=verbatim`: the script has already normalised
    the message, and a user's `commit.cleanup=strip` would otherwise delete body lines that
    start with `#` (or `core.commentChar`), so the committed message would differ from the
    one lint approved.
  - Signing: never disabled. When `commit.gpgsign` is true, `plan` probes it
    (`plan.signing.ready`):
    - `openpgp`: a batch detach-sign with `--pinentry-mode error`. If it fails, the
      `pinentry-program` from `gpgconf --list-options gpg-agent` decides: a GUI pinentry
      (`pinentry-mac`, `pinentry-qt*`, `pinentry-gtk*`, `pinentry-gnome3`, `pinentry-w32`, or
      none set on Windows, where Gpg4win's default is a GUI) → `"prompt"`; anything else
      (`pinentry-tty`, `pinentry-curses`, none set on Linux or macOS) → `false`.
    - `ssh`: the key is in `ssh-add -L` or has no passphrase → `true`, else `false`.
    - `x509`: `"unknown"`.
    - A custom signing program is outside the probe's view and never maps to `false`: a
      `gpg.ssh.program` other than the default (1Password's `op-ssh-sign` asks with Touch ID
      or a window, and its key is usually not in the default agent's `ssh-add -L`) →
      `"prompt"`; a custom `gpg.program` → `"unknown"`.

    `false` → `plan` refuses with exit 6 `signing`, before any lock or grouping: "signing key
    locked — unlock it (e.g. sign once in a terminal), then `/commit`". `"prompt"` → the run
    goes ahead and the reply's `notices` say "a passphrase window may have popped up during
    the commit". The worker commits through `check --commit` before anyone reads a notice,
    so the window itself is the first sign; the notice explains it afterwards. `"unknown"`
    → the run goes ahead.
  - Timeouts: `commit --all` and `check --commit` run with a 600-second tool timeout (the
    Bash tool's maximum; the worker's prompt says so, and a handback's `run` carries
    `timeoutMs`). The script's own budget is 540 seconds per call, not per group: the first
    group always starts, a later one only while at least 480 s are left; otherwise the call
    stops cleanly with a `continue` handback that runs the same command, and the run goes on
    where it stopped (the handback goes to the caller, which follows `callerRule`; the
    guard denies the worker's own `commit` call, Q25). Each
    `git commit` is timed out at what is left of the budget. On timeout it kills the process
    tree (`taskkill /T /F` on Windows, the process group elsewhere), removes `index.lock`
    only when it is newer than the spawn, and reports "git commit did not finish in 9 min —
    a pre-commit hook or a signing prompt may be waiting".
- **Rejected.**
  - Rolling back committed groups (destroys work the user may want); retrying on a repo hook
    failure (the hook's rules are not the plugin's to guess); `-c commit.gpgsign=false`.
  - `GIT_TERMINAL_PROMPT=0` as the signing guard: it governs credential prompts, not pinentry.
  - A 120-second timeout with a signing-specific message: the Bash tool's own default kills
    the script first, and a slow pre-commit hook is indistinguishable from a signing prompt.
  - Treating every uncached openpgp key as not ready: gpg-agent's default cache lasts
    10 minutes, so a GUI pinentry user would be sent to a terminal on most runs, although the
    real commit would have shown the passphrase window.
  - Telling hook, signing and lock failures apart by parsing git's stderr: localised and
    mixed with arbitrary hook output.
  - Reporting a moved HEAD as `diff-changed`: its message ("files changed") names the wrong
    cause when only HEAD moved.
  - A literal `message: <text>` answer after two failed lints that skips the worker: a
    third input path in the prompt, and `edit` already carries dictated text.
  - A 540-second timeout per group inside `--all`: two groups behind a slow hook pass the
    600-second tool maximum, and three can pass the 15-minute lock window (Q22).
  - Counting lint attempts in the worker's prompt: a prompt rule, where the script can
    count deterministically.
  - An unconditional `git reset -q` on every `split` failure: after a refusal in (a) or
    (b) it reset an index the run never touched, and after `index-lock` it ran into the
    same `index.lock` and failed unmapped.
- **Consequences.** A failed run leaves a clean, explainable state. A GUI pinentry prompts for
  the passphrase during the commit, within the 540-second timeout; SSH signing through an
  agent works without interaction; a TTY pinentry must be unlocked beforehand, and a locked
  key is caught before any work.

## Q19 Large diffs

- **Context.** Lockfiles, generated and minified files, and big untracked files would flood the
  worker and slow the scan.
- **Decision.**
  - `plan --hunks` marks a file `summary-only` when it is a known lockfile, `*.min.*`, `*.map`,
    marked `linguist-generated` in `.gitattributes`, over 1000 changed lines, or over 256 KB.
    The worker gets only its stats (`+a -b`) and groups it as a whole file.
  - Hunk **bodies** in `plan --hunks` are capped at 3000 changed lines in total, counted over
    files in path order (byte-wise, UTF-8). The first file that would cross the cap and every
    file after it get no body in `hunks.txt`, but keep one ID per hunk with its range and
    line counts (`"body": "cap"` in the index). The worker can still split such a file by
    its ranges, and may `Read` the working-tree file at a range. The cap limits the
    worker's context, not the tool output.
  - Tool output limits are handled separately (Q9). The Bash tool cuts output at about
    30 000 characters and `Read` cuts lines over 2000 characters, so hunk bodies go to
    `hunks.txt` (raw text, one line per diff line), which the worker `Read`s in pages; stdout
    carries only an index within a 20 000-character budget. `plan`'s own stdout fields
    stay within 1 kB (its `reply` and `hunks` have their own budgets, Q9), and its full
    output always goes to `plan.json` in the run folder. Accepted: a diff line over 2000
    characters is cut by `Read`; grouping needs the shape of a hunk, not every byte, and
    minified files are summary-only anyway.
  - The scan still covers lockfiles and `.map` files (tokens do leak into them). Its skip
    limit is 1 MB of added content (Q10). Untracked directories collapsed by the count cap
    (Q16) are neither planned nor scanned.
- **Rejected.**
  - No cap: a single lockfile update can exceed the worker's useful context.
  - Making files past the cap summary-only (whole-file units): the files past it are not
    huge, only late in path order (`z…`, `tests/…`), so on any diff near the cap the last
    files would lose hunk-level grouping.
- **Consequences.** Grouping inside a summary-only file is not possible; it is always one
  unit. Past the cap, grouping works from ranges and line counts alone, unless the worker
  `Read`s the file.

## Q20 Reword via amend

- **Context.** "Fix the last commit message" needs `git commit --amend -m`, which the guard
  denies (Q4), and bare `--amend` opens an editor.
- **Decision.** The worker has an amend path, used only when the user explicitly asks to reword
  the last commit.
  - The script runs `git commit --amend --only -F -`: with `--amend` and no paths, `--only`
    changes the message only; staged changes stay staged and are not included (verified
    2026-09-26).
  - Flow, all inside the worker (input `reword: true`, or `reword: <dictated text>`):
    `plan --reword` (takes the lock and records HEAD, Q9) → the worker writes the message
    from HEAD's diff and old message (`reword` mode), or, after
    `plan --reword --dictated` (no hunk index, Q9), writes the dictated text as a
    one-group worker plan with `"source": "user"` → `check --commit`, which commits at
    once. No confirmation on the first spawn (Q16); a respawn after a `lintFailed`
    answer is `resumed` and confirms like any other.
  - Dictated text that fails lint (a missing type: "Fixed the parser") is not fixed by
    the worker: the first lint failure of `"source": "user"` text returns the
    `lintFailed` handback (Q18), where the user types the corrected text under Other or
    picks `retry`. Either way the resumed run shows the result before the amend.
  - No content changes, so no content scan, no reset, no staging and no staged-diff check
    (Q18). Lint and the message scan (Q10) apply. A failure leaves the index as it is.
  - `commit` refuses with `head-moved` when HEAD is no longer the commit `plan --reword`
    checked, so the amend never rewrites a commit that skipped the pushed check (Q18).
  - Trailers of the **old** message, read with the script's footer parser (Q13):
    - allowed tokens (`BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes`, `Fixes`) are not
      carried over; the new message owns them. The worker sees the old message, and text the
      user gives is taken as meant.
    - any `Co-Authored-By: … <noreply@anthropic.com>` (whatever the model name) is dropped;
      the current attribution replaces it, so it is never doubled.
    - every other trailer (`Signed-off-by`, a human `Co-Authored-By`, Gerrit's `Change-Id`) is
      carried over verbatim, in its original order.

    Footer order in the result: the new message's footers, then the carried trailers, then
    the attribution.
  - The attribution follows who wrote the text: it is appended when the worker wrote the
    new message, or when the old message had an attribution trailer. Text the user dictates
    (`"source": "user"`) on a commit without one gets no Claude trailer, so a hand-written
    commit is not claimed as co-authored. `source` is set by the worker from its input;
    like the rest of the plugin it steers and does not enforce (Q3). After an `edit` or a
    `retry` it stays `user` only when the worker writes the user's words unchanged. In
    `split` and `staged` the worker always writes the message, so the attribution always
    applies.
  - Refused (by `plan --reword`, before the run folder exists) when HEAD is reachable from
    any remote-tracking ref (`git for-each-ref --contains HEAD refs/remotes`), on an unborn
    HEAD, or when HEAD is a merge commit (`state`: "HEAD is a merge commit; reword it by
    hand"). A root commit is allowed; its diff is against the empty tree.
  - The message: text the user gives is passed through `check` as is, and never rewritten
    by the worker unless the user answers `retry`; otherwise ("make it better", "wrong
    type") the worker writes it in `reword` mode.
- **Rejected.**
  - Leaving rewording to the user (`!git commit --amend`): a common request would always need
    manual work.
  - Refusing when the index is not empty: `--only` makes it unnecessary.
  - Checking only the branch's upstream: misses commits pushed to another remote or branch.
  - Refusing to reword a commit with foreign trailers: a Gerrit repo, where every commit has
    a `Change-Id`, could never reword.
  - A separate `commit --amend` entry point without `--plan` for user-supplied text: a second
    input path to lint and lock.
  - Rewording a merge commit with its first-parent or combined diff: its message is usually
    git's own "Merge branch …", outside Conventional Commits, and either diff misdescribes
    what the merge did.
  - Appending the attribution to every reword: claims the user's own words, on a commit a
    human wrote, as co-authored. Never appending it in a reword: the worker's rewrite of a
    commit would go unattributed.
- **Consequences.** The allowlist stays free of any message-writing form. Accepted gap: stale
  remote-tracking refs (pushed from another clone, not fetched) pass the check; the README
  notes it.

## Q21 Repo states

- **Context.** Not every repo is on a branch with a HEAD and nothing in progress. `git diff
  HEAD` and `git show HEAD:` fail on an unborn HEAD, and during a merge the first group would
  become the merge commit.
- **Decision.** `plan` reports `state` and acts on it:

  | State | Behaviour |
  | --- | --- |
  | unborn HEAD | handled: diff against the empty tree, no `scanIgnore` (no HEAD config), reword refused, pushed check skipped |
  | merge, cherry-pick or revert in progress | refused: "finish it with `git commit --no-edit`, or abort it" |
  | rebase in progress (including `edit` / `reword` stops) | refused: "continue the rebase by hand" |
  | bisect in progress | refused |
  | detached HEAD | handled, with a warning |
  | not a repository, bare repository | error |

  Detection: `git rev-parse --git-path` for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
  `rebase-merge`, `rebase-apply` and `BISECT_LOG`.
- **Rejected.** Letting the worker make the in-progress commit: its message, parents and
  conflict state belong to the operation, not to a Conventional Commits plan.
- **Consequences.** Finishing a merge goes through the guard's `--no-edit` form (Q4), which is
  what that allowance exists for.

## Q22 Concurrent runs

- **Context.** Q17's workflow can run several implementers in one repo. Two `/commit` runs
  clobber each other's index (`git reset`) or collide on `index.lock`.
- **Decision.**
  - `plan` takes a run lock when there is work to do (Q9):
    `<toplevel>/.commit-plan/lock` (next to the run folders, Q9) created exclusively (`wx`), holding
    `{ planId, created }`, written once and never rewritten. Re-plans reuse the `planId`
    and never take a second lock.
  - `touched` is the lock file's **mtime**. Every subcommand with `--plan` (`plan --hunks`,
    `check`, `commit`) reads the lock, checks it holds its `planId`, then refreshes the mtime
    with `fs.utimesSync`. Nothing truncates or rewrites the lock, so a concurrent `plan`
    never reads a half-written one. If a takeover lands between the read and the
    `utimes`, the refresh touches the new holder's lock, which is harmless, and the next
    step's read refuses the old run.
  - A lock whose `touched` is under 15 minutes old refuses the new run with exit 6 `lock`:
    "another /commit run is in progress (started 13:58, last active 40 s ago)", the same
    wording as the takeover question below. An older one is taken over with a warning.
    `commit --all` touches the lock before every group and stops within its 9-minute
    budget (Q18), so a slow hook never loses the lock mid-run.
  - An empty or unparseable lock (a `plan` between its `wx` create and its write, or one
    killed there) is judged by its mtime alone: fresh → `lock` ("another /commit run is
    starting"), `planId: null`, so it cannot be taken over by `--take-over` and the user
    waits for the 15 minutes (only a process killed in that window leaves one behind);
    stale → the automatic takeover.
  - Takeover, automatic or `--take-over <planId>`, is atomic: `plan` renames `lock` to
    `lock.<own planId>` (only one of several renames of the same file succeeds; the others
    get `ENOENT` and retry the exclusive create, which then refuses them with `lock`), reads
    the renamed file and checks it is the lock it decided on: automatic, the bytes and
    mtime it judged stale (a rename keeps the mtime); `--take-over`, the `planId` the user
    was asked about. On a match it deletes that run's folder and the renamed file, then
    creates its own lock exclusively. On a mismatch it moved a lock that another `plan`
    created in between: it puts it back with `fs.linkSync` (fails if a lock exists, so it
    never overwrites one), deletes its copy and refuses with `lock`, carrying the details
    of the lock it found, so the question can be asked again about the right run. If the
    link fails, the moved run is refused at its next step ("taken over"). That refusal
    does not end the run, so its folder stays until `plan`'s 24-hour sweep; accepted.
  - On Windows, a rename, read or `utimes` of a lock that another process holds open fails
    with `EPERM`, `EBUSY` or `EACCES`, not `ENOENT`. Every lock operation maps those to
    "someone else is on it" and refuses with `lock`, never with `internal`.
  - Interrupted runs: Esc at the confirmation, a cut-off session, or a worker that dies or
    is stopped after `plan` (context limit, tool error, Q25) leaves the lock behind, and the
    next `/commit`, often in the same session a minute later, meets a stale lock (seen in
    the spike's first interactive run: an Esc while the worker ran left its run folder
    behind, and the retry followed within 20 s). A `lock`
    refusal in an interactive run carries a `lock` handback (Q25): "A /commit run started
    at HH:MM holds the lock, last active 40 s ago. It may still be running (a subagent
    committing in parallel); taking it over resets its index mid-commit. Take it over?",
    built from the holder's `planId`, `created` and `touched`. Its `take over` answer
    respawns the worker with `takeOver: <that planId>`, plus the mode of the refused call
    (Q9: a respawn repeats the flags of the `plan` call that built it), which runs
    `plan --take-over <that planId>` with that mode: it replaces that lock only and
    deletes the old run's folder; if the run finished in the meantime and a subagent
    took a fresh lock, the takeover refuses instead of resetting a run nobody asked
    about. `--take-over` exists only in that respawn. A run without a user
    (`--no-user`) gets a plain refusal and returns it to its parent.
  - `plan --hunks`, `check` and `commit` take `--plan <planId>` and refuse unless the lock
    matches. A run that was taken over is refused at its next step: "this run was taken
    over by another /commit; run /commit again". That message needs a lock held by another
    `planId`; when there is no lock at all, the run has ended on its own (`diff-changed`,
    `head-moved`, a failure): "this run has already ended; run /commit again". `release`
    also takes `--plan`, but on a mismatch it is a no-op with exit 0 ("nothing to release:
    the run has already ended or was taken over"): its only caller is a `no` answer, which
    wants the run gone, and after a takeover it must not touch the new holder's lock.
  - Released by the commit of the last group (the state file knows the group count from
    `check`), by `check` on zero groups (Q16), on a `humanOnly` hand-back or a final lint
    failure without a user (Q17, Q18), by every failure path (Q18), and by `release` (the
    `no` answer of a handback, Q25).
  - Housekeeping: releasing the lock deletes the run folder (state, hunks, temporary index,
    worker plan, `plan.json`), so no hunk hashes of past diffs are left behind. `plan`
    also deletes run folders older than a day, which covers runs that were never released.
  - The README recommends `isolation: "worktree"` for parallel implementers: each worktree has
    its own git dir, index and lock.
- **Rejected.**
  - Documenting the risk only: the damage (a reset index mid-run) is silent.
  - A `pid` in the lock: every subcommand is a separate short-lived process, so the pid says
    nothing about whether the run is alive.
  - Expiry measured from `created`: a multi-group run with slow hooks, or a user slow to
    answer, would lose its lock halfway.
  - "Delete `<path>` if it is stale" as the only way out: an interrupted run in the same
    session is a common refusal, and it would cost 15 minutes or a manual delete.
  - Asking without the lock's age: a refused lock is by definition touched within 15
    minutes, and with parallel implementers (Q17) a live holder is a real case; the user
    needs "last active 40 s ago" versus "12 min ago" to answer.
  - A session-aware lock (the guard's `session_id`, same session takes over automatically):
    parallel implementers in one session share the `session_id`, which is the case the lock
    exists for.
  - A shorter window: a user slow to answer the confirmation would lose the lock.
  - Delete-then-create for a stale lock: two `plan`s that find the same stale lock (parallel
    implementers after an interrupted run) can both delete it, one of them the other's new
    lock, and both believe they hold it.
  - A bare `--take-over` that replaces whatever lock it moves: between the question and the
    call the asked-about run can end and another take a fresh lock, which is then reset
    unasked, the parallel-implementer case the question exists for.
  - `touched` inside the lock, refreshed by a rewrite: `writeFile` truncates first, so a
    concurrent `plan` could read an empty lock; a temp file renamed over `lock` could
    overwrite a lock a takeover had just created.
- **Consequences.** Manual git activity during a run is not locked; an `index.lock` present
  before `git commit` is refused as `index-lock`, and one created during it surfaces as an
  ordinary Q18 failure.

## Q23 Guard heartbeat

- **Context.** Without Node on the hook's PATH, with plugin hooks disabled or with
  `disableAllHooks` set, the guard does not run and nothing says so (Q1).
- **Decision.**
  - `plan` itself runs through the Bash or PowerShell tool, so the guard's `PreToolUse` fires
    for it. When a segment of the tokenised command is a script call to `plan` (`node` or
    `node.exe`, then a token whose basename is `commit.js`, then `plan`, after quote
    removal; [contracts](contracts.md#guard)), the guard writes
    `~/.claude/commit-guard/heartbeat.json` (`os.homedir()`) = `{ ts, cwd, command }`. Not
    `os.tmpdir()`: Claude Code's sandbox gives sandboxed Bash commands their own `TMPDIR`,
    while `HOME` stays the same, and only the unsandboxed hook writes the file.
  - `plan` reads it: a `ts` under 15 minutes old and a `cwd` that matches →
    `env.guard: "active"`, otherwise `"not-seen"`. Matching: both paths are normalised
    (realpath, `\` → `/`, case-folded on Windows and macOS), and the hook's `cwd` must be
    inside `plan`'s git toplevel, or the toplevel inside the hook's `cwd`. This covers
    `cd sub && node …/commit.js plan` and `cd repo && …` from a parent directory without a
    git call in the hook.
  - On `not-seen` the reply's `notices` tell the user "Guard hook did not run: `node`
    missing from the hook's PATH, plugin hooks disabled, or `disableAllHooks` set. Direct
    `git commit` is not blocked." The run goes on.
- **Rejected.**
  - Inferring the hook's state from settings: managed settings and runtime state are not all
    visible to the script; the heartbeat measures what actually happened.
  - Comparing raw `cwd` strings: `cd sub && …` and Windows path case and slashes make them
    differ although the guard ran.
  - Matching the substring `commit.js plan` on the raw command (the design before the
    ninth review): every script call is quoted for the anchored allow rule (Q16), so the
    raw text holds `commit.js" plan` and never matched. Every run would have carried a
    false "Guard hook did not run", and Q25's worker-only deny would never have fired.
  - A 10-second window: `PreToolUse` runs **before** the permission prompt, so without the
    README's allow rule a user who takes more than 10 seconds to approve `plan` gets a false
    "guard did not run", on the first run in every new setup, which is when the user decides
    whether to trust the warning. The guard's state rarely changes within a session.
- **Consequences.** Needs the `node *commit.js*` entries in the hook `if` condition (Q13).
  Accepted gaps: a session without the guard that runs `plan` in the same repo within 15
  minutes of one with it sees the other's heartbeat and reports `active` (same machine, same
  repo, different hook settings: rare). A guard disabled mid-session is noticed only after
  15 minutes. `cd ../other-repo && …` reports `not-seen` although the guard ran (a false
  warning, never a false all-clear).

## Q24 Token budget

- **Status.** Decided on 2026-09-26 after a design session; supersedes Q12 where they
  conflict. After the eighth design review the affected entries (Q2, Q3, Q4, Q6, Q8, Q9,
  Q15–Q20, Q22, Q23) and the contracts were rewritten to match, and the worker protocol
  became Q25. The commit-worker spike (open verification items, 2026-09-26) confirmed the
  direction: the description triggers, the worker runs on its own model, nested spawns
  work, and a pure commit prompt costs the main thread 2 calls headless. It moved the run
  folder out of `.git` (Q9), made the allow rules required (Q16) and dropped `workerModel`
  (Q6).
- **Context.** Measured on 2026-09-26 over 414 Claude Code transcripts from one machine,
  none of them from this plugin: 2,368 commit episodes with 3,052 `git commit` calls, made
  without the plugin. Cost is in input-token equivalents (input 1×, cache read 0.1×, 1 h
  cache write 2×, output 5×).

  | Metric | Median | p90 |
  | --- | --- | --- |
  | API calls with tools per episode | 1 | 3 |
  | tokens of git status / diff / log / show output the agent chose to read | 134 | 1,385 |
  | output tokens | 1,668 | 4,084 |
  | context when the episode starts | 288k | — |
  | episode cost | 76k | 196k |

  - Cost is calls × context. Every extra main-thread API call re-reads the whole context
    from cache, about 0.1 × context: 29k at the median. Over all episodes, git output
    was 1.19M tokens against 1.79B tokens of cache reads. A p90 diff carried for 50 more
    turns costs about 7k, less than a quarter of one extra call. Keeping the diff out of
    the main context (Q12's reason for the planner) saves next to nothing.
  - 62% of episodes are a single call, usually `git add … && git commit -F - <<EOF` at the
    end of a TDD step, where the agent already knows what it changed. 39% ran in a
    subagent, whose context is also large (median 230–250k). 16.5% made more than one
    commit.
  - A prompt-only personal commit skill (10 episodes): median 4 calls and 113k, about 1.5×
    the baseline; its body is about 1.3k tokens per invocation.
  - About 2% of commit calls failed. Ten of these were shell quoting or heredoc errors,
    which the `Write`-based `plan.groups.json` removes (Q9). The saving averages under 1k per
    commit.
  - Outliers: a subagent took 22 calls to make 8 commits, diffing and committing file by
    file. A turn after the cache expired re-wrote up to 1.4M tokens. Both make extra calls
    even more expensive.
  - Caveats: episodes are grouped heuristically, and the weights assume 1 h cache writes.
    The git-output row measures what the agent read, which is little when it already knows
    its change; it is **not** the size of the diff at commit time, which was not measured.

  Estimate for the design as of the seventh review, at the median context. The main thread
  makes Skill → `plan` → Agent → `check` → (confirmation) → `commit` × N → reply calls,
  against commit → reply without the plugin:

  | Case | Extra cost | Total | × baseline |
  | --- | --- | --- | --- |
  | one group, no confirmation | +4 calls (~115k), SKILL.md (~8k, then carried), `plan` and `check` JSON (~3k), planner (~20–40k) | ~220k | ~2.9 |
  | two groups, confirmation | two more calls | ~280k | ~3.7 |
  | guard deny first (Q3): the agent reads status, diff and log, is denied, then runs the skill | baseline, plus one deny call, plus the full run | ~300k+ | ~4 |

  A lint retry, an `edit` or a `one` answer spawns a new planner that re-reads the whole
  diff, even when only a header changes. The plugin saves tokens only on long split loops
  (the 22-call case needs about 11 calls) and on quoting failures. Its gains are
  correctness: the scan gate, lint and grouping.
- **Decision.** Resolved in a design session on 2026-09-26, refined after the eighth
  review. The run moves out of the main thread into one worker agent; the main thread spawns
  it and relays.
  - **One worker, no separate planner.** `commit-planner` becomes `commit-worker` (tools
    `Bash`, `PowerShell`, `Read`, `Write`). It runs `plan`, reads `hunks.txt`, writes
    `plan.groups.json`, runs
    `check --commit`, which commits when nobody needs to be asked. It starts with a fresh
    context, so it reads the diff itself; a nested planner would add a second agent prefix
    (about 20k) for nothing. A lint retry loops inside the worker (one, counted by the
    script, Q18). A user's `edit` or `one` arrives after the worker has returned its
    handback, so it is always a respawn with `resume: <planId>` (Q25); the respawned worker
    reads the previous plan from `plan.groups.json` and reads `hunks.txt` only when the edit
    changes the grouping, which it judges from the free text. The diff still never enters
    the main context, and the worker still writes every message (single-author rule, Q12,
    Q17).
  - **Launch through the Agent tool, not a forked skill.** A `context: fork` skill runs on
    the caller's model whatever its `model:` says (Claude Code docs, 2026-09-26), so the
    worker would run on the main session's Opus or Fable; `agent:` in a skill is documented
    for `.claude/agents/` types, not plugin agents. A plugin agent's `model:` is honoured.
    - The model spawns `Agent(commit:commit-worker)` directly, triggered by the agent's
      description (Q2). A plugin agent's type is namespaced by the plugin
      (`commit:commit-worker`, spike); every text that names it uses that form.
    - The `/commit` skill gets `disable-model-invocation: true` (Q2): no resident
      description, loaded only when the user types `/commit`, and it does the same spawn.
      Its SKILL.md is only the spawn, with the argument mapping of Q2; the handback
      carries the rest (Q25).
    - The guard's deny message (Q3, Q4) says "spawn the commit:commit-worker agent (…)",
      never "run /commit": the reason goes to the model, which cannot invoke `/commit`.
    - The worker's model: frontmatter `model: sonnet`, no config key (Q6). The Agent call's
      `model` parameter overrides it (docs and spike), so a caller that passes one wins;
      nothing on the spawn path passes one. Also in the frontmatter: `omitClaudeMd: true`
      (the worker needs none of the user's CLAUDE.md; listed as a supported plugin-agent
      field in the plugin docs, and verified: it drops both the project's and the user's
      CLAUDE.md, open verification items),
      `maxTurns: 25` as a runaway cap, and `tools: Bash, PowerShell, Read, Write`. Both
      shell tools are listed because a Windows setup may have only the PowerShell tool
      (no Git Bash); every script call is one `node "<script>" …` command that runs the
      same in both, the guard matches both (Q3) and the allow rules exist for both (Q16).
      The worker's prompt says "run each script call with whichever shell tool you have".
      Git Bash is therefore not a requirement next to Node (Q1). Whether a listed tool the
      session lacks is ignored, and a PowerShell-only worker runs, is part of the
      allow-rule spike (open verification items). The spike used 5–7
      calls for a one-group run; paging `hunks.txt` near the 3000-line cap (about 3
      pages), a `Read` of a capped file at a range and one lint retry can double that, and
      25 still leaves room. A worker that hits the cap dies after `plan` and leaves the
      lock (Q25: the takeover question on the next run), so the dogfood list includes a
      fixture run near the cap that must finish under it.
  - **Handback built by the script.** Every script output that needs a human carries a
    self-describing `handback`, and every output that ends the worker's part a `reply`; the
    worker returns the reply verbatim. Kinds, answers, `ifNoUser` and `callerRule` are Q25.
    `yes` and `no` run one script command in the caller and never spawn a worker.
  - **Callers without a user.** Q17: `interactive: false` makes the worker answer a plain
    confirmation itself; omitted, the caller follows the handback's `ifNoUser`. An
    implementer subagent with `interactive: false` makes the same calls as the main thread
    (Agent, reply, plus a notification turn if the spawn runs in the background).
  - **Measured main-thread calls** (spike, interactive, background worker): a run without a
    confirmation 3 (Agent, acknowledgement, reply); a confirmed run 5 (Agent,
    acknowledgement, `AskUserQuestion`, the handback's `run`, reply); `no` the same 5 with
    `release`. The main thread used `AskUserQuestion` and ran the `run` command verbatim,
    without a permission prompt, both times. In the later nested-spawn probe, which got
    the `SubagentHandback` delivery (Q25), the main thread took one turn for the hand-back
    and one more for the completion notification that followed it: 4 for a run without a
    confirmation, if a direct spawn behaves the same (the gate's harness floor, below).
  - **Also adopted:** `commit --plan <planId> --all` (Q9, Q18); `check --commit`; the
    compact `plan` stdout with the rest in `plan.json` (Q9); a dictated reword passed in the
    worker input (Q20); Haiku through the frontmatter default, for every mode, once the
    eval allows it (Q6, Q12); workflow skills that end in a commit (a TDD skill) spawning
    the worker with its public input fields (Q25).
  - **Budget and gates.** The user runs on a Claude subscription: usage counts against plan
    limits whose weighting of cache reads, cache writes and output is unpublished, and Opus
    may be metered separately. So the gates are counted in calls and raw tokens, not in
    price-weighted cost:
    - CI size tests: agent and skill descriptions ≤ 200 characters, `/commit` SKILL.md
      ≤ 1.5 kB, the worker's agent prompt ≤ 6 kB, `plan`'s own stdout fields ≤ 1 kB, the
      `reply` without its `text` ≤ 2 kB (its `callerRule`, `notices` and `handback`
      included), the reply's `text` ≤ 4 kB with every list at its cap (10 entries, then
      "+N more"; the messages a `confirm` block or a `lintFailed` text quotes are not
      counted, since the user has to read them whole), `plan --hunks` stdout ≤ 20 000
      characters. The budgets add up
      and do not nest: `plan`'s stdout is its own fields plus either a `reply` or the
      in-process `hunks` output, each tested against its own limit, and a refusal's
      `error` object counts toward the 1 kB. Starting values; the slice that writes the
      prompts sets the exact limits.
    - 1.0.0 gate, measured **per episode** (the baseline's unit; a two-group run is one
      episode) on at least 30 dogfood episodes, on a machine without a personal commit
      skill (Q8), with the episode analysis (moved to `tools/`, not packaged). An episode
      includes any denied `git commit` attempt before the spawn. Median main-thread API
      calls per episode for the commit itself, gated separately for unconfirmed and
      confirmed episodes: unconfirmed ≤ 3 in an interactive session, where the worker
      runs in the background (Agent, notification turn, reply), and ≤ 2 in a headless
      one, where the Agent call blocks (spike: 2 in every pure commit prompt); confirmed
      ≤ 5 (spike: 5). A third bucket, **question before planning**, holds episodes with a
      `modeChoice` or `lock` handback (Agent, reply, `AskUserQuestion`, respawn, reply: 6
      or more calls before any confirmation), gated against its own harness floor. A
      single median over all of them would fail by construction once more than half the
      episodes confirm. These limits hold for the delivery shape the spike
      measured (the reply arrives in the completion notification). Under the
      `SubagentHandback` shape (Q25) the harness adds a turn the plugin cannot remove, so
      each limit is the **harness floor** for the shape in use: the calls a stub worker
      that replies at once takes in the same shape, measured once per shape (3 and 5
      above for the notification shape). Each episode records its shape. The
      **confirmation share** `c` and its trigger reasons are reported, and next to `c`
      and `d` the `modeChoice` share and the `lock` share. A likely `modeChoice` source is
      an agent that ran `git add` in its own call and was then denied on `git commit`: the
      spawn finds "index plus other changes" and asks about staging the user never did.
      If that share is high, the staged-by-agent case is reconsidered with the data.
      Median tokens
      that reach the main context per episode (cache writes plus output) ≤ the baseline
      plus 2k; the **deny share** (episodes with a guard deny) reported; worker tokens reported
      per model; the diff size at commit time (`git diff HEAD --numstat`, and the tokens of
      `hunks.txt`) recorded, which replaces the assumed worker cost below. The
      price-weighted ratio is reported as a proxy only. The gate sits next to the Haiku eval
      (Q12); 1.0.0 waits on both.

  Estimate, per episode at the median context, as a function of the deny share `d` (the
  share of episodes where the agent first tries `git commit` and is denied): baseline 76k,
  plus the worker (assumed 20–40k on Sonnet until dogfood measures the diff size), plus one
  main-thread call (~29k) if the spawn runs in the background, plus one more (~29k) in the
  `SubagentHandback` delivery shape (Q25: the hand-back turn and the completion
  notification), plus `d` × (one denied call,
  ~29k, and whatever the agent read before it), plus `c` × two main-thread calls (~58k),
  where `c` is the confirmation share of interactive episodes (`AskUserQuestion` and the
  handback's `run`; an `edit` or `one` adds a respawn and a second confirmation), plus `q` ×
  at least two main-thread calls (~58k) for the `modeChoice` and `lock` share `q` (the
  question and the respawn's reply), which the figures below leave at 0. With a
  blocking spawn and `d = c = 0`: about 100–115k (≈ 1.3–1.5×). Background, notification
  shape, `d = 1`, `c = 0`: about 160–175k (≈ 2.1–2.3×); with `c = 0.5`, about 190–205k
  (≈ 2.5–2.7×). The `SubagentHandback` shape adds about 29k to each background figure.
  Q24's own
  data (62% single-call `git add … && git commit` episodes) says `d` stays high unless the
  agent description and workflow skills change the habit. `c` is high by design in TDD work:
  `split` confirms on more than one group or any new file, and a TDD step often adds a test
  file. The new-file trigger stays: it is the only check against a stray scratch file
  (`out.txt`, `debug.log`) the agent never meant to commit, and no deterministic rule tells a
  new test file from junk. The gate measures `d` and `c`, and records every trigger reason, so
  the new-file trigger can be narrowed with data (for example, a new file whose bucket is
  `test` next to a changed or new `code` file in the same group).
- **Rejected.**
  - Treating diff size as the cost driver: git output read in the baseline is about 0.07%
    of cache reads. The Q19 caps stay for the worker's context and the tool output limits,
    not for cost.
  - The caller driving the run with a planner subagent (the design before Q24): about six
    main-thread calls, ~2.9× the baseline.
  - A worker with a nested planner: a second agent prefix and nesting depth for no gain.
  - A `context: fork` skill as the launcher: runs on the caller's model, and `agent:` is not
    documented for plugin agents.
  - A thin model-invocable skill that spawns the worker: three main-thread calls, and a
    SKILL.md loaded into the main context on every commit.
  - The model calling the Agent tool with no `/commit` skill at all: `/commit` must keep
    working for the user (the README's entry point).
  - "or run /commit" in the guard's deny message: the message goes to the model, which
    cannot invoke a `disable-model-invocation` skill; the call is wasted at full context,
    and on a machine with a personal commit skill it resolves to that skill (Q8).
  - Every answer respawning the worker: `yes` would pay an agent prefix to run one command.
  - The worker composing the answer commands: a script-built command cannot drift, and it
    stays a single `node … commit.js …` call for the allow rule (Q16).
  - Skipping the diff for a known single slice (`"source": "caller"`): after the worker
    move it costs more main-thread calls (`plan`, `Write`, `check --commit`, reply) than the
    worker saves, and it broke the single-author rule. A proposed header in `intent` with
    the worker skipping `hunks.txt`: the worker would lose its check that the change is one
    slice, and the caller would author the message again (Q12). The earlier cost argument
    ("the median diff is 134 tokens") misread the metric and is withdrawn; the dogfood
    measurement of the diff size can reopen the question on cost alone.
    `"source": "user"` stays only for a reword with dictated text (Q20).
  - A price-weighted ratio (≤ 1.6×) as a hard gate: it rests on API weights that do not
    describe subscription limits.
  - The gate per commit: divides a two-group run's calls by two, while the baseline is per
    episode. Leaving the denied attempt out of the episode: hides the path the data says is
    common.
  - Two or three worker agents, one per model, as the `workerModel` fallback: resident
    descriptions in every session, and Haiku waits on the eval anyway.
  - `CLAUDE_CODE_SUBAGENT_MODEL` as the model switch: global to every subagent.
  - Haiku for the message-only modes (`staged`, `reword`) only: the mode is known only
    after `plan` has run inside the worker, so the first spawn cannot pick the model. A
    `model` field on a script-built `staged` respawn would cover only the runs that went
    through a `modeChoice`, and adds a public field for it.
- **Consequences.** Q12 is superseded where it conflicts (see its status). The estimate
  depends on two numbers the design cannot fix on paper: the deny share and the worker's
  real cost; the gate measures both. The heartbeat (Q23) is unaffected: the worker's `plan`
  call still fires the guard.

## Q25 Worker protocol

- **Context.** After Q24 most runs start from the agent description (or the guard's deny
  message), and nothing loads SKILL.md there: `/commit` is not model-invoked. The caller
  still has a protocol to follow when a human is needed: show the question with
  `AskUserQuestion`, run a command verbatim with a 600-second timeout, or respawn the worker
  with the right input; and without a user, never answer `humanOnly`. A 200-character
  description cannot carry that. The eighth review also found answers that pointed at a run
  already released, notices with no place to go, and no plan for a worker that dies.
- **Decision.**
  - **Reply.** Every script output that ends the worker's part carries a `reply` built by
    the script ([contracts](contracts.md#reply-and-handback)): `status` (`committed`,
    `nothing`, `handback`, `failed`), `planId`, `text` (what the user reads), `commits`,
    `notices` and `handback`. The worker's final report is the reply, verbatim; in the
    spike it once put a sentence in front of the JSON, so the caller takes the first JSON
    object in the message, and the reply size test runs against the real prompt. `notices`
    carries what SKILL.md used to relay: guard `not-seen` (Q23), signing `"prompt"` (Q18),
    config warnings and the detached-HEAD warning, scan-hit notices (Q10), `indexOnly`
    notices; `text` carries `unstaged` (Q11, Q18) and repeats every notice in a `Notices:`
    block (at most 10 lines). `text` is the only field a caller relays, so a subagent that
    summarises "committed 2 groups" still passes "src/b.js:14 github-token left out" on.
  - **`callerRule` in every reply.** A fixed base rule ("show text to the user verbatim; a
    subagent puts text verbatim in its final report; the reply is final, no git log or git
    status") on every status, plus the handback rule when a handback is set. Notices
    arrive on `committed` and `nothing` replies too, and nothing else tells a subagent to
    pass them on: not the 200-character description, and no handback.
  - **Self-describing handback.** Each handback carries `question`, `answers` (each a `run`,
    one `node … commit.js …` command with `timeoutMs`, or a `respawn`, a complete worker
    input), `ifNoUser` (the answer to take without a user, and whether to return `text` to
    the parent), and the reply's `callerRule` gains the handback rule, the whole protocol
    in about 650 characters ([contracts](contracts.md#reply-and-handback)). The rule
    arrives exactly when it is needed. It covers what `AskUserQuestion` cannot take as is
    (2–4 options, "Other" added by the tool): a handback with `question: null`
    (`continue`) runs its one answer without asking; an answer with `needsText` (`edit`)
    is not an option but the text the user types under Other, which the question names;
    an answer with neither `run` nor `respawn` (`wait`) ends the run; and a `run`'s output
    holds a new reply, handled the same way (a `continue`, notices).

    | Kind | When | Answers |
    | --- | --- | --- |
    | `confirm` | a Q16 trigger, interactive | `yes` (run `commit --all`), `one` (respawn; `split` with more than one group only, Q16), `no` (run `release`); `edit` under Other (respawn) |
    | `modeChoice` | index plus other changes, no mode flag (Q9) | `staged`, `split` (respawn) |
    | `lock` | a live lock, interactive (Q22) | `take over` (respawn), `wait` |
    | `lintFailed` | second lint failure, or the first on dictated text; interactive (Q18) | `retry` (respawn with the errors), `no` (run `release`); `edit` under Other (respawn) |
    | `handedBack` | `humanOnly` without a user, run already released (Q17) | none: `text` says "nothing committed — run /commit to plan again" |
    | `continue` | `commit --all` out of budget (Q18) | `continue` (run the same command, no question) |

    An answer never points at a released run: `handedBack` has none, and the others exist
    only while the lock is held.
  - **Where each rule comes from.**

    | Entry path | Spawn rule | Handback rule |
    | --- | --- | --- |
    | model-invoked, main thread | agent description | `callerRule` |
    | model-invoked, subagent | agent description (plus Q17's `interactive`) | `callerRule`, `ifNoUser` |
    | `/commit` | SKILL.md | `callerRule` |
    | guard deny (Q3) | deny message | `callerRule` |
    | workflow skill | its own text, with the public input fields | `callerRule` |

  - **Worker input.** `key: value` lines in the Agent prompt, all optional: `intent`,
    `interactive`, `reword`, `mode`, `takeOver`, `resume`, `edit`
    ([contracts](contracts.md#worker-input)). The agent type `commit:commit-worker` and the
    fields `intent`, `interactive` and `reword` are **public surface**: `/commit` is not
    model-invocable, so a third-party workflow skill has to spawn the worker itself, and
    those three are all it needs. `mode`, `takeOver`, `resume` and `edit` are internal:
    they appear only in script-built `respawn` values, which belong to the handback shape,
    and the contracts mark them "respawn-only, do not write by hand". The README documents
    the one-line spawn ("spawn commit:commit-worker with `intent: …`").
  - **Respawns carry the caller's own fields.** The script builds each `respawn`, and
    repeats in it the flags of the call that built it (Q9: `mode`, `takeOver`). It never
    sees `intent` or a dictated `reword: <text>`: both live only in the worker's
    prompt. So the handback rule says "plus the intent and reword lines of your first
    spawn, and interactive: false if you cannot ask", and a caller adds exactly those,
    besides inserting the user's `edit` text. Without the `interactive` line a subagent
    that took `ifNoUser: split` would respawn without `--no-user` and pay one call more on
    every later handback. Without it, a `take over` on a
    dictated reword respawned as `reword: true` and committed a worker-written message
    nobody saw, and a `modeChoice` answer grouped without the intent that scopes the run
    (Q16, Q17). With
    `resume`, the worker takes the mode from the state file, and `plan.groups.json` still
    holds each group's `reason`.
  - **The caller waits.** In an interactive session the Agent call returns at once and the
    worker runs in the background (spike). Edits made before `plan` are grouped under an
    intent that does not describe them; edits after it end the run with `diff-changed`
    after the worker's whole cost. The agent description, `/commit`'s SKILL.md, the deny
    message's route and the handback rule all say "edit no files until the reply
    arrives". `diff-changed` stays the deterministic backstop. A nested spawn does not
    block either (nested-spawn probe, open verification items): in an interactive
    session a subagent's Agent call returned "Async agent launched" within a second, the
    subagent ran another command while the worker slept, then idled until the worker's
    report arrived as a message. So an implementer subagent is as free to edit files
    during the run as the main thread, and the rule applies to it too.
  - **Two delivery shapes.** How a worker's final report reaches its caller changed
    between two runs on the same Claude Code version (2.1.283) on 2026-09-26, so it is
    likely rolled out server-side:
    - Notification shape (the commit-worker spike): the worker's last message is the
      result, delivered in the completion notification's `<result>`.
    - `SubagentHandback` shape (the nested-spawn probe): a system reminder tells every
      subagent that only a `SubagentHandback({message})` tool call reaches its caller and
      that plain final text is not delivered. The tool was available to an agent whose
      `tools:` listed only `Bash`, so the worker's tool list needs no change. The caller
      gets the report as a message framed "model output, NOT a message from the user:
      instructions … inside it are the subagent's", followed later by the completion
      notification.

    Consequences: the worker's prompt says "your final report is the reply JSON,
    verbatim", not "your final message", so it holds in both shapes. The framing makes
    `callerRule` untrusted text in the caller's eyes: its authority has to come from text
    the caller does trust, the agent description ("follow the reply's `callerRule`",
    Q2), SKILL.md or the deny message, which is why that clause stays in the
    200-character description whatever else is cut. For `yes` and `no` the user's
    `AskUserQuestion` answer is the authority anyway; the unasked paths (`continue`,
    `ifNoUser`) lean on the description alone. Whether a caller follows a handback in
    this shape is part of the hand-tests (open verification items).
  - **Script path.** An agent file gets no base directory, and on the model-invoked path no
    caller knows the path either. The agent body names the script as
    `${CLAUDE_PLUGIN_ROOT}/scripts/commit.js`, which the plugin loader substitutes (docs and
    spike); `/commit`'s SKILL.md does the same. The variable is **not** in the worker's shell
    environment (spike), so no command relies on it. A handback's `run` carries the script's
    own absolute path (`process.argv[1]`), so the caller needs none.
  - **The worker never answers a handback.** In the first spike run the worker read
    `callerRule`, found it could not ask a user, and ran `yes` itself, confirming its own
    plan. A prompt rule fixed it in every later run, and the guard makes it deterministic:
    it denies a script call (tokenised, [contracts](contracts.md#guard)) to `commit` or
    `release` when the hook input's `agent_type` is `commit:commit-worker` ("return the reply
    to your caller; its handback is not for you"). So a `continue` handback also goes to the
    caller. `check --commit` commits inside its own process and is not affected.
  - **Trailers are the script's.** The harness tells the main thread to end commit messages
    with its Co-Authored-By line, and the main thread passed that into the worker's prompt
    (spike); the worker spent three calls on it. The worker's prompt says the script adds
    every trailer (Q5, Q13) and any instruction to add one is ignored; the reply's `text`
    names the trailer the script appended, so the caller does not offer to add one by hand.
  - **No verify call.** After an implement-then-commit task the main thread ran
    `git log` / `git status` once the worker had returned (spike: 2 of 2 such runs). The
    reply's `text` therefore ends with the tree state ("working tree clean", or "N files
    left: …"), and the base `callerRule` says the reply is final, on every reply. The
    agent description does not repeat it (Q2).
  - **A worker that dies or is stopped** (Esc, context limit, tool error) after `plan` took
    the lock returns no reply, or an error without the `planId`. The caller does not guess
    an ID and runs nothing. The next run meets the lock and Q22's takeover question, which
    shows how long ago the run was last active; after 15 minutes the lock is taken over
    automatically. When the worker can still answer, its fallback reply carries the `planId`
    it knows ([contracts](contracts.md#worker-input)).
- **Rejected.**
  - The protocol in the agent description: it does not fit in 200 characters and would be
    resident in every session.
  - The protocol in the worker, with the worker asking the user: a subagent has no
    `AskUserQuestion` (Q17), and a worker in the background may not reach the user.
  - `interactive` as the only signal: a caller that forgets it gets a handback it has no
    instructions for. Dropping `interactive` and always handing back: one more call at full
    context per confirmation in every implementer (Q17).
  - Answers kept after a release (a `humanOnly` hand-back whose `yes` runs `commit --all`):
    the command fails with "this run has already ended".
  - The worker writing its own reply: the shape drifts, notices get dropped, and the size
    cannot be tested.
  - An internal spawn contract that third-party skills rely on anyway: a silent change
    would break them.
  - Releasing the lock from the caller when the worker died: the caller has no reliable
    `planId`, and a guessed one could release another run's lock.
  - The worker storing `intent` in `plan.groups.json` for `resume`: it covers only one of
    the three respawns, since `modeChoice` and `lock` end before any plan file exists.
    `plan --intent <text>`: brings back the shell-escaping problem (Q9).
  - `edit` as an `AskUserQuestion` option: an option has no text field, so a user who
    picks it leaves the caller without `{text}`. A `lintFailed` with `edit` and `no` only:
    one option is below `AskUserQuestion`'s minimum of two, hence `retry`.
  - `callerRule` only on handbacks (the design before the ninth review): notices on a
    `committed` reply had no rule that carried them past a subagent.
  - All seven input fields as public surface (the design before the tenth review): a
    workflow skill needs only `intent`, `interactive` and `reword`, and freezing the
    respawn-only fields would have blocked the respawn fix (Q9) and any later protocol
    change without a major version.
  - Respawns that hold only their own answer, with the caller adding `intent` and
    `reword` (the design before the tenth review): a takeover after a mode choice looped
    (Q9).
- **Consequences.** Every entry path follows the same rule text, and the rule is tested
  once, in the script. Public surface grows by the agent name and three input fields; the
  respawn-only fields, the reply and the handback shapes stay internal (`version: 1`), since
  they describe themselves. A worker that dies costs the user one takeover question, or 15
  minutes.

## Non-goals

- Pushing and pull requests.
- Setting up commit signing (the plugin only coexists with it, Q18).
- Repos that do not use Conventional Commits (use the opt-out, Q14).
- Making the commit that finishes a merge, rebase, cherry-pick or revert (Q21).
- Folding new changes into an existing commit ("add this fix to the last commit"): the worker
  makes a new commit instead (Q4). Roadmap: a scanned amend mode with Q20's pushed check.
- Rewording a merge commit (Q20).
- Generating issue references; `Refs` / `Closes` / `Fixes` footers are written only when the
  user supplies them.
- Inferring monorepo scopes.
- Enforcing a message language: messages follow the language of recent history.

## Public surface

Hard to change once released; changes need a major version or a migration path:

- Config paths `~/.claude/commit.json` and `.claude/commit.json`, the key names, their layers
  and values (Q6).
- Plugin and marketplace identity `commit@commit`, the skill names and the agent name
  `commit:commit-worker` (Q8, Q25).
- The worker input fields `intent` (including that it scopes a `split` run, Q16),
  `interactive` and `reword` and their meaning (Q25), and that the caller follows a reply's
  `callerRule`.
- Scan pattern IDs (`github-token`, `local-path`, …): users see them in reports, and the
  roadmap's `scanIgnore` object form will name them (Q10).
- The env variable `COMMIT_GUARD_DEBUG` (Q1).

Internal, versioned with `version: 1` for the plugin's own tests and free to change in a minor
release: the script CLI and exit codes, the `plan`, `check`, `commit` and worker-plan JSON, the
`reply` and `handback` shapes, the respawn-only worker input fields `mode`, `takeOver`,
`resume` and `edit`, the run folder (state file, `plan.json`, `hunks.txt`,
`plan.groups.json`, temporary index) and lock, and the heartbeat file. Only the plugin's own
skills, agent and hook use them.

## Open verification items

- Whether a hook `if` condition matches when **any** subcommand of a compound command matches
  (`cd x && git commit`, `& git commit`). The docs say compound commands are split on `&&`,
  `||`, `;`, `|`, `&` and newlines, but not how `if` combines the parts. Decides between Q13's
  two variants. Planned as a spike before the guard slice, together with the `node
  *commit.js*` entries for the heartbeat (Q23).
- The `openpgp` signing probe (Q18): that `gpg --batch --pinentry-mode error` fails fast, and
  does not prompt, for a locked key with `pinentry-tty`, `pinentry-curses` and Gpg4win's GUI
  pinentry; that `gpgconf --list-options gpg-agent` reports `pinentry-program` on all three
  OSes; and whether `pinentry-gnome3` without a display falls back to curses (then it must
  map to `false`, not `"prompt"`). Spike before the signing slice.
- The heartbeat under the sandbox (Q23): that a sandboxed Bash command can read
  `~/.claude/commit-guard/heartbeat.json` on macOS (Seatbelt) and Linux (bubblewrap). If not,
  the spike picks another location both sides reach. Spike together with the `if` condition
  one.
- Tool output limits (Q9, Q19): the Bash and PowerShell tools' output cut-off
  (`BASH_MAX_OUTPUT_LENGTH`, about 30 000 characters by default) and the `Read` tool's
  2000-character line cap and default page size, on the current Claude Code. They set the
  20 000-character stdout budget and the `hunks.txt` paging. Spike before the file-level
  slice.
- The README allow rules (Q16): the commit-worker spike confirmed the cache layout
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and the quoted, anchored
  `Bash(node "…/*/scripts/commit.js" *)` rule with a `*` version segment, plus
  `Edit(**/.commit-plan/**)`, on Windows with the Bash tool. Still open: the `PowerShell(…)`
  rule, and macOS and Linux. Also the worker's shell (Q24): on a Windows setup without Git
  Bash, a worker with `tools: Bash, PowerShell, Read, Write` runs a whole run through the
  PowerShell tool with no prompt, and on a setup with both, listing both changes nothing.
  If a listed tool the session lacks breaks the agent, Git Bash becomes a documented
  requirement next to Node (Q1) instead. Also a home-based run folder
  (`~/.claude/commit-runs/<hash of the toplevel>/`) with a `Read(…)` and `Edit(…)` rule
  pair: whether it asks nothing and is not treated as a sensitive path; only then does
  Q9's location move. Before the file-level slice.
- The project directory (Q5): which directory the harness reads `.claude/settings.json` and
  `.claude/settings.local.json` from when Claude runs in a subfolder of a repo (launch
  directory or git toplevel), and whether `CLAUDE_PROJECT_DIR` reaches the Bash and
  PowerShell tools' environment (the commit-worker spike: not in a subagent's Bash
  environment; the main thread's is unchecked). Spike before the attribution slice.
- The temporary index (Q11): that `git diff -M` against an index copy with `git add -N`
  entries shows each intent-to-add path as `A` with its content, and pairs a deleted path
  with an intent-to-add path as `R` (a plain `mv` and a `git mv` after step 1's reset), and
  that `git diff --cached --no-renames --diff-filter=A` lists a `git mv`'s new path and works
  on an unborn HEAD, on git 2.34 and the current release. Spike before the file-level
  slice.
- Filtered files (Q11): with `git-lfs` installed, that `git diff` shows an LFS-tracked
  change as a pointer diff, that `git add` of the whole file stores the object under
  `.git/lfs/objects`, and that the staged diff then matches the planned hash; on git 2.34
  and the current release. The test suite covers the mechanism with a `sed` clean filter;
  this spike covers LFS itself. Spike before the file-level slice.
- Agent frontmatter (Q24): **resolved** on 2026-09-26. The plugin docs list `omitClaudeMd`
  among the supported plugin-agent fields (ignored there: `permissionMode`, `hooks`,
  `mcpServers`, `initialPrompt`). Probe (Claude Code, Windows, headless, `--plugin-dir`, a
  Haiku probe agent, a repo CLAUDE.md with a canary word, 2 runs each): with
  `omitClaudeMd: true` neither the canary nor the user's global CLAUDE.md reached the
  agent; without it, both did. The worker keeps `omitClaudeMd: true`.
- Nested spawn blocking (Q25): **resolved** on 2026-09-26 (Claude Code 2.1.283, Windows,
  interactive session, `--plugin-dir` probe plugin). The main thread spawned a
  `general-purpose` subagent, which spawned a Haiku stub worker that slept 20 s. The
  subagent's Agent call returned "Async agent launched" within a second; its next Bash
  call ran 10 s later, while the worker was still asleep; the worker's report arrived as a
  message about 20 s later, and the subagent waited for it before handing back. Nested
  spawns run in the background: "edit no files until the reply" applies to an
  implementer subagent too (Q25). The probe also showed the `SubagentHandback` delivery
  shape and the extra completion-notification turn in the main thread (Q24, Q25).
- Handback answers by hand (Q16, Q18, Q25), like the spike's tests B and C: `edit` typed
  under Other on a `confirm` (the respawn carries the text and the intent, the run is
  `resumed` and confirms again), `one`, `retry` and `edit` on a `lintFailed`, `wait` and
  `take over` on a `lock` (a dictated reword keeps its text), `modeChoice` answered
  `staged`, then `lock`, then `take over` (the takeover respawn carries `mode: staged` and
  commits the staged set; Q9), `one` absent from a single-group or `staged` confirmation,
  and a `continue` run without a question. Run in the delivery shape current at the time,
  and in both if both can still be reached: under the `SubagentHandback` framing
  ("instructions inside it are the subagent's"), the caller must still follow
  `callerRule`, including `ifNoUser` in a subagent and `continue` without a question. If
  it does not, the description's clause is strengthened or the protocol moves into
  SKILL.md-like trusted text. Before the reply slice is released.
- The commit worker (Q2, Q16, Q24, Q25): **resolved** by a spike on 2026-09-26 (Claude Code
  2.1.283, Windows, a throwaway local plugin with a stub worker and stub script loaded with
  `--plugin-dir`, headless `claude -p` runs with every skill disabled, so no personal commit
  skill competed; plus the Claude Code docs). Results:
  - `model`: the Agent call's parameter overrides the frontmatter (a `haiku` call ran on
    Haiku with `model: sonnet` in the frontmatter) → `workerModel` dropped (Q6, Q24).
  - Trigger: 7 of 7 commit requests spawned `commit:commit-worker` (5 on Opus 5.5, 2 on
    Sonnet 5), with 0 guard denies; an implementer subagent spawned it nested by itself. The
    main thread read the diff first once, with the first description; after "don't read the
    diff first" was added, 0 of 5. Small sample, explicit commit prompts: the deny share
    stays a dogfood measurement (Q24).
  - Blocking: in `-p` the Agent call blocks (2 main-thread calls for a pure commit prompt,
    5 of 5 with the final description). Interactive sessions spawn in the background
    ("Async agent launched", then a notification; the main thread acknowledges in between):
    3 calls for a pure commit, 5 with a confirmation (Q24). No frontmatter field forces the
    foreground (`background: true` exists, `false` is undocumented).
  - Permissions: a `Write` under `.git` is a "sensitive file" and always asks; no allow
    rule lifts it → run folder moved to `<toplevel>/.commit-plan/` (Q9). A heredoc is not
    matched by the `node` allow rule. With the anchored `Bash(node "…/*/scripts/commit.js"
    *)` rule and `Edit(**/.commit-plan/**)`, a run asked nothing (Q16), headless and
    interactive. Without them, a background worker's prompts surface in the interactive
    main session and hold the worker until answered (manual test A).
  - Handback, by hand in an interactive session (manual tests B and C): the main thread
    showed the confirmation with `AskUserQuestion`; `yes` ran `commit … --all` and `no` ran
    `release`, each verbatim, with no prompt and no respawn; after `no` nothing was
    committed and the run folder was gone. The worker once prefixed the reply JSON with a
    sentence (Q25).
  - Script path: `${CLAUDE_PLUGIN_ROOT}` is substituted in the agent body; the variable is
    set in the hook's environment but not in the worker's shell (Q25).
  - Nested: a `general-purpose` subagent spawned the worker, got a confirm handback, and
    applied `ifNoUser` (`yes`) correctly. The docs allow 3 nesting levels.
    `AskUserQuestion` is in neither the subagent's tool list nor its deferred list, nor in
    a headless session (Q17).
  - Guard: `PreToolUse` fires for the worker's calls with `agent_type:
    commit:commit-worker`, and the heartbeat is written for its `plan` (Q23, Q25).
  - Found on the way: the worker answered its own handback (Q25), the harness's attribution
    leaked into the worker (Q25), the main thread verified with `git log` after a task
    (Q25), and `CLAUDE_PROJECT_DIR` is not in the worker's shell (see the project directory
    item above).
  - Cost, for scale (tiny test diff, small context): a pure commit prompt was about $0.08–0.11
    in total, the main thread about 340 output tokens; the worker made 7 calls (one of them
    the spike's probe) on Sonnet, about 1.4–2.2k output tokens.
