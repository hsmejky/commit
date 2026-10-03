# Open verification items

- Whether a hook `if` condition matches when **any** subcommand of a compound command matches
  (`cd x && git commit`, `& git commit`). The docs say compound commands are split on `&&`,
  `||`, `;`, `|`, `&` and newlines, but not how `if` combines the parts. Decides between Q13's
  two variants. Planned as a spike before the guard slice, together with the `node
  *commit.cjs*` entries for the heartbeat (Q23).
- The guard's cold-start time (Q13, story 22): measure the exec-form hook's cold start on
  all three OSes and set the target before the guard slice claims it.
- The `openpgp` signing probe (Q18): **deferred past 0.1.0** with the pinentry
  classification (see [Non-goals](non-goals.md)); no spike before 0.1.0. 0.1.0 notes that
  openpgp signing is enabled (`"prompt"`), checked by a manual hand-test of the note.
- The heartbeat under the sandbox (Q23): that a sandboxed Bash command can read
  `commit-guard/heartbeat.json` under the Claude home (Q5) on macOS (Seatbelt) and Linux
  (bubblewrap). If not, the spike picks another location both sides reach. Spike together
  with the `if` condition one.
  - Linux (bubblewrap) result: confirmed — a sandboxed Bash command reads the heartbeat
    under the default Claude home and under `CLAUDE_CONFIG_DIR`, but the Claude home is
    mounted read-only inside the sandbox, so it can neither write nor forge the file.
  - macOS (Seatbelt) result: confirmed on macos-latest (macOS 26.6.2, Claude Code
    2.1.288) — a sandboxed Bash command reads the heartbeat under the default Claude home
    and under `CLAUDE_CONFIG_DIR`; writes there fail with `Operation not permitted`, as do
    writes under `$HOME`, while writes inside the project succeed. No relocation needed.
- The shell tokenizer (Q3): a spike runs the hand-written tokenizer design against
  heredocs, `$(...)`, backticks, `bash -c '…'`, reordered flags, PowerShell here-strings
  and unterminated quotes, plus escaped newlines (Bash `\` plus newline, PowerShell
  backtick plus newline) and subshells such as `( git commit )`. Case variants of the
  command name are decided (the `git` basename compared case-insensitively, the early-exit
  `commit` substring case-insensitive, spec pass 7; the subcommand case-insensitive, spec
  pass 8), and so are subshells (`(` and `)` as tokens) and heredocs (blanket-denied,
  round 8) (Q3); the spike only confirms them. Safety comes from failing closed
  on unrecognised options; fragility it finds is answered with a wider fail-closed rule or a
  documented false positive. Spike before the tokenizer slice.
  **Run** on 2026-09-29 (PRE-03; throwaway prototype of C:guard "Parsing" plus a G1/G3-lite
  classifier, not kept; bash 5.3, Windows PowerShell 5.1 and PowerShell 7.6 parser API).
  The 143 cases, with the prototype's segments, decision and per-oracle class, are the
  GRD-03 fixture seed: `tests/fixtures/guard/segments-seed.json`, which the amendment's
  review rounds grew by hand to 254 cases (its schema and oracle classes are checked by
  `tests/guard-segments-seed.test.js`). Confirmed: the `git`
  basename, the `commit` substring and the subcommand case-insensitively (`GIT`,
  `Git.exe`, `/usr/bin/GIT`, `git COMMIT`, `git-COMMIT.exe`); `(` and `)` as tokens
  (`( git commit )` and `(git commit -m x)` denied, `(git commit --no-edit)` allowed, in
  both shells); heredoc bodies dropped (quoted and unquoted delimiters, `<<-`, two heredocs
  on one line, unterminated body, a heredoc inside `"$(…)"` whose body holds `)`); escaped
  newlines, unterminated quotes and here-strings, redirections, reordered global options.
  The 5.1 and 7 parsers agree on every case but the PowerShell 7 `` `u{…} `` escape, which
  5.1 lacks (`p-nul-u00`); at run time 5.1 and 7 also bind a comma-joined argument
  differently (round 5 below). Oracle differences outside the listed skip
  classes: backtick substitution, brace expansion and globs (Bash expansions like `$`),
  PowerShell assignment and keyword statements, `--%`, a backtick plus newline inside a
  word (PowerShell keeps the newline), and a carriage return (the Cygwin bash used strips
  it). **Settled in Q3 (PRE-03 amendment):**
  - F1: a Bash subcommand holding a backtick (`` git `echo commit` -m x ``) is not denied.
  - F2: Bash `$'…'` quoting is not read, so `echo $'\'' ; git commit -m x` swallows the rest
    of the line as an unterminated quote and is not denied.
  - F3: PowerShell script blocks glue `{` to `git` (`&{git commit -m x}`,
    `if ($true) {git commit -m x}`), so they are not denied.
  - F4: Bash process substitution `diff <(git commit -m x) f` reads `git` as the `<`
    target, so it is not denied.
  - F5: comments are read as words: `git commit --no-edit # done` and `# git commit -m x`
    are denied (false positives, fail closed), in both shells.
  - F6: expansion in the command position (`{git,commit,-m,x}`, `/usr/bin/gi? commit`) is
    not denied, like the accepted `$(echo git) commit` gap.
  - F7: C:guard step 4's example `git $c -m x` exits early (no `commit` in the text); the
    `$` rule applies only in a command that mentions `commit` elsewhere, as story 15 and
    GRD-12 already say.

  **Settled by the review rounds of the amendment (Q3):**
  - PowerShell NUL escapes (`` `0 ``, a zero `` `u{…} ``) cut the native command line: a
    `cut` token ends git's arguments, and every `git` token of a segment is classified.
  - Brackets: a `(` or PowerShell `{` token among git's arguments is denied (grouping
    expressions, `@(…)` arrays and script blocks become several arguments).
  - Round 5, restated as one rule, git's arguments must be literal (C:guard step 4):
    Windows PowerShell 5.1 comma arrays (`git -C . ,commit -m x`), `--%` stop-parsing
    (`git --% -c x.y=; commit -m x`, and a here-string opener after `--%` hiding the next
    line), and `$(…)`, `@s` or an array variable in a value (`--fixup @s`) are denied; and
    command substitution bodies are classified as segments of their own
    (`echo $(git commit -m x)`).
  - Round 8 (user decision after round 7): a blanket fail-closed rule replaced the heredoc,
    here-string, comment, Bash typographic-quote and substitution-body handling: a command
    that mentions `commit` and holds `$(`, `${`, `#`, a Bash backtick, heredoc `<<` or
    typographic quote, or a PowerShell `@(` or here-string opener, is denied untokenized
    (C:guard step 2). Such seed cases have no segments (oracle class `blanket`); the heredoc
    and here-string confirmations above describe the superseded rules. Its review added
    the script-call exemption (a plain script call whose quoted path holds a trigger is
    tokenized), Bash extglob openers kept in their word, and pinned readings of `$"…"`,
    the escaped-newline pre-pass and PowerShell mixed quote pairs (seed `b-exempt-*`,
    `p-exempt-*`, `b-extglob-*`, `b-locale-quote`, `b-cont-*`, `p-mixed-*`).
  No finding needs a parser beyond the hand-written design: the fragility is PowerShell
  native-argument binding, which differs between 5.1 and 7 and which unbash (Bash only)
  does not cover (unbash not raised).
