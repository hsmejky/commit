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
- **Decision.** Two thin Node entry points (Node 22+), the commit script and the guard, over
  one shared module library do the deterministic work; the `commit-worker` agent does
  judgement (type, subject, grouping, Q24). No npm dependencies, Node built-ins only,
  nothing vendored. This is a choice, not a platform limit (Claude Code does install a
  plugin's npm dependencies): install latency and failure on first run, offline machines,
  supply-chain exposure of a hook that sees every shell command, and `--ignore-scripts`.
  Data (regex tables) and test cases may be borrowed from permissively licensed sources with
  attribution; code is never copied. Tests use `node:test`. Node is a documented hard
  requirement: the native Claude Code installer does not ship it.
- **Amended.** By spec pass 1 (2026-09-27): named the two entry points (commit script,
  guard) and their layering over the shared library, and split the dependency policy
  (no npm dependencies, licensing for borrowed data and test cases, the CI Node 22 leg)
  into its own spec section.
- **Amended.** By spec pass 5 (2026-09-27): both entry points are written in syntax every
  Node since 12 parses, and check `process.versions.node` first (commit entry point: the
  `env` JSON refusal; guard: silent exit), only then loading the shared library with a
  dynamic `import()`. The dependency policy is why: Claude Code can install a plugin's npm
  dependencies, but only non-blocking, with `--ignore-scripts` and a 60 s timeout, so if
  `commit` relied on npm dependencies the guard could be silently absent on first run.
  `GIT_ADVICE` is rejected because it needs git 2.46, above the project's git-2.34 floor
  (Q15).
- **Amended.** By spec pass 6 (2026-09-27): dated facts behind the dependency policy, as of
  2026-09-27 (moved out of spec.md, which keeps only timeless reasons): `util.parseArgs`'s
  `allowNegative` option needs Node 22.4.0+; `path.matchesGlob` / `fs.glob` are stable only
  from Node 22.20.0; the npm alternatives `@conventional-commits/parser` (unreleased since
  2021) and `proper-lockfile` (no release since 2021) are stale; `shell-quote` carries
  advisory GHSA-w7jw-789q-3m8p.
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
  1. "follow the reply's `callerRule`": the trust clause, the only trusted text behind the
     handback protocol and the base rule's `run` shape check (caller trust, Q25); never
     cut.
  2. The triggers: without them the description never fires.
  3. The `intent` field: it also scopes what a `split` run commits (Q16), so without it
     the worker plans every change in the tree.
  4. "edit no files until it replies" (Q25): `diff-changed` is the backstop, at the cost
     of a whole run.
  5. The `interactive` field (Q17): without it a subagent still follows `ifNoUser`, one
     call dearer.
  6. "don't read the diff first" (commit-worker spike): cost only.

  When the description has to shorten, it cuts from the bottom, so the trust clause is
  never the one cut. "The reply is final" is not a clause: the base `callerRule` says it
  on every reply (Q25). The `/commit` skill has `disable-model-invocation: true`: it is
  loaded only when the user types `/commit`, and it does the same spawn. Its arguments map
  to the worker input, and SKILL.md never adds an `intent` of its own, whatever the session
  did before:

  | Typed | Worker input |
  | --- | --- |
  | `/commit` | no `intent`: every change is planned (Q16) |
  | `/commit <text>` | `intent: <text>` |
  | `/commit reword` | `reword: true` |
  | `/commit reword <text>` | `reword: <text>` (dictated; text that fails lint reaches `lintFailed`, Q20) |

  An explicit `/commit` is the user asking to commit what is in the tree, the caller Q16
  describes as "omits it". Fixture (Q17's eval set): Claude implemented X, the user
  hand-edited Y, then typed `/commit` → both planned, Y not in `not included`.
- **Amended.** By spec pass 2 (2026-09-27): clause 1 is the trust clause behind the base
  rule's `run` shape check, and is cut last when the description has to shorten.
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
    and newlines. Escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline)
    are removed outside single quotes before splitting, so a continued line stays one
    segment. An unterminated quote or here-string makes the rest of its line one
    quoted token and scanning goes on, so a `git commit` before it is still denied.
    Redirection operators outside quotes (`>`, `>>`, `<`, `2>&1` and the like) become tokens
    of their own and are dropped with their target, so `git commit … 2>&1` is still denied
    and a redirect target is never read as a commit argument or option;
    `git` / `git.exe` at any path, the basename compared case-insensitively (the early-exit
    substring `commit` is matched case-insensitively too, and is looked for after every `'`,
    `"`, `\` and backtick is removed from the command, so `git co''mmit` and `git COMMIT` are
    not early exits),
    with or without the `&` call operator; git global options (`-C`, `-c`, `--git-dir`,
    `--work-tree`, `--no-pager`, `-P`, …) skipped before the subcommand. An unknown global
    option followed by a `commit` token is denied (fail closed), and so is a subcommand
    token that contains `$` (a variable or substitution such as `git $c`) or, in
    PowerShell, starts with `@` (a splat), since it may expand to `commit`.
  - Output: a `deny` decision with a fixed message, or nothing. The hook never returns
    `allow`, so the user's permission prompts still apply. A crash or unreadable hook input
    exits 0 with no output (fail open): a guard bug must not block every shell call.
  - False positives such as `echo git commit` (unquoted) are accepted; a deny costs one turn.
- **Amended.** By spec pass 1 (2026-09-27): an unterminated quote or here-string turns the
  rest of its line into one quoted token and scanning continues on the next line, so a
  truncated `git commit -m "…` is still denied. By spec pass 2 (2026-09-27): redirection
  operators outside quotes become tokens of their own and are dropped along with their
  target, so a redirect target is never read as a commit argument or option.
- **Amended.** By spec pass 3 (2026-09-27): escaped newlines are removed
  before splitting, and the `git` / `git.exe` basename is compared case-insensitively while
  the early-exit substring `commit` stays case-sensitive, so `GIT.EXE commit` and a
  continued line cannot slip past; the tokenizer spike only confirms them. `.git/config`
  and `.git/hooks` recorded as an accepted gap (below).
- **Amended.** By spec pass 4 (2026-09-27): the early-exit substring check
  runs after removing `'`, `"`, `\` and backticks, so split quotes cannot skip parsing; a
  subcommand token holding `$` (or a PowerShell `@` splat) is denied; other paths to a
  commit (`git commit-tree`, `git am`, stash and cherry-pick replays, MCP shells) and a
  `commit` split by an escaped newline recorded as accepted gaps (below).
- **Amended.** By spec pass 5 (2026-09-27): the guard closes three more bypasses: after the
  `commit` substring check passes, a `{`, `(` or glob char (`*`, `?`, `[`) in the subcommand
  position right after `git` is denied (fail closed; covers Bash brace expansion
  `git {commit,-m,x}` and PowerShell `git (…)`); typographic quotes (`“` `”`
  `‘` `’`) are treated as quotes (PowerShell does); the dashed binary `git-commit`
  (any directory, `.exe`, case-insensitive basename) matches as `git commit`. Accepted gap: a
  command whose text never contains `commit` literally (`git $(echo com)mit`, PowerShell
  `git ('com'+'mit')`) passes the early exit and is not denied; `sudo -u git git commit` is
  not addressed (negligible). The PowerShell rules hold for both Windows PowerShell 5.1 and
  PowerShell 7+, and the guard's PowerShell tests run under each (Q15).
- **Amended.** By spec pass 7 (2026-09-27): the early-exit substring check for `commit` is
  case-insensitive (it previously stayed case-sensitive while the `git`/`git.exe` basename
  check and the dashed `git-commit` match, pass 5, were already case-insensitive), so a
  variant such as `git-COMMIT.exe` cannot skip the early exit and reach the dashed-binary
  match unseen.
- **Amended.** By spec pass 8 (2026-09-27): unquoted `(` and `)` become tokens of their own
  (like redirection operators, but kept; a `$(…)` substitution stays in its word), so
  `(git commit -m x)` is denied instead of passing as the token `(git`; a `(` in the
  subcommand position stays denied, and a `)` token ends `commit`'s arguments, so
  `(git commit --no-edit)` stays allowed. The subcommand is compared with `commit`
  case-insensitively (fail closed), so `git COMMIT -m x` is denied like `git commit -m x`.
  A Bash heredoc body is dropped, never read as a command (the body ends at the line equal
  to its delimiter), so a script written through `cat <<'EOF'` that contains `git commit`
  is not denied. The PowerShell reading of typographic quotes (pass 5) was verified on
  2026-09-27 with the PowerShell 7 parser, where `git co‘’mmit` parses to `commit`.
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
  - Commands run through another interpreter: `sh -c '…'`, `bash -c '…'`, `cmd /c`, `pwsh -c`,
    scripts that wrap git (`xargs git commit` is denied: unquoted, it tokenizes to separate
    `git` and `commit` tokens).
  - Command substitution (`$(…)`, backticks) and variables anywhere but the subcommand
    position (`$(echo git) commit`); `GIT_DIR` / `GIT_WORK_TREE` redirection;
    config injected through env prefixes (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
    `GIT_CONFIG_VALUE_<n>`).
  - `.git/config` and `.git/hooks` are trusted as git itself trusts them: an untrusted repo
    can run code through `core.fsmonitor`, `filter.*.clean`, `core.hooksPath` or
    `gpg.program` during any git call the plugin makes.
  - Other paths to a commit that never run `git commit`: `git commit-tree`, `git am`, the
    replays of `git stash` and `git cherry-pick`, and shells provided by MCP servers (the
    hook's matcher covers only `Bash` and `PowerShell`).
  - A `commit` split by an escaped newline (Bash `\` plus newline, PowerShell backtick plus
    newline, as in `git com\` newline `mit`): the early-exit check removes the `\` or
    backtick but keeps the newline, so the command exits early unparsed, although the
    tokenizer would join the line.

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
  | `--no-edit` | `--amend`, `-q` / `--quiet` |
  | `--fixup=<commit>` (plain only) | `-q` / `--quiet` |

  Denied therefore: bare `git commit`; anything with `-m`, `-F`, `--message` or `--file`;
  `--amend` without `--no-edit`; `--squash` in any form; `-c <commit>` / `--reedit-message`,
  `-C <commit>` / `--reuse-message`; `--fixup=amend:` and `--fixup=reword:` (both open an editor); `-n` /
  `--no-verify`, `--no-gpg-sign`, `--allow-empty`, `--allow-empty-message`, `-a`, `-t`,
  pathspecs and `--`. Also denied: the git global options `-c <k=v>` and `--config-env`
  before `commit`, whatever the key. `core.hooksPath`, `commit.gpgsign`, `gpg.program` and
  `user.signingkey` each undo a `--no-verify` / `--no-gpg-sign` ban, and a key list would
  always miss one.

  `git revert`, `cherry-pick` and `merge` do not call `git commit` and are not affected. A
  merge with resolved conflicts is finished with `git commit --no-edit` (Q21).
- **Amended.** By spec pass 3 (2026-09-27): `--quiet` is allowed wherever
  `-q` is; it is the same flag spelled long, and denying it cost a turn for nothing.
- **Amended.** By spec pass 6 (2026-09-27): reworded the denial to "`--squash` in any form"
  (not just "without `--no-edit`"); the old wording implied `--squash --no-edit` might be
  allowed, when the allowlist table above (only `--amend` / `-q` / `--quiet` are allowed
  alongside `--no-edit`) already denies it. Matches contracts.md and spec.md wording.
- **Amended.** By spec pass 8 (2026-09-27): names `--reedit-message`, the long form of
  `-c <commit>`, in the denied list (spec story 28 already did); no behaviour change, since
  every form outside the allowlist is denied.
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
  - Layers, highest first: managed (`managed-settings.json` at the OS path only; its
    drop-in directory is not read in 0.1.0), project `.claude/settings.local.json`,
    project `.claude/settings.json`, user `settings.json` in the Claude home. The first
    layer that defines a key wins. "Project" is the directory the harness reads project
    settings from: `CLAUDE_PROJECT_DIR` when the script sees it, else the git toplevel. The
    two differ when Claude runs in a monorepo subfolder (open verification item).
  - The Claude home is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, resolved once by each
    entry point. It holds the user `commit.json` (Q6), the user Claude settings and the
    guard heartbeat (Q23), so all three follow a relocated Claude home.
  - The managed directory (where `managed-settings.json` lives) is derived by
    the entry point from the platform, never from an environment variable, and injected
    into the resolver. An agent cannot redirect the highest layer through `env`, and tests
    cover that layer only in CI, where the job can write the platform's managed directory;
    elsewhere those cases are skipped, not faked.
  - Not read, since a script cannot reach them: MDM profiles (macOS), registry policy
    (Windows) and server-managed settings. The attribution source `plan` reports shows
    which layer applied, and the README names the gap.
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
- **Amended.** By spec pass 2 (2026-09-27): the managed layer's drop-in directory is not
  read in 0.1.0; the Claude home resolves via `CLAUDE_CONFIG_DIR` (else `~/.claude`); MDM
  profiles, registry policy and server-managed settings are named as unread policy sources;
  and the managed directory is derived by the entry point from the platform, never from an
  environment variable, and injected into the resolver so a redirected `env` cannot reach
  the highest layer.
- **Amended.** By spec pass 3 (2026-09-27): the managed layer reads
  `managed-settings.json` only; reading its drop-in directory is deferred past 0.1.0 (see
  [Non-goals](#non-goals)) to keep the first release's resolver small. The drop-in files
  join the policy sources the README names as unread.
- **Rejected.**
  - Hard-coded opinionated rules; reading `commitlint.config.*` (executes third-party JS).
  - Reproducing the harness default footer: it contains the model name, which the script
    cannot know. Having the worker pass the model name in reopens the path Q13 closes.
  - Appending `attribution.commit` verbatim: a multi-line value becomes body text.
  - `git interpret-trailers --trailer` for appending (Q13).
- **Consequences.** Without an attribution setting the trailer omits the model name. The
  trailer is produced deterministically; no agent-supplied text reaches it. Settings passed
  on the command line (`claude --settings <file>`) are invisible to the script, and so are
  MDM, registry and server-managed policy and the managed drop-in files; the README says
  so. An organisation that sets attribution only through those sources gets the trailer
  the readable layers give.

## Q6 Config layers and keys

- **Context.** Commit style is shared by a team, but repos without a config still need
  personal defaults.
- **Decision.** Two layers: user `commit.json` in the Claude home (`~/.claude`, or
  `CLAUDE_CONFIG_DIR` when set, Q5) overridden per key by repo
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
    `types` entry, or unparseable JSON: error; `plan` stops before any run starts, with
    the CLI kind `config` (exit 1, Q9).
  - `scanIgnore` is read from the repo config at HEAD (Q10), every other repo key from the
    working tree; `plan` reports its source as `repo@HEAD`.

  Defaults: the commitlint `config-conventional` types (build, chore, ci, docs, feat, fix,
  perf, refactor, revert, style, test), no scope, no body, 72 code points, lowercase. The
  worker's model is not a config key (Q24).
- **Amended.** By spec pass 2 (2026-09-27): added the user layer's `commit.json` in the
  Claude home below the repo layers, and gave an invalid layer or glob the CLI kind
  `config` (exit 1) instead of a bare error.
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
  level, and writes only after confirmation. The skill never composes JSON: `infer` returns
  `configJson` per layer, the current layer with the proposal's keys replaced and other keys
  (such as `scanIgnore`) kept, validated by the config loader's rules (Q6), and the skill
  writes the chosen layer's text verbatim. When the chosen layer is already invalid (the
  current file fails validation, so `configJson` for it carries `errors` instead of text),
  the skill shows those errors and writes nothing: a broken file is fixed by hand first.
  Below 20 commits it proposes nothing and
  recommends the defaults. Below 50% Conventional Commits it proposes nothing, says the repo is
  out of scope, and points to the opt-out (Q14).
- **Amended.** By spec pass 1 (2026-09-27): `infer` returns `configJson` per layer (the
  current layer with the proposal's keys replaced and other keys kept) instead of the skill
  composing JSON itself. By spec pass 2 (2026-09-27): when the chosen layer is already
  invalid, `configJson` for it carries `errors` instead of text and the skill writes
  nothing.
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
    `plan.json` in the run folder, which the worker does not read. After the state checks
    (and, with `--reword`, the unborn, merge commit and pushed checks, Q20) it mints the
    `planId` and creates a provisional run folder, because the `split` scan needs the
    temporary index (Q11) in it; a read-only `peek` then refuses a live lock (`lock`)
    before any inventory work, except under `--take-over`, whose `acquire` takes over the
    named lock whatever its age (Q22). The signing check (Q18) runs only after the scan, the
    `staged-hit` check and clean-tree detection, so a clean tree on a locked key reports
    "nothing to commit"; a `signing` refusal deletes the provisional folder like every
    other outcome after it. The whole `plan` call has a 540-second deadline from its start
    that bounds every git call it makes, the ones before the lock included; past it `plan`
    ends as `timeout` and deletes the provisional folder. The worker prompt runs `plan` and
    `check` with a 600 000 ms tool timeout, so the tool never cuts a call the script still
    bounds itself, and a retried `plan` never races a backgrounded one. When there is work
    to do it records `HEAD`, stores the untracked-candidate, staged-new and index-only
    lists (Q11), mints the unit IDs with the `id → hash` map and the scan map from the very diff it scanned (Q10), stores the
    notices for the reply (guard, signing, warnings) and whether the run has a user
    (`--no-user`, Q17), and takes the run lock (Q22). Having taken it, it goes straight on
    as `plan --hunks` in the same process and prints that output, which saves the worker
    one call on every first spawn (spike: six worker calls for a one-group run, five with
    this). Every outcome without a lock leaves
    no folder behind: refusals before the folder (`env`, `config`, `state`, `pushed`) never
    create one, the rest (`lock`, `staged-empty`, `staged-hit`, clean tree, `modeChoice`,
    `signing`, `git-failed`, `timeout`, a `run-folder` lock link, and a `head-moved` or
    `index-changed` after the lock) delete it before `plan` exits. What takes the lock:

    | Outcome | Exit | Lock, `planId` |
    | --- | --- | --- |
    | refused repo state, `unmerged` included (Q21) | 6 `state` | none |
    | `.commit-plan` tracked, a link or not a directory, or its filesystem lacks hard links (Q22) | 6 `state` (code `run-folder`) | none |
    | signing not ready (Q18), checked after the scan | 6 `signing` | none |
    | another run holds the lock (the read-only `peek`, or a lost `acquire`) (Q22) | 6 `lock` | none |
    | a `git add` of the temporary index fails | 4 `git` (code `git-failed`) | none |
    | `plan` past its 540-second deadline | 5 `timeout` | none |
    | `--staged` with an empty index | 1 `usage` (code `staged-empty`) | none |
    | `--staged` and the index diff has a pattern hit, or the index holds a staged-new path the hidden rule excludes (Q10, Q11) | 6 `staged-hit` | none |
    | clean tree (nothing plannable, Q16) | 0, `planId: null`, reply `nothing` | none |
    | index and other changes both present, no mode flag | 0, `planId: null`, `modeChoice` handback | none |
    | HEAD moved, or the index changed (`index-changed`), after `acquire` | 6 `head-moved`, `diff-changed` | taken, then released |
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
    repeats the `mode` flag of the `plan` call that produced it, besides its own answer:
    the `lock` handback of a `plan --staged` carries `mode: staged` next to `takeOver`.
    Without that, `modeChoice`, then `lock`, then `take over` looped: the takeover respawn
    had no mode and got `modeChoice` again. A `modeChoice` never carries `takeOver`, also
    under `--take-over <planId>`: the takeover finishes at `plan` step 3, before the mode
    decision, and the `modeChoice` releases the lock (Q22 pass 9), so its answer's
    respawn meets no lock of the taken-over run (amended by spec pass 10, below).
    `--reword` is the exception: the
    caller adds its own `reword` line (Q25), which also carries a dictated text the script
    never sees.
  - `plan --hunks --plan <planId>`: run inside `plan` on the first spawn, and by the worker
    on every respawn with `resume`. Writes the hunk bodies (within the Q19 cap) to `hunks.txt`
    in the run folder and prints a compact index (ID, path, kind, range, line count, line
    offset in `hunks.txt`); the worker `Read`s the file in pages. Besides the index it repeats
    only what the worker needs from `plan` (`runDir`, `mode`, the lint config, counts,
    `recentSubjects`), not the file lists, which the index covers. The whole output has a
    budget of 20 000 characters of stdout; above it the full index goes to `hunks.json` (one
    entry per line) and stdout keeps everything else, with the absolute `hunksIndexFile`
    in place of `hunks` and `summaryOnly`. It resets the state file's
    lint-failure counter (Q18). It never mints IDs: every run for the `planId`, the first one
    included (then every respawn for `edit` or `one`), re-diffs, and re-emits `plan`'s IDs when
    the hash set equals the map `plan` stored, or refuses with exit 6 `diff-changed` ("files
    changed since plan, run /commit again"). So the diff the worker sees is the one `plan`
    scanned: a file edited between the two calls, a hit that moved to another line, or an
    untracked file that grew past the skip limit cannot slip in between. HEAD must still be the
    recorded one, else exit 6 `head-moved`. The mode comes from the state file: `split`
    rebuilds the temporary index from the stored lists (Q11), `staged` diffs the index only
    (pre-staged set), `reword` shows HEAD's own diff (Q20). When a script call fails, the
    worker writes nothing and returns the failure's `reply` (Q25).
  - `check --plan <planId>`: reads the worker plan from `plan.groups.json` in the
    run folder; lints every group's message, validates hunk IDs and paths, requires every
    unit to be placed exactly once (`split` only; the single group of a `staged` or `reword`
    run holds every unit implicitly), and **computes** `confirm` (Q16). On success it stores
    the validated groups in the state file: per group the resolved units (hunk IDs, or paths
    in the file-level slice), the normalised message and whether the attribution applies
    (Q20). It clears the stored groups before it validates, so a failed `check` after `edit`
    leaves nothing committable, and it refuses (`usage`) once any group is committed: a
    re-plan after a partial commit would renumber groups over units already in HEAD. Zero
    groups is a valid `split` outcome: `check` then releases the lock itself. With
    `confirm: null` it goes straight on as `commit --all` in the same process; with
    `confirm` set it commits nothing and returns a `confirm` handback, except in a run
    without a user, where Q17 applies.
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
    edits the state file itself (the run folder is agent-writable, Q16; a tamper digest is
    deferred past 0.1.0, and only the state `version` is checked; Q3: the plugin steers, it
    is not a security boundary). The scan
    backstop still holds, because it rescans the index and
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
  `plan.groups.json` with the `Write` tool and runs `check`, so `commit` has a
  single input path and the main thread makes no extra call. A lint failure of
  `"source": "user"` text ends the worker's part at once (Q18, Q20).

  No subcommand reads stdin. `plan.groups.json` is written with the `Write` tool, which always
  writes UTF-8, and is read as bytes and normalised before lint: UTF-8 BOM stripped, UTF-16
  decoded when it carries a BOM, CRLF and lone CR turned into LF, trailing blank lines
  trimmed. Invalid UTF-8 is a lint error. Every command the worker runs, and every `run`
  command in a handback, is a single `node … commit.js …` call, so the README's allow rules
  (Q16) match it in Bash and PowerShell alike.

  Every git call runs with its `cwd` set to the toplevel (`git rev-parse --show-toplevel`,
  resolved once from wherever the tool ran), so `diff.relative` and a `cd sub && node …`
  call cannot narrow what it sees (Q11). Every call except `git commit` removes every
  inherited `GIT_*` variable except a keep-set (`GIT_EXEC_PATH`, `GIT_CONFIG_GLOBAL`,
  `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`),
  so `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_ATTR_SOURCE`, `GIT_TRACE*` and the object-directory
  variables cannot redirect what the scan reads (Q10), while every call reads the same
  config files `git commit` reads (an exported `GIT_CONFIG_SYSTEM` that sets
  `commit.gpgsign` reaches the signing probe too). Every call except `git commit` also runs with
  `GIT_LITERAL_PATHSPECS=1` in its environment, so a path such as `[id].tsx`, `*.js` or
  `:foo` names exactly that file, and with the `-c` pins (`core.quotePath=false`,
  `diff.suppressBlankEmpty=false`, Q11). `git commit` takes no pathspec and runs with
  neither; it removes only the redirecting variables (`GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG_COUNT` / `KEY_*` / `VALUE_*`,
  `GIT_CONFIG_PARAMETERS`,
  `GIT_ATTR_SOURCE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`) and keeps
  the rest, so repo hooks inherit the user's own git environment: a hook that runs
  `git diff -- '*.js'` or parses quoted paths behaves as it does on a manual commit (Q18).

  Every subcommand writes one JSON object to stdout, on failure too, and exits with a code
  that tells the causes apart (0 ok, 1 usage, config, env or internal, 2 lint, 3 scan, 4 git
  (CLI kind `git`): `git commit` or `plan`'s `git add` of the temporary index failed
  (domain code `git-failed`), or staging after the reset failed (`stage-failed`), 5 timeout, 6 refused, including `lock`, `head-moved` and `diff-changed`). Exit 1 has four kinds: `usage` (bad argv or flag
  combination), `config` (an invalid config layer or `scanIgnore` glob, Q6, Q10), `env`
  (git missing, git older than 2.34, Node older than 22; Q1, Q15; a plugin install path
  holding `$`, a backtick, `"` or `\`, the last two POSIX only; Q16, Q25) and `internal`. A
  `config` failure stops `plan` before any run starts (Q6). Exit 6 `state` also carries
  the domain codes `unmerged` (Q21) and `run-folder` (Q22). Every output that ends the
  worker's part carries the script-built `reply` (Q25).
- **Amended.** By spec pass 1 (2026-09-27): `check` always commits when `confirm` is
  null; the `--commit` flag is dropped (no caller). By spec pass 2 (2026-09-27): the CLI
  kinds `config` and `env` (exit 1); `git commit` runs without `GIT_LITERAL_PATHSPECS` and
  the `-c` pins (story 147).
- **Amended.** By spec pass 3 (2026-09-27):
  - Signing order: `plan` refuses on signing only after the clean-tree and `staged-hit`
    checks, so a clean tree is never blocked by a locked key; `signing` leaves the
    pre-folder refusals and joins the outcomes that delete the provisional folder, with a
    read-only lock `peek` before inventory (the `acquire` stays for the race).
  - The `GIT_*` allowlist on every call except `git commit`, which removes only the
    redirecting variables, so an exported variable cannot redirect the scan while hooks
    still see the user's environment.
  - The `run-folder` code (CLI kind `state`) and `unmerged` in the `state` refusals.
  - A 540-second deadline for `plan` bounding all its git calls (`timeout`, provisional
    folder deleted), and a 600 000 ms tool timeout for `plan` and `check` in the worker
    prompt: a slow hook or clean filter was cut mid-call by the tool's default timeout.
  - `<toplevel>/.commit-plan/` is settled for 0.1.0: the home-based run folder spike is
    dropped and the idea deferred past 0.1.0 (see [Non-goals](#non-goals)).
  - No tamper digest in 0.1.0: `state.json` carries only its `version` check (Q16).
- **Amended.** By spec pass 4 (2026-09-27):
  - `GIT_CONFIG_SYSTEM` joins the keep-set, so the signing probe and `git commit` read the
    same config; `git commit` also removes `GIT_COMMON_DIR`, which every other call removes.
  - Every git call, read-only ones included, is asynchronous with a timer from the call's
    deadline and a tree kill (a clean filter, fsmonitor or LFS can hang a read); `spawnSync`
    is kept only for M2's named short calls (`git --version`, the toplevel lookup). The guard
    loads no runner module and spawns nothing (Q3).
  - While a child runs, the script handles `SIGINT`, `SIGTERM` and `SIGHUP` by killing the
    child's process tree and removing the call's `call.lock` before it exits, so an Esc or a
    session end does not leave `git commit` or a hook running as an orphan that lands a
    commit after the call ended. A hard kill of the script itself (`SIGKILL`, a Windows
    hard kill) runs no handler; that residue is an accepted gap.
- **Amended.** By spec pass 5 (2026-09-27):
  - `plan` refuses `head-moved` and `index-changed` (CLI kind `diff-changed`) after
    `acquire`: once the lock is taken at step 7, it re-reads HEAD and the index
    fingerprint; a HEAD that moved since the inventory releases the lock, deletes the
    folder and refuses with `head-moved`, and an unchanged HEAD with a changed fingerprint
    does the same with `diff-changed` (domain code `index-changed`,
    [contracts](contracts.md#plan) step 7). `commit` makes the matching per-group check
    (Q11).
  - The git runner (M2) pins `GIT_OPTIONAL_LOCKS=0` on every read-only call; history reads
    additionally pin `log.showSignature=false` and `i18n.logOutputEncoding=UTF-8`; every
    spawn runs with `windowsHide`.
  - `plan --staged` with an empty index (the index was emptied between the `modeChoice`
    answer and the respawn) is refused as `usage`, domain code `staged-empty`, and deletes
    the provisional folder (Q16). Exit 4 is CLI kind `git`; `git-failed` and
    `stage-failed` are its domain codes.
- **Amended.** By spec pass 6 (2026-09-27): every script call the worker makes (`plan`,
  `plan --hunks`, `check`, `commit --all`, `release`) gets the 600 000 ms tool timeout, not
  only `plan` and `check`; a resumed run's own `plan --hunks` call rebuilds the temporary
  index and diffs under the 540/590 s deadline while holding `call.lock`, so a shorter
  default tool timeout could cut or background it and a retry would then get `busy`.
- **Amended.** By spec pass 7 (2026-09-27): corrects the pass-6 amendment: the worker itself
  makes only `plan`, `plan --hunks` and `check`, each under the 600 000 ms tool timeout (a
  resumed run's `plan --hunks` call still needs it, now under the 540/580 s deadline, Q18
  pass 7, while holding `call.lock`). `commit --all` and `release` never run from the worker
  (G3 denies them to `commit:commit-worker`, Q25); they run only from a handback's `run` in
  the caller, each under its own `timeoutMs` (Q25 pass 5: 600000 for `commit`, 60000 for
  `release`).
- **Amended.** By spec pass 10 (2026-09-27): supersedes "a `modeChoice` produced under
  `--take-over <planId>` carries `takeOver: <planId>` next to `mode`" and its rationale
  ("`modeChoice` … takes no lock"). Since Q22 pass 9 the takeover runs at `plan` step 3:
  by the time step 4 returns `modeChoice`, the taken-over run's lock was moved, its folder
  deleted and the new lock released. A respawned `plan --take-over <planId> --staged` would
  then create `<planId>/call.lock` in a folder that no longer exists (`ENOENT` →
  `taken-over`), so a user who answered `staged` or `split` got "run /commit again"
  instead of a plan. `takeOver` is now repeated only in a `lock` handback's `take over`;
  a `modeChoice` answer respawns a plain `plan` with its `mode`, whose `peek` finds no
  lock of the taken-over run (a lock another run took meanwhile is asked about afresh).
  The loop the flag repetition prevents cannot recur: the respawn carries a mode, and a
  forced `modeChoice` (`killedLeftover`) needs a takeover, which the respawn no longer
  does.
- **Rejected.**
  - `--take-over` of an absent lock as a plain `acquire` (spec pass 10): it keeps a flag
    that no longer names anything and adds a lock case the contracts must define; the
    respawn without `takeOver` gets the same result through the ordinary path.
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
    plus `Edit(…)` pair might lift that prompt; that spike is dropped for 0.1.0 and the
    home-based run folder deferred past it (see [Non-goals](#non-goals)). The working-tree
    location is settled for 0.1.0. Its costs, weighed and
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
    1 MB, is not scanned and is reported as skipped (Q19), checked before any content
    decision below. Binary is decided by content only for a file `git check-attr` confirms
    is hidden by an attribute (`diff`, `binary`, or a custom `diff` driver): a NUL byte in
    the first 8000 bytes of the new content (git's own heuristic) means it is genuinely
    binary; otherwise it is a text file the attribute hides, still scanned through a
    `--text` diff (Q11). A file git itself reports as binary without such an attribute
    (real NUL content, or over `core.bigFileThreshold`) stays binary and is not
    reclassified. A file with a `filter` attribute
    (Git LFS, git-crypt, `nbstripout`) is scanned in the cleaned form `git diff` shows,
    which is what enters history: an LFS pointer, ciphertext (usually binary, so skipped),
    a stripped notebook.
  - Patterns and their false-positive rules are fixed in
    [contracts](contracts.md#scan-patterns). `local-path` also matches the current OS user
    name as a path segment in any path shape, but only a name of 4 or more characters that
    is not a well-known service user (`node`, `ubuntu`, `runner`, `vscode`, …). The same
    service users are placeholders for the fixed `/home/<name>`, `/Users/<name>` and
    `C:\Users\<name>` regexes, so `/home/node/app` in a Dockerfile is not a hit. A hit reports
    the pattern ID and location, never the matched value. The table records a source per
    row (gitleaks' rule file `config/gitleaks.toml`, `secretlint-rule-preset-recommend`,
    GitHub's documented token prefixes), borrowed as data with attribution only from
    sources whose license does not restrict who may use them; every pattern has one
    positive and one negative fixture.
  - Exceptions: `scanIgnore` globs only, read from the repo config **at HEAD**
    (`git show HEAD:.claude/commit.json`), not the working tree. The glob dialect is fixed in
    [contracts](contracts.md#scanignore-globs) (the matcher is hand-written, zero deps).
    Matching is case-sensitive on every OS. A diff that changes `scanIgnore` is flagged.
    A pattern with no literal character (`**`, `**/?*`, `*/**` and the like) is a `config`
    error (Q9), so one amended line cannot switch the scan off. A broad but literal pattern
    such as `src/**` is accepted: whoever can commit `.claude/commit.json` can widen it, an
    accepted gap.
  - `plan` cuts the diff it scanned into units (Q9), maps every scan item to the unit that
    holds it and stores the map in the state file, so `check` decides per unit. Every
    `plan --hunks` must see the same hash set, so the map cannot drift from the diff the
    worker groups. What each item does:

    | Item | Rule in `check` | `humanOnly` (Q16, Q17) | `commit` backstop |
    | --- | --- | --- | --- |
    | pattern hit | the unit must be in `notIncluded`; in a group it is a lint error ("h4 has scan hit `github-token`; move it to notIncluded") | never: the unit is always left out, and the report names it with two lines, `!git --literal-pathspecs add -- <path>` and then `!git commit -m "<message>"` (no `&&`, which Windows PowerShell 5.1 cannot parse), to commit it by hand (a `!` command has no terminal, so a bare `git commit` could hang on an editor; the guard does not see `!` commands). The path is bare when it holds only `[A-Za-z0-9._/@+-]` and in single quotes otherwise (literal in Bash and PowerShell); a path holding `'`, a PowerShell single quote (U+2018–U+201B) or a control character gets no line, only "commit by hand"; `<message>` stays a placeholder | **blocks** |
    | skipped file | may be included | when the unit is included | does not block |
    | `scanIgnore` change | may be included | when the unit that changes the `scanIgnore` value in `.claude/commit.json` is included (a unit that edits only another key, e.g. `maxSubjectLength`, does not); it takes effect from the next commit | does not block |

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
- **Amended.** By spec pass 1 (2026-09-27): each secret pattern row records its source
  (gitleaks' rule file and generator samples, `secretlint-rule-preset-recommend`, GitHub's
  documented token prefixes, and Nosey Parker's examples as fixture seeds) and carries one
  positive and one negative fixture.
- **Amended.** By spec pass 2 (2026-09-27): in a container without a passwd entry,
  `os.userInfo()` throws; `osUser` falls back to `USER` or `USERNAME`, else `null`, which
  skips the OS-user segment of `local-path` rather than failing the scan. A whole-repo
  `scanIgnore` pattern is a `config` error.
- **Amended.** By spec pass 3 (2026-09-27):
  - A `scanIgnore` pattern with no literal character is a `config` error; this replaces the
    list of whole-repo shapes, which could never be complete.
  - The manual `!git` line uses `--literal-pathspecs` and `--`, and quotes the path so it
    stays literal in Bash and PowerShell; a path holding `'` gets no line. By pass 4, a path
    holding a control character gets no line either, and every path the reply `text`
    renders has C0 and C1 control characters and DEL written as `\xNN`, so a newline or
    ESC in a file name cannot forge a reply line or reach a terminal.
  - Binary is decided by content, so a `-diff` or `binary` attribute cannot hide a text
    file from the scan.
  - Every inherited `GIT_*` variable outside a keep-set is removed from the scan's git
    calls (Q9), so `GIT_INDEX_FILE` or `GIT_ATTR_SOURCE` cannot redirect what is scanned.
  - Accepted gaps recorded (Consequences): UTF-16 text and unprefixed secret formats are
    not scanned; `scanIgnore` is widenable by whoever commits the repo config.
- **Amended.** By spec pass 4 (2026-09-27): removed lines recorded as an
  accepted gap (Consequences).
- **Amended.** By spec pass 5 (2026-09-27): borrowed data and test cases (including the
  fixture license list) are restricted to MIT, ISC, BSD, Apache-2.0 (NOTICE kept) or
  CC-BY-4.0 sources — licenses that do not restrict who may use them; Nosey Parker's examples
  (Apache-2.0) are used as fixture seeds. Betterleaks is explicitly not a 0.1.0 source, and
  its token-efficiency filter is rejected.
- **Amended.** By spec pass 6 (2026-09-27):
  - Settled: symlink targets are scanned as an added line (Q11 already said so). Dropped the
    contradictory "symlink targets are not scanned" claim from both accepted-gap lists above
    (the pass-3 amendment and the Consequences list).
  - The NUL-byte content check only decides binary-vs-text for a file `git check-attr`
    confirms is hidden by an attribute (`diff`, `binary`, or a diff driver); a file git
    itself reports as binary without such an attribute (real NUL content, or over
    `core.bigFileThreshold`, default 512 MiB) stays binary and is not reclassified —
    otherwise the NUL check would force a `--text` diff on a huge binary file only for it to
    be skipped at the 1 MB scan limit anyway, wasting the budget, and the NUL check only
    looked at the new side while git checks both sides. The security property still holds:
    an attribute still cannot hide a text file.
- **Amended.** By spec pass 8 (2026-09-27):
  - Every scanned line (diff line, symlink target, message line) is cut to its first 4096
    characters before the regexes run, so scanning stays linear in the input (no regex
    backtracking over a minified or generated line); a secret past the cut is missed, an
    accepted gap (Consequences). The rule and the length are in C:scan-patterns.
  - The manual lines for a unit left out on a pattern hit are two lines, as the table says.
    A path holding U+2018–U+201B gets no line either, only "commit by hand": PowerShell
    treats those characters as single quotes, so they would end the quoted path.
- **Amended.** By spec pass 9 (2026-09-27):
  - A `scanIgnore` change is found by comparing the parsed `scanIgnore` at HEAD with the one
    parsed from the repo config on the snapshot side, in the config loader, so the pure
    scanner parses no config. A missing file or key is no patterns; the lists are compared
    in order; content that is not valid JSON, or a `scanIgnore` that is not an array of
    strings, counts as changed. When they differ, every unit of `.claude/commit.json` is
    flagged, not only the one that edits `scanIgnore`: a whole-file comparison cannot tell
    which hunk carries the change, and flagging one hunk would let the worker commit the
    other without a human. A unit that edits only another key is therefore flagged when
    the same diff also changes `scanIgnore` elsewhere in the file, an accepted extra
    confirmation; with `scanIgnore` unchanged, no unit is flagged (the table above).
  - The `commit` backstop scans its tree-to-tree diff with the same raw, patch and
    attribute-hidden `--text` passes and the same 1 MB limit as the `plan` diff, from the
    same change-set code, so an attribute cannot hide a text file from the backstop either
    (pass 3).
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
  in an LFS-tracked `*.json` is not caught. The README says so. Also accepted: UTF-16 text
  counts as binary (its NUL bytes) and is not scanned;
  every scanned line is cut to its first 4096 characters, so a secret past the cut on a
  longer line is missed;
  unprefixed secret formats (Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-proj-`, JWTs)
  have no pattern of their own in 0.1.0 and are caught only where `generic-secret` matches
  their key. Only added lines are scanned, so a hunk that removes a hardcoded secret shows
  it in `hunks.txt`, and through it in the worker's model context and transcript; it never
  enters history through the plugin. Roadmap: `scanIgnore` entries
  of the form `{ "path": "<glob>", "pattern": "<id>" }` to silence one pattern per path
  (additive); new pattern IDs for common high-signal prefixes: `sk_live_` / `rk_live_`
  (Stripe), `glpat-` (GitLab), `npm_`, `AIza` (Google), `sk-proj-` (OpenAI); Slack app
  tokens (`xapp-`) are already matched by `slack-token`. IDs are additive public surface.

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
       on it): the hash match decides what its absence means. Paths stored with
       `ignored: true` go in a separate `git add -N -f` call, so no other ignored path is
       added. A non-zero `git add` exit is a failure (`git-failed`) even when some paths
       were added.
    3. Run the pinned diff (below) against the copy.

    The copy is never built from HEAD alone: it is always the real index, reset, then
    extended with the intent-to-add entries, so it keeps the stat cache and the
    sparse-checkout entries; built from HEAD, out-of-cone sparse-checkout paths would show
    as deleted. A path whose bytes are not valid UTF-8 is not a
    unit: it goes to `notIncluded` ("path is not UTF-8 — commit by hand"), written with
    each non-UTF-8 byte as `\xNN`, since the state file and the reply carry paths as
    strings. `plan` also records an index fingerprint (a hash of `git ls-files --stage -z`,
    read-only, no index lock); when it changes between inventory and the lock while HEAD
    is unchanged, `plan` refuses with `index-changed` (CLI kind `diff-changed`).

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
    a reset copy of the real index plus the lists; the real index itself is only read). A
    missing hash refuses the
    run: "files changed since plan, run /commit again", and the user's index is as they
    left it. Only then does it reset the real index, build the patch from the **current**
    hunks (current ranges) and run `git apply --cached --whitespace=nowarn` on it (Q18).
  - Every diff the script runs uses pinned options: `--no-ext-diff --no-color --no-textconv
    --no-relative -U3 --inter-hunk-context=0 --indent-heuristic -M --diff-algorithm=myers
    --ignore-submodules=dirty --src-prefix=a/ --dst-prefix=b/` and `-c core.quotePath=false
    -c diff.suppressBlankEmpty=false`, from the toplevel (Q9). `--whitespace=nowarn` keeps
    `apply.whitespace=error|fix` from rejecting or changing what was planned and scanned.
    Left to the user's config because the script does not depend on it: `diff.orderFile`
    (every list is sorted by the script itself, Q19).
  - Path lists never go on argv: staging, attribute and index calls (`git add -N`,
    `git add -A`, `check-attr`, `update-index`) read them from stdin with NUL separators
    (`--pathspec-from-file=- --pathspec-file-nul`, `check-attr --stdin -z`,
    `update-index -z --stdin`). A rename group of a few thousand paths would otherwise exceed
    the Windows command-line limit after the real index was reset, and a `-z` list carries
    any path byte for byte.
  - Whole-file units, staged with `git add -A` (literal pathspecs, Q9; both paths of a
    rename; paths on stdin; ignored paths in a separate `git add -A -f` call, and a non-zero
    exit is `stage-failed` even when some paths were added) and never split across groups:

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
  - Other repo configurations need no code of their own, because units come from git's diff:
    - `core.autocrlf` and `eol` attributes: git's diff already compares the converted
      content, and `git apply --cached` and `git add` stage it in git's converted form, so
      line endings never cause a mismatch. Conversion warnings on stderr are not errors; a
      `core.safecrlf=true` rejection after the reset is a staging failure (Q18).
    - Case-only renames: planned when git reports them (a staged `git mv`). An unstaged
      case-only rename on a case-insensitive filesystem is invisible to git and not
      planned.
    - Sparse-checkout and `skip-worktree` entries never appear in the diff and are never
      units.
  - The worker `Read`s nothing outside the run folder except a working-tree file at a line
    range, when a hunk needs more context (Q19), and never a file that has a scan hit, so
    it cannot recover a unit whose body was withheld for a hit (Q10).
  - Binary is decided by content: a path git reports as binary is binary only when its new
    content has a NUL byte in its first 8000 bytes. Otherwise a `-diff` or `binary`
    attribute hid a text file: it has `kind: "text"`, is one whole-file unit (staged with
    `git add`) with a `body` like a summary-only file's, and its added lines are still
    scanned through a `--text` diff (Q10).

  One `commit --all` call commits the groups in order; per group: reset the index, stage,
  commit. A pre-staged set
  (`staged` mode, Q9) is committed as-is and never regrouped; other unstaged changes are left
  untouched and reported in the reply's tree state ("N files left: …"). In `--split` mode a
  pre-staged set is reset like any other index and planned with the rest; a staged new file
  stays a unit and a `git mv` rename comes back as the same `R` unit through step 2 of the
  temporary index. Delivered in two slices: file-level
  grouping first, hunk-level staging second. In the file-level slice `check` resolves the
  worker's paths to units itself; an `R` unit is named by its **new** path only, in `files`
  and in `notIncluded` alike ("use the new path src/b.js for the rename of src/a.js").
- **Amended.** By spec pass 2 (2026-09-27): path lists on stdin, never on argv;
  line-ending conversion, case-only renames, sparse-checkout and `skip-worktree` entries;
  the worker's `Read` limit; the per-group temporary index recorded as deferred.
- **Amended.** By spec pass 3 (2026-09-27):
  - The temporary index is a reset copy of the real index extended with intent-to-add
    entries, never built from HEAD; the old `commit` note that it was built from HEAD
    plus the lists contradicted step 1.
  - The index fingerprint (`git ls-files --stage -z`) and its `index-changed` refusal
    (CLI kind `diff-changed`) at `plan`'s lock.
  - A path that is not UTF-8 goes to `notIncluded` with `\xNN` escapes (accepted gap:
    such paths are never planned).
  - Binary decided by content; an attribute-binary text file is a whole-file `text` unit
    whose added lines are still scanned (also Q10).
  - Paths with `ignored: true` in separate `git add -N -f` (`snapshot`) and `git add -A -f`
    (`stage`) calls; a non-zero `git add` exit is a failure (`git-failed`, `stage-failed`)
    even when some paths were added, since a partial add would commit a different set.
  - The worker `Read`s nothing outside the run folder except a working-tree file at a line
    range, never a file with a hit.
  - The per-group temporary index stays deferred past 0.1.0 (see [Non-goals](#non-goals)).
- **Amended.** By spec pass 4 (2026-09-27):
  - The pinned list above is complete: no `--full-index` (text hunks go through
    `git apply --cached`, which needs no full blob IDs; binary files are whole-file adds)
    and no pinned rename limit. `diff.renameLimit` is left to the user's config like
    `diff.orderFile`: `plan` and `commit` read the same limit, so a skipped rename detection
    yields the same delete-plus-add units on both sides.
  - Content keeps its raw bytes: diff output stays a `Buffer`, and hunk bodies, unit hashes
    and built patches use the raw bytes; only presentation (the worker's hunk text, the
    reply) and the scanner decode, lossily, and none of them feeds a hash or a patch. A
    lossy decode in the hash would let a corrupted Latin-1 or CRLF commit pass the match.
  - The patch pass is one `git diff -z --raw -p` call; its patch sections pair with its raw
    records by position, checked by counting `diff --git` header lines against the records
    (a mismatch is `internal`), so no path is parsed out of patch text and no call per path
    is needed. It runs over the whole diff with no pathspecs: `git diff` has no
    `--pathspec-from-file`, so a path list would go on argv and could pass the Windows
    command-line limit, and a pathspec narrows rename detection (and what counts against
    `diff.renameLimit`), so its records could differ from the raw pass. The output is read
    as a stream and only what a later step needs is kept: hunks of units that carry a body
    and, for the scan, added lines up to the 1 MB limit (Q10), past which the section is
    dropped. Retained memory is bounded by the existing caps (256 KB and 1000 changed lines
    per body-carrying file, Q19; 1 MB of scanned additions per file); binary and submodule
    sections are one line each; git already computes the same diff for `--numstat`, and the
    call's deadline bounds the time.
    - Rejected: pathspecs batched under an argv byte budget. Batching costs several spawns,
      and every batch would need both paths of a rename and would still see a different
      rename-limit count.
  - The patch for `git apply --cached` reuses git's own per-file header lines verbatim, so
    a path with quotes, tabs, newlines or leading spaces is quoted exactly as git quotes it.
  - Tests add a Latin-1 file and a file with CRLF content under `core.autocrlf=false`, each
    split into two groups and committed byte for byte.
- **Amended.** By spec pass 5 (2026-09-27):
  - `commit` re-reads the index fingerprint (`git ls-files --stage -z`, hashed as `plan`
    does) before each group and refuses with `index-changed` (CLI kind `diff-changed`) when
    it differs from the one stored in the run state, so staging the user made between `plan`
    and `commit`, or between groups, is never silently lost from the report; the stored
    fingerprint is updated after each of the run's own commits and unstages, and groups
    already committed stay committed (Q9 makes the matching per-group check at the same
    point).
  - The index fingerprint sees an intent-to-add entry and a staged empty file alike (both
    hash as the empty blob) — an accepted gap: a switch between the two is not refused as
    `index-changed`.
  - Added lines of a text file that a `-diff` or `binary` attribute (or a custom `diff`
    driver) marks binary are read by a second whole-diff `git diff -z --raw -p --text` pass,
    run only when at least one such file exists; the pass is streamed like the first, keeping
    only those files' sections and discarding the rest as it arrives, with the same rename
    detection as the main diff, and the file list that picks out which sections to keep is
    never passed to git on argv.
- **Amended.** By spec pass 8 (2026-09-27): a type-change (`T`) record (file↔symlink,
  file↔submodule) owns two consecutive patch sections with its path, since git prints a
  delete and then a new file for it (checked with `git diff --cached --raw -p`); it is one
  whole-file unit, in the main and the `--text` pass alike. Pairing one section per record
  would have ended every run with a type change as `internal`.
- **Amended.** By spec pass 9 (2026-09-27): the tests also cover a cone-mode sparse
  checkout with a path outside the cone and a path marked `--skip-worktree` whose
  working-tree file is removed: neither is a unit or in `notIncluded`, and neither is
  committed as a deletion. The pass 2 rule that such entries are never units had no test,
  although out-of-cone paths are the failure a temporary index built from HEAD would show.
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
  - Deferred, not spiked: committing each group from its own temporary index (built from
    HEAD plus the group's units, committed with `GIT_INDEX_FILE`) instead of resetting and
    restaging the shared real index. It would leave the user's index alone during a run;
    recorded as considered and deferred, since it has not been spiked (how repo hooks and
    filters behave against an alternate index is unverified).
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
  and mode-plus-content changes, symlinks, a file→symlink and a file→submodule type change
  (`T`: one whole-file unit), submodule pointers, a pointer change in a
  submodule with untracked files inside (committed), dirt without a pointer change (report
  line, tree `clean`), a trailing-whitespace hunk under `apply.whitespace=error`, a file
  with a clean filter (a `sed`-based `filter.<x>.clean` in the test repo: whole-file unit,
  staged with the filter applied, scanned in its cleaned form), `diff.relative=true` with
  `plan` run from a subfolder (changes outside it still listed),
  `diff.interHunkContext=10` (units unchanged), CRLF content with `core.autocrlf=true` and
  a `.gitattributes` `eol=crlf` file (no mismatch), a staged case-only `git mv`, and on
  Windows a rename group of a few thousand paths that would exceed the command-line limit
  on argv (committed).

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
- **Decision.** *Superseded by Q24 and Q25 (see Status): the agent is `commit-worker`,
  `model: sonnet`, and it runs the whole run itself.* The plugin ships an agent
  `commit-planner` (frontmatter `model: inherit`, tools
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
  - *Superseded (Q24, Q25): the worker writes the [worker plan](contracts.md#worker-plan) to
    `plan.groups.json` and runs `check` itself.* It writes the planner output to
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

  *Superseded (Q24): lint retries loop inside the worker, which re-reads
  `plan.groups.json`.* The caller runs `check`, which lints every group and computes
  `confirm`. On a lint error a **new** planner is spawned with the same `planId` and the `check` errors; it reads the
  previous plan from `planner.json` itself and overwrites it. One retry, then Q18. Hunk IDs
  stay valid across re-plans (Q9). A missing or unparseable `planner.json` is a lint error
  and counts as a failed attempt; after the retry the caller runs `release`.

  *Superseded (Q6 Rejected, Q24): the model key is dropped and the frontmatter is
  `model: sonnet`.* `plannerModel` mapped onto the Agent call: `"sonnet"` and `"haiku"` were
  passed as `model`; `"inherit"` omitted `model`, so the frontmatter `inherit` applied.
- **Amended.** By spec pass 2 (2026-09-27): the Haiku planner eval is a 1.0.0-roadmap item
  with its own harness and thresholds; no 0.1.0 verifier depends on it.
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
  Haiku against Sonnet. Version 1.0.0 waits on that eval. The eval, its harness, fixtures and
  thresholds are a 1.0.0-roadmap item: no 0.1.0 story is verified by it, and in 0.1.0 the
  manual hand-test and the dogfood gate (Q24) stand in for it.
- **Amended.** By spec pass 7 (2026-09-27): corrects the Consequences above: the dogfood gate
  is itself a 1.0.0 gate (30+ episodes, Q24), not a 0.1.0 check standing in for the eval —
  Q24's tooling for it is built only after 0.1.0 ships. In 0.1.0 only the manual hand-test
  verifies grouping quality; nothing measures Haiku against Sonnet until 1.0.0.

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
    `Token: value` or `Token #value`, where the token is `BREAKING CHANGE` or a word of
    ASCII letters, digits and hyphens starting with a letter;
    indented lines continue the previous footer. A `Note: …` line in an earlier paragraph,
    or next to non-footer lines, is body text.
  - The agent may write only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes` and
    `Fixes` footers. Any other token (`Co-Authored-By`, `Signed-off-by`, …) fails lint; only
    the script adds those (Q5, Q20). `!` in the header is allowed. A last paragraph such as
    `Note: see #12` parses as a footer with a disallowed token, so the lint error says what to
    do: "`Note` is not an allowed footer token. If this is body text, rephrase it or add a
    non-footer line to the paragraph." The worker's lint retry can fix it on its own.
  - A footer-only final paragraph is not a body, so it is allowed under `body: forbidden`.
- **Amended.** By spec pass 3 (2026-09-27): the guard's cold-start time is
  an open verification item: it is measured for the exec-form hook on all three OSes, and
  the target is set, before the guard slice claims one. `module.enableCompileCache` for
  the cold start is deferred past 0.1.0 (see [Non-goals](#non-goals)).
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

- **Context.** The layout must keep one shared module library behind both entry points, keep
  the guard's load small (Q13), and let the plugin dogfood its own rules.
- **Decision.**

  ```
  .claude-plugin/marketplace.json
  .claude/CLAUDE.md
  .claude/commit.json                 repo config; scanIgnore: tests/fixtures/**
  .github/workflows/test.yml          ubuntu + windows + macos × Node 22/24, + git 2.34 container job
  plugin/.claude-plugin/plugin.json
  plugin/scripts/commit.js            commit entry point: thin, subcommands for worker and skills
  plugin/scripts/guard.js             guard entry point: thin, the PreToolUse hook
  plugin/scripts/lib/                 shared module library; the guard loads only its modules
                                      plus heartbeat and script call
  plugin/hooks/hooks.json
  plugin/agents/commit-worker.md       the run (Q24, Q25)
  plugin/skills/commit/SKILL.md       /commit: spawn only
  plugin/skills/commit-config/SKILL.md
  docs/contracts.md, decisions.md, spec.md
  tools/                              episode analysis (Q24), not packaged
  tests/*.test.js, tests/fixtures/
  LICENSE (MIT), README.md
  ```

  Neither entry point holds domain logic; module boundaries are in [spec](spec.md).

  Tests build git repos in temp directories at run time (fixed author and dates via env).
  Minimum git version 2.34 (SSH signing, Q18). The script spawns only git, plus `ssh-add`
  for the signing probe (Q18) and, on Windows, `taskkill` for the tree kill (Q9, Q18;
  resolved from the system directory, never from `PATH`), all through one process adapter. The main CI matrix
  (ubuntu, windows, macos × Node 22, oldest and latest, and Node 24) tests whatever git the runners ship. One extra
  job tests the minimum in an `ubuntu:22.04` container with the distribution's git (2.34.1);
  its first step asserts that `git --version` is 2.34.x, since the hosted `ubuntu-22.04`
  runner image ships a newer git and a job on it would not test the minimum. A
  privacy-guard test keeps local paths and usernames out of docs, README,
  manifests and test sources (Q10): `local-path` over all four, matching a home-directory
  path with any user name on every OS, and the CI runner's user name as a path segment. A
  bare user name outside a home path is not caught (accepted). Design review reports stay out of history: they quote
  the bugs they found, local paths included, and `decisions.md` already records what they
  changed. They are written next to the docs (`docs/design-review*.md`, where the review
  skill puts them) and kept out by a `docs/design-review*.md` line in the clone's
  `.git/info/exclude`, so a `git add docs` or a `split` run never sees them and later
  rounds are covered without a new rule. Start at version 0.1.0.
- **Amended.** By spec pass 1 (2026-09-27): added the shared module library path, the
  unpackaged `tools/` directory for episode analysis, and the `docs/` list (`contracts.md`,
  `decisions.md`, `spec.md`) to the layout. By spec pass 2 (2026-09-27): the git 2.34 job
  runs in an `ubuntu:22.04` container, and the main CI matrix tests Node 22 oldest and
  latest plus Node 24.
- **Amended.** By spec pass 3 (2026-09-27): the privacy-guard test does not
  catch a bare user name outside a home path, an accepted gap; the process list is git plus `ssh-add` for the signing probe, since the
  openpgp `gpg` / `gpgconf` probes are deferred (Q18).
- **Amended.** By spec pass 5 (2026-09-27): the guard is supported and tested on both
  Windows PowerShell 5.1 and PowerShell 7+ (Q3): the windows CI runner ships both, and the
  guard's PowerShell tests, including the PowerShell parser oracle, run under each
  (`powershell.exe` and `pwsh`). Other PowerShell editions are not supported. The process
  list adds `taskkill` on Windows for the tree kill (Q9 spec pass 4, Q18).
- **Amended.** By spec pass 9 (2026-09-27): the privacy-guard test matches the CI runner's
  user name only as a path segment (between `/` or `\` separators, as in `/home/<name>/`,
  `/Users/<name>/` or `C:\Users\<name>\`, the OS-user segment rule of Q10), never as a bare
  word, and without Q10's service-user and length exemptions, so `/home/<runner name>/` is still
  caught. Matching it anywhere failed by construction: the runner's name is `runner` on
  ubuntu and macos and `root` in the container, and both are ordinary words in the docs.
- **Amended.** By spec pass 10 (2026-09-27): the pass-9 amendment quoted a runner path
  literally, which the test itself flags on ubuntu and macos; it now writes the runner's
  name as a placeholder. A self-test runs the segment check over the repo's tracked files with
  the user name set to `runner` and to `root`, so such a literal fails locally too.
- **Rejected.**
  - Node 18 or 20 as the minimum: both are end-of-life, and Claude Code's npm install
    already requires Node 22.
  - Git 2.23 as the minimum: untested in CI, and SSH signing needs 2.34.
  - The hosted `ubuntu-22.04` runner for the minimum-git job: its image ships a newer git,
    so the job would pass without ever running 2.34.
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
    and `check` would commit a header the user, who was in the middle of
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
- **Amended.** By spec pass 2 (2026-09-27): `state.json` carries a `version` field, and a
  mismatch on re-read is refused with `ended`.
- **Amended.** By spec pass 3 (2026-09-27):
  - The tamper digest is deferred past 0.1.0: `state.json` keeps only its `version` check,
    and the digest file, its sweep and the digest-mismatch refusal are dropped. An agent
    that rewrites the state under the README `Edit` rule is an accepted gap.
  - The script-call builder escapes nothing; the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\`, replacing the per-shell escaping
    (Q25).
- **Amended.** By spec pass 5 (2026-09-27): the candidates counted for the `modeChoice`
  decision (index plus other changes) are counted after the hidden rule and before the
  caps ([contracts](contracts.md#plan) step 4), so a file the hidden rule excludes never
  tips the count into a mode choice. The `Edit(**/.commit-plan/**)` allow rule stays global
  (it must work across repos from user settings); known gap: `**/.commit-plan/**` matches at
  any depth, so a project path such as `src/.commit-plan/x.js` is also edited without a
  prompt. `staged` needs a non-empty index: a `plan --staged` that finds the index empty
  (emptied after the user picked `staged`) is refused as `usage` (`staged-empty`, Q9).
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
  `plan.groups.json` and `check`; a `resume` respawn adds its separate
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
  the anchored rule does not give. Accepted. The same rule lets an agent rewrite
  `state.json` (units, messages, `confirm`, `awaitingConfirm`) without a prompt, an
  accepted gap in 0.1.0 (Q3: the plugin steers). The state carries a `version`, and every
  later call that opens the run refuses with `ended` on a `version` written by another
  plugin build. A tamper digest (a SHA-256 of `state.json` stored outside the run folder)
  is deferred past 0.1.0 (see [Non-goals](#non-goals)).

  The script path in every `run` command is built without escaping: the commit entry point
  refuses (`env`) an install path containing `$`, a backtick, `"`, `\`, or a typographic
  quote (U+201C–U+201E: `“` `”` `„`, which PowerShell reads as a double quote, G2) before
  any work, so no shell can expand or mangle the path, and the one quoted form stays the one
  the anchored allow rules match. The check runs on the forward-slash form the call uses
  (Windows separators converted to `/`), so a native Windows install is not refused.
- **Amended.** By spec pass 7 (2026-09-27): the refused set gains U+201C–U+201E (PowerShell's
  typographic quotes): unrefused, one of them in a Claude home path breaks the quoted `run`
  in PowerShell and stops the S2 `recognise` guard from seeing script calls, silently
  disabling the worker-only rule (G3) and the heartbeat.

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
      15 minutes applies like to any run). `check` then commits a confirmation that
      is not `humanOnly` without asking: the worker's grouping is confirmed by nobody else.
      After two failed lints (one on dictated text) `check` releases the lock and the
      reply carries the errors (Q18).
    - `interactive` omitted: the worker returns handbacks as for a user, and the caller
      follows the handback's `ifNoUser` (Q25): `yes` for a plain confirmation (the
      implementer, who knows the task, has seen the grouping), `no` plus hand-back for
      `humanOnly` and a `lintFailed`, `split` for a mode choice, `wait` plus hand-back for
      a lock (`returnToParent: true`), and `continue` for a `continue` handback, run without
      asking; the full column is in [contracts](contracts.md#reply-and-handback).
      One call more per confirmation, in the implementer's context.
  - `humanOnly` is never answered without a user: nothing is committed, the lock is
    released (by `check` with `--no-user`, by the `no` answer otherwise), and the reply's
    `text` goes verbatim to the parent, which shows it to the user; the user then runs
    `/commit`, which plans afresh. The `handedBack` handback has no answers, so nothing in
    it points at the ended run. Scan-hit notices (Q10) are passed on the same way, but do
    not stop the commit: every notice is part of `text`, and every reply's `callerRule`
    says a subagent puts `text` verbatim in its final report (Q25), on `committed` and
    `nothing` replies too.
- **Amended.** By spec pass 2 (2026-09-27): the caller-trust eval fixture set is a
  1.0.0-roadmap item; the manual hand-test stands in for it in 0.1.0.
- **Amended.** By spec pass 4 (2026-09-27): the `ifNoUser` list matches
  contracts (`wait` returns to the parent; `continue` runs without a user).
- **Amended.** By spec pass 5 (2026-09-27): a file skipped for size (over 1 MB added, Q10)
  in a run without a user (`interactive: false` or `--no-user`): the worker leaves it out,
  in `notIncluded` with the reason "over 1 MB, not scanned: commit by hand", and commits the
  rest, since including it would make the run `humanOnly` and commit nothing.
- **Amended.** By spec pass 9 (2026-09-27): a run without a user can still take over a
  stale lock automatically, and the takeover can find `killedLeftover` (the user staged
  beyond the killed group's paths after the kill, Q22's pass-6 amendment), which in an
  interactive run forces a `modeChoice`. Nobody could answer that question here, so:
  - `--no-user` without `--reword` → a refusal, exit 6 `state`, domain code
    `killed-leftover`, whose text names the killed group's paths still staged; the index is
    left untouched, the lock is released and the folder deleted. The run still never gets
    a `modeChoice`, and the parent relays the text like any refusal.
  - `--reword` (with or without `--no-user`) → no forced `modeChoice`: `--amend --only`
    never touches the index, so the leftover cannot be committed; the run goes on, and a
    notice names the killed group's paths still staged.
  - Interactive `split` and `staged` runs keep the forced `modeChoice`.
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
  committing the rest. Eval fixtures (Q12's set, run on every worker model; a 1.0.0-roadmap
  item with its own harness and thresholds, so no 0.1.0 verifier depends on them): an
  unrelated modified file next to the intended change, spawned with an `intent` and
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
    can `git reset HEAD~n`. `commit --all` (and `check`, which runs it) reports the
    groups it committed, the failed group and the ones not committed, and exits with the
    failed group's cause (Q9).
  - `split`: each group runs in three phases: (a) the refusals (`lock`, `usage`,
    `head-moved`, `index-lock`, and `diff-changed` for `index-changed`); (b) rebuild the
    temporary index, diff and match the group's hashes (`diff-changed`), which never
    touches the real index; (c) reset the real index,
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
    - `git commit` failed (exit 4) → stop, show git's output, no retry, never
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
    (`plan.signing.ready`), after the clean-tree and `staged-hit` checks, so a clean tree
    on a locked key reports "nothing to commit" (Q9):
    - `openpgp`: `"prompt"`, with the note "signing enabled; a passphrase prompt may
      appear". A locked openpgp key is not detected at `plan` (an accepted gap); classifying
      the pinentry program with `gpg` and `gpgconf` probes is deferred past 0.1.0 (see
      [Non-goals](#non-goals)).
    - `ssh`: the key is in `ssh-add -L`, or the private key file (`user.signingKey` minus a
      `.pub` suffix) has no passphrase, decided from its header with no extra process
      (OpenSSH `openssh-key-v1` with cipher `none`; PEM without `ENCRYPTED`) → `true`,
      else `false`; `"unknown"` when the key source cannot be checked
      (`gpg.ssh.defaultKeyCommand` or no key, a `~user/` path, a private key file whose
      header is neither form) or when a `false` rests on an `ssh-add -L` check that was not
      run or not trusted (the case table in [contracts](contracts.md#plan)).
    - `x509`: `"unknown"`.
    - A custom signing program is outside the probe's view and never maps to `false`: a
      `gpg.ssh.program` other than the default (1Password's `op-ssh-sign` asks with Touch ID
      or a window, and its key is usually not in the default agent's `ssh-add -L`) →
      `"prompt"`; a custom `gpg.program` → `"unknown"`.
    - The probe runs only git and `ssh-add` (Q15), each under a fixed timeout; a timeout
      yields `"unknown"`, so a wedged agent cannot stall `plan`, and a probe that could not
      finish never maps to `false`.

    `false` → `plan` refuses with exit 6 `signing`, before any grouping: "signing key
    locked — unlock it (e.g. sign once in a terminal), then `/commit`". `"prompt"` (openpgp
    or a custom `gpg.ssh.program`) → the run goes ahead and the reply's `notices` carry the
    plan's note "signing enabled; a passphrase prompt may appear". The worker commits through `check` before anyone reads a notice,
    so the window itself is the first sign; the notice explains it afterwards. `"unknown"`
    → the run goes ahead.
  - Timeouts: every script call the worker itself makes (`plan`, `plan --hunks`, `check`)
    runs with a 600-second (600 000 ms) tool timeout (the Bash tool's maximum; the worker's
    prompt says so; Q9). `commit --all` and `release` never run from the worker (G3, Q25):
    they run only from a handback's `run` in the caller, which carries its own `timeoutMs`
    (Q25 pass 5). `plan` has its own 540-second deadline from its start, bounding
    all its git calls (`timeout`, Q9). The script's own budget is 540 seconds per call, not per group: the first
    group always starts, a later one only while at least 480 s are left; otherwise the call
    stops cleanly with a `continue` handback that runs the same command, and the run goes on
    where it stopped (the handback goes to the caller, which follows `callerRule`; the
    guard denies the worker's own `commit` call, Q25). Each
    `git commit` is timed out at what is left of the budget. On timeout it kills the process
    tree (on POSIX `SIGTERM` to the process group, then `SIGKILL` after a 5-second grace; on
    Windows `taskkill /T`, then `taskkill /T /F` after the same grace), and reports "git
    commit did not finish in 9 min — a pre-commit hook or a signing prompt may be waiting".
    On a partial commit (reword's `--amend --only`), where git holds `index.lock` across its
    hooks until the kill, it removes `index.lock` only when it is stale by the two-marker
    rule. On a plain commit (`split`, `staged`) it never removes `index.lock`: git released
    it before the hooks ran, so a lock present after the kill may belong to another process;
    the report says `index.lock` was left and should be checked and removed by hand if no
    git process is running. The two-marker rule: a marker file is written next to
    `index.lock` (both resolved through `git rev-parse --git-path index.lock`, the
    per-worktree git directory) right before the `git commit` spawn and a second one right
    before the tree kill starts; after the child has ended, `index.lock` is removed only when
    its mtime is at least the first marker's minus 2 seconds (mtime resolution) and strictly
    below the second marker's. Only the lower bound is widened: on a partial commit the
    running `git commit` holds the lock until the kill, so a lock another process creates
    after the kill has an mtime at or above the second marker's and is kept. All three times
    come from the same filesystem, so a skewed clock cannot lead to removing a foreign lock.
    One module (M10) owns the markers, the spawn and the removal.
- **Amended.** By spec pass 2 (2026-09-27): the signing probe (git and `ssh-add` only, Q15)
  runs each process under a fixed timeout, and a timeout yields `"unknown"` rather than
  failing the run.
- **Amended.** By spec pass 3 (2026-09-27):
  - The kill sequence: `SIGTERM` to the process group, then `SIGKILL` after a 5-second
    grace (Windows: `taskkill /T`, then `/T /F`), instead of an immediate hard kill.
  - The two-marker stale `index.lock` rule replaces "newer than the spawn", which compared
    the lock's filesystem mtime with the local clock.
  - Signing probe: SSH readiness by `ssh-add -L` or the key file's header; openpgp enabled
    → `"prompt"` with a note; the probe runs only git and `ssh-add`. The openpgp pinentry
    classification (`--pinentry-mode error`, `gpgconf`) is deferred past 0.1.0.
  - `plan` refuses on signing only after the clean-tree and `staged-hit` checks (Q9).
  - `plan`'s 540-second deadline and the 600 000 ms tool timeout for `plan` and `check`
    (Q9).
- **Amended.** By spec pass 4 (2026-09-27):
  - Two-marker rule: the second marker is written before the tree kill and only the lower
    bound is widened (a 2-second widening after the kill could remove a lock another
    process created right after it); markers and lock resolve through the `--git-path` of
    `index.lock`; M10 owns the whole mechanism.
  - SSH readiness follows an explicit case table (contracts, `plan`): a literal key is
    matched against `ssh-add -L` only; `gpg.ssh.defaultKeyCommand` or no key → `"unknown"`;
    a private-key path reads its `.pub`; `~/` expands against the OS home; `ssh-add` is the
    one next to the `ssh-keygen` git runs (on Windows a `PATH` `ssh-add` may talk to another
    agent), and a `false` that rests on an agent check that could not run is `"unknown"`.
  - The backstop runs `git write-tree` first and scans the tree-to-tree diff of the
    expected HEAD against that tree, so the tree recorded is the tree scanned.
- **Amended.** By spec pass 5 (2026-09-27): `cleanupDeadline` = the call's start plus 590 s;
  after a failure or a timeout, the cleanup and reporting calls (the `finally` unstage, the
  HEAD re-read, the tree-state read, and the release) take the time left before
  `cleanupDeadline`, never the spent 540-second `deadline`, so a call that used up its 540 s
  budget still reports and releases inside the worker's tool timeout.
- **Amended.** By spec pass 6 (2026-09-27):
  - Phase (a)'s `index-changed` refusal (exit 6 `diff-changed`) is skipped in `reword` mode:
    `--amend --only` never touches the index, so staging a file during a reword must not end
    the run with `diff-changed` (Q20 rejects refusing a reword over a non-empty index for the
    same reason).
  - What a caller shows through `text` for git or hook output is capped and escaped, not
    shown verbatim: `text` carries at most the last 2000 characters of that output, prefixed
    with a "[… N characters cut]" marker when cut, while the full output stays in
    `gitOutput`. Control characters (C0/C1, ESC included, so ANSI is neutralised) are escaped
    as `\xNN` the same way the path rule escapes them; `\n` and `\t` are kept. Accepted gap:
    hook output can still hold forged plain-text lines or echo a secret — the cap and escape
    only bound size and terminal/rendering damage. (The contracts.md-side shape of `text` /
    `gitOutput` carries the rest of this rule.)
  - On a takeover of a run whose `indexReset` was set and whose current group was not
    committed, the new run resets the index or asks via `modeChoice` before its own
    inventory step runs, instead of only reporting `unstaged` — see Q22's pass-6 amendment
    for the full mechanism.
- **Amended.** By spec pass 7 (2026-09-27): `cleanupDeadline` lowered to the call's start plus
  580 s (was 590 s, pass 5): 590 s left too little margin once the 5-second kill grace and
  Node's own start-up (the 600 s tool timer starts before Node does) are subtracted. A
  cleanup or reporting call (the `finally` unstage, the HEAD re-read, the tree-state read, the
  release) whose `timeoutMs` (= `cleanupDeadline - now()`) is ≤ 0 is not spawned at all and
  counts as timed out, the same outcome as one that started but did not finish in time.
- **Amended.** By spec pass 8 (2026-09-27):
  - A plain `git commit` (as in `split` and `staged`) releases `index.lock` before its
    hooks run; only a partial commit, such as reword's `--amend --only`, holds it across
    the hooks. The stale-lock test (story 215) is therefore built on the `reword` path with
    a sleeping hook that records that `index.lock` exists, and asserts that record, so the
    lock existed when the tree was killed.
  - After a timeout kill, `index.lock` is removed by the two-marker rule only on a path
    where git holds the lock until the kill (a partial commit). On a plain commit it is
    never removed: a lock another process created while a hook hung would fall between the
    markers and be deleted. The report instead says `index.lock` was left and should be
    checked and removed by hand if no git process is running. The earlier rationale ("the
    running `git commit` holds the lock until the kill") held only for partial commits.
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
  agent works without interaction, and a locked SSH key is caught before any grouping. A
  locked openpgp key behind a TTY pinentry is not caught at `plan`: the plan notes that
  signing is enabled, and the commit fails or times out at `git commit` (an accepted gap
  until the pinentry classification lands).

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
    one-group worker plan with `"source": "user"` → `check`, which commits at
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
- **Amended.** By spec pass 6 (2026-09-27): confirms and records that phase (a)'s
  `index-changed` check from Q18 does not apply to `reword` (extends "Refusing when the
  index is not empty: `--only` makes it unnecessary" below, and "No content changes, so no
  content scan, no reset, no staging and no staged-diff check (Q18)" above): staging a file
  during a reword must not end the run with `diff-changed`. Cross-references Q18's matching
  pass-6 amendment.
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
  | paused sequence (a multi-commit cherry-pick or revert stopped between picks) | refused, like an in-progress operation: "continue or abort it by hand" |
  | pending `merge --squash` (`SQUASH_MSG` present) | refused: "a squashed merge is staged: commit it by hand, or drop it with `git reset --merge`" |
  | unmerged index entries without an in-progress marker (such as a conflicted `stash pop`) | refused with `unmerged`: "resolve the conflicts first" |
  | `i18n.commitEncoding` set to anything but UTF-8 | refused |
  | detached HEAD | handled, with a warning |
  | not a repository, bare repository | refused |

  Every refusal here is the CLI kind `state` (exit 6, Q9). Detection: `git rev-parse
  --git-path` for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`,
  `rebase-apply`, `BISECT_LOG`, `sequencer/` and `SQUASH_MSG`; unmerged entries from any `u`
  line of the same porcelain v2 status that reads HEAD (pinned `--untracked-files=no
  --ignore-submodules=all`), so conflict markers are never committed. A paused sequence counts as in progress
  even when no `CHERRY_PICK_HEAD` or `REVERT_HEAD` is left (the stop after a conflicted pick
  was committed by hand): a new commit would land in the middle of the sequence. The
  encoding check reads `i18n.commitEncoding`, compared case-insensitively with `utf-8` and
  `utf8`: the script writes UTF-8 messages only, so a repo that declares another encoding
  would get commits labelled with the wrong one.
- **Amended.** By spec pass 2 (2026-09-27): a paused sequence with no `CHERRY_PICK_HEAD` or
  `REVERT_HEAD` left still counts as in progress; a non-UTF-8 `i18n.commitEncoding` refuses;
  and "not a repository" and "bare repository" are both refused with the CLI kind `state`.
- **Amended.** By spec pass 3 (2026-09-27): a `SQUASH_MSG` row with its
  own refusal text; unmerged index entries without an in-progress marker refused with
  `unmerged`; `i18n.commitEncoding` compared case-insensitively, so `UTF-8`, `utf-8` and
  `utf8` all pass.
- **Rejected.** Letting the worker make the in-progress commit: its message, parents and
  conflict state belong to the operation, not to a Conventional Commits plan.
- **Consequences.** Finishing a merge goes through the guard's `--no-edit` form (Q4), which is
  what that allowance exists for.

## Q22 Concurrent runs

- **Context.** Q17's workflow can run several implementers in one repo. Two `/commit` runs
  clobber each other's index (`git reset`) or collide on `index.lock`.
- **Decision.**
  - `plan` takes a run lock when there is work to do (Q9):
    `<toplevel>/.commit-plan/lock` (next to the run folders, Q9), holding
    `{ planId, created }`: written to a temporary file in `.commit-plan/` and moved into
    place with `fs.linkSync`, which fails when a lock exists, so no reader ever sees a lock
    without its content; never rewritten. A link that fails with `EEXIST` is the normal
    held-lock handling; on Windows an `EPERM` or `EBUSY` is retried like the `state.json`
    rename, and one that persists falls back to a hard-link probe: the probe succeeds →
    `busy` (another process has the file in use), the probe fails → `run-folder` (CLI kind
    `state`, "the run folder's filesystem does not support hard links"); `ENOTSUP` or
    `ENOSYS` is `run-folder` at once, without a probe. Re-plans reuse the `planId` and never
    take a second lock.
  - Run IDs are validated and deletions contained: a `planId` is `crypto.randomUUID()`
    output, and every `planId` the script reads (`--plan`, `--take-over`, a lock's content)
    must be a lowercase UUID v4; a malformed flag value is `usage`. Every folder or file
    the script deletes is resolved and checked to lie strictly inside
    `<toplevel>/.commit-plan/`.
  - Before its first write, `plan` checks `<toplevel>/.commit-plan` with `lstat`: a
    symlink, a junction, a non-directory or a path tracked in the index is refused with
    `state`, domain code `run-folder` ("`.commit-plan` is tracked or not a plain directory; remove it by hand"), and
    the check is repeated after `mkdir`.
  - One call per run at a time: every call with `--plan` (and `plan --take-over`) creates
    `<planId>/call.lock` exclusively and removes it on exit; a second call on the same run
    while it exists is refused with `busy` (CLI kind `lock`), since a call backgrounded by
    a tool timeout and then retried must not share the temporary index. A `call.lock`
    holds `{ pid, host }` (the calling process and `os.hostname()`). It is stale when its
    host is this host and `process.kill(pid, 0)` fails with `ESRCH` (the call was killed:
    Esc, a session end or a signal runs no `finally`), and is then removed at once, so
    `plan --take-over` of a killed call's run (stories 190, 210) is not refused `busy`;
    otherwise (another host, an unreadable file, or a pid that answers, including with
    `EPERM`) it is stale only when older than 15 minutes by mtime. A stale `call.lock` is
    replaced with the lock's atomic takeover below (rename to a private name, check it is
    the file judged stale, put it back on a mismatch). Unlike the run lock, a pid means
    something here: one process holds a `call.lock` for its whole life. `release` takes
    the `call.lock` only after it has read a lock holding its own `planId`, so `busy` is
    the only `lock` refusal it can raise.
  - Every write of `state.json` goes to a temporary name, then a rename; on Windows a
    rename that fails with `EPERM` or `EBUSY` is retried a few times over about a second
    before it counts as a failure.
  - `touched` is the lock file's **mtime**. Every subcommand with `--plan` (`plan --hunks`,
    `check`, `commit`) reads the lock, checks it holds its `planId`, then refreshes the mtime
    with `fs.utimesSync`. Nothing truncates or rewrites the lock, so a concurrent `plan`
    never reads a half-written one. If a takeover lands between the read and the
    `utimes`, the refresh touches the new holder's lock, which is harmless, and the next
    step's read refuses the old run.
  - A lock whose `touched` is under 15 minutes old refuses the new run with exit 6 `lock`:
    "another /commit run is in progress (started 13:58, last active 40 s ago)", the same
    wording as the takeover question below. An older one is taken over automatically, and
    the reply's `notices` name the stale run's `planId`, so a run that was only slow is
    traceable.
    `commit --all` touches the lock before every group and stops within its 9-minute
    budget (Q18), so a slow hook never loses the lock mid-run.
  - An unparseable lock, or one whose `planId` is not in the minted form (the linked
    creation never leaves a half-written one, so only a foreign or hand-edited file does),
    is judged by its mtime alone: fresh → `lock`, `planId: null`, so it cannot be taken
    over by `--take-over` and the user waits for the 15 minutes; stale → the automatic
    takeover.
  - Takeover, automatic or `--take-over <planId>`, is atomic: `plan` renames `lock` to
    `lock.<own planId>` (only one of several renames of the same file succeeds; the others
    get `ENOENT` and retry the link, which then refuses them with `lock`), reads
    the renamed file and checks it is the lock it decided on: automatic, the bytes and
    mtime it judged stale (a rename keeps the mtime); `--take-over`, the `planId` the user
    was asked about. On a match it deletes that run's folder and the renamed file, then
    links its own lock into place. When the taken-over run's state has `indexReset` and an
    uncommitted group (a call killed mid-staging), the takeover reports that run's
    `unstaged` paths (Q18) before deleting its folder. On a mismatch it moved a lock that another `plan`
    created in between: it puts it back with `fs.linkSync` (fails if a lock exists, so it
    never overwrites one), deletes its copy and refuses with `lock`, carrying the details
    of the lock it found, so the question can be asked again about the right run. If the
    put-back link fails with `EEXIST` (a third `plan` linked its lock in the gap), it keeps
    its private copy for the sweep, reads the lock now in place and refuses with `lock`
    (`held`) naming that new holder; the moved run is refused at its next step with
    `taken-over`. That refusal does not end the run, so its folder stays until `plan`'s
    24-hour sweep; accepted.
  - On Windows, a rename, read or `utimes` of a lock that another process holds open fails
    with `EPERM`, `EBUSY` or `EACCES`, not `ENOENT`. Every lock operation other than the
    lock link maps those to "someone else is on it" and refuses with `busy` (CLI kind
    `lock`), never with `internal`.
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
    wants the run gone, and after a takeover it must not touch the new holder's lock. On a
    match it takes the `call.lock` like every call (above), so a `no` answer never deletes
    the folder under a call still running on that run.
  - Released by the commit of the last group (the state file knows the group count from
    `check`), by `check` on zero groups (Q16), on a `humanOnly` hand-back or a final lint
    failure without a user (Q17, Q18), by every failure path (Q18), and by `release` (the
    `no` answer of a handback, Q25).
  - Housekeeping: releasing the lock deletes the run folder (state, hunks, temporary index,
    worker plan, `plan.json`), so no hunk hashes of past diffs are left behind. `plan`
    also deletes run folders older than a day, which covers runs that were never released,
    and leftover takeover and lock temp files. The sweep considers only folders named in
    the minted `planId` form and never follows a link. A cleanup error after a successful commit (a Windows
    file lock on a temp file) never changes the outcome: the commits stand, the error
    becomes a notice, and the sweep removes the leftovers later.
  - The README recommends `isolation: "worktree"` for parallel implementers: each worktree has
    its own git dir, index and lock.
- **Amended.** By spec pass 2 (2026-09-27): when the taken-over run's state has
  `indexReset` and an uncommitted group, the automatic takeover reports that run's
  `unstaged` paths before deleting its folder; and a cleanup error after a successful
  commit becomes a notice rather than changing the outcome.
- **Amended.** By spec pass 3 (2026-09-27):
  - `planId` validated as a UUID and every deletion resolved inside
    `<toplevel>/.commit-plan/`; the sweep covers ID-shaped folders only; a symlinked,
    junctioned or tracked `.commit-plan` is refused.
  - The per-run `call.lock` (`busy`).
  - The lock is written to a temporary file and linked into place (`linkSync`) instead of
    an exclusive create followed by a write, so an empty lock is never seen; a link failing
    with `ENOTSUP` or `ENOSYS`, or with a persisting `EPERM`/`EBUSY` whose hard-link probe
    also fails, is `run-folder`.
  - `state.json` written to a temporary name and renamed, with the Windows `EPERM`/`EBUSY`
    retry.
  - A killed call's takeover reports the unstaged paths.
  - Accepted gap: lock staleness on a network filesystem compares the file server's mtime
    with the local clock. Deferred past 0.1.0: a concurrent-runs stress test.
- **Amended.** By spec pass 4 (2026-09-27): `call.lock` holds
  `{ pid, host }` and a dead pid on this host makes it stale at once, so a killed call no
  longer blocks `--take-over` for 15 minutes; `--take-over` skips `plan`'s `peek`; a
  put-back that fails with `EEXIST` keeps the private copy and refuses `held` naming the new
  holder; `release` takes the `call.lock` after its lock check (`busy` its only refusal).
- **Amended.** By spec pass 5 (2026-09-27): on Windows the lock's hard link is retried on
  `EPERM`/`EBUSY` like the `state.json` rename; `run-folder` (the domain code, CLI kind
  `state`, for `.commit-plan` problems, "the run folder's filesystem does not support hard links") is reported only when
  a hard-link probe (a temporary file hard-linked once more in `.commit-plan/`) also fails; a
  persisting `EPERM`/`EBUSY` whose probe succeeds is `lock` (`busy`) instead, since another
  process genuinely holds the link. `ENOTSUP` and `ENOSYS` are `run-folder` at once, without
  a probe; `EEXIST` stays the normal held-lock handling.
- **Amended.** By spec pass 6 (2026-09-27): supersedes the pass-2 amendment's "reports that
  run's `unstaged` paths" for the case where the leftover staging is exactly the killed
  group's own paths (now reset instead of just reported). After `acquire` succeeds in a
  takeover (automatic or `--take-over`) and before the new run's own inventory/mode-decision
  step runs, when the killed run's state has `indexReset` set and its current group was not
  committed: compare the index with HEAD.
  - If every staged path belongs to the killed group's paths (defined once in
    [contracts](contracts.md#run-folder): the current group's unit paths from the stored
    validated groups, both halves of a rename included, ∪ the stored `preStaged` ∪ the
    stored `indexOnly`) → run `git reset -q`, and the takeover notice says the killed
    group's partial staging was reset (replacing, for this case, the old "reports
    `unstaged`" behaviour).
  - Otherwise (the user staged something else after the kill) → leave the index untouched;
    never auto-commit it in `staged` mode; ask via the existing `modeChoice` handback, whose
    notice additionally names the killed group's paths still staged.
  - Seam 1 cases: kill during phase (c) then take over → index reset, the new run's inventory
    sees a clean index; kill, then the user stages another file, then take over → no reset,
    `modeChoice` asked instead. Cross-references Q18's pass-6 amendment and
    [contracts](contracts.md#plan).
- **Amended.** By spec pass 8 (2026-09-27): `indexReset` stays set once an earlier group
  has committed, so a run killed in phase (a) of a later group, before any staging, leaves
  an empty staged set that trivially "belongs to the killed group's paths". When nothing is
  staged (the index equals HEAD), the takeover neither resets nor gives the reset notice;
  the `unstaged` notice is still reported. Seam 1 case: group 1 committed, kill in phase (a)
  of group 2, take over → no reset notice.
- **Amended.** By spec pass 9 (2026-09-27):
  - Takeover order. Supersedes "on a match it deletes that run's folder and the renamed
    file, then links its own lock into place" above and the pass-6 amendment's "after
    `acquire` succeeds": the repair needs the killed group's paths, `preStaged`,
    `indexOnly` and `indexReset`, which live in the taken-over run's `state.json`, so the
    folder must outlive the repair. A takeover (automatic or `--take-over`) runs in three
    steps: `acquire` moves the lock (rename, verify, link its own lock) and reads those
    facts and the current group's status without deleting anything; `plan` runs the index
    repair; then the taken-over run's folder and the renamed lock file are deleted.
  - A kill during the repair leaves the taken-over run's folder, its `indexReset` evidence
    and the renamed lock file (which names that run) for the next takeover: the killed
    takeover's own folder has no `state.json` yet, so the next takeover reads the facts from
    the run the renamed file names, following such files back to the first folder with a
    `state.json`, and deletes every folder on that chain after the repair.
  - Where the automatic takeover runs: at `plan`'s step 3, where the read-only `peek` finds
    the stale lock; step 7's lock-take is the path with no takeover. From a step-3 takeover
    on, the run holds the lock, so every later outcome that takes no lock on the path with
    no takeover (a clean tree, `modeChoice`, `staged-empty`, `staged-hit`, `signing`,
    `killed-leftover`, `git-failed`, `timeout`, …) releases it and deletes the folder. Q9's
    lock table ("none" for those outcomes) means no lock is left.
  - `killedLeftover` in a run without a user: see Q17's pass-9 amendment (`--no-user`
    refuses with `killed-leftover`; `--reword` goes on with a notice).
- **Amended.** By spec pass 10 (2026-09-27): the takeover's notices (the takeover notice
  naming the stale run's `planId`, the reset notice, the `unstaged` report, the
  `killedLeftover` paths) are kept from `plan`'s step 3 on and go into the reply of every
  output `plan` ends with, whatever step it ends at, not only into the notices stored at
  step 8. Since pass 9 a step-3 takeover can end at steps 4-7 (a clean tree, `modeChoice`,
  `staged-empty`, `staged-hit`, `signing`, `head-moved`, `index-changed`, …), after
  `finishTakeover` has deleted the taken-over run's folder, so without this the user never
  learned that a run was taken over or its staging reset. Seam 1 cases: an automatic stale
  takeover on a clean tree → "nothing to commit" with the takeover notice; a reset plus a
  mixed index → `modeChoice` with the takeover, reset and `unstaged` notices.
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
  ordinary Q18 failure. Lock staleness on a network filesystem compares the file server's
  mtime with the local clock, so clock skew shifts the 15-minute limit (accepted). A
  concurrent-runs stress test is deferred past 0.1.0; 0.1.0 covers the races with targeted
  tests.

## Q23 Guard heartbeat

- **Context.** Without Node on the hook's PATH, with plugin hooks disabled or with
  `disableAllHooks` set, the guard does not run and nothing says so (Q1).
- **Decision.**
  - `plan` itself runs through the Bash or PowerShell tool, so the guard's `PreToolUse` fires
    for it. When a segment of the tokenised command is a script call to `plan` (`node` or
    `node.exe`, then a token whose basename is `commit.js`, then `plan`, after quote
    removal; [contracts](contracts.md#guard)), the guard writes
    `commit-guard/heartbeat.json` under the Claude home (`CLAUDE_CONFIG_DIR` when set, else
    `~/.claude` from `os.homedir()`; Q5) = `{ ts, cwd, command }`. `command` is stored
    redacted: the script-call form only (subcommand and flags), cut to 200 characters, so
    arguments a caller passed on the command line do not persist in the Claude home. The
    file is written to a temporary name carrying the pid and a random part and renamed into
    place, so `plan` never reads a partial one and parallel sessions never share a
    temporary name. The debug log (`COMMIT_GUARD_DEBUG=1`) holds the command in the same
    redacted form (for a `git commit` segment, its matched options only). The guard and
    `plan` resolve the Claude home the same way, so a relocated Claude home moves both
    ends. Not
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
- **Amended.** By spec pass 2 (2026-09-27): the heartbeat file moved under the Claude home
  (honouring `CLAUDE_CONFIG_DIR`); `command` is stored redacted, and the file is written to
  a temporary name and renamed into place.
- **Amended.** By spec pass 3 (2026-09-27): the heartbeat's temporary
  name carries the pid and a random part; the debug log holds the redacted command, never
  message text; the one global heartbeat with parallel sessions is an accepted gap.
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
  warning, never a false all-clear). The heartbeat is one file per Claude home: with
  parallel sessions or worktrees, another session's worker can overwrite it with its own
  `cwd`, so a run can report the guard `not-seen` although it is active. Keying it by repo
  would need a git call on the guard's hot path, where the guard knows only the hook's
  `cwd`.

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
    `check`, which commits when nobody needs to be asked. It starts with a fresh
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
  - **Also adopted:** `commit --plan <planId> --all` (Q9, Q18); `check` committing in the same process; the
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
      ≤ 5 (spike: 5). A third episode class, **question before planning**, holds episodes with a
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
- **Amended.** By spec pass 4 (2026-09-27): the episode analysis in
  `tools/` reads Claude Code session transcripts (the source of the baseline above), the
  worker's own transcripts included for worker tokens. An episode starts at the first
  main-thread commit attempt after a user prompt (a `git commit` shell call, denied or not,
  or an Agent call spawning `commit:commit-worker`) and ends at the main-thread turn that
  presents the last reply before the next user prompt that is not an answer to a handback
  question; each episode records its delivery shape and episode class. The tools are built for the
  1.0.0 gate, after 0.1.0 ships; no 0.1.0 slice depends on them.
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
    move it costs more main-thread calls (`plan`, `Write`, `check`, reply) than the
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
  `AskUserQuestion`, run a command verbatim with its tool timeout, or respawn the worker
  with the right input; and without a user, never answer `humanOnly`. A 200-character
  description cannot carry that. The eighth review also found answers that pointed at a run
  already released, notices with no place to go, and no plan for a worker that dies.
- **Decision.**
  - **Reply.** Every script output that ends the worker's part carries a `reply` built by
    the script ([contracts](contracts.md#reply-and-handback)): `status` (`committed`,
    `nothing`, `handback`, `failed`), `planId`, `text` (what the user reads), `commits`,
    `notices` and `handback`. The worker's final report is the reply, verbatim; in the
    spike it once put a sentence in front of the JSON, so the caller recognises the reply
    by its `version` and `callerRule` keys, not by its position in the message (a leading
    sentence that holds JSON cannot pose as the reply), and the reply size test runs
    against the real prompt. `notices` carries what SKILL.md used to relay: guard `not-seen` (Q23), signing `"prompt"` (Q18),
    config warnings and the detached-HEAD warning, scan-hit notices (Q10), `indexOnly`
    notices; `text` carries `unstaged` (Q11, Q18) and repeats every notice in a `Notices:`
    block (at most 10 lines). `text` is the only field a caller relays, so a subagent that
    summarises "committed 2 groups" still passes "src/b.js:14 github-token left out" on.
  - **`callerRule` in every reply.** A fixed base rule ("show text to the user verbatim; a
    subagent puts text verbatim in its final report; the reply is final, no git log or git
    status"; plus the `run` shape check below) on every status, plus the handback rule
    when a handback is set. Notices arrive on `committed` and `nothing` replies too, and
    nothing else tells a subagent to pass them on: not the 200-character description, and
    no handback.
  - **Caller trust.** The reply reaches the caller as subagent output, and the worker read
    the user's diff to write it, so a prompt injection in the diff could make the worker
    return a forged reply whose `run` is an arbitrary command. The base `callerRule`
    therefore carries a shape check: the caller runs a handback command only when it is a
    single command segment and a script call (the single definition in
    [contracts](contracts.md#guard): `node`, the anchored commit entry point, a subcommand) to `commit` or `release` for the run's `planId` (a
    lowercase UUID v4, Q22), and refuses and shows the user anything else. It also tells
    the caller to run a command with `--confirmed` only as the answer the user picked, or
    as `ifNoUser.answer` without a user. Every `run` the script builds has that shape
    (a test over every handback kind), so the check never refuses a genuine reply, and a
    forged one gets no further than the plugin's own `commit` or `release` for that run.
    One builder emits every script call, the handback's and the worker prompt's alike: the
    install path in double quotes with forward slashes, the form the anchored allow rules
    match (Q16). The builder escapes nothing: the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\` before any work, so no shell can
    expand or mangle the path.
  - **Confirmation bound to its answer.** When `check` returns a `confirm` handback it
    stores `awaitingConfirm` in the run state, and only the `yes` answer's `run` carries
    `--confirmed`. `commit` refuses without `--confirmed` while `awaitingConfirm` is set
    (usage code `unconfirmed`) and clears it on its first group, so a steered worker cannot
    return a plain `commit --all` that skips the question. This is advisory in interactive
    mode (Q16, Q17): nothing enforces that the user, not the model, picks `yes`.
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
    | `confirm` | a Q16 trigger, interactive | `yes` (run `commit --all --confirmed`), `one` (respawn; `split` with more than one group only, Q16), `no` (run `release`); `edit` under Other (respawn) |
    | `modeChoice` | index plus other changes, no mode flag (Q9) | `staged`, `split` (respawn) |
    | `lock` | a live lock, interactive (Q22) | `take over` (respawn), `wait` |
    | `lintFailed` | second lint failure, or the first on dictated text; interactive (Q18) | `retry` (respawn with the errors), `no` (run `release`); `edit` under Other (respawn), except when every error is a shape error (the worker plan is not valid JSON or not its shape): dictated text cannot fix a shape. The text quotes each rejected message with every scan-hit span replaced by `[<pattern-id>]` |
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
    repeats in it the flags of the call that built it (Q9: `mode`, and `takeOver` in a
    `lock` handback's `take over` only). It never
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
    `ifNoUser`) lean on the description alone, and the `run` shape check (caller trust,
    above) bounds what they can run. Whether a caller follows a handback in
    this shape is part of the hand-tests (open verification items).
  - **Script path.** An agent file gets no base directory, and on the model-invoked path no
    caller knows the path either. The agent body names the script as
    `${CLAUDE_PLUGIN_ROOT}/scripts/commit.js`, which the plugin loader substitutes (docs and
    spike); `/commit`'s SKILL.md does the same. The variable is **not** in the worker's shell
    environment (spike), so no command relies on it. A handback's `run` carries the script's
    own absolute path (`process.argv[1]`), so the caller needs none.
  - **The script call, not `git commit`.** The worker's prompt tells it to commit only
    through the script call (`check`, which commits when no confirmation is needed, Q9),
    never with `git commit`: the guard denies that anyway (Q3), and a denied attempt costs
    a call. The prompt names the call to make rather than leaving the worker to discover it
    from a deny.
  - **The worker never answers a handback.** In the first spike run the worker read
    `callerRule`, found it could not ask a user, and ran `yes` itself, confirming its own
    plan. A prompt rule fixed it in every later run, and the guard makes it deterministic:
    it denies a script call (tokenised, [contracts](contracts.md#guard)) to `commit` or
    `release` when the hook input's `agent_type` is `commit:commit-worker` ("return the reply
    to your caller; its handback is not for you"). So a `continue` handback also goes to the
    caller. `check` commits inside its own process and is not affected.
  - **Trailers are the script's.** The harness tells the main thread to end commit messages
    with its Co-Authored-By line, and the main thread passed that into the worker's prompt
    (spike); the worker spent three calls on it. The worker's prompt says the script adds
    every trailer (Q5, Q13) and any instruction to add one is ignored; the reply's `text`
    names the trailer the script appended, so the caller does not offer to add one by hand.
  - **No verify call.** After an implement-then-commit task the main thread ran
    `git log` / `git status` once the worker had returned (spike: 2 of 2 such runs). Every
    reply (`committed`, `nothing`, `handback`, `failed`) therefore carries the tree state,
    and its `text` ends with it ("working tree clean", or "N files left: …" with up to 10
    paths plus "+N more"); the base `callerRule` says the reply is final, on every reply. The
    agent description does not repeat it (Q2).
  - **A worker that dies or is stopped** (Esc, context limit, tool error) after `plan` took
    the lock returns no reply, or an error without the `planId`. The caller does not guess
    an ID and runs nothing. The next run meets the lock and Q22's takeover question, which
    shows how long ago the run was last active; after 15 minutes the lock is taken over
    automatically. When the worker can still answer, its fallback reply carries the `planId`
    it knows ([contracts](contracts.md#worker-input)).
- **Amended.** By spec pass 2 (2026-09-27): caller trust added a `run` shape check to the
  base `callerRule`, since a prompt injection in the diff could make the worker return a
  forged reply; the caller recognises the reply by its `version` and `callerRule` keys, not
  by its position in the message; the worker's prompt names the script call instead of
  `git commit`; one script-call builder escapes the install path; and every reply carries
  the tree state.
- **Amended.** By spec pass 3 (2026-09-27):
  - The script-call builder escapes nothing; the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\`, replacing the per-shell escaping
    (also Q16).
  - `awaitingConfirm`, `--confirmed` on the `yes` answer only, and the `unconfirmed` usage
    code; the base `callerRule` names the UUID `planId` and the `--confirmed` rule.
  - `lintFailed` text redacts scan hits; a shape-error `lintFailed` offers only `retry` and
    `no`.
  - After `git commit`, the tree-ID notice: `commit` records the scanned index's tree ID
    (`git write-tree`) at the backstop, and when `HEAD^{tree}` differs after the commit, a
    notice names the group ("committed tree differs from the scanned index"); the change is
    noticed, never undone.
  - Moving the caller protocol into trusted, skill-like text, if callers do not follow
    `callerRule`, is deferred past 0.1.0 (see [Non-goals](#non-goals)).
- **Amended.** By spec pass 5 (2026-09-27): `timeoutMs` is 600000 for `commit` and 60000 for
  `release` or otherwise, since `release` never waits on a git call; the caller passes it as
  the tool timeout. `busy` (another call's `call.lock` already held) is an immediate
  refusal, never a wait. Accepted gap: `--confirmed` stops a steered (prompt-injected)
  worker from returning the confirmed command itself, but such a worker can still
  misdescribe the plan in its own reply `text`, even though the `run` shape check bounds
  what it can actually execute.
- **Amended.** By spec pass 6 (2026-09-27): handbacks work only from a marketplace install,
  because the caller's `run`-shape check requires the script path to be inside the Claude
  plugin cache (contracts.md already states this rule); with `--plugin-dir` the caller cannot
  get a matching path, so it shows the command to the user instead of running it — an
  accepted gap (recorded in spec.md's Out of Scope, not this decision). The already-resolved
  spikes (Agent frontmatter, Nested spawn blocking, The commit worker, below) do not depend
  on this path check, so their results still hold even though they ran under
  `--plugin-dir`.
- **Amended.** By spec pass 7 (2026-09-27): the `release` reply keeps `treeState` (Q25's own
  rule that every reply carries the tree state), paired with the 60 s `release` timeout
  (pass 5): its status read (M10) gets its own 45 s budget, below that 60 s ceiling. When the
  budget runs out the reply omits `treeState`; the release itself has already completed by
  then, so only the reply's completeness is affected, not the outcome.
- **Amended.** By spec pass 9 (2026-09-27):
  - Output that is not JSON. When a worker's script call prints output that is not JSON,
    the fallback reply's `text` quotes it with the escaping and the 2000-character cap of
    relayed git or hook output. The handback rule gains the clause "if it holds no reply,
    show it and run nothing more" for a `run` whose output holds no reply (the rule was
    silent, and only the worker prompt had a non-JSON rule); the lock is left to Q22's
    takeover question, as after a dead worker.
  - Accepted gap: a steered worker can forge a `confirm` reply whose `ifNoUser.answer`
    picks `yes` (`commit --all --confirmed`) on a `humanOnly` confirmation. A caller without
    a user that spawned the worker without `interactive: false` runs it, because
    `callerRule` travels inside the reply, and `commit` accepts it while `awaitingConfirm`
    is set. Mitigation: spawn with `interactive: false` when no user can answer, so `check`
    hands a `humanOnly` run back and releases it. Refusing `--confirmed` on a `humanOnly`
    run without a user, or allowing it only on a picked `yes`, was considered; the gap is
    documented instead (spec.md Out of Scope).
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
  - The caller taking the first JSON object in the worker's message as the reply (the
    design before spec pass 2): a leading sentence that holds JSON would pose as it.
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

Deferred past 0.1.0 (roadmap; 0.1.0 is designed without them, spec Out of Scope):

- The 1.0.0 gate: 30+ dogfood episodes and the Haiku-vs-Sonnet eval (Q12, Q24).
- The caller-trust eval fixture set, which the manual hand-test stands in for in 0.1.0 (Q17).
- The scanned amend mode and the object form of `scanIgnore` (Q4, Q10).
- A per-group temporary index (Q11).
- A home-based run folder under the Claude home; 0.1.0 keeps `<toplevel>/.commit-plan/`
  (Q9).
- A tamper digest for run state; 0.1.0 checks only the state `version` (Q16).
- Reading the managed settings drop-in directory; 0.1.0 reads `managed-settings.json` only
  (Q5).
- Classifying openpgp pinentry programs (`gpg` / `gpgconf` probes) at `plan` (Q18).
- `module.enableCompileCache` for the guard's cold start (Q13), and a concurrent-runs stress
  test (Q22).
- Moving the caller protocol into trusted, skill-like text if callers do not follow
  `callerRule` (Q25).

## Public surface

Hard to change once released; changes need a major version or a migration path:

- Config paths `commit.json` in the Claude home (`CLAUDE_CONFIG_DIR` when set, else
  `~/.claude`) and `.claude/commit.json`, the key names, their layers and values (Q6).
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
- The guard's cold-start time (Q13, story 22): measure the exec-form hook's cold start on
  all three OSes and set the target before the guard slice claims it.
- The `openpgp` signing probe (Q18): **deferred past 0.1.0** with the pinentry
  classification (see [Non-goals](#non-goals)); no spike before 0.1.0. 0.1.0 notes that
  openpgp signing is enabled (`"prompt"`), checked by a manual hand-test of the note.
- The heartbeat under the sandbox (Q23): that a sandboxed Bash command can read
  `commit-guard/heartbeat.json` under the Claude home (Q5) on macOS (Seatbelt) and Linux
  (bubblewrap). If not, the spike picks another location both sides reach. Spike together
  with the `if` condition one.
- The shell tokenizer (Q3): a spike runs the hand-written tokenizer design against
  heredocs, `$(...)`, backticks, `bash -c '…'`, reordered flags, PowerShell here-strings
  and unterminated quotes, plus escaped newlines (Bash `\` plus newline, PowerShell
  backtick plus newline) and subshells such as `( git commit )`. Case variants of the
  command name are decided (the `git` basename compared case-insensitively, the early-exit
  `commit` substring case-insensitive, spec pass 7; the subcommand case-insensitive, spec
  pass 8), and so are subshells (`(` and `)` as tokens) and heredoc bodies (dropped), spec
  pass 8 (Q3); the spike only confirms them. Safety comes from failing closed
  on unrecognised options; fragility it finds is answered with a wider fail-closed rule or a
  documented false positive. Spike before the tokenizer slice.
- Exec-form hooks (Q3, Q13): the guard is registered in exec form (`node` as the command,
  the guard entry point as the only argument), so no shell quotes the plugin path. Which
  minimum Claude Code version supports exec-form hooks in a plugin's `hooks.json`. Before
  the guard slice.
- To revisit, not a spike: vendoring unbash (ISC), a Bash tokenizer, for the Bash side of
  the guard. It is Bash-only, and vendoring would need a Q1 amendment (nothing vendored);
  it is reconsidered only if the tokenizer spike shows the hand-written tokenizer is
  fragile.
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
  requirement next to Node (Q1) instead. The home-based run folder check is **dropped**:
  `<toplevel>/.commit-plan/` is settled for 0.1.0 and the home-based folder is deferred
  (Q9, [Non-goals](#non-goals)). Before the slice in which the worker runs the script.
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
- How Claude Code ends a Bash/PowerShell tool call (Esc, timeout) on Linux, macOS and
  Windows: whether it sends a process-group `SIGTERM`, a `SIGKILL`, or a Windows tree kill,
  and whether a detached child (the spawned git or hook process; Q9's kill handling, Q18's
  `SIGINT`/`SIGTERM`/`SIGHUP` handler) survives that termination.
- Filtered files (Q11): with `git-lfs` installed, that `git diff` shows an LFS-tracked
  change as a pointer diff, that `git add` of the whole file stores the object under
  `.git/lfs/objects`, and that the staged diff then matches the planned hash; on git 2.34
  and the current release. The test suite covers the mechanism with a `sed` clean filter;
  this spike covers LFS itself. Spike before the slice that stages a filtered or LFS file.
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
  it does not, the description's clause is strengthened; moving the protocol into
  SKILL.md-like trusted text is deferred past 0.1.0 (see [Non-goals](#non-goals)). Before
  the reply slice is released. This spike must run from a marketplace install (a local
  marketplace is fine), not `--plugin-dir`: the handback commands it exercises depend on the
  caller's `run`-shape check, which requires the script path to be inside the plugin cache
  (Q25 pass 6).
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
