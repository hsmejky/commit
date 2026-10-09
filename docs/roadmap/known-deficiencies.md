# Known deficiencies in the roadmap

Open defects in the slicing, blockers and acceptance criteria of this plan. None blocks the
frontier; check this file before starting a slice it names. Design-level defects are in the
[spec's known deficiencies](../spec/known-deficiencies.md) (KD-S IDs). When an item is
fixed, delete it here; IDs are never reused.

## Slicing

- **KD-R1. CHG-03 is a horizontal slice** (07). Its one criterion, "no path is parsed out
  of patch text", names no seam or observable and cannot fail, yet CHG-03 is on the INT-02
  and REL-05 critical paths. CHG-03b's parser-oracle test now asserts `hunks.hunks[].path`
  for a path whose patch headers render differently (`a b/c`), settling the Seam-1 half.
  Fix: merge CHG-03 into CHG-03b (update counts and critical paths) or label it build-only.
- **KD-R2. INT slices repeat component criteria** (12, 09, 10). INT-13 repeats RUN-13,
  INT-05 repeats RUN-07's `peek` cases, INT-09's `unconfirmed` case repeats EXE-22; INT-05
  promises an untested "race lost at `acquire`". Fix: keep only handback-shape assertions
  in INT; test or drop the race.
- **KD-R3. EXE-24 re-asserts GIT-08's teardown.** Fix: limit EXE-24 to "no commit after the
  kill" and the `indexReset` case.
- **KD-R4. INF-07 waits needlessly** behind CFG-07
  though it needs only the `scanIgnore` glob compile. Optional fix: a CFG-03b "`validateLayer`
  compiles `scanIgnore`" blocked by CFG-03 and SCN-03, blocking CFG-07 and INF-07.

## Blocking edges

- **KD-R5.** CHG-11 needs CHG-09 (symlink `T` unit); CHG-21 needs CHG-09 and CHG-14. Add the
  edges.
- **KD-R6.** CHG-11's scan criteria (secret found, `scan.skipped` over 1 MB) need CHG-16 and
  SCN-13, which it does not reach. Move them to SCN-16 or add the blockers.
- **KD-R7.** SCN-12's symlink-target case needs SCN-13. Add the edge or drop the case.
- **KD-R10.** RUN-23, RUN-24, RUN-25 list RUN-20b directly although RUN-21 already carries
  it. Drop the edges or note they are kept for reading.

## Acceptance criteria

- **KD-R11. Criteria no test can observe.** GIT-01's `windowsHide` and "never decodes
  stdout"; four WRK-04 worker-behaviour bullets. Fix: a
  static spawn-options test plus a non-UTF-8 byte case; prompt-phrase checks for WRK-04,
  behaviour left to WRK-06.
- **KD-R16.** CHG-03b's fault criteria say "no lock file"; a lock temp file may legitimately
  remain. Say "no `.commit-plan/lock`".
- **KD-R17.** CHG-23's `index.lock` grep trips on M16's expected notice and on
  `index-lock`. Have M10 return the notice text; grep fs calls only, fixed-string.
- **KD-R18.** EXE-14's "(with no extra commit — this is EXE-06's case)" reads backwards.
  Reword (see KD-R41).
- **KD-R19.** MSG-01's header-mismatch criterion lacks its seam ("Seam 3 table").
- **KD-R73.** C:cli-and-exit-codes says every output that ends the worker's part of a run,
  failures included, carries `reply`. RPL-04 built the `failed` reply for every `plan`
  refusal, but `release`'s and `commit`'s own `env` refusals, and `commit`'s and `check`'s
  lint/scan failures, still go through the plain `refusalFailure` with no `reply` at all. No
  roadmap criterion currently names this gap. (INT-09 gave a direct `commit --all`'s success
  path its `committed`/`continue` reply; its failure path is still reply-less.) Fix: add it as an explicit INT-02-or-later
  criterion, or a dedicated slice, before 0.1.0 closes.
- **KD-R106.** EXE-11 AC5's "the report says the index is untouched" is not reachable: a
  `commit --all` refusal before any group reached (c) has `unstaged: null` (asserted at
  Seam 1, `tests/commit-all-unstaged.test.js`), but goes out through the plain
  `refusalFailure` with no `failed` reply and so no report text (KD-R73). Fix: when KD-R73's
  `failed` reply lands for `commit --all`, add a line saying the index is untouched (Q18,
  C:commit-release `unstaged: null`) after the failed group in `reply.mjs`'s `failed`
  text, and assert it on the same refusal. Slice: whichever lands KD-R73.
- **KD-R107.** EXE-12 AC2's reply-text half (story 160: the `failed` reply's `text` naming
  the committed group 1, the failed group 2 and the remaining group 3) is not reachable for a
  direct `commit --all`: its failure goes out through `commitAllFailure` with no `reply`
  (KD-R73). `tests/commit-all-git-failed.test.js` asserts the rest of AC2 (lock and run
  folder gone). Fix: when KD-R73's `failed` reply lands for `commit --all`, assert the
  group lists in `reply.text` on the exit-4 case of that test file, including the Q18
  "committed as `<sha>`, but git did not exit cleanly" case, whose group is listed as
  committed. Slice: whichever lands KD-R73.
