# Q22 Concurrent runs

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
    its private copy as an orphan renamed lock for the next `acquire` to adopt (RUN-20b
    orphan pass, [contracts](../contracts/run-folder.md)), reads the lock now in place and
    refuses with `lock` (`held`) naming that new holder; the moved run is refused at its
    next step with `taken-over`. That refusal does not end the run, so its folder stays
    until adoption or `plan`'s 24-hour sweep deletes it; accepted (review-RUN-02 finding 1:
    adoption, not the sweep, owns a put-back's orphaned private copy — the sweep never
    deletes a renamed lock file).
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
  a hard-link probe (a fresh empty `<planId>/hardlink-probe.tmp` hard-linked as
  `<planId>/hardlink-probe.link`) also fails; a persisting `EPERM`/`EBUSY` whose probe
  succeeds, or whose probe link already exists (`EEXIST`), is `lock` (`busy`) instead, since another
  process genuinely holds the link. `ENOTSUP` and `ENOSYS` are `run-folder` at once, without
  a probe; `EEXIST` stays the normal held-lock handling.
- **Amended.** By spec pass 6 (2026-09-27): supersedes the pass-2 amendment's "reports that
  run's `unstaged` paths" for the case where the leftover staging is exactly the killed
  group's own paths (now reset instead of just reported). After `acquire` succeeds in a
  takeover (automatic or `--take-over`) and before the new run's own inventory/mode-decision
  step runs, when the killed run's state has `indexReset` set and its current group was not
  committed: compare the index with HEAD.
  - If every staged path belongs to the killed group's paths (defined once in
    [contracts](../contracts/run-folder.md): the current group's unit paths from the stored
    validated groups, both halves of a rename included, ∪ the stored `preStaged` ∪ the
    stored `indexOnly`) → run `git reset -q -- .` (the pathspec form writes no ref, Q11), and the takeover notice says the killed
    group's partial staging was reset (replacing, for this case, the old "reports
    `unstaged`" behaviour).
  - Otherwise (the user staged something else after the kill) → leave the index untouched;
    never auto-commit it in `staged` mode; ask via the existing `modeChoice` handback, whose
    notice additionally names the killed group's paths still staged.
  - Seam 1 cases: kill during phase (c) then take over → index reset, the new run's inventory
    sees a clean index; kill, then the user stages another file, then take over → no reset,
    `modeChoice` asked instead. Cross-references Q18's pass-6 amendment and
    [contracts](../contracts/plan.md).
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
- **Amended.** By the RUN-20 decision pass (2026-09-29), settling KD-S10: step 7's re-read
  of HEAD and the index fingerprint runs on both paths, the one with no takeover (after
  step 7's `acquire`) and after a step-3 takeover (no `acquire` at step 7, the lock already
  held), and it compares against what step 4's inventory recorded. So the window it
  guards is "since the inventory", not "between the inventory and taking the lock": after
  a takeover the lock is taken before the inventory. The contracts and M18 say "since the
  inventory"; after a takeover a `head-moved` or `index-changed` there carries the
  takeover's notices like every other ending (pass 10). A `modeChoice` answer under the
  forced `modeChoice` of pass 6 replaces the refused call's mode flag (Q9 as amended by
  the same pass).