- Exec-form hooks (Q3, Q13): the guard is registered in exec form (`node` as the command,
  the guard entry point as the only argument), so no shell quotes the plugin path. Which
  minimum Claude Code version supports exec-form hooks in a plugin's `hooks.json`. Before
  the guard slice.
- To revisit, not a spike: vendoring unbash (ISC), a Bash tokenizer, for the Bash side of
  the guard. It is Bash-only, and vendoring would need a Q1 amendment (nothing vendored);
  it is reconsidered only if the tokenizer spike shows the hand-written tokenizer is
  fragile.
- Tool output limits (Q9, Q19): **resolved (spiked)**, Claude Code 2.1.284, 2026-09-29.
  Bash and PowerShell tools no longer silently cut output; past roughly 29-31 KB (noisy
  around 30 000 characters, not cleanly pinned to one byte value) they spill the full
  output to a file and return a `<persisted-output>` head preview (first ~2 KB) instead —
  nothing is discarded. `BASH_MAX_OUTPUT_LENGTH` set to 60 000 or 100 000 via a nested
  headless `claude -p` session did not raise this threshold (outputs of 31-78 KB still
  spilled), so the env var has no observed effect on the spill threshold in this version.
  The `Read` tool showed no per-line character cut up to at least 10 000 characters on one
  line; instead it enforces a whole-call token budget (~25 000 tokens, roughly 50 000
  characters) and errors ("exceeds maximum allowed tokens... use offset and limit") rather
  than truncating when a requested range is over it. A default call (no offset/limit) on a
  5000-line/~29 KB file returned the entire file, not capped at 2000 lines — the documented
  "2000 lines by default" did not act as a hard cap in this session; the real constraint is
  the token budget. Confirms the 20 000-character `plan --hunks` stdout budget (comfortably
  under both the ~30 KB tool spill and the ~25 000-token Read budget) and corrects Q19's
  "`Read` cuts lines over 2000 characters" (see Q19 amendment).
- The README allow rules (Q16): the commit-worker spike confirmed the cache layout
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and the quoted, anchored
  `Bash(node "…/*/scripts/commit.js" *)` rule (stub named `commit.js`; same rule with
  `commit.cjs`, Q15) with a `*` version segment, plus
  `Edit(**/.commit-plan/**)`, on Windows with the Bash tool. Still open: the `PowerShell(…)`
  rule, and macOS and Linux. Also the worker's shell (Q24): on a Windows setup without Git
  Bash, a worker with `tools: Bash, PowerShell, Read, Write` runs a whole run through the
  PowerShell tool with no prompt, and on a setup with both, listing both changes nothing.
  If a listed tool the session lacks breaks the agent, Git Bash becomes a documented
  requirement next to Node (Q1) instead. The home-based run folder check is **dropped**:
  `<toplevel>/.commit-plan/` is settled for 0.1.0 and the home-based folder is deferred
  (Q9, [Non-goals](non-goals.md)). Before the slice in which the worker runs the script.