- **KD-R108.** C:commit-release has no "unknown" value for `unstaged`. When `git status`
  fails after the last commit and the release (EXE-11 review finding 3), `commitAll` keeps the
  commit list and lists every `preStaged` and `indexOnly` path (`ignored: false`, `blob` where
  stored) with a notice, instead of the old `internal`. Not tested at Seam 1: `finalReply`'s
  own `treeState` runs `git status` right after, and the same failure ends the run `internal`
  there. Also, EXE-11 AC6's (a)-refusal arm (a phase (a) refusal after group 1 with an index
  that differs from HEAD) has no Seam 1 trigger; the (b) `diff-changed` arm is tested. Fix:
  a contract value or text for an unread `unstaged`, and a tree-state read that degrades the
  same way, then a Seam 1 case. Slice: none yet.
- **KD-R91.** A hidden staged-new path that is also gitignored (Q11's own example,
  `git add -f .env.local` where `.env.local` is listed in `.gitignore`) never gets the
  "and .gitignore then hides it from `git status`" clause on its `notIncluded` entry:
  `state.json`'s `stagedExcluded` list (`plugin/scripts/lib/workflows.mjs`
  `stagedExcludedOf`) carries no `ignored` flag, and `plan-validator.mjs`
  `notIncludedResult` ties that clause only to the stored staged-new list (`stagedNew`),
  which a hidden-and-excluded path is never on (it never became a unit). Decided for now:
  no clause applies to an automatic `stagedExcluded` entry; only a worker-placed
  `notIncluded` entry for a staged-new **unit** carries it (C:check). Fix: thread `ignored`
  onto `stagedExcluded` entries too (`stagedExcludedOf`, workflows.mjs) and read it in
  `notIncludedResult`, or decide in docs that the gap is permanent and narrow C:check's
  wording instead. Slice: a later one touching `stagedExcludedOf`/C:check (none assigned
  yet).
