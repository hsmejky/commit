# Q9 Script interface

- **Context.** Messages contain newlines, quotes, backticks and non-ASCII text; passing them as
  arguments breaks in PowerShell. The run happens inside the `commit-worker` agent (Q24); the
  main thread sees only the worker's reply and, when a human is needed, runs one
  script-built command (Q25).
- **Decision.** Subcommands of the shared script (shapes in [contracts](../contracts/README.md)). Every
  run keeps its files in one run folder, `<toplevel>/.commit-plan/<planId>/`
  ([contracts](../contracts/run-folder.md)): the state file, the hunk text, the temporary index
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
  command in a handback, is a single `node … commit.cjs …` call, so the README's allow rules
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
    dropped and the idea deferred past 0.1.0 (see [Non-goals](non-goals.md)).
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
    [contracts](../contracts/plan.md) step 7). `commit` makes the matching per-group check
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
    `node *commit.cjs*` allow rule matches, so it prompted on every run, and Windows
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
    home-based run folder deferred past it (see [Non-goals](non-goals.md)). The working-tree
    location is settled for 0.1.0. Its costs, weighed and
    accepted: `git clean -fdx` deletes a run mid-run (the next step refuses with "this run
    has already ended"); a file watcher that watches `json` (nodemon by default) restarts
    on the state-file writes (the README names `.commit-plan/` for watcher ignore lists);
    a Docker build context or a cloud-synced folder may pick up the folder during a run.
    A secret no longer sits in it: a unit with a pattern hit gets no body in `hunks.txt`
    (Q10), and the file it came from is in the working tree anyway.
  - The worker plan on `check`'s stdin through a Bash heredoc, to avoid the `Write`: the
    anchored `Bash(node "…/commit.cjs" *)` allow rule does not match a heredoc command, so it
    prompted (spike), and the PowerShell objection below still holds.
  - A paged hunk output (`plan --hunks --page n`): pagination bookkeeping in the LLM, and
    every string still escaped. A stdout cap in characters instead of lines: about 400 diff
    lines would fit, so most runs would go summary-only.
- **Consequences.** Nothing is committed through the plugin without passing lint and scan,
  even if the prompt's rules are ignored. Prompt rules only help get it right the first
  time. The diff and the worker plan never enter the main context. The CLI, its exit
  codes, its JSON, the handback and the run folder are internal (see
  [Public surface](public-surface.md)).