- **Amended.** By the RUN-20b decision pass (2026-09-29), settling KD-S1 to KD-S5 and KD-S8
  ([contracts](../contracts/run-folder.md) takeover paragraph):
  - Orphan renamed locks (KD-S4). A kill between the rename and the link leaves
    `lock.<planId>` with no `lock` in place, and the next `peek` took the path with no
    takeover, so the repair never ran and a `--staged` run could commit the killed group's
    partial staging. An orphan is a `lock.<planId>` file not on the acquirer's own chain.
    `peek` reports no lock plus an orphan like a stale lock: at step 3 `acquire` links its
    own lock (nothing to rename) and adopts it. Every `acquire`, after its link succeeds,
    adopts each orphan: it walks the chain (the file's content names run X; X's folder with
    a `state.json` gives the facts, one without follows `lock.X`, a missing one ends the
    chain with no facts), the repair runs, then `finishTakeover` deletes the chain, the
    renaming runs' provisional folders included. A step-7 `acquire` whose adopted chain
    needs the repair does not repair after the inventory: it leaves the chain, releases its
    own lock and folder and refuses `index-changed`; the next `plan` adopts at step 3. A
    takeover whose rename succeeded but whose link fails with `EEXIST` deletes nothing of
    the takeover and refuses `held`: the holder in place linked after the rename, so it
    adopts the renamed lock. Supersedes "keeps its private copy for the sweep" and "its
    folder stays until `plan`'s 24-hour sweep" in the body and "keeps the private copy" in
    the pass-4 amendment: the put-back copy is an orphan the new holder adopts. The sweep
    never deletes a renamed lock file or a folder on its chain.
  - Deletion order (KD-S5). `finishTakeover` deletes every chain folder first, then every
    renamed lock file; a kill in between leaves renamed locks whose chain ends at a missing
    folder, which the next adopter counts as done (no facts, no repair) and deletes. The
    reverse order could leave a folder with `indexReset` and no renamed lock leading to it,
    forgetting a pending `killedLeftover`.
  - A failed repair (KD-S2). When the repair's `git reset -q -- .` fails, `finishTakeover` does
    not run: the chain (the taken-over folder and the renamed lock) is kept as evidence and
    becomes an orphan for the next `plan`; the run releases its own lock and deletes its own
    folder. A foreign `index.lock` → `index-lock` (domain code `index-locked`), the
    540-second deadline → `timeout`, any other git error → `git-failed`; the reply carries
    the notices so far plus "the takeover's index repair failed (<cause>); the next /commit
    retries it". Deleting the evidence would lose the killed group's staging for good;
    keeping the run's own lock would block every later run for 15 minutes.
  - A lock or run already gone (KD-S3). Supersedes "the others get `ENOENT` and retry the
    link, which then refuses them with `lock`" in the body: a rename that fails with
    `ENOENT` re-peeks once. A lock in place → `lock` (`held`) with a fresh handback naming
    it. No lock → the automatic takeover adopts the winner's renamed lock (the winner, if
    alive, then meets `EEXIST` and refuses `held`), while `--take-over <planId>` refuses
    `ended` ("that run has already ended; run /commit again"): the handback was answered
    after the named run ended on its own. The same `ended` replaces `taken-over` for an
    `ENOENT` on the named run's `call.lock` (its folder is gone): the renamed lock is
    deleted (its chain ends at a missing folder); the named run's `call.lock` is taken
    before the run links its own lock, so nothing of its own exists yet to release. `taken-over` was false there, since nobody took that run over. Q9's rationale is
    corrected to match.
  - The run-integrity case of pass 10, "a reset plus a mixed index → `modeChoice` with the
    takeover, reset and `unstaged` notices" (KD-S1), cannot be built: the repair is
    `git reset -q -- .`, which leaves the index equal to HEAD, so a reset never leaves a mixed
    index. Replaced by two cases: an automatic stale takeover with `killedLeftover` in an
    interactive run → the forced `modeChoice` carrying the takeover, `killedLeftover` and
    `unstaged` notices; a reset under `--take-over <planId> --staged` → `staged-empty`
    carrying the reset notice.
  - Documentation sync (KD-S8), deciding nothing new: the reply's `notices` definitions in
    the contracts ([reply and handback](../contracts/reply-and-handback.md),
    [run folder](../contracts/run-folder.md)) now name the step-3 takeover notices pass 10
    already keeps, also when `plan` ends before step 8 stores them.
- **Rejected.**
  - Documenting the risk only: the damage (a reset index mid-run) is silent.
  - The kill between the rename and the link as an accepted gap (RUN-20b decision pass):
    the next run would take the path with no takeover, skip the repair, and a `--staged`
    run could commit the killed group's partial staging unasked.
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
