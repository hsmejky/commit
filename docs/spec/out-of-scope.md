# Out of Scope

Non-goals ([decisions](../decisions/non-goals.md)):
- Pushing and pull requests; setting up signing (the plugin only coexists with it).
- Repos that do not use Conventional Commits (use the opt-out).
- The commit that finishes a merge, rebase, cherry-pick or revert.
- Folding new changes into an existing commit (roadmap: a scanned amend mode).
- Rewording a merge commit; generating issue references; inferring monorepo scopes.
- Enforcing a message language (the worker follows recent history instead).

Accepted gaps (Q3, Q5, Q9, Q10, Q11, Q16, Q17, Q18, Q19, Q20, Q22, Q23, Q25). This is the one gap list:
every accepted gap named elsewhere in this spec is listed here; story 201, the README block
and the module sections point here, and the README states it in full.
- The guard is not a security boundary: every allowed form (`--no-edit`, `--amend
  --no-edit`, `--fixup=<commit>`) commits the current index unscanned, and aliases,
  interpreters and constructs that evaluate a string as code (`sh -c '…'`, `pwsh -c`,
  `eval`, Bash `${x@P}` and array-subscript evaluation, `Invoke-Expression`,
  `Start-Process`),
  and expansion in the command position (`$(echo git) commit`, `$GIT commit`,
  PowerShell `& $g commit` or `& ('git') commit`, Bash brace expansion or a glob such as
  `{git,commit,-m,x}` or `/usr/bin/gi? commit -m x`), `GIT_DIR`
  redirection and env-prefixed config pass it.
- A command whose text never spells `commit` (`git $(echo com)mit`, PowerShell
  `git ('com'+'mit')`) passes G1's early exit unparsed (Q3); `sudo -u git git commit` is
  not addressed. Brace expansion, a parenthesised or globbed subcommand, a backtick
  substitution in the subcommand position, typographic quotes and the dashed `git-commit`
  binary are denied (story 15).
- Other paths to a commit pass the guard (Q3): `git commit-tree`, `git am`, the replays of
  `git stash` and `git cherry-pick`, and shells provided by MCP servers.
- A `commit` split by an escaped newline (Bash `\` plus newline, PowerShell backtick plus
  newline) passes the guard (Q3): G1's early-exit check removes the `\` or backtick but
  keeps the newline, so the command exits early unparsed.
- False positives: a command that only mentions `git commit` in text, such as
  `echo git commit`, is denied, and so is a comment that mentions it
  (`git commit --no-edit # done`, `# git commit -m x`, PowerShell `<# … #>`), a git
  subcommand held in a variable (`git $x`) in a command that mentions `commit` anywhere,
  a quoted variable among git's arguments (`git -C "$dir" commit --no-edit`,
  `git commit --fixup "$sha"`), a `git` word after another PowerShell command's `--%`
  (`Write-Output --% git commit -m x`), and any git command with `$` in a global option
  value in a command that mentions `commit` anywhere (`git -C "$d" log | grep commit`),
  since git's arguments must be literal (C:guard step 4). The commit worker and the skills
  are unaffected: the worker runs only script calls.
- In interactive mode a `humanOnly` confirmation is advisory (Q16, Q17): the reply asks the
  caller to put it to the user, but nothing enforces that the user, not the model, answers
  it. `--confirmed` stops a steered worker from returning the confirmed command itself, but
  such a worker can still misdescribe the plan in its own reply text.
- A steered worker can forge a `confirm` reply whose `ifNoUser.answer` picks the `yes`
  answer (`commit --all --confirmed`) on a `humanOnly` confirmation (a file skipped for size, a
  `scanIgnore` change), and a caller without a user that spawned the worker without
  `interactive: false` runs it, because `callerRule` travels inside the reply; `commit`
  accepts it, since `awaitingConfirm` is set (Q25). Mitigation: a caller that no user can
  answer spawns the worker with `interactive: false`, so `check` hands a `humanOnly` run
  back and releases it instead of asking.
- `Edit(**/.commit-plan/**)` lets an agent rewrite any file in a run folder without a prompt
  (Q16), `state.json` included (for example clearing `awaitingConfirm`); a tamper digest is
  deferred past 0.1.0. The rule stays global (it must work across repos from user
  settings), and `**/.commit-plan/**` matches at any depth, so a project file such as
  `src/.commit-plan/x.js` is editable without a prompt too.
- A main interactive session in which the user denied or disallowed `AskUserQuestion`
  (`permissions.deny`, `--disallowedTools`) takes the subagent path (Q17).
- Settings passed on the command line (`claude --settings <file>`), MDM, registry and
  server-managed policy are invisible to the script (Q5), and so are the drop-in files of
  the managed settings directory (only `managed-settings.json` is read); attribution set
  only there is not applied.
- A locked openpgp signing key is not detected at `plan` (Q18): the plan notes that openpgp
  signing is enabled, and the commit fails, or times out, at `git commit`.
- `.git/config` and `.git/hooks` are trusted as git itself trusts them: an untrusted repo
  can run code through `core.fsmonitor`, `filter.*.clean`, `core.hooksPath` or
  `gpg.program` during any git call the plugin makes.