- **KD-R92.** `lintFailureOf` (`plugin/scripts/lib/workflows.mjs`) drops `plan`'s stored
  notices on a lint failure: the interactive `lintFailed` handback's `finalReply` call
  carries no `notices` at all, and the `--no-user` `failed` reply's `notices` holds only the
  release notice (`released.notice`), never `ctx.notices`. Per [plan](plan.md) step 8 /
  [reply-and-handback](reply-and-handback.md), every output that ends the worker's part of a
  run should carry the notices `plan` stored (the guard notice included), so a
  heartbeat-less run whose user answers `no` to a lint failure never sees the guard notice.
  Pre-existing, outside INT-27's ACs (review-INT-27-r2 Low-2). Fix: pass `ctx.notices` (or
  `[...ctx.notices, released.notice]` for the `--no-user` branch) into both `finalReply`
  calls. Slice: RUN-27 (`lintFailureOf`'s own comment: "M15 `runEnd` replaces this branch
  when RUN-27 builds it"), or an earlier RPL slice if one touches this function first.
- **KD-R103.** review-EXE-10 Low-1/Low-3: `plugin/scripts/lib/commit-executor.mjs:448` (the
  `stage-failed`/`mismatch` refusal) and `~515` (the backstop/commit-throw `catch`) both
  `await unstage(git)` and ignore a non-zero `git reset` from it — `{ ok: false, gitOutput }`
  at 448, a straight call with no return value read at 515. C:commit-release "On failure"
  wants the original cause kept, a notice, `unstaged: null`, and the lock and run folder kept
  for the next run's takeover (EXE-01 item 2) on a failed unstage, same as EXE-17's own
  skipped-cleanup branch; EXE-17's own criteria test only the deadline (skipped) case, not a
  `git reset` that actually runs and fails, so that branch is untested. No fixture reaches it
  without stretching a seam: Seam 1's fault-injection preload (testing-seams.md) only fails
  named `fs`/`os` calls, not a chosen `git` subprocess call by position, and a repo-content
  trick (such as a stray `index.lock`) cannot fail only the cleanup `git reset` without also
  failing the phase-(c) call just before it. Also at 515: `unstage` never throws on git's own
  exit code (by design, same as the replaced `resetIndex`), but a spawn/timeout throw from M2
  `run` inside it would replace `err`, masking the original cause the `catch` was reporting.
  Fix: add a non-zero-`git reset` criterion to EXE-17 once a seam for it exists (a user
  decision), and guard the 515 call so a throw from `unstage` itself cannot replace `err`.
  Slice: none yet.

## Test mechanisms

- **KD-R21. PATH git shims** (RUN-06, RUN-12, GIT-01, EXE shim cases) do not work on
  Windows and their argv/env log is undefined (KD-S35). Fix: a shim paragraph in
  testing-seams (POSIX script, compiled `.exe`, log format) or mark cases POSIX-only.
  GIT-05's argument/env case needs no shim: the spawn-record preload logs each spawn's
  `GIT_*` environment (`gitEnv`) on every platform.
- **KD-R22.** RUN-12's first clock step fires before the provisional folder exists, so the
  discard is never exercised. Tie the step to "folder exists, no lock"; add setup and exit
  code. AC6 (a separate `plan --hunks` taking its own 540 s deadline from its own start) is
  pinned at M15 level by RUN-12; its Seam 1 case landed with CHG-19
  (`tests/plan-hunks-resnapshot.test.js`, the clock step keyed on the call's own `call.lock`).
- **KD-R23.** RUN-09 AC2 (a real `FileShare.None` holder on `state.json`, released inside the
  retry window → success) has no deterministic Seam 1 case: no call renames over an existing
  `state.json` at a moment a test can hold it (`commit` is still a stub, and `plan` writes it
  once, into a `<planId>/` folder minted during the call), and the fault preload's faults persist for the whole call. Covered
  instead by M12's in-process clears-partway case (`tests/run.test.js`) and a Seam 1
  persisting-`EPERM` case (six attempts, then `internal`). Fix: once EXE-02 writes
  `state.json` per group, use a holder that releases once the fault log shows the second
  rename attempt, or add a "fail the first N calls" option to the preload.
- **KD-R26.** RUN-04's late-`ENOENT` → `taken-over` case has no trigger (the stub call ends
  at once). Move it after EXE-02 or add an FND-10 fault mode.
- **KD-R29.** FND-10's ESM check does not import `node:fs/promises`; add it.
- **KD-R89.** PLN-05's `staged` AC1 ("a group naming only some files still holds
  every unit") and AC2 (`newFiles`) are asserted on M14 `validatePlan` directly
  (`tests/plan-staged-reword-group.test.js`), not through `check`'s own output: `check`'s
  success path goes straight on to `commit --all` in-process, and M16's execution for
  `staged` is not built yet (EXE-19). INT-14 covers a staged commit
  end-to-end but no criterion checks that a plan naming only some files still commits every
  staged unit, or `newFiles` in `check`'s output (INT-24's
  `tests/reword-workflow.test.js` covers reword's `newFiles: []` through `check`). Fix:
  once EXE-19 lands, add a subprocess `check --plan` success case to
  `tests/plan-staged-reword-group.test.js`: staged with a partial `files` list still
  commits every unit and reports `newFiles` from the index diff. Slice: PLN-05, EXE-19.
- **KD-R77.** GIT-07's M2 and M11 cases (`tests/git-timeout-tree-kill.test.js`,
  `tests/signing-probe-deadline.test.js`), like GIT-05's and GIT-12's own M2 cases, call
  `run`/`withDeadline`/`probeSigning` in-process, outside testing-seams.md's user-confirmed
  seam list (M2 and M11 are neither Seam 1 nor a Seam 3 table module). They pin what Seam 1
  cannot reach without a wall-clock wait: a per-call budget scripted call by call, a spent
  budget never spawning, and the probe's `"unknown"` mapping of each timed-out read. Fix:
  either add an "in-process adapter" seam to testing-seams.md (a user decision), or rebuild
  these cases at Seam 1. Slice: none yet (needs the user's seam decision). Status:
  accepted (user decision, 2026-10-04): the in-process cases stay, and the seam list in
  testing-seams.md stays as confirmed.
- **KD-R84.** INT-02's two `workflows.check` in-process cases in
  `tests/first-end-to-end-commit.test.js` (review-INT-02 Medium-1's stack-sniffing-clock
  case and Low-3's `fs.renameSync` patch) call `check` directly, outside testing-seams.md's
  user-confirmed seam list, the same gap KD-R77 names for M2/M11. Two earlier M18 cases have
  the same unrecorded gap: `tests/plan-deadline.test.js` (around lines 201 and 299) and
  `tests/plan-run-folder.test.js` (around line 344), both also calling `workflows.plan` or
  `workflows.check` in-process. They pin what Seam 1 cannot reach without a dedicated
  preload addition: Medium-1's stack-depth-keyed clock reading (no Seam 1 clock-preload step
  is keyed to an M2 call frame) and Low-3's locked-rename simulation (the fault preload's
  `fs.renameSync` fault matches a target basename, not the lock's exact path, and the real
  `EBUSY` is OS/timing-dependent). Medium-1 can very likely move to Seam 1 with a
  clock-preload step keyed to a path `commitAll` creates before `git commit`; Low-3 would
  need the fault preload's basename match widened to a path, a seam-list change. Fix: either
  add an "in-process adapter" seam to testing-seams.md (a user decision, as KD-R77's), or
  rebuild these cases at Seam 1. Slice: none yet (needs the user's seam decision).
- **KD-R87.** CHG-17's fourth criterion (a summary-only file's hunk lines dropped while
  streaming, retained memory bounded by the Q19 and Q10 caps) is met, but retained memory
  itself is not measured: no seam in testing-seams.md observes it, and the seam list is
  user-confirmed. M10 reads the `size` rule's sizes in a `git diff -z --raw` size pass before
  the patch pass. The reader streams a file into its whole-file hash, counts and added lines
  (`startFold`) once it is bound to be summary-only: at its first hunk for the name rules,
  `generated` and `size`, at its 1001st changed line for `lines`; a `--text` pass streams
  every kept file the same way. So no summary-only file buffers more than 1000 changed lines
  (with their context), and its added lines stop at the 1 MB scan limit.
  `tests/plan-summary-cap.test.js` observes only the call order and count at Seam 1 (the
  size pass, at most one `cat-file --batch-check`, then the patch pass) and the unchanged
  output. The size pass repeats the patch pass's `-M` rename detection (M10). Fix: none
  planned (a memory seam would be a user decision). Slice: none.
- **KD-R100.** CHG-21's sed test (`tests/stage-whole-file.test.js`, "a sed clean filter file
  is committed as its cleaned form, with the plan hash") checks the plan's stored hash only
  indirectly: its last assert compares the committed blob to `git hash-object --path` run live
  over the current working file, not the `unit.hash` `plan --split` actually stored
  (`change-set.mjs`'s structured sha256 over the cleaned diff, CHG-10's hash table), and the
  match is implied only by `stage`'s own internal verify having passed (review-CHG-21 L4). A
  direct comparison would need the test to recompute that sha256 from the stored `state.json`
  unit, which reaches past Seam 1 into M10's internal hash format from a test file whose own
  header says it deliberately takes no in-process M10 seam (unlike the dedicated
  `change-set-*.test.js` files). Fix: none planned; the indirect check already fails if the
  committed blob differs from the cleaned form, which is what the criterion guards against.
  Revisit only if a cheap Seam-1-safe way to expose the stored hash appears, or the user
  accepts stretching this file's seam for one assert. Slice: none.
- **KD-R101.** User decision: (b), the rest via (c) (as KD-R77's). Every `snapshot`/
  `inventory` case in `tests/change-set-submodules.test.js` that checked a unit's path,
  oldPath, status, kind, hash or identityKey, a submodule's dirtySubmodules/clean report, or
  an embedded-repository report, is now rewritten at Seam 1: `plan --split` over a temp repo
  (or, for a reply-only "nothing" outcome, plain `plan`), reading `state.json`'s unit table
  (hash, identityKey, path, oldPath, status, kind), `plan.json`'s `tracked` list
  (added/deleted) and the inline hunk index (`range`, `body` kind, the patch text in
  `hunks.txt`) — never `snapshot`/`inventory` in-process. The remainder, truly unreachable at
  Seam 1 without stretching it or adding one: a unit's `addedLines` array (the per-`+`-line
  `{ line, text }` list Q11's hash table folds in, e.g. a symlink's new target text, or a
  file-to-submodule `T`'s new lines) never reaches Seam 1 output — `renderHunks`
  (`plugin/scripts/lib/hunk-index.mjs`) strips it in every branch (`file`, `cap`, `none`,
  summary-only) and the `state.json` unit table (`docs/contracts/run-folder.md`) does not
  carry it either, confirmed by reading both. The scanning behavior `addedLines` feeds is
  already provable through `plan`'s `scan.hits`/`scanLines` at Seam 1 and through M8's own
  Seam 3 table (C:scan-patterns); asserting the exact per-line array itself is M10-internal.
  Dropped assertions, all in `tests/change-set-submodules.test.js`: the symlink-target-change
  case's `addedLines` (`[{ line: 1, text: 'b.txt' }]`), the file-replaced-by-symlink and
  pointer-change cases' `addedLines: []`, and the submodule-replaced-by-a-file case's
  `addedLines` (`[{ line: 1, text: 'p' }, { line: 2, text: 'q' }]`). Fix: none planned; code
  reading only. Slice: none.
- **KD-R105.** The in-process `tests/run.test.js` M12 takeover cases (`peek`,
  `acquire({ takeOver })`, `finishTakeover`) call M12 directly, outside testing-seams.md's
  user-confirmed seam list (M12 is Seam 1 only, Seam 3 "—", testing-modules.md), the same gap
  KD-R77/KD-R84/KD-R101 name for other modules. RUN-21 moved two of these to Seam 1 once the
  fault preload's `COMMIT_TEST_FAULT_RENAME_BASENAME` could match a rename's source basename
  (`tests/plan-takeover.test.js`: the busy case, and the ENOENT-with-the-stale-lock-still-
  in-place case); the rest cannot move without a further preload change and stay here: a
  lock touched, or replaced, after the peek (same mtime, other bytes); a rename `ENOENT`
  with no lock at all in place; a link `EEXIST` after the rename (another call links its own
  lock in between); and `finishTakeover`'s `rmSync` order (old folder before the renamed
  lock) and its `rmSync` failure becoming a notice. The earlier (pre-RUN-21) M12 takeover
  cases share the same unrecorded gap, not only RUN-21's own new ones — this row covers the
  whole M12-in-process-beyond-Seam-1 gap. Also folds in two RUN-21-review hardening gaps in
  the same takeover code, left unfixed by design (optional, not a behaviour bug): `open`/
  `touch` read-then-`utimes` by path, not handle, so a stale holder's own `open`/`touch` can
  touch the *new* taker's lock if a takeover races in between (bounded damage); and a stale
  non-regular `lock` (a directory or symlink, hand-made only) can never be taken over. Fix:
  either add an "in-process adapter" seam to testing-seams.md (a user decision, as KD-R77's),
  or rebuild each case at Seam 1 as the preload gains the matching fault shape. Slice: none
  yet (needs the user's seam decision).

## Coverage

- **KD-R31.** GRD-05 tests deny precedence only against the bare row. Add pairs such as
  `--amend --squash=HEAD`, `--squash -n`, `-n --fixup=amend:x` (GRD-11's pairs, `git -c k=v
  commit --amend` and `git --unknown commit --amend`, are in `tests/guard-global-options.test.js`).
- **KD-R32.** EXE-20 has only the negative reword case; add a `post-commit` hook commit that
  fires the mismatch notice.
- **KD-R86.** `checkRefusalEnding`'s review-INT-02 N2 fix (`workflows.mjs`: release the run on
  a `timed-out` refusal only when `facts.commits === undefined`) has no Seam 1 or in-process
  case: today `commitAll` never returns a `timed-out` refusal, so the branch it guards
  (`commits` present alongside `timed-out`) is unreachable, and the fix is verified by code
  reading only (the two reachable `timed-out` sources — the pre-step check and `CHECK_STEPS`'
  own `runStepsWithin` — never set `commits`, so the fixed condition is equivalent to the old
  one for every case Seam 1 can build today). EXE-17 (a hung `git commit` killed at the
  deadline) is expected to be the first slice giving `commitAll` a timeout-shaped outcome
  with earlier groups already committed; its Seam 1 cases should add one through `check
  --plan` asserting the run stays open (lock and folder kept) rather than being released out
  from under `commitAll`'s own kept staging. Slice: EXE-17.
- **KD-R85.** INT-02's first end-to-end commit has no Seam 1 case exercising FND-10's
  `osUser` fault preload (`os.userInfo()` throwing, `USER=jdoe1`) over a passing `check`'s
  own state writes, so that coverage of `osUser` never being stored is lost for this path
  (review-INT-02 r1 Low-2, deferred as optional). Fix: once EXE-16's stepping-clock preload
  is in place for this path, add a case combining it with the FND-10 `osUser` fault over a
  `check --plan --all` that commits, asserting the commit's author/committer carry no
  `osUser` artifact. Slice: INT-02 follow-up or FND-10.
- **KD-R98.** INT-31's (row, producer) manifest (`tests/domain-code-reachability.test.js`)
  lists four pairs as gaps because the code producing them is not built: `env` via the entry
  point for an install path with a shell-special character (RPL-08), `killed-leftover`
  (RUN-24), `index-locked` via M18's takeover repair (RUN-23, RUN-25) and `timed-out` via
  M16's `git commit` deadline (EXE-17); EXE-12 already replaced its `git-failed` entry
  (`tests/commit-all-git-failed.test.js`). Fix: each
  slice replaces its gap entry with a Seam 1 case and drops its pair from this row. Slices:
  EXE-17, RPL-08, RUN-23, RUN-24, RUN-25.
- **KD-R99.** INT-31 AC2's own case (EXE-01 item 3: the FND-10 preload failing
  `fs.renameSync` on `state.json` with `EIO` on a `staged` run's `commit --all`, exit 1 with
  `sha` and "committed as `<sha>`, but the script failed") cannot be built: `commitAll` throws
  `notBuilt('commit --all in staged mode', 'EXE-19')` before any `git commit`, and `split`
  writes `state.json` (`indexReset`) before `git commit`, so the fault fires there with no
  `sha`; the preload cannot fail only a later rename. AC2 is INT-31's own criterion, not the
  accepted-gap list: INT-31 cannot close until this case exists. Fix: once EXE-19 and EXE-17
  land, add the case and drop this row. Slice: INT-31.
- **KD-R102.** RUN-21's last criterion (the takeover notice reaching the `text` of a
  `confirm` handback and of the `committed` reply) is covered only in part by
  `tests/plan-takeover.test.js`: the `confirm` handback and `commit --confirmed`'s
  `committed` reply (INT-09) carry the notice in `reply.notices`, but no reply `text` renders
  notices yet (the `Notices:` block is RPL-05's). Fix: once RPL-05 lands, assert the notice in
  the handback's and the `committed` reply's `text`, and drop this row. Slice: RUN-21 (with
  RPL-05).
- **KD-R104.** EXE-22's AC2/AC3 case (`tests/commit-all.test.js`, the `--confirmed` test)
  still forges `state.awaitingConfirm = true` through `threeGroupRun`'s `edit` hook instead
  of reaching `confirm` through a real `check` (RUN-18's route), unlike AC1
  (`tests/commit-open.test.js`, rebuilt over a real `check --plan` confirm handback:
  review-EXE-22 Low-2). `threeGroupRun` backs most of this file's multi-group budget-stop
  cases, so rebuilding it over three real new-file confirm handbacks is out of EXE-22's own
  scope. The same gap leaves the `unconfirmed`-before-`no-groups` order (C:commit-release
  phase (a)) untested: no case stores `awaitingConfirm` with zero stored groups, so only a
  tampered state (Q16's `Edit(**/.commit-plan/**)` gap) could show the order, and none exists
  (review-EXE-22 Low-3). Where: `tests/commit-all.test.js` `threeGroupRun`. Fix: once INT-09
  rebuilds the forged-state confirm-route cases over real `check` handbacks, add a
  three-group case the same way and, separately, a case with `awaitingConfirm` and zero
  stored groups (`unconfirmed`) next to a `--confirmed` case with zero stored groups
  (`no-groups`), and drop this row. Slice: INT-09 (confirm-route tests).

## Design sync

Plan text that depends on a design fix; fix the design and the slice together.

- **KD-R34. Cleanup budget contradiction** (CHG-03b, RUN-12, EXE-17). The slices say release
  and delete take no `timeoutMs`; M15, the `internal` row and C:plan time them against
  `cleanupDeadline`, and EXE-17 agrees with those. Fix: only git calls take the budget;
  amend M15 and both contracts, align EXE-17.
- **KD-R35.** RUN-12's "the reply still comes" past `cleanupDeadline` has no reply shape
  for a skipped tree-state read (PRE-15's Q25 tree-state exceptions do not cover it). Add the omission rule to C:reply-and-handback.
- **KD-R38.** C:plan and C:run-folder say `plan.json` holds `hunks`; M18 writes it at step 8,
  before `plan --hunks`. Pick one.
- **KD-R39.** MSG-03 and INF-04 use an M6 case-check export the spec does not list. Add it.
- **KD-R41. Tree notice alongside the first-parent notice** (EXE-06, EXE-14). Both checks
  are independent, so a hook commit fires both. State that the tree check runs only when
  the first parent matches; assert no tree notice in EXE-06. Q4's body was also rewritten
  in place (as Q9's was, restored by RUN-20b): restore it.
- **KD-R42.** The tree check has no reference tree in `reword` (EXE-20). Skip it there or
  compare with the expected HEAD's tree.
- **KD-R44.** The mismatch notice says "later groups refused" in single-group modes. Drop
  the clause there (contract, Q18, criteria).
- **KD-R45.** A hook-made commit is reported with the hook's SHA (EXE-06); no disposition is
  recorded. Record one in Q18 or the README.
- **KD-R47.** The `infer` state refusal is only in C:infer and C:cli-and-exit-codes: M18's
  `infer` steps lack it, the table sources it to M15, no Q7/Q21 amendment (KD-S20). INF-01
  implements it via M15 `planRefusal` over the probe (workflows.mjs `inferRefusals`); only
  the docs remain.
- **KD-R49.** The Q4 and Q18 amendments say "By spec pass 9"; they came later. Relabel.
- **KD-R50.** C:guard precedence is not in Q4's amendment; the `-c` text also serves
  `--config-env`; GRD criteria cite an undefined "(D2)". Amend Q4, cite "C:guard
  Precedence".
- **KD-R51.** The errno option and ESM sync of the fault preload sit under "Seams
  (confirmed by the user)" without the user's sign-off. Confirm or mark pending.
- **KD-R62.** GIT-01's not-a-repo classification cannot distinguish git's dubious-ownership
  refusal (`safe.directory`, git 2.34.2+/2.35.2+, common on shared or WSL mounts) from an
  actual non-repository; such a repo is reported as "not a git repository", which is
  misleading. Where: `plugin/scripts/lib/process-adapter.mjs` `toplevel`,
  `plugin/scripts/lib/repo-probe.mjs` `classifyNoWorkTree`. Fix: detect the refusal (e.g. from
  stderr text) and give it its own state or message. Slice: GIT-03 or GIT-04.
- **KD-R68.** A reword of a root commit in a shallow repo fails instead of succeeding.
  `rewordFacts.root` reads `true` for a shallow clone's boundary (graft) commit the same as
  a real root, because `rev-list --parents` prints no parents for either; diffing the graft
  against the empty tree would then silently hunk-index the whole repository, so `snapshot`'s
  `reword` branch diffs a shallow repo's root commit against `<head>^` instead (the fail-safe
  chosen over "accept and document", review-CHG-15 finding 1). `<head>^` never actually
  resolves there: the graft makes git read the boundary commit as parentless regardless of
  whether the real parent object happens to be present locally, so the diff always fails,
  surfacing to the caller as `internal` (`git diff failed (128)...`), a bug-shaped message for
  a legitimate repo state. Almost always masked by `pushed`, since such a HEAD is usually on a
  remote-tracking ref too, but an unpushed orphan-branch commit in a shallow clone (e.g. CI)
  still hits it. Where: `plugin/scripts/lib/change-set.mjs` `snapshot`'s `reword` branch. Fix:
  tell graft from true root precisely (`git cat-file commit <head>` prints the real `parent`
  lines regardless of the graft); refuse with a dedicated message when one is present,
  otherwise use the empty tree. Slice: CHG-15 (done; this is accepted interim behavior until
  revisited).
- **KD-R69.** EXE-11, CHG-20, RUN-23: now that CHG-05 leaves intent-to-add paths out of
  `preStaged`, a split run's `git reset -q -- .` drops a user's i-t-a mark on any path it
  resets; the worktree content stays, only the mark is lost. If that path's group never
  commits (a failure, a budget stop, or a takeover before it is reached), `unstaged` does
  not name it, because `unstagedAfterReset(preStaged, indexOnly)` is built only from those
  two — the i-t-a path is only in the stored `stagedNew` (review-CHG-05 r3 finding 1).
  Where: C:commit-release `unstaged`, EXE-11's `unstagedAfterReset` and report,
  RUN-23's repair. RUN-23 also needs a decision: if its "staged" check for the repair uses
  `--ita-visible-in-index`, a path that was intent-to-add before the run started reads as
  unstaged after the kill, falls outside the killed group's paths, and turns the repair
  into `killedLeftover` instead of a plain reset. Fix: read the stored `stagedNew` for
  i-t-a paths still uncommitted when building `unstaged`, or accept and document the loss.
  Slices: EXE-11, CHG-20, RUN-23.

- **KD-R83.** `commitCheckedGroups` (INT-02) skips `check`'s in-process commit and RUN-18's
  `afterCheck` routing (no `confirm` handback, no `handedBack` release), keeping the run with
  the pre-INT-02 output, whenever any group has a hunk-level file entry
  (`hunks !== null`): M16's (c) apply stages whole paths today, so routing a hunk-level group
  through it would also commit the file's other hunks, `notIncluded` ones included
  (review-INT-02 Medium-2). Removal is owned by INT-18's criterion, after CHG-20's hunk
  `stage` lands. Where: `plugin/scripts/lib/workflows.mjs` `commitCheckedGroups`. Fix: once
  CHG-20's `stage` commits only a group's own hunks, lift the gate as part of INT-18 (its
  criterion names this), routing it through `afterCheck` like a whole-file plan. Slices:
  CHG-20, INT-18.


- **KD-R71.** A worker-plan parse failure echoes V8's raw `JSON.parse` message, which can
  quote a snippet of the invalid JSON text verbatim (e.g. a secret-shaped fragment next to the
  syntax error). PLN-06's redaction (C:check) only covers scanned message text; this
  unscanned worker-plan text is not redacted. Where: `plugin/scripts/lib/plan-validator.mjs`
  `parseWorkerPlan`'s JSON-parse catch (review-PLN-06-r2, "Out of PLN-06 scope"). Fix: have
  `parseWorkerPlan` give a fixed reason instead of `err.message`, or scan/redact the snippet,
  if this is wanted. Slice: PLN-01 (done; this is accepted interim behavior until revisited).
- **KD-R72.** `resolvePath`'s "`<path>` is not a change" and "use the new path ... for the
  rename of `<path>`" lint errors echo the worker plan's own, unscanned path text verbatim
  for any `files`/`notIncluded` path the worker names that is not a real change. Where:
  `plugin/scripts/lib/plan-validator.mjs` `resolvePath` (review-PLN-06-r2, "Out of PLN-06
  scope"). Fix: scan or redact the path before quoting it, if this is wanted. Slice: PLN-02
  (done; this is accepted interim behavior until revisited).
- **KD-R74.** `stage`'s verify step runs its `check-attr` call against the **real** index
  after `git reset`/`git add -A`, while `plan`'s `snapshot` ran its `check-attr` call against
  the **temporary** index. The two disagree when a group deletes `.gitattributes` together
  with the tracked file it gave a `filter` attribute: `plan` still sees `.gitattributes`
  through the temporary index's working-tree-then-index fallback and classifies the file
  `filtered`; by the time `stage` queries the real index, `git add -A` has already removed
  `.gitattributes` from it, so the file reads as plain `text` and the verify diff splits into
  hunks, refusing `mismatch` (review-CHG-10-r2 finding 11; fails safe, the index is reset,
  and the case is rare — editing or adding `.gitattributes` stays consistent because the
  working tree wins on both sides). Where: `plugin/scripts/lib/change-set.mjs` `stage`
  (the `checkAttrs` call ahead of its verify `diffUnits`). Fix (reviewer-suggested): build
  `stage`'s attrs map straight from the stored units it is given (`kind === 'filtered'`)
  instead of a fresh `check-attr` call, which would also drop a git call per group. Not
  applied: `docs/spec/modules-m10-m13.md`'s `stage` entry mandates exactly "one `check-attr`
  call over the group's paths so a filtered file hashes as its stored unit", so the
  reviewer's fix contradicts the spec as written. Amend that spec line first (derive from
  the stored `kind` instead of a fresh call) if this is wanted, then land the code change
  and a seam test for the probe above. Slice: CHG-10 (done; this is accepted interim
  behavior, fails safe, until revisited).
- **KD-R76.** A budget stop (EXE-16) builds its `continue` handback with S2 `build()`
  (`commit-executor.mjs`), which throws a `TypeError` for an install path holding `"`, `$`,
  a backtick, `!` or a control character. Until RPL-08 adds the up-front `env` refusal for
  such a path, a budget stop that lands on one turns group 1's otherwise-clean exit 0 into an
  `internal` exit 1 after that group was already committed (review-EXE-16-r2 finding L3).
  Where: `plugin/scripts/lib/commit-executor.mjs` `budgetStop`. Fix: none needed in EXE-16;
  RPL-08's `env` refusal runs before any group starts, so this stops being reachable once
  RPL-08 lands. Slice: RPL-08 (closes this row).
- **KD-R81.** POSIX detached session: `process-adapter.mjs`'s `run` spawns every git child with
  `detached: process.platform !== 'win32'`, which calls `setsid`, so each child gets a new
  session and process group. Until GIT-08's `killActive` lands, two effects stay unwritten: (a)
  a group-wide `SIGINT`/`SIGTERM` from Esc, Ctrl-C or session end no longer reaches git,
  `git commit` and its hooks included (no timeout of their own until EXE-17), the exact risk
  architectural-decisions.md:26-29 and Q9:219 guard against — so an Esc can orphan a
  `git commit` that later lands a commit; (b) the children lose the controlling terminal, so
  anything that prompts on `/dev/tty` (an `ssh-keygen` passphrase, an interactive hook) fails
  (review-GIT-07 finding Medium-3). Where: `plugin/scripts/lib/process-adapter.mjs` `run`'s
  spawn options. Fix: none needed beyond GIT-08 landing as scheduled; this row documents the
  gap until then. Slice: GIT-08 (closes this row; also blocked on PRE-13, RUN-04, RUN-20,
  INT-02, so this window may be long).
- **KD-R93.** C:reply-and-handback's `callerRule` entry says the handback rule is "added
  when `handback` is set" — every kind, not only `lock`. `reply` (`plugin/scripts/lib/reply.mjs`)
  only appends `HANDBACK_RULE` for a `lock` handback; `modeChoice` (RUN-13) and `continue`
  (INT-02) replies still carry the base rule alone, with no handback rule at all. Today's
  `modeChoice` and `lintFailed` (RUN-16) handbacks are stubs — `{kind, question}` with no
  `answers` yet — so a rule saying "run the only answer" / "ask with `AskUserQuestion`; the
  answers..." has nothing to act on; applying it now would describe a shape the reply does
  not yet carry. The code comment on `HANDBACK_RULE` defers the other kinds to "later slices"
  without a KD row (review-INT-05 finding 4). Where: `plugin/scripts/lib/reply.mjs` `reply()`,
  the `callerRule` ternary. Fix: once the slice that completes those handbacks lands, apply
  `HANDBACK_RULE` whenever `handback !== null` and drop the `lock`-only ternary (or confirm a
  kind-specific rule text is wanted instead and amend the contract). Slices: RPL-08 (Handback
  commands and caller-trust fixtures) closes this row once every handback kind carries real
  answers and the rule.
- **KD-R94.** RUN-17's Seam-1 coverage of C:confirmation-triggers' `staged` no-trigger row
  (`confirm: null`) is missing. INT-09 moved the skipped/`scanIgnore` and `resumed` `staged`
  rows to Seam 1 (`tests/run-policy-confirm.test.js`, through the `confirm` route). The
  no-trigger row still routes to `commit`, where `commitAll` throws `notBuilt('commit --all in
  staged mode', 'EXE-19')` before `check`'s real output can reach the caller, caught only by
  `commit.cjs`'s top-level handler as an `internal` failure with no `confirm` field; it and
  the unreachable "resumed but not interactive" row stay pure-unit ("pure fallback
  (KD-R94)"). Where: `plugin/scripts/lib/commit-executor.mjs` `commitAll`;
  `tests/run-policy-confirm.test.js`. Fix: rebuild the no-trigger row once EXE-19 lands; then
  drop this row. Slice: EXE-19.
- **KD-R96.** CHG-18's stdout budget (C:plan-hunks, Q9) covers only the hunk index: past it,
  the full index spills to `hunks.json` and stdout "keeps everything else". `oldMessage`
  (reword) and `recentSubjects` carry no bound of their own, so a reword of a commit whose
  message is itself over 20 000 characters, or an unusually long run of `recentSubjects`,
  still prints stdout past the budget even after the spill. The implementation
  (`hunk-index.mjs` `renderHunks`) follows the contract as written; this is a contract gap,
  not a bug. Fix: amend C:plan-hunks (and Q9) to cap or spill `oldMessage` and
  `recentSubjects` too, or accept the gap explicitly and drop this row.

## Bookkeeping

- **KD-R53.** CFG-03 lacks a wrong-JSON-type case such as `body: 1` → `config` (not
  `body: "required"`).
- **KD-R55.** CHG-17's Gates line restates its PRE-15 blocker. Delete the line.
- **KD-R56.** CHG-16 states the 1 MB rule it hands to SCN-13; CHG-12's Sources omit story
  219.
- **KD-R57.** The README claims the blocking edges were checked against each slice's
  criteria (KD-R5 to KD-R7 disprove it).
- **KD-R59.** Sources lines omit stories their criteria cite: CFG-10 (112), INT-18 (91),
  INT-29 (19), INT-30 (63), WRK-02 (228), WRK-06 (43, 47-49, 79, 151,
  213).
- **KD-R60.** CHG-03b cites "C:plan (step 7)" and counts the `plan.json` write in step 7; M18
  writes it at step 8. C:run-folder's "Versioned" bullet omits `plan.json`.

## Suggested order

1. KD-R1 (on both critical paths).
2. KD-R34 (a design sync before RUN-12 or EXE-17), then KD-R35.
3. KD-R16, KD-R29, KD-R51 and KD-R4 (optional).
4. The CHG-03b area: KD-R60.
5. KD-R5, KD-R6.
6. Design sync: KD-R38, KD-R39; KD-R41 with KD-R42 to KD-R44 and KD-R18; KD-R47;
   KD-R49, KD-R50, KD-R45.
7. Edges: KD-R7, KD-R10.
8. Test mechanisms: KD-R21, KD-R22, KD-R23, KD-R26.
9. The rest of the text and bookkeeping items.
