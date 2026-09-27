# 09 Runs

M12 Run (the run-folder directory, run folders, the run lock, `call.lock`, typed run state,
sweep and takeover, including M18's takeover index repair) and M15 Run policy (mode, refusal
order, lint counter, confirmation, run end, deadlines). Every behaviour here is observable
only at Seam 1, so each slice adds its M12 or M15 call to the M18 step that uses it and
tests it through the subcommand. The path without a takeover (RUN-01 to RUN-19) does not
wait for the takeover open items; the takeover slices (RUN-21 to RUN-26) wait on RUN-20.
Main sources: M12, M15, M18 and the domain-code table, C:run-folder, C:commit-release,
C:cli-and-exit-codes, Q9, Q16-Q18, Q22, stories 187-196, 206-210, 217-227. RUN-20 also
settles who removes `call.lock` when a call exits. RUN-07 and RUN-13 build the policy; the
`lock` and `modeChoice` handbacks are built by INT-05 and INT-13.

## RUN-01: `release` ends a run and deletes its folder

**What to build:** the M12 tracer bullet through its thinnest public entry point. `release
--plan <planId>` reads the run lock. When the lock holds that `planId`, it removes the lock
and deletes the run folder. Otherwise it does nothing and exits 0. M12 `releaseById`, the
check that keeps every deletion inside the run-folder directory, and the M18 `release`
workflow with its reply. It uses the walking skeleton's thin tree-state read; CHG-04
completes it.

**Blocked by:** INT-01, RPL-02.

**Status:** ready-for-agent

**Sources:** Q22, C:commit-release (release), C:run-folder, M12, M18 `release`, stories 194, 206.

- [ ] Seam 1: a fixture writes a lock holding `planId` X (C:run-folder shape) and a folder
      `X/`. `release --plan X` exits 0 with `status: "nothing"`, and the lock and the
      folder are gone.
- [ ] Seam 1: the lock holds Y, or there is no lock. `release --plan X` exits 0 with the
      "nothing to release: the run has already ended or was taken over" text, and Y's lock
      and folder are unchanged.
- [ ] Seam 1: the reply's `text` ends with the tree state.
- [ ] Seam 1: a lock whose content names a traversal or absolute path instead of a minted
      `planId` deletes nothing outside `.commit-plan/`.


## RUN-02: `call.lock` guards `release` against a running call

**What to build:** the per-call `call.lock` (`{ pid, host }`, created exclusively),
exercised through `release`. When the lock matches, `release` takes the `call.lock`
before it deletes anything. A live `call.lock` refuses with `busy` and keeps the run. A
stale one is replaced through the atomic rename, verify and put-back.

**Blocked by:** RUN-01.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (`call.lock` row), architectural decisions (one call per run
at a time), M12, story 209.