- Scan coverage (Q10): LFS content is not scanned (only its pointer); binaries and
  credential containers (keystores, `.p12` files) are not scanned, which matters most in
  headless runs where no user sees the file list; UTF-16 text counts as binary (its NUL
  bytes) and is not scanned; every scanned line is cut to
  its first 4096 characters before the regexes run (M8), so a secret past the cut is missed. Unprefixed secret
  formats (Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-proj-`, JWTs) have no pattern of
  their own in 0.1.0 (a roadmap item); they are caught only where `generic-secret` matches
  their key.
- Only added lines are scanned (Q10): a hunk that removes a hardcoded secret shows it in
  `hunks.txt`, and through it in the worker's model context and transcript; it never
  enters history through the plugin.
- The worker's rule never to `Read` a file with a scan hit, and to read a working-tree file
  only at a line range, is prompt-only (Q10, Q11; story 226): the script does not enforce
  it, so keeping a hit's content out of the worker's context depends on the worker
  following its prompt.
- A diff line over 2000 characters may be cut by `Read` (Q19).
- `scanIgnore` silences the scan for its paths, and it is read from the committed config, so
  whoever can commit `.claude/commit.json` can widen it (Q10). Only a pattern with no
  literal character is rejected (a `config` error); a broad but
  literal pattern such as `src/**` is legal.
- A path whose bytes are not UTF-8 is never planned (Q11); it is reported in `notIncluded`,
  each non-UTF-8 byte written as `\xNN`, for the user to commit by hand.
- An unstaged case-only rename on a case-insensitive filesystem is invisible to git and not
  planned (Q11, story 78).
- The index fingerprint (Q11, M10 `indexFingerprint`, checked by `plan` and `commit`) sees an intent-to-add entry
  and a staged empty file alike (both the empty blob), so a switch between the two is not
  refused as `index-changed`.
- `pushed` passes a commit that only a stale remote-tracking ref would show as pushed (pushed
  from another clone, not fetched) (Q20).
- Lock staleness on a network filesystem compares the file server's mtime with the local
  clock (Q22), so clock skew shifts the 15-minute limit.
- The heartbeat is one file per Claude home (Q23): with parallel sessions or worktrees,
  another session's worker can overwrite it with its own cwd, so a run can report the guard
  as not seen although it is active. Keying it by repo would need a git call on the guard's
  hot path, where the guard knows only the hook's cwd. For the same reason, a session
  without the guard reports it `active` from another session's fresh heartbeat; a guard
  disabled mid-session is noticed only once the heartbeat is 15 minutes old; and a command
  such as `cd ../other-repo && …` reports it `not-seen` for the repo the run is in.
- An edit to a path the run already knows (a stored candidate, staged-new, `indexOnly`, or
  tracked-directory path) between `plan` and `commit` ends the run with `diff-changed` (Q11,
  Q22): the snapshot hash matches those stored lists, not every file in the tree, so a new
  untracked file or a hidden path is left for the next run and `staged` mode checks only the
  index. Parallel implementers in one repo use worktrees (Q22).
- Manual git activity during a run is not locked (Q22): an `index.lock` present before
  `git commit` is refused as `index-lock`, and one created during it surfaces as an ordinary
  Q18 failure.
- Repo hooks (Q18, M16): after `git commit` returns, a changed tree is only noticed (story
  167), never undone, and a changed message is not checked; hook-rewrite detection covers
  only the diff left for later groups; a slow hook spends the call's 540 s budget, so later
  groups may need several `continue` round trips; a timeout kills the process tree, which
  can strand a hook's own stash. Hook output reaches `text` escaped and cut to its last 2000
  characters (story 163), but a hook can still print forged plain-text lines or echo a
  secret into the reply.
- Handbacks work only from a marketplace install (Q25 as amended): the caller's rule requires
  the script path to be under the plugin cache, so with `--plugin-dir` the caller shows the
  command instead of running it.
- The run folder lives in the working tree (Q9): `git clean -fdx` mid-run deletes it, file
  watchers and Docker build contexts see it, and cloud-synced folders may copy or lock it.
- A lock put-back that meets `EEXIST` (Q22) keeps its private copy until the 24-hour sweep.
- Claude Code versions older than the first one with exec-form plugin hooks are not
  supported (the minimum is pending the spike); the sandbox is covered only as far as the
  heartbeat spike reaches; PowerShell editions other than Windows PowerShell 5.1 and
  PowerShell 7+ (both tested in CI) are not supported.
- A hard kill of the script itself (`SIGKILL`, a Windows hard kill) runs no signal handler
  (Q9): a running `git commit` or hook can be left as an orphan and still land a commit
  after the call ended, and `call.lock` stays behind until it is found stale.

Also out: re-planning after a hook rewrites files mid-run; reading commitlint configs;
`body: "required"`; npm dependencies, vendored code and a full shell parser.

Deferred past 0.1.0 (roadmap; 0.1.0 is designed without them):
- The 1.0.0 gate: 30+ dogfood episodes, the episode-analysis tool in `tools/` (reads session transcripts and reports the
  [Dogfood gate](story-verification.md)'s measures per episode class and delivery shape),
  the Haiku-vs-Sonnet eval and the caller-trust eval fixture set, so that cost and quality
  are measured (Q12, Q17, Q24).
- The scanned amend mode and the object form of `scanIgnore`.
- A per-group temporary index.
- A home-based run folder under the Claude home; 0.1.0 keeps `<toplevel>/.commit-plan/`
  (Q9).
- A tamper digest for run state; 0.1.0 checks only the state `version`.
- Reading the managed settings drop-in directory (Q5).
- Classifying openpgp pinentry programs (`gpg`/`gpgconf` probes) at `plan` (Q18).
- `module.enableCompileCache` for the guard's cold start, and a concurrent-runs stress test.
- Moving the caller protocol into trusted, skill-like text if callers do not follow
  `callerRule` (it would revisit story 7 and the skill's 1.5 kB budget).