- The project directory (Q5): which directory the harness reads `.claude/settings.json` and
  `.claude/settings.local.json` from when Claude runs in a subfolder of a repo (launch
  directory or git toplevel), and whether `CLAUDE_PROJECT_DIR` reaches the Bash and
  PowerShell tools' environment (the commit-worker spike: not in a subagent's Bash
  environment; the main thread's is unchecked). Spike before the attribution slice.
  **Resolved** on 2026-10-03 (PRE-11): launched in a repo subfolder with its own
  `.claude/settings.json`, only that subfolder's settings apply (no walk-up, no merge with
  the toplevel's); launched in a subfolder without `.claude/`, no project settings apply at
  all (no walk-up to the toplevel). `CLAUDE_PROJECT_DIR` is not set in the main thread's
  Bash or PowerShell tool environment, confirmed (checked interactively and in `claude -p`),
  matching the already-known subagent case. Decision: the project directory is
  `CLAUDE_PROJECT_DIR` when the script sees it, else the entry point's `process.cwd()`; no
  walk-up to a git toplevel. Q5 and M5 amended.
- The temporary index (Q11): that `git diff -M` against an index copy with `git add -N`
  entries shows each intent-to-add path as `A` with its content, and pairs a deleted path
  with an intent-to-add path as `R` (a plain `mv` and a `git mv` after step 1's reset), and
  that `git diff --cached --no-renames --diff-filter=A` lists a `git mv`'s new path and works
  on an unborn HEAD, on git 2.34 and the current release. Spike before the file-level
  slice. **Resolved** on 2026-09-29: git 2.54.0, Windows, local run
  (`tests/temporary-index.test.js`, PRE-09); and git 2.34.1, the CI `ubuntu:22.04` container
  min-git job (FND-03, run
  https://github.com/hsmejky/commit/actions/runs/36566328437, job 109399035878, all 10 legs
  green; `tests/temporary-index.test.js` ok 693-697). All three assumptions hold, on both git
  versions, with the exact pinned diff options and `-c` config pins: an intent-to-add path
  (untracked or already staged-new) diffs as `A` with its working-tree content; a plain `mv`
  and a `git mv`, each followed by step 1's reset and an intent-to-add of the new path, pair
  as `R100`; and the staged-new-path query lists only a `git mv`'s new path on a normal HEAD,
  and every staged path on an unborn HEAD. No Q11 amendment needed.
- How Claude Code ends a Bash/PowerShell tool call (Esc, timeout) on Linux, macOS and
  Windows: whether it sends a process-group `SIGTERM`, a `SIGKILL`, or a Windows tree kill,
  and whether a detached child (the spawned git or hook process; Q9's kill handling, Q18's
  `SIGINT`/`SIGTERM`/`SIGHUP` handler) survives that termination.
- Filtered files (Q11): with `git-lfs` installed, that `git diff` shows an LFS-tracked
  change as a pointer diff, that `git add` of the whole file stores the object under
  `.git/lfs/objects`, and that the staged diff then matches the planned hash; on git 2.34
  and the current release. The test suite covers the mechanism with a `sed` clean filter;
  this spike covers LFS itself. Spike before the slice that stages a filtered or LFS file.
  **Resolved** on 2026-09-29: git 2.54.0, git-lfs 3.7.1, Windows, local run
  (`tests/lfs-filtered-file.test.js`, PRE-10); and git 2.34.1 with git-lfs 3.0.2-1ubuntu0.3
  and `COMMIT_REQUIRE_LFS=1`, the CI `ubuntu:22.04` container min-git job (FND-03, run
  https://github.com/hsmejky/commit/actions/runs/36566328437, job 109399035878, all 10 legs
  green; `ok 223 - an LFS-tracked change diffs as a pointer, and staging it matches the
  pre-add diff and stores the object`). Both assumptions hold, on both git versions, run
  with the exact pinned diff options: `git diff` on a modified LFS-tracked file shows the
  pointer's `oid` and `size` lines changing, never the real bytes, because git runs the
  `clean` filter on the working-tree content before diffing it against the (already clean)
  index blob, the same mechanism Q11 already describes for the general filter-attribute
  case. `git add` of the whole file stores the object at
  `.git/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` keyed by the content's own sha256, and
  `git diff --cached` afterwards is byte-for-byte identical to the pre-add `git diff` (the
  bytes compared, not a decoded string), so the diff `plan` would hash before staging
  equals the one `commit` verifies after. No Q11 amendment needed.
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
  SKILL.md-like trusted text is deferred past 0.1.0 (see [Non-goals](non-goals.md)). Before
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
    *)` rule (stub named `commit.js`; same rule with `commit.cjs`, Q15) and
    `Edit(**/.commit-plan/**)`, a run asked nothing (Q16), headless and
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
