# 09 Runs

M12 Run (the run-folder directory, run folders, the run lock, `call.lock`, typed run state,
sweep and takeover, including M18's takeover index repair) and M15 Run policy (mode, refusal
order, lint counter, confirmation, run end, deadlines). Every behaviour here is observable
only at Seam 1, so each slice adds its M12 or M15 call to the M18 step that uses it and
tests it through the subcommand. The path without a takeover (RUN-01 to RUN-19) does not
wait for the takeover open items; the takeover slices (RUN-21 to RUN-26) wait on RUN-20 and
RUN-20b.
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

**Status:** done

**Sources:** Q22, C:commit-release (release), C:run-folder, M12, M18 `release`, stories 194, 206.

- [x] Seam 1: a fixture writes a lock holding `planId` X (C:run-folder shape) and a folder
      `X/`. `release --plan X` exits 0 with `status: "nothing"`, and the lock and the
      folder are gone.
- [x] Seam 1: the lock holds Y, or there is no lock. `release --plan X` exits 0 with the
      "nothing to release: the run has already ended or was taken over" text, and Y's lock
      and folder are unchanged.
- [x] Seam 1: the reply's `text` ends with the tree state.
- [x] Seam 1: a lock whose content names a traversal or absolute path instead of a minted
      `planId` deletes nothing outside `.commit-plan/`. The forged lock in this fixture can
      never match (`--plan` is always a fresh, valid `planId`), so the containment itself —
      a forged, matching-shaped `planId` still resolving inside `.commit-plan/` — is proved
      by `run.test.js`'s `insideRunDir` table, not by this fixture (review-RUN-01 finding 9).


## RUN-02: `call.lock` guards `release` against a running call

**What to build:** the per-call `call.lock` (`{ pid, host }`, created exclusively),
exercised through `release`. When the lock matches, `release` takes the `call.lock`
before it deletes anything. A live `call.lock` refuses with `busy` and keeps the run. A
stale one is replaced through the atomic rename, verify and put-back.

**Blocked by:** RUN-01.

**Status:** done

**Sources:** Q22, C:run-folder (`call.lock` row), architectural decisions (one call per run
at a time), M12, story 209.