- [ ] Seam 1: `X/call.lock` holds the test process's own pid on this host. `release --plan
      X` exits 6 `lock` (`busy`), and the lock and the folder are kept.
- [ ] Seam 1: the `call.lock` names a dead pid on this host. It is stale at once, and
      `release` succeeds.
- [ ] Seam 1: the `call.lock` names another host (or is unreadable). If it is fresh →
      `busy`. With its mtime aged past 15 minutes → replaced, and `release` succeeds.
- [ ] Seam 1: when the lock does not match, `release` never creates a `call.lock`.


## RUN-03: `release` bounds its tree-state read (45 s)

**What to build:** M15 `releaseDeadline`. `release` reads the tree state for its reply
within 45 s of the call's start. Past that budget the reply omits the tree state, and the
release has already completed.

**Blocked by:** RUN-01, FND-05.

**Status:** ready-for-agent

**Sources:** M15 `releaseDeadline`, M18 `release`, C:reply-and-handback, testing seams (Clock at Seam 1).

- [ ] Seam 1 with the stepping clock at 46 s elapsed after the release: exit 0, the lock
      and folder are gone, and the reply's `text` has no tree-state line.
- [ ] Seam 1 below the budget: the tree-state line is present.


## RUN-04: `--plan` calls check the lock (M12 `open`)

**What to build:** M12 `open`, wired as the first step of M18 `commit`. It verifies that
the lock holds the `planId`, refreshes `touched` (the lock mtime), checks the state
`version`, and holds `call.lock` for the whole call. It refuses `taken-over` (the lock
holds another `planId`), `ended` (no lock, or a state `version` mismatch) and `busy` (a
live `call.lock`, or a `call.lock` or folder that vanishes with `ENOENT` → `taken-over`).
State writes use a temporary name, then a rename.

**Blocked by:** RUN-02, RPL-02.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (versioned state), C:commit-release phase (a), M12 `open`, stories 192, 209, 224.

- [ ] Seam 1: the lock holds Y and `commit --plan X --all` runs → exit 6 `lock`, with the
      "this run was taken over by another /commit" text.
- [ ] Seam 1: there is no lock → `ended` ("this run has already ended"). A `state.json`
      whose `version` differs from this build's → `ended`.
- [ ] Seam 1: the lock matches → the lock mtime advances, and `call.lock` is absent after
      the call exits.
- [ ] Seam 1: `X/call.lock` holds a live pid → `busy`, and the run is kept.


## RUN-05: `plan` creates the provisional run folder and checks the directory

**What to build:** M12 `create` at `plan` step 3. It `lstat`s `.commit-plan` (a symlink,
junction, non-directory or tracked path → `run-folder`, checked again after `mkdir`). It
adds the `/.commit-plan/` exclude line once to the common dir's `info/exclude`, mints the
`planId`, and creates the provisional folder. `discard` removes the folder on every outcome
that takes no lock.

**Blocked by:** RUN-01, INT-01, GIT-01, CFG-02.

**Status:** ready-for-agent

**Sources:** Q9, Q22, C:run-folder, architectural decisions (run-folder directory
check), M12 `create`/`discard`, M18 `plan` step 3, stories 196, 207.

- [ ] Seam 1: a symlinked `.commit-plan`, and a tracked `.commit-plan` → exit 6 `state`
      with the "`.commit-plan` is tracked or not a plain directory; remove it by hand"
      text, and nothing is written through the link.
- [ ] Seam 1: after `plan`, `info/exclude` holds exactly one `/.commit-plan/` line, also
      after a second `plan`, and `git status` does not show the run folder.
- [ ] Seam 1: `plan` on a clean tree → no `<planId>/` folder and no lock remain.


## RUN-06: `plan` takes the run lock at step 7

**What to build:** M12 `acquire` without a takeover. The lock `{ planId, created }` is
written to a temporary file in `.commit-plan/` and hard-linked into place. `EEXIST` →
`held`. The state is written atomically with `version`, `plan.json` is written, and the run
is kept for the later calls.

**Blocked by:** RUN-04, RUN-05, CHG-03.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (`lock` row), M12 `acquire`, M18 `plan` step 7, story 187.

- [ ] Seam 1: `plan` with work to do → the lock holds the printed `planId` and a
      `created` time. `<planId>/state.json` carries `version`. `plan.json` exists. No
      temporary lock file is left.
- [ ] Seam 1: `plan --reword` on a clean tree → exit 0 and the lock is taken.
- [ ] Seam 1: `release --plan <that planId>` then removes the lock and the folder.


## RUN-07: a live lock refuses `plan` before inventory (`peek`)

**What to build:** M12 `peek` at `plan` step 3. A live lock (touched under 15 minutes ago)
refuses with `lock` (`held`), carrying the holder's `planId`, start time and last-active
time, before any inventory work, and the provisional folder is discarded. A fresh lock that
cannot be parsed, or whose `planId` is not in the minted form, refuses with `planId: null`
and no handback. Its text names when the automatic takeover becomes possible. The `lock`
handback itself is built by INT-05.

**Blocked by:** RUN-06, RPL-04.

**Status:** ready-for-agent

**Sources:** Q22, C:plan step 3, M12 `peek`, M17 `lock` rule, stories 188, 191.

- [ ] Seam 1: a fresh lock held by another `planId` → exit 6 `lock` with the "another
      /commit run is in progress (started HH:MM, last active N s ago)" text. No new
      folder and no temporary index are left.
- [ ] Seam 1: the same case interactively → a `lock` handback. With `--no-user` → a plain
      refusal without a takeover answer.
- [ ] Seam 1: a fresh lock with garbage content, and a fresh lock with a non-UUID
      `planId` → `lock` with `planId: null` and no handback.


## RUN-08: `plan` sweeps old run folders

**What to build:** M12 `sweep` at the end of `plan` step 7. It deletes `<planId>/` folders
older than 24 hours that the lock does not name, and leftover lock temporary files. It
considers only entries named in the minted form and never follows a link. A cleanup error
becomes a notice and never changes the outcome.

**Blocked by:** RUN-06.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (sweep), M12 `sweep`, story 195.

- [ ] Seam 1: a minted-form folder aged 25 hours → deleted. A 1-hour-old one → kept. The
      folder the lock names → kept, whatever its age.
- [ ] Seam 1: an aged entry that is not in the minted form, and an aged symlink to a
      folder outside `.commit-plan/`, are both left untouched, and the link's target is
      intact.
- [ ] Seam 1: an aged lock temporary file → removed.


## RUN-09: Windows file-in-use errors map to `busy`

**What to build:** the errno mapping of C:run-folder. On Windows, a rename, read or
`utimes` of a lock that another process holds open (`EPERM`, `EBUSY`, `EACCES`) → `busy`.
The lock link is retried on `EPERM`/`EBUSY` for about a second. If it still fails, a
hard-link probe decides: `busy` when the probe succeeds, `run-folder` when it fails.
`ENOTSUP`/`ENOSYS` → `run-folder` at once. The `state.json` rename is retried the same way.

**Blocked by:** RUN-04, RUN-06.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (`lock` row, versioned state), M12, stories 193, 220.

- [ ] Seam 1 (windows runner): a child process holds the lock open without share-delete.
      `commit --plan <id> --all` → exit 6 `lock` (`busy`), never `internal`.
- [ ] Seam 1 (windows runner): a held `state.json` that is released within the retry
      window → the call succeeds.


## RUN-10: manual check: a filesystem without hard links

**What to build:** a manual check, run by hand against such a filesystem when one is
available. On it, `plan` refuses with `run-folder` ("the run folder's filesystem does not
support hard links"). No fixture or CI runner claims this case.

**Blocked by:** RUN-09.

**Status:** needs-human

**Sources:** testing modules (Other checks, M12 manual checks), story 220.

- [ ] On a filesystem without hard links (for example a FAT volume or a network share),
      `plan` exits 6 `state` with the `run-folder` text, and no lock or folder is left.
- [ ] The result is recorded with the release checks.
- [ ] A file merely held open by another process is reported `busy` (RUN-09), not
      `run-folder`


## RUN-11: linked worktrees get their own run

**What to build:** in each worktree, the run folder and the lock live under that
worktree's toplevel. The exclude line lives once in the common dir, which every worktree
shares.

**Blocked by:** RUN-06.

**Status:** ready-for-agent

**Sources:** Q9, Q22, C:run-folder, M12, story 221.

- [ ] Seam 1: two linked worktrees of one repo each run `plan` with work → both are kept,
      each with its own lock and folder, and neither gets `lock`.
- [ ] Seam 1: the common `info/exclude` holds one `/.commit-plan/` line.


## RUN-12: `plan` has a 540-second deadline

**What to build:** M15 `deadline` for `plan`. Every M2 call of the call takes `timeoutMs =
deadline - now()` at its own start. Past the deadline, `plan` ends as `timeout` and
discards its provisional run (it releases the run when it already holds the lock).

**Blocked by:** RUN-05, FND-05.

**Status:** ready-for-agent

**Sources:** Q9, Q18, M15 `deadline`, C:commit-release (budget text), domain-code table (`timed-out`).

- [ ] Seam 1 with the stepping clock at 541 s elapsed from the start → exit 5 `timeout`,
      and no folder and no lock are left.
- [ ] Seam 1 with the stepping clock at 530 s → `plan` completes normally.


## RUN-13: mode resolution without a takeover

**What to build:** M15 `resolveMode` at `plan` step 4, passed `killedLeftover: false`. Flags
win. `--staged` with an empty index → `staged-empty`. An empty or fully staged index →
`split`. A mixed index (staged changes plus unstaged tracked changes or candidates) →
`modeChoice`. Candidates are counted after M9 `hideFilter` and before the caps. The
`modeChoice` and `staged-empty` outcomes discard the run. The `modeChoice` handback itself
is built by INT-13.

**Blocked by:** RUN-05, CHG-01, CHG-05, RPL-04.

**Status:** ready-for-agent

**Sources:** Q9, Q16, C:plan (mode), M15 `resolveMode`, stories 81, 225.

- [ ] Seam 1: every tracked change staged → `split`. Nothing staged → `split`.
- [ ] Seam 1: one staged file plus one unstaged tracked edit → `modeChoice` with counts
      only, `planId: null`, and no folder left.
- [ ] Seam 1: a fully staged index beside a large new directory → `modeChoice`. A fully
      staged index beside hidden files only → `split`.
- [ ] Seam 1: `plan --staged` with an empty index → exit 1 `usage` (`staged-empty`).


## RUN-14: pre-folder refusals come in order

**What to build:** M15 `planRefusal` before the folder exists, in order: `env`, `config`,
`state` (encoding and `unmerged` included). In `reword`: unborn HEAD, merge commit, then
`pushed`. None of these creates a folder.

**Blocked by:** RUN-05, GIT-03, GIT-04, GIT-09, CFG-03.

**Status:** ready-for-agent

**Sources:** Q9, Q20, Q21, M15 `planRefusal`, C:plan, domain-code table.

- [ ] Seam 1: invalid config and an in-progress merge together → `config` (exit 1).
- [ ] Seam 1: an in-progress merge alone → exit 6 `state`, and no `.commit-plan` is
      created.
- [ ] Seam 1: `plan --reword` on a pushed merge commit → `state` ("HEAD is a merge
      commit"), not `pushed`. On a pushed ordinary commit → exit 6 `pushed`.


## RUN-15: post-scan refusals come in order

**What to build:** M15 `planRefusal` after the scan: `staged-hit`, then clean-tree
detection, then `signing`. A tree with only hidden files, only collapsed directories, only
`stagedExcluded` paths or only dirty submodules counts as clean. The `nothing` reply names
their counts and paths. `reword` skips the clean check.

**Blocked by:** RUN-05, SCN-15, GIT-10, CHG-13.

**Status:** ready-for-agent

**Sources:** Q9, Q10, Q18, M15 `planRefusal`, C:plan, story 170.

- [ ] Seam 1: a clean tree on a locked SSH key → status `nothing`, not `signing`.
- [ ] Seam 1: `plan --staged` with a staged secret on a locked key → `staged-hit`.
- [ ] Seam 1: only a hidden file changed → `nothing`, and `text` names its count and path.
- [ ] Seam 1: a modified file on a locked key → exit 6 `signing`, and no folder or lock
      is left.


## RUN-16: the lint-failure counter ends the worker's retries

**What to build:** M15 `onLintFailure` in `check`. The first failure of a worker-written
plan → `fix` (exit 2, run kept). The second failure since the last `plan --hunks` → the
`lintFailed` handback. `plan --hunks` resets the counter. The first failure with `source:
user` → `lintFailed`. A failure made only of shape errors offers only `retry` and `no`.
With `--no-user`, the ending failure releases the lock and deletes the folder.

**Blocked by:** RUN-06, PLN-01, PLN-02, PLN-06.

**Status:** ready-for-agent

**Sources:** Q18, Q20, M15 `onLintFailure`/`runEnd`, C:check, story 214.

- [ ] Seam 1: two bad `check` calls in a row → exit 2 and then `lintFailed`. Running
      `plan --hunks` between them → exit 2 both times.
- [ ] Seam 1: a `source: user` plan with a lint error → `lintFailed` on the first failure.
- [ ] Seam 1: a worker plan that is not valid JSON, twice → a `lintFailed` offering
      `retry` and `no` only.
- [ ] Seam 1: `--no-user` and a second failure → the lock and the folder are gone.


## RUN-17: `check` computes the confirmation from its table

**What to build:** M15 `computeConfirm` per C:confirmation-triggers, tested through the
table-driven fixture generator (one repo and worker plan per table row: mode, groups, new
files, scan items, `resumed`, `interactive`). A hit is never a trigger.

**Blocked by:** RUN-16, CHG-13, PLN-04.

**Status:** ready-for-agent

**Sources:** Q16, C:confirmation-triggers, M15 `computeConfirm`, testing seams (generator), stories 88, 90, 95.

- [ ] Seam 1: every row of C:confirmation-triggers yields the `confirm` reasons and the
      `humanOnly` flag it lists, asserted in `check`'s output.


## RUN-18: `check` routes on the confirmation

**What to build:** M15 `afterCheck` → `commit` | `confirm` | `handedBack` |
`releaseNothing`. `confirm: null` commits in the same process (the route INT-02's `check` takes
unconditionally until this slice). `confirm` stores
`awaitingConfirm` and returns a `confirm` handback without committing. A `humanOnly`
confirmation under `--no-user` hands back and releases the run. Zero groups releases. It
builds the first `confirm` and `handedBack` handbacks; INT-09 adds the confirm block and the
`yes` answer.

**Blocked by:** RUN-17, RPL-04, INT-02.

**Status:** ready-for-agent

**Sources:** Q16, Q17, M15 `afterCheck`/`runEnd`, C:check, architectural decisions (confirmation bound to its answer), stories 86, 208.

- [ ] Seam 1: a new file in a group (interactive) → a `confirm` handback. HEAD is
      unchanged, the run is kept, and `awaitingConfirm` is stored.
- [ ] Seam 1: a `humanOnly` reason with `--no-user` → `handedBack`, and the lock and the
      folder are gone.
- [ ] Seam 1: the INT-02 First-slice run (one group of modified tracked files, interactive)
      → `check` finds no confirmation needed (`confirm: null`) and commits in the same
      process, with no question (story 86); the INT-02 tests still pass.


## RUN-19: `check` is refused after a committed group

**What to build:** M15 `checkGate`. Once any group of the run is committed (a run stopped
at the budget with `continue`), `check` refuses with `already-committed` (exit 1 `usage`).

**Blocked by:** RUN-16, EXE-16.

**Status:** ready-for-agent

**Sources:** Q9, M15 `checkGate`, domain-code table.

- [ ] Seam 1: after a budget stop that committed group 1, `check --plan <id>` → exit 1
      `usage` (`already-committed`), and the committed group stays.


## RUN-20: settle the takeover and run-lock open items

**What to build:** a decision pass (human) over the takeover and run-lock items the last spec review
left open. Record each decision in Q22 (and Q9 where the respawn is concerned),
C:run-folder, C:plan, C:reply-and-handback, M12 and M18, and fix the Seam 1 case list in
the run-integrity list. The items:
(1) a kill between the lock rename and the link, which leaves an orphan renamed lock file
with no lock in place;
(2) the order of the deletions inside `finishTakeover`;
(3) a failure of the index repair itself (a `git reset -q` blocked by a foreign
`index.lock`, or a timeout during the repair): whether `finishTakeover` still runs, what
is kept, and which notices the reply carries;
(4) `--take-over` of a lock or folder that is already gone (the `lock` handback answered
after the run ended on its own): `ended`, or the rename-`ENOENT` retry, and the
rationale in Q9 corrected;
(5) the run-integrity case "a takeover whose repair resets the staging and leaves a mixed
index → `modeChoice`", which cannot be built (a reset leaves the index equal to HEAD):
replace it with a forced `modeChoice` under `killedLeftover`, and a reset under
`--take-over X --staged` → `staged-empty` carrying the reset notice;
(6) a `modeChoice` answer that conflicts with the refused call's mode flag: the answer
replaces the flag, with the handback table row fixed and a `split`-answer fixture added;
(7) the unqualified "a `--take-over` respawn cannot fall back to a `modeChoice`";
(8) the reply `notices` definitions, which must also cover takeover notices that were
never stored;
(9) Q9's body, rewritten in place, needs its original sentence restored;
(10) no M12 operation owns the removal of `call.lock` when a call exits.

**Blocked by:** None (can start immediately)

**Status:** needs-human

**Sources:** Q9, Q17, Q18, Q22, C:run-folder, C:plan, C:reply-and-handback, M12, M18 (takeover paragraph), testing modules (run integrity).

- [ ] Each of the ten items has a recorded decision (an **Amended** bullet in the Q it
      changes), and decisions, contracts and spec agree.
- [ ] The run-integrity case list holds only buildable cases, including the fixtures that
      items (3), (4) and (6) add.
- [ ] RUN-21 to RUN-25, INT-06, INT-13, INT-26, GIT-08 and RPL-09 are updated to cite the
      settled behaviour.


## RUN-21: automatic takeover of a stale lock

**What to build:** at `plan` step 3, `peek` reports a lock untouched for 15 minutes (by
mtime against the injected clock; an unparseable lock or a `planId` not in the minted form
is judged by mtime alone). M12 `acquire({ takeOver })` then renames the lock to
`lock.<own planId>`, verifies its bytes and mtime, links its own lock and reads no killed
run (`killedRun: null`). `finishTakeover` deletes the old folder and the renamed file in
the order RUN-20 settled. A notice names the stale `planId` and goes into every output
`plan` ends with.

**Blocked by:** RUN-07, RUN-08, RUN-20.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder, C:plan step 3, M12 `peek`/`acquire`/`finishTakeover`, M18 `plan` step 3, stories 189, 192, 210.

- [ ] Seam 1: a lock with its mtime aged 16 minutes and a modified file → the new run
      holds the lock, the old folder and `lock.<planId>` are gone, and the notices name
      the stale `planId`.
- [ ] Seam 1: the same stale lock on a clean tree → "nothing to commit" carrying the
      takeover notice, and no lock is left.
- [ ] Seam 1: a stale unparseable lock → taken over automatically.
- [ ] Seam 1: the taken-over run's next `commit --plan <old> --all` → `taken-over`.


## RUN-22: `--take-over <planId>` replaces only the asked-about run

**What to build:** `plan --take-over <planId>` skips `peek` and takes over the named lock
whatever its age. It verifies that the moved lock holds that `planId`. On a mismatch it
puts the lock back and refuses with `lock`, naming the holder now in place and giving a
fresh handback. It creates the old run's `call.lock` (a live call → `busy`, a dead pid on
this host → proceeds). An unparseable lock is never taken over this way. A lock or folder
that is already gone behaves as RUN-20 settled.

**Blocked by:** RUN-21.

**Status:** ready-for-agent

**Sources:** Q9, Q22, C:plan (`--take-over`), C:run-folder (`call.lock` row), M12 `acquire`, stories 190, 191, 206.

- [ ] Seam 1: a fresh lock held by X, then `plan --take-over X` → the new run holds the
      lock, and X's folder is gone.
- [ ] Seam 1: the lock holds Y, then `plan --take-over X` → exit 6 `lock` naming Y, and
      Y's lock is back in place, byte for byte, with its mtime.
- [ ] Seam 1: X's `call.lock` holds a live pid → `busy`. With a dead pid → the takeover
      succeeds.
- [ ] Seam 1: a fresh unparseable lock and `--take-over` with any `planId` → `lock`, and
      the lock is untouched. A traversal `planId` in the flag → `usage`, and nothing
      outside `.commit-plan/` is touched.
- [ ] Seam 1: the settled absent-lock case (RUN-20 item 4) has its fixture.


## RUN-23: takeover of a killed run repairs the index

**What to build:** `acquire` returns `killedRun` from the taken-over `state.json`: the
killed group's paths (both halves of a rename), `preStaged`, `indexOnly`, `indexReset` and
the group's status. It deletes nothing. M18 then repairs the index before inventory:
nothing staged → no reset and no reset notice; every staged path within the killed group's
paths → `git reset -q` with the reset notice. `finishTakeover` runs only after the repair.
The takeover, reset and `unstaged` notices reach every output `plan` ends with.

**Blocked by:** RUN-21, RUN-20, CHG-20, EXE-11, EXE-02.

**Status:** ready-for-agent

**Sources:** Q18, Q22, C:run-folder (takeover paragraph), M12 `acquire`, M18 (killed-process paragraph), stories 210, 227.

- [ ] Seam 1: a `commit` call SIGKILLed while its pre-commit hook sleeps (the group is
      staged, `indexReset` is set), then the lock is aged and `plan` runs → the index is
      reset, inventory sees a clean index, and the reply carries the takeover, reset and
      `unstaged` notices.
- [ ] Seam 1: group 1 committed, then a kill in phase (a) of group 2, then a takeover →
      no reset and no reset notice, and the `unstaged` notice is still given.
- [ ] Seam 1: the old run's folder still exists when the repair runs (asserted through a
      repair-time marker or equivalent observable), and it is gone after the takeover.


## RUN-24: leftover staging after a kill is never committed unasked

**What to build:** M15 `resolveMode` with `killedLeftover` (the index holds paths beyond
the killed group's paths). An interactive run → `modeChoice` whatever the flags, naming
the killed group's paths still staged; its answers respawn without `takeOver`. `--no-user`
without `--reword` → `killed-leftover` (exit 6 `state`, run released, index untouched).
`--reword` → goes on with a notice.

**Blocked by:** RUN-23, RUN-13, RPL-09.

**Status:** ready-for-agent

**Sources:** Q17, Q22, C:run-folder, C:plan (mode), M15 `resolveMode`, domain-code table, story 227.

- [ ] Seam 1: kill in phase (c), then the user stages another file, then `plan
      --take-over <id> --staged` → no reset, and a `modeChoice` naming the killed group's
      paths. Its `staged` answer respawns without `takeOver` and plans the index as
      staged.
- [ ] Seam 1: the same with an automatic takeover under `--split --no-user` → exit 6
      `state` (`killed-leftover`) naming those paths. The index is unchanged, and the lock
      and the folder are gone.
- [ ] Seam 1: the same under `--reword` → the run goes on with a notice naming the paths.
- [ ] Seam 1: the replacement cases that RUN-20 item 5 settled.


## RUN-25: a killed takeover is recovered through the renamed lock chain

**What to build:** a takeover killed during its repair leaves the taken-over folder and
the renamed lock file. The next takeover reads the facts through the renamed lock files,
following them back to the first folder with a `state.json`, and deletes every folder on
that chain after the repair. It also covers the orphan renamed lock, the repair-failure
handling and the deletion order, as RUN-20 settled them.

**Blocked by:** RUN-23, RUN-20.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (takeover paragraph), M12 `acquire`/`finishTakeover`/`sweep`, M18 (killed-process paragraph), story 227.

- [ ] Seam 1: a takeover killed during its repair, then taken over → the repair uses the
      first run's facts, and every folder on the chain plus the renamed files are gone.
- [ ] Seam 1: the repair-failure fixture (a foreign `index.lock` blocking the reset)
      behaves as RUN-20 item 3 settled.
- [ ] Seam 1: an orphan `lock.<planId>` with no lock in place behaves as RUN-20 item 1
      settled (including what `sweep` does with it).


## RUN-26: manual check: a lock put-back that meets `EEXIST`

**What to build:** a manual check of the race no fixture can produce from outside the
process. A takeover that moved the wrong lock, and whose put-back fails with `EEXIST`,
refuses `held` naming the new holder and keeps its private copy for the sweep. The moved
run is `taken-over` at its next step.

**Blocked by:** RUN-22.

**Status:** needs-human

**Sources:** testing modules (Other checks, M12 manual check), Q22, C:plan (`--take-over`).

- [ ] Reproduced by hand (for example with a debugger pause between the rename and the
      put-back): the refusal names the new holder, the private copy remains until a sweep
      24 hours later, and the moved run's next call → `taken-over`.


## RUN-27: every ending outcome releases the run, and only those do

**What to build:** M15 `runEnd` as the single source of which outcomes keep the run and
which release it. The check covers the refusal codes, a lint failure, the `check` results,
the `commit` outcomes and `release`, per C:cli-and-exit-codes and C:run-folder. An
`internal` ending releases as well.

**Blocked by:** RUN-16, RUN-18, EXE-10, EXE-12, EXE-16.

**Status:** ready-for-agent

**Sources:** M15 `runEnd`, C:cli-and-exit-codes (error table), C:run-folder (deleted with the lock), Q18, Q22, story 194.

- [ ] Seam 1: one assertion of lock and folder presence after each ending outcome the
      error table lists and that an earlier slice can reach (the table row names the
      fixture).
- [ ] Seam 1: an interactive `lintFailed` and a budget stop keep the run. A `confirm`
      handback keeps it. `busy` keeps it.