- [x] Seam 1: `X/call.lock` holds the test process's own pid on this host. `release --plan
      X` exits 6 `lock` (`busy`), and the lock and the folder are kept.
- [x] Seam 1: the `call.lock` names a dead pid on this host. It is stale at once, and
      `release` succeeds.
- [x] Seam 1: the `call.lock` names a live pid on this host (it answers `process.kill(pid,
      0)`) but its mtime is aged past 15 minutes → replaced, and `release` succeeds (a
      live-but-old lock on this host is stale by mtime, same as an unreadable or
      another-host one).
- [x] Seam 1: the `call.lock` names another host (or is unreadable). If it is fresh →
      `busy`. With its mtime aged past 15 minutes → replaced, and `release` succeeds.
- [x] Seam 1: when the lock does not match, `release` never creates a `call.lock`.
- [x] `release` removes the lock through the same rename-to-private-name, verify-`planId`,
      unlink-or-put-back sequence `acquire`'s takeover uses, not a bare unlink by name, so a
      takeover racing a `release` between the lock read and the delete cannot delete the new
      holder's lock instead (review-RUN-01 finding 1).
- [x] Before this slice's own `<planId>/call.lock` path resolution touches `call.lock`, it
      `lstat`s `<planId>` itself and refuses to follow it when it is a link (a junction
      swapped in between the lock check and the `call.lock` write must not redirect the
      write outside the run-folder directory; review-RUN-01 finding 1).


## RUN-03: `release` bounds its tree-state read (45 s)

**What to build:** M15 `releaseDeadline`. `release` reads the tree state for its reply
within 45 s of the call's start. Past that budget the reply omits the tree state, and the
release has already completed.

**Blocked by:** RUN-01, FND-05.

**Status:** done

**Sources:** M15 `releaseDeadline`, M18 `release`, C:reply-and-handback, testing seams (Clock at Seam 1).

- [x] Seam 1 with the stepping clock at 46 s elapsed since the call's start (not since the
      release completed): exit 0, the lock and folder are gone, and the reply's `text` has
      no tree-state line.
- [x] Seam 1 below the budget (measured from the call's start): the tree-state line is
      present.


## RUN-04: `--plan` calls check the lock (M12 `open`)

**What to build:** M12 `open`, wired as the first step of M18 `commit`. It verifies that
the lock holds the `planId`, refreshes `touched` (the lock mtime), checks the state
`version`, and holds `call.lock` for the whole call. It refuses `taken-over` (the lock
holds another `planId`, or its own lock/`call.lock`/folder vanishes mid-call with a late
`ENOENT`), `ended` (no lock, or a state `version` mismatch) and `busy` (only a live
`call.lock`). State writes use a temporary name, then a rename. With no group-commit behaviour built
yet, a matched lock's call falls through to a stub that ends the call at once, exit 0,
with no commits; EXE-02 replaces the stub with the real loop. `call.lock` is created
exclusively when the call starts and removed when it ends by M12 `run.close()` (idempotent,
`ENOENT`-tolerant), called from M18's `finally` for every call with `--plan` (RUN-20 item
10; C:run-folder, `call.lock` row; architectural decisions).

**Blocked by:** RUN-02, RPL-02.

**Status:** done

**Sources:** Q22, C:run-folder (versioned state), C:commit-release phase (a), M12 `open`, M12 `run.close()`, stories 192, 209, 224.

- [x] Seam 1: the lock holds Y and `commit --plan X --all` runs → exit 6 `lock`, with the
      "this run was taken over by another /commit" text.
- [x] Seam 1: there is no lock → `ended` ("this run has already ended"). A `state.json`
      whose `version` differs from this build's → `ended`.
- [x] Seam 1: the lock matches → the lock mtime advances and the stub call exits 0 with no
      commits, and `call.lock` is absent after the call ends (a kept run's `call.lock` does
      not outlive its call).
- [x] Seam 1: `X/call.lock` holds a live pid → `busy`, and the run is kept.
- [x] Seam 1: a `call.lock` or folder that vanishes with `ENOENT` mid-call maps to
      `taken-over`, not `internal` (C:cli-and-exit-codes `lock` row).
- [x] M12 test row: `run.close()` called twice, and after the folder was deleted, succeeds
      without error.
- [x] `run.close()` (M12, built here) replaces the private `closeCallLock` RUN-02 added to
      `plugin/scripts/lib/run.mjs`; RUN-04 removes `closeCallLock` and calls `run.close()`
      from `release` too, not only from `commit`'s `finally` (review-RUN-02 finding 9).


## RUN-05: `plan` creates the provisional run folder and checks the directory

**What to build:** M12 `create` at `plan` step 3. It `lstat`s `.commit-plan` (a symlink,
junction, non-directory or tracked path → `run-folder`, checked again after `mkdir`). It
adds the `/.commit-plan` exclude line once to the common dir's `info/exclude`, mints the
`planId`, and creates the provisional folder. `discard` removes the folder on every outcome
that takes no lock.

**Blocked by:** RUN-01, INT-01, GIT-01, CFG-02.

**Status:** done

**Sources:** Q9, Q22, C:run-folder, architectural decisions (run-folder directory
check), M12 `create`/`discard`, M18 `plan` step 3, stories 196, 207.

- [x] Seam 1: a symlinked `.commit-plan`, `.commit-plan` as a plain file, and (Windows)
      `.commit-plan` as a junction → exit 6 `state` with the "`.commit-plan` is tracked or
      not a plain directory; remove it by hand" text; a tracked `.commit-plan` (in any ASCII
      case) → the same exit 6 `state`, naming the actual tracked variant. Nothing is written
      through the link or junction.
- [x] Seam 1: after `plan`, `info/exclude` holds exactly one `/.commit-plan` line, also
      after a second `plan` (no duplicate line), `git status --porcelain -uall` shows no
      `.commit-plan` path, and `.gitignore` is unchanged (absent stays absent); the same
      holds in a linked worktree, whose exclude line goes to the common dir (story 196).
- [x] Seam 1: `runDir` in `plan`'s output is absolute, `path.resolve`d from the toplevel,
      and uses forward slashes even on Windows (C:run-folder). RUN-05 asserts it in-process
      on M12 `create` only (a clean tree prints `runDir: null`); the Seam-1 check is made
      by CHG-03b (KD-R63, retired).
- [x] Seam 1: `plan` on a clean tree → no `<planId>/` folder and no lock remain.


## RUN-06: step 7's re-reads, `held`, the reword lock and `release`

**What to build:** CHG-03b builds step 7's M12 `acquire` (the lock hard-linked into place)
and the atomic `state.json`/`plan.json` write; this slice adds the lost race (`EEXIST` →
`held`: the race loser deletes its own provisional folder and exits 6 `lock`) and what runs
around that acquire. After `acquire` succeeds, step 7 re-reads HEAD: a HEAD moved
since the inventory releases the lock, deletes the folder and exits 6 `head-moved`
(C:plan step 7, C:cli-and-exit-codes `head-moved` row). `plan --reword` on a clean tree (which skips the
clean-tree refusal but not step 7) still takes the lock. `release --plan <planId>` removes
the lock and the folder.

**Blocked by:** RUN-04, RUN-05, CHG-03b.

**Status:** done

**Sources:** Q22, C:run-folder (`lock` row), C:plan (step 7), C:cli-and-exit-codes,
M12 `acquire`, M18 `plan` step 7, story 187.

- [x] Seam 1: a PATH git shim makes a manual commit the first time step 7's HEAD re-read
      call runs → `acquire` succeeds, the re-read finds HEAD moved by that commit, the
      lock is released, the folder is deleted, and `plan` exits 6 `head-moved`.
- [x] Seam 1: a PATH git shim creates the lock file (as another process's `acquire` would)
      the first git call once the provisional folder exists and no lock does, before step 7
      hard-links its own → `EEXIST` → `held`, and the placed lock and folder are unchanged;
      the race loser (this call) deletes its own provisional folder and exits 6 `lock`.
- [x] Seam 1: `plan --reword` on a clean tree → exit 0 and the lock is taken.
- [x] Seam 1: `release --plan <that planId>` then removes the lock and the folder.


## RUN-07: a live lock refuses `plan` before inventory (`peek`)

**What to build:** M12 `peek` at `plan` step 3. A live lock (touched under 15 minutes ago)
refuses with `lock` (`held`), carrying the holder's `planId`, start time and last-active
time, before any inventory work, and the provisional folder is discarded. The error carries
them as `planId`, `created` and `touched` (ISO), from `peek` and a lost `acquire` alike
(C:cli-and-exit-codes). A fresh lock that cannot be parsed, or whose `planId` is not in the
minted form, refuses with `planId: null`, `created: null` and no handback.

Out of scope here (review-RUN-07 findings 1 and 4): the `lock` handback, and its end-to-end
Seam-1 check against a real first run, are INT-05's. The reply `text` that names when an
unreadable lock is taken over automatically (`touched` plus 15 minutes) is RPL-05's, in both
the interactive and the `--no-user` mode: the contracts fix the time but not the wording, and
RPL-05 owns the `text` layout.

**Blocked by:** RUN-06, RPL-04.

**Status:** done

**Sources:** Q22, C:plan step 3, M12 `peek`, M17 `lock` rule, stories 188, 191.

- [x] Seam 1: a fresh lock held by another `planId` → exit 6 `lock` with the "another
      /commit run is in progress (started HH:MM, last active N s ago)" text. No new
      folder and no temporary index are left.
- [x] Seam 1: the refusal carries the same `planId`, `created` and `touched` fields whether
      from a `peek` refusal or a lost `acquire` (RUN-06), and whether the call is interactive
      or `--no-user`; the `lock` handback's own shape is INT-05's, and the `--no-user`
      reply's shape (no takeover question, no handback) is RPL-05's (C:reply-and-handback).
- [x] Seam 1: a fresh lock with garbage content, and a fresh lock with a non-UUID
      `planId` → `lock` with `planId: null`, `created: null` and no handback.


## RUN-08: `plan` sweeps old run folders

**What to build:** M12 `sweep` at the end of `plan` step 7. It deletes `<planId>/` folders
older than 24 hours that the lock does not name, and leftover lock temporary files. It
considers only entries named in the minted form and never follows a link. A cleanup error
becomes a notice and never changes the outcome. It never deletes a renamed lock file
(`lock.<planId>`) or a folder on its chain: adoption owns them (RUN-20b; RUN-25 asserts it).

**Blocked by:** RUN-06.

**Status:** done

**Sources:** Q22, C:run-folder (sweep), M12 `sweep`, story 195.

- [x] Seam 1: a minted-form folder aged 25 hours → deleted. A 1-hour-old one → kept. The
      folder the lock names → kept, whatever its age.
- [x] Seam 1: an aged entry that is not in the minted form, and an aged symlink to a
      folder outside `.commit-plan/`, are both left untouched, and the link's target is
      intact.
- [x] Seam 1: an aged lock temporary file → removed.


## RUN-09: Windows file-in-use errors map to `busy`

**What to build:** the errno mapping of C:run-folder. On Windows, a rename, read or
`utimes` of a lock that another process holds open (`EPERM`, `EBUSY`, `EACCES`) → `busy`.
The lock link is retried on `EPERM`/`EBUSY` for about a second. If it still fails, a
hard-link probe decides: `busy` when the probe succeeds, `run-folder` when it fails.
`ENOTSUP`/`ENOSYS` → `run-folder` at once. The `state.json` rename is retried the same way.

**Blocked by:** RUN-04, RUN-06.

**Status:** done

**Sources:** Q22, C:run-folder (`lock` row, versioned state), M12, stories 193, 220.

- [x] Seam 1 (windows runner): a PowerShell/.NET helper opens the lock file with
      `FileShare.None` and holds it until an observable event (a marker file the test
      writes) tells it to close → `commit --plan <id> --all` meets `EPERM`/`EBUSY` while
      held, exits 6 `lock` (`busy`), never `internal`.
- [ ] Accepted gap (KD-R23): the same helper holding `state.json` with `FileShare.None`,
      released on its own observable event before the retry window elapses → the call
      succeeds. No deterministic Seam 1 case can hold `state.json`'s rename this way
      (`commit` is still a stub, and `plan` writes it once into a folder minted during the
      call). Covered instead by M12's in-process clears-partway case (`tests/run.test.js`)
      and a Seam 1 persisting-`EPERM` case (six attempts, then `internal`).
- [x] Seam 1 (fault preload, every runner): the lock link fails `EPERM` (and, separately,
      `EBUSY`) on every try → six `lock` link attempts over about a second, then the
      hard-link probe (`<planId>/hardlink-probe.link`) decides: the probe succeeds → exit 6
      `lock` (`busy`); the probe link also fails (`hardlink-probe.link=ENOTSUP`) → exit 6
      `state` (`run-folder`). Nothing is left in `.commit-plan/`. A real holder cannot reach
      this path: while `lock` exists, held or not, the link fails `EEXIST` (`held`); a
      persisting `EPERM`/`EBUSY` comes from a delete-pending `lock` or a held link source,
      which no fixture can create on demand (review-RUN-09 finding 4).
- [x] Seam 1 (windows runner): a stubbed `ENOTSUP`/`ENOSYS` on the lock link → `run-folder`
      at once, without a probe (to RUN-10's manual check, or an accepted gap where it
      cannot be forced).

Tests: `tests/run-file-in-use.test.js` (Seam 1: the preload cases on every runner, the
`FileShare.None` lock holder on Windows only); the retry that clears partway is M12's
in-process case in `tests/run.test.js` (KD-R23).


## RUN-10: manual check: a filesystem without hard links

**What to build:** a manual check, run by hand against such a filesystem when one is
available. On it, `plan` refuses with `run-folder` ("the run folder's filesystem does not
support hard links"). No fixture or CI runner claims this case. Watch the errno: on a FAT
volume `CreateHardLink` fails `ERROR_INVALID_FUNCTION`, which libuv may map to `EISDIR`
rather than `ENOTSUP`; M12 maps only `ENOTSUP`/`ENOSYS` (and a failed probe) to
`run-folder`, so any other code reaches `internal`. If the check sees one, add it to
C:run-folder's `lock` row and M12 (review-RUN-09 finding 8).

**Blocked by:** RUN-09.

**Status:** needs-human

**Sources:** testing modules (Other checks, M12 manual checks), story 220.

- [ ] On a filesystem without hard links (for example a FAT volume or a network share),
      `plan` exits 6 `state` with the `run-folder` text, and no lock or folder is left.
- [ ] The result is recorded with the release checks.
- [ ] A file merely held open by another process is reported `busy` (RUN-09), not
      `run-folder`.


## RUN-11: linked worktrees get their own run

**What to build:** in each worktree, the run folder and the lock live under that
worktree's toplevel. The exclude line lives once in the common dir, which every worktree
shares.

**Blocked by:** RUN-06.

**Status:** done

**Sources:** Q9, Q22, C:run-folder, M12, story 221.

- [x] Seam 1: two linked worktrees of one repo each run `plan` with work → both are kept,
      each with its own lock and folder, and neither gets `lock`.
- [x] Seam 1: the common `info/exclude` holds one `/.commit-plan` line.


## RUN-12: `plan` has a 540-second deadline

**What to build:** M15 `deadline` and `cleanupDeadline` for `plan`. Every M2 call of the
call takes `timeoutMs = deadline - now()` at its own start (the per-call `timeoutMs`
plumbing and tree kill are GIT-07's). Past the deadline, `plan` ends
as `timeout` and discards its provisional run (it releases the run when it already holds
the lock). After a timeout or an `internal` throw with the lock held, the cleanup and
reporting git calls (the reply's M10 `treeState` read) take `cleanupDeadline - now()`
(`plan`'s start plus 580 s), never the spent `deadline`; a cleanup call whose budget is at
or below 0 is not spawned and counts as `timed-out`. The release and delete are CHG-03b's
file-system calls and take no `timeoutMs`.

**Blocked by:** RUN-05, FND-05, CHG-03b.

**Status:** done

**Sources:** Q9, Q18, M15 `deadline`/`cleanupDeadline`, C:plan (deadline text),
C:cli-and-exit-codes (`timeout` and `internal` rows), C:commit-release (budget text),
domain-code table (`timed-out`).

KD-R64: the `internal` output built here carries `plan`'s collected notices (the
provisional-folder discard notice included) instead of dropping them.

- [x] Seam 1: the stepping clock crosses 540 s before the provisional folder exists →
      exit 5 `timeout`, and no folder and no lock are left (the provisional run is
      discarded).
- [x] Seam 1: the stepping clock crosses 540 s only after step 7 has taken the lock →
      exit 5 `timeout`, and the run is released (lock and folder both gone), not merely
      discarded.
- [x] Seam 1: the stepping clock crosses 540 s after step 7 has taken the lock, then stays
      below 580 s → the reply's tree-state read still runs (seen in the argv log of the
      PATH git shim, `docs/spec/testing-modules.md`) and the reply carries it; the lock and
      folder are gone.
- [x] Seam 1: the stepping clock stepped past 580 s before the cleanup → the tree-state
      read is not spawned (absent from the git shim's argv log), the lock and folder are
      still gone, and the reply still comes.
- [x] Seam 1 with the stepping clock at 530 s → `plan` completes normally.
- [x] Seam 1: a separate `plan --hunks` call takes its own 540 s deadline from its own
      start (M15 `deadline`, `modules-m14-m19.md`), distinct from an in-process
      `plan --hunks` which still runs under `plan`'s own deadline. Pinned here at M15
      (pure-function) level only; the Seam 1 case for the separate call lands with CHG-19
      (KD-R22).


## RUN-13: mode resolution without a takeover

**What to build:** M15 `resolveMode` at `plan` step 4, passed `killedLeftover: false`. Flags
win. `--staged` with an empty index → `staged-empty`. An empty or fully staged index →
`split`. A mixed index (staged changes plus unstaged tracked changes or candidates) →
`modeChoice`. Candidates are counted after M9 `hideFilter` and before the caps. The
`modeChoice` and `staged-empty` outcomes discard the run. The `modeChoice` handback itself
is built by INT-13.

**Blocked by:** RUN-05, CHG-01, CHG-05, RPL-04.

**Note (review-CHG-13 finding 3):** CHG-13 moved the caps out of `plan`'s `inventory` step
into their own later step (`collapseCandidates`), so `ctx.inventory.candidates`/`stagedNew`
are pre-cap for `resolveMode` to count here; do not move the caps call earlier than this step.

**Note (review-CHG-07 finding 1):** the `case-rename` check (`refuseCaseRenames`) runs
after the mode decision and only when it resolves to `split` (C:plan step 4); keep
`resolveMode` before it, so `plan --staged` and a mixed index are never refused for it.

**Status:** done

**Sources:** Q9, Q16, C:plan (mode), M15 `resolveMode`, stories 81, 225.

- [x] Seam 1: every tracked change staged → `split`. Nothing staged → `split`.
- [x] Seam 1: one staged file plus one unstaged tracked edit → `modeChoice` with counts
      only, `planId: null`, and no folder left.
- [x] Seam 1: a fully staged index beside a large new directory → `modeChoice`. A fully
      staged index beside hidden files only → `split`.
- [x] Seam 1: `plan --staged` with an empty index → exit 1 `usage` (`staged-empty`).
- [x] Seam 1: `--split` or `--staged` on a mixed index skips `modeChoice` (the flag wins,
      as stated above) and plans directly in that mode.
- [x] Seam 1: with `core.ignorecase=true`, a staged case-only `git mv` beside an unstaged
      edit → `modeChoice`, not `case-rename`; `plan --split` on it → `case-rename`
      (the `--staged` half is CHG-14's).


## RUN-14: pre-folder refusals come in order

**What to build:** M15 `planRefusal` before the folder exists, in order: `env`, `config`,
`state` (encoding and `unmerged` included). In `reword`: unborn HEAD, merge commit, then
`pushed`. None of these creates a folder.

**Blocked by:** RUN-05, GIT-03, GIT-04, GIT-09, CFG-03.

**Status:** done

**Sources:** Q9, Q20, Q21, M15 `planRefusal`, C:plan, domain-code table.

- [x] Seam 1: invalid config and an in-progress merge together → `config` (exit 1).
- [x] Seam 1: an in-progress merge alone → exit 6 `state`, and no `.commit-plan` is
      created.
- [x] Seam 1: `plan --reword` on a pushed merge commit → `state` ("HEAD is a merge
      commit"), not `pushed`. On a pushed ordinary commit → exit 6 `pushed`.


## RUN-15: post-scan refusals come in order

**What to build:** M15 `planRefusal` after the scan: `staged-hit`, then clean-tree
detection, then `signing`. A tree with only hidden files, only collapsed directories, only
`stagedExcluded` paths, only dirty submodules or only untracked embedded repositories
(`embeddedRepos`) counts as clean. The `nothing` reply names
their counts and paths. `reword` skips the clean check. This covers every "counts as
clean" case, hidden-only included.

**Blocked by:** RUN-05, SCN-15, GIT-10, CHG-13, GIT-12, CHG-14.

**Status:** ready-for-agent

**Sources:** Q9, Q10, Q18, M15 `planRefusal`, C:plan, stories 156, 170, 219.

- [ ] Seam 1: a clean tree on a locked SSH key → status `nothing`, not `signing`.
- [ ] Seam 1: `plan --staged` with a staged secret on a locked key → `staged-hit`.
- [ ] Seam 1: only a hidden file changed → `nothing`, and `text` names its count and path.
- [ ] Seam 1: only collapsed directories changed (every change falls into
      `untracked.collapsed`) → `nothing`, named in the reply.
- [ ] Seam 1: a dirty submodule with no pointer change (`dirtySubmodules` only, no unit) →
      `nothing`, named in the reply.
- [ ] Seam 1 (POSIX): only a path that is not UTF-8 changed (the inventory's `notUtf8`
      only, CHG-12) → `nothing`, and `text` names it in its `\xNN` form (story 219;
      review-CHG-12 finding 3).
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

Note (PLN-01 review): `plan-validator.mjs`'s lint errors are all `group: null` today; a
shape error (`parseWorkerPlan`) is not marked apart from a completeness error (PLN-02),
though both land in the same `errors` array. The "failure made only of shape errors" rule
above needs to tell them apart, so `onLintFailure` needs a marker on the lint result (for
example `kind: 'shape'` per error, or on the overall failure) added here, not retrofitted
onto PLN-01.

- [ ] Seam 1: two bad `check` calls in a row → exit 2 and then `lintFailed`. Running
      `plan --hunks` between them → exit 2 both times.
- [ ] Seam 1: a `source: user` plan with a lint error → `lintFailed` on the first failure.
- [ ] Seam 1: a worker plan that is not valid JSON, twice → a `lintFailed` ending (the
      handback's `retry`/`no`-only shape, with no `edit` answer, is RPL's).
- [ ] Seam 1: `--no-user` and a second failure → the lock and the folder are gone, and the
      next `plan` starts fresh.


## RUN-17: `check` computes the confirmation from its table

**What to build:** M15 `computeConfirm` per C:confirmation-triggers, tested through the
table-driven fixture generator (one repo and worker plan per table row: mode, groups, new
files, scan items, `interactive`). A hit is never a trigger. The `humanOnly` row needs
SCN-14's scan wiring. The `resumed` row needs the separate `plan --hunks` call that INT-12
builds, so INT-12 asserts that row instead of here.

**Blocked by:** RUN-16, CHG-13, PLN-04, SCN-14.

**Status:** ready-for-agent

**Sources:** Q16, C:confirmation-triggers, M15 `computeConfirm`, testing seams (generator), stories 88, 90, 95.

- [ ] Seam 1: every row of C:confirmation-triggers except `resumed` (INT-12 covers it)
      yields the `confirm` reasons and the `humanOnly` flag it lists, asserted in `check`'s
      output.


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

**Sources:** Q16, Q17, M15 `afterCheck`/`runEnd`, C:check, architectural decisions (confirmation bound to its answer), stories 86, 97, 208.

- [ ] Seam 1: a new file in a group (interactive) → a `confirm` handback. HEAD is
      unchanged, the run is kept, and `awaitingConfirm` is stored.
- [ ] Seam 1: a `humanOnly` reason with `--no-user` → `handedBack`, and the lock and the
      folder are gone.
- [ ] Seam 1: the INT-02 First-slice run (one group of modified tracked files, interactive)
      → `check` finds no confirmation needed (`confirm: null`) and commits in the same
      process, with no question (story 86); the INT-02 tests still pass.
- [ ] Seam 1: `confirm` set, `interactive: false`, not `humanOnly` → `check` commits in the
      same process as with `confirm: null` (C:check, `interactive: false` row), no question asked.
- [ ] Seam 1: a worker plan with every unit in `notIncluded` (zero groups) → `check` exits
      0 with `status: "nothing"`, the `text` lists each `notIncluded` reason, the lock and
      the folder are gone, and there is no `confirm` handback (story 97).


## RUN-19: `check` is refused after a committed group

**What to build:** M15 `checkGate`. Once any group of the run is committed (a run stopped
at the budget with `continue`), `check` refuses with `already-committed` (exit 1 `usage`).

**Blocked by:** RUN-16, EXE-16.

**Status:** ready-for-agent

**Sources:** Q9, M15 `checkGate`, domain-code table.

- [ ] Seam 1: after a budget stop that committed group 1, `check --plan <id>` → exit 1
      `usage` (`already-committed`), and the committed group stays.


## RUN-20: settle the run-lock open items (basics)

**What to build:** a decision pass (human) over the run-lock items that do not depend on
takeover mechanics (RUN-20b covers those). Record each decision in Q22 (and Q9 where the
respawn is concerned), C:run-folder, C:plan, C:reply-and-handback, M12 and M18. The items:
(6) a `modeChoice` answer that conflicts with the refused call's mode flag: the answer
replaces the flag, with the handback table row fixed and a `split`-answer fixture added;
(10) a documentation sync: M12 `run.close()` (idempotent, `ENOENT`-tolerant) removes the
call's `call.lock` from M18's `finally` and from the signal handler (KD-S25);
(11) a documentation sync: both lock error tables (C:cli-and-exit-codes, domain code → CLI
kind) list the late `ENOENT` → `taken-over` and the probe-succeeds `busy` cause (KD-S15);
(12) scoped to the takeover path only: what happens "between the inventory and taking the
lock" for the index-fingerprint and HEAD rechecks C:plan cites twice (KD-S10),
*during a takeover*. RUN-06 already builds and tests the non-takeover step-7 HEAD recheck,
so only the takeover-path recheck remains open here; the resulting buildable criterion
("after a takeover, HEAD moved → `head-moved` carrying the takeover notice") is gated on
RUN-20b and lives in RUN-21.

**Blocked by:** None (can start immediately)

**Status:** done

**Sources:** Q9, Q17, Q22, C:run-folder, C:plan, C:reply-and-handback, C:cli-and-exit-codes, M12, M18.

- [x] Item 6 has a recorded decision (an **Amended** bullet in the Q it changes), and
      decisions, contracts and spec agree.
- [x] Items 10 and 11 are recorded as documentation-sync notes (no **Amended** bullet
      needed): RUN-04 already asserts the behaviour they describe.
- [x] Item 12's takeover-path scope is recorded, and RUN-06's non-takeover recheck is
      cited so the two are not retested twice.
- [x] GIT-08, INT-13, RPL-09 and RUN-21 (the direct dependents of this slice) are updated
      to cite the settled behaviour; RUN-20b, not this slice, updates the takeover-only
      dependents.


## RUN-20b: settle the takeover open items

**What to build:** a decision pass (human) over the takeover items left open in [known
deficiencies](../spec/known-deficiencies.md) (KD-S1 to KD-S5, KD-S7 to KD-S9). Record each
decision in Q22 (and Q9 where the respawn is concerned), C:run-folder, C:plan,
C:reply-and-handback, M12 and M18, and fix the Seam 1 case list in the run-integrity list.
The items:
(1) a kill between the lock rename and the link, which leaves an orphan renamed lock file
with no lock in place;
(2) the order of the deletions inside `finishTakeover`;
(3) a failure of the index repair itself (a `git reset -q -- .` blocked by a foreign
`index.lock`, or a timeout during the repair): whether `finishTakeover` still runs, what
is kept, and which notices the reply carries;
(4) `--take-over` of a lock or folder that is already gone (the `lock` handback answered
after the run ended on its own): `ended`, or the rename-`ENOENT` retry, and the
rationale in Q9 corrected;
(5) the run-integrity case "a takeover whose repair resets the staging and leaves a mixed
index → `modeChoice`", which cannot be built (a reset leaves the index equal to HEAD):
replace it with a forced `modeChoice` under `killedLeftover`, and a reset under
`--take-over X --staged` → `staged-empty` carrying the reset notice; note in the record
that the original case is unbuildable and why;
(7) the unqualified "a `--take-over` respawn cannot fall back to a `modeChoice`" — partly
fixed already (`plan.md` excepts `killedLeftover`, but not a bare first-spawn `plan`): the
remaining gap is recorded and closed;
(8) the reply `notices` definitions, which must also cover takeover notices that were
never stored;
(9) Q9's body, rewritten in place, needs its original sentence restored.

**Blocked by:** None (can start immediately)

**Status:** done

**Sources:** Q9, Q18, Q22, C:run-folder, C:plan, C:reply-and-handback, M12, M18 (takeover
paragraph), testing modules (run integrity).

- [x] Each of the eight items (1-5, 7-9) has a recorded decision (an **Amended** bullet in
      the Q it changes), and decisions, contracts and spec agree.
- [x] The run-integrity case list holds only buildable cases, including the fixtures that
      items (3), (4) and (5) add.
- [x] RUN-21, RUN-22, RUN-23, RUN-24 and RUN-25 are updated to cite the settled behaviour;
      GIT-08 does not wait on this slice (it needs only RUN-20's basics).


## RUN-21: automatic takeover of a stale lock

**What to build:** at `plan` step 3, `peek` reports a lock untouched for 15 minutes (by
mtime against the injected clock; an unparseable lock or a `planId` not in the minted form
is judged by mtime alone). M12 `acquire({ takeOver })` then renames the lock to
`lock.<own planId>`, verifies its bytes and mtime, links its own lock and reads no killed
run (`killedRun: null`). `finishTakeover` deletes the old folder first and the renamed
file last (RUN-20b item 2). A rename that fails with `ENOENT` re-peeks once: a lock in
place → `lock` with a fresh handback (RUN-20b item 4). A notice names the stale `planId`
and goes into every output `plan` ends with.

**Blocked by:** RUN-07, RUN-08, RUN-12, RUN-13, RUN-18, RUN-20, RUN-20b.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder, C:plan step 3, M12 `peek`/`acquire`/`finishTakeover`, M18 `plan` step 3, stories 189, 192, 210.

- [ ] Seam 1: a lock with its mtime aged 16 minutes and a modified file → the new run
      holds the lock, the old folder and `lock.<planId>` are gone, and the notices name
      the stale `planId`.
- [ ] Seam 1: the same stale lock on a clean tree → "nothing to commit" carrying the
      takeover notice, and no lock is left.
- [ ] Seam 1: a stale unparseable lock → taken over automatically.
- [ ] Seam 1: the taken-over run's next `commit --plan <old> --all` → `taken-over`.
- [ ] `call.lock`'s disposition when a call exits follows RUN-04's settled behaviour: M12
      `run.close()` removes it (RUN-20 item 10).
- [ ] Seam 1 (RUN-20 item 12, takeover path): after a takeover, HEAD moved since step 4's
      inventory → step 7's re-read (which runs on both paths; RUN-06 covers the path with
      no takeover) refuses `head-moved` carrying the takeover notice.
- [ ] Seam 1: the takeover notice survives a later refusal of the same `plan`
      (`staged-empty`, `timeout`), and, on a modified tree needing confirmation, reaches
      the `committed` reply and the text of a `confirm` handback.


## RUN-22: `--take-over <planId>` replaces only the asked-about run

**What to build:** `plan --take-over <planId>` skips `peek` and takes over the named lock
whatever its age. It verifies that the moved lock holds that `planId`. On a mismatch it
puts the lock back and refuses with `lock`, naming the holder now in place and giving a
fresh handback. It creates the old run's `call.lock` (a live call → `busy`, a dead pid on
this host → proceeds). An unparseable lock is never taken over this way. A lock or folder
that is already gone refuses `ended` ("that run has already ended; run /commit again"):
a rename `ENOENT` whose re-peek finds no lock, or an `ENOENT` on the old run's `call.lock`
(its folder is gone), which also deletes the renamed lock; a re-peek that finds another
lock → `lock` naming it (RUN-20b item 4).

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
- [ ] Seam 1 (RUN-20b item 4): no lock in place, then `plan --take-over X` → exit 6
      `lock` (`ended`), and no lock or folder of the new run is left.
- [ ] Seam 1 (RUN-20b item 4): X's lock in place but X's folder gone, then
      `plan --take-over X` → exit 6 `lock` (`ended`); no `lock.<planId>` and no lock or
      folder of the new run is left.


## RUN-23: takeover of a killed run repairs the index

**What to build:** `acquire` returns `killedRun` from the taken-over `state.json`: the
killed group's paths (both halves of a rename), `preStaged`, `indexOnly`, `indexReset` and
the group's status. It deletes nothing. M18 then repairs the index before inventory:
nothing staged → no reset and no reset notice; every staged path within the killed group's
paths → `git reset -q -- .` with the reset notice. `finishTakeover` runs only after the repair.
The takeover, reset and `unstaged` notices reach every output `plan` ends with. A repair
that fails, and an adopted orphan chain, are RUN-25's (RUN-20b items 1 and 3).

**Blocked by:** RUN-21, RUN-20b, CHG-20, EXE-11, EXE-02.

**Status:** ready-for-agent

**Sources:** Q18, Q22, C:run-folder (takeover paragraph), M12 `acquire`, M18 (killed-process paragraph), stories 210, 227.

KD-R69: the repair's reset drops a pre-run intent-to-add mark the same way a split run's
does; also open is whether the repair's "staged" check uses `--ita-visible-in-index`, which
would put a pre-run i-t-a path outside the killed group's paths and turn the repair into
`killedLeftover`.

- [ ] Seam 1: a `commit` call SIGKILLed while its pre-commit hook sleeps (the group is
      staged, `indexReset` is set), then the lock is aged and `plan` runs → the index is
      reset, inventory sees a clean index, and the reply carries the takeover, reset and
      `unstaged` notices.
- [ ] Seam 1: group 1 committed, then a kill in phase (a) of group 2, then a takeover →
      no reset and no reset notice, and the `unstaged` notice is still given.
- [ ] Seam 1: the old run's folder still exists when the repair runs (asserted through a
      repair-time marker or equivalent observable), and it is gone after the takeover.
- [ ] Seam 1: the `unstaged` reset notice survives a later refusal of the same `plan`
      (`staged-empty`, `timeout`), and, on a modified tree needing confirmation, reaches
      the `committed` reply and the text of a `confirm` handback.


## RUN-24: leftover staging after a kill is never committed unasked

**What to build:** M15 `resolveMode` with `killedLeftover` (the index holds paths beyond
the killed group's paths). An interactive run → `modeChoice` whatever the flags, naming
the killed group's paths still staged; its answers respawn without `takeOver`. `--no-user`
without `--reword` → `killed-leftover` (exit 6 `state`, run released, index untouched).
`--reword` → goes on with a notice.

**Blocked by:** RUN-23, RUN-20b, RUN-13, RPL-09.

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
- [ ] Seam 1 (RUN-20b item 5): an automatic stale takeover with `killedLeftover` in an
      interactive run → the forced `modeChoice` carrying the takeover, `killedLeftover`
      and `unstaged` notices; a repair that resets under `--take-over <id> --staged` →
      `staged-empty` carrying the reset notice.


## RUN-25: a killed takeover is recovered through the renamed lock chain

**What to build:** a takeover killed during its repair leaves the taken-over folder and
the renamed lock file. The next takeover reads the facts through the renamed lock files,
following them back to the first folder with a `state.json`, and deletes every folder on
that chain after the repair. It also covers, as RUN-20b settled them: the orphan renamed
lock (`peek` treats it like a stale lock and every `acquire` adopts it; at step 7 a chain
that needs the repair refuses `index-changed`), the repair failure (the chain kept, the
run's own lock and folder released, `index-lock`/`timeout`/`git-failed` with a "repair
failed" notice), the deletion order (folders first, renamed locks last) and a sweep that
never deletes a renamed lock.

**Blocked by:** RUN-23, RUN-20b.

**Status:** ready-for-agent

**Sources:** Q22, C:run-folder (takeover paragraph), M12 `acquire`/`finishTakeover`/`sweep`, M18 (killed-process paragraph), story 227.

- [ ] Seam 1: a takeover killed during its repair, then taken over → the repair uses the
      first run's facts, and every folder on the chain plus the renamed files are gone.
- [ ] Seam 1 (RUN-20b item 3): a foreign `index.lock` blocking the repair → exit 6
      `index-lock` with the notices so far and the "repair failed" notice; the taken-over
      folder and the renamed lock remain, the new run's lock and folder are gone; once the
      `index.lock` is removed, the next `plan` adopts the chain and repairs.
- [ ] Seam 1 (RUN-20b item 1): an orphan `lock.<planId>` with no lock in place (a takeover
      killed between its rename and its link) → `plan` adopts it at step 3: the repair
      uses the chain's facts, then the chain's folders and the renamed file are gone.
- [ ] M12 test row: `sweep` over an orphan renamed lock and its chain folder, both aged
      past 24 hours, leaves both in place.
- [ ] Seam 1 (RUN-20b item 2): a renamed lock whose chain ends at a missing folder →
      counted done, no repair, and deleted.
- [ ] Seam 1 (RUN-20b item 1, step 7): an orphan `lock.<planId>` whose chain has
      `indexReset` and an uncommitted group, placed after `peek` (injected between steps 3
      and 7) → exit 6 `diff-changed` (`index-changed`) with the repair-first notice; the
      chain remains, and the run's own lock and folder are gone.


## RUN-26: manual check: a lock put-back that meets `EEXIST`

**What to build:** a manual check of the race no fixture can produce from outside the
process. A takeover that moved the wrong lock, and whose put-back fails with `EEXIST`,
refuses `held` naming the new holder and leaves its private copy, which the new holder
adopts as an orphan (RUN-20b item 1). The moved run is `taken-over` at its next step.

**Blocked by:** RUN-22.

**Status:** needs-human

**Sources:** testing modules (Other checks, M12 manual check), Q22, C:plan (`--take-over`).

- [ ] Reproduced by hand (for example with a debugger pause between the rename and the
      put-back): the refusal names the new holder, the private copy is adopted by that
      holder's `acquire` as an orphan rather than left for the sweep, and the moved run's
      next call → `taken-over`.


## RUN-27: every ending outcome releases the run, and only those do

**What to build:** M15 `runEnd` as the single source of which outcomes keep the run and
which release it. The check covers the refusal codes, a lint failure, the `check` results,
the `commit` outcomes and `release`, per C:cli-and-exit-codes and C:run-folder. An
`internal` ending releases as well: `runEnd` replaces the `plan`-only `internal` cleanup
CHG-03b built, so every subcommand's `internal` ending goes through it.

**Blocked by:** RUN-16, RUN-18, EXE-10, EXE-12, EXE-16.

**Status:** ready-for-agent

**Sources:** M15 `runEnd`, C:cli-and-exit-codes (error table), C:run-folder (deleted with the lock), Q18, Q22, stories 45, 194.

- [ ] Seam 1: one assertion of lock and folder presence after each ending outcome the
      error table lists and that an earlier slice can reach (the table row names the
      fixture).
- [ ] Seam 1: an interactive `lintFailed` and a budget stop keep the run. A `confirm`
      handback keeps it. `busy` keeps it.
- [ ] Seam 1: `commit --all`'s `releaseOpen(run)` result (`{ notice, kept }`) after the last
      group reaches the reply, not just the lock/folder outcome: a busy lock rename
      (`kept: true`) and a folder-removal error each surface their notice text (review-EXE-02
      finding 3; no slice currently asserts this — INT-02 asserts only the `committed` reply,
      and this slice's own criterion above asserts only lock/folder presence).
