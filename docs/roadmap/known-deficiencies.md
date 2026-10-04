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
  roadmap criterion currently names this gap. Fix: add it as an explicit INT-02-or-later
  criterion, or a dedicated slice, before 0.1.0 closes.
- **KD-R90.** PLN-04's pinned example for a left-out scan hit ("src/b.js:14 github-token
  left out") names a line number; the built notice omits it
  (`plugin/scripts/lib/plan-validator.mjs` `notIncludedResult`, which emits
  `` `${path} ${patternId} left out` ``). `state.json`'s `scanned` map (`buildScanMap`,
  `plugin/scripts/lib/workflows.mjs`) stores only the pattern IDs a unit hit, never the
  `(path, line)` pair that produced them; the stored unit table carries no `addedLines`
  either. Widening `scanned`'s stored shape to carry a line would also reach
  `plugin/scripts/lib/hunk-index.mjs` (`renderHunkIndex`), which reads `scanMap[id]` as
  `string[] | "skipped"` for the public `hunks.json`/`hunks.txt` `"scan"` field
  (C:plan-hunks) — out of PLN-04's scope to touch. Fix: store the line per hit alongside its
  pattern ID in `buildScanMap`/`state.json`, and widen `hunk-index.mjs`'s read of it to
  match. Slice: PLN-04 (criterion as pinned), M13.

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
- **KD-R89.** PLN-05's `staged`/`reword` AC1 ("a group naming only some files still holds
  every unit") and AC2 (`newFiles`) are asserted on M14 `validatePlan` directly
  (`tests/plan-staged-reword-group.test.js`), not through `check`'s own output: `check`'s
  success path goes straight on to `commit --all` in-process, and M16's execution for
  `staged`/`reword` is not built yet (EXE-19, EXE-20). INT-14 covers a staged commit
  end-to-end but no criterion checks that a plan naming only some files still commits every
  staged unit, or `newFiles` in `check`'s output; INT-24 covers reword but not
  `newFiles: []`. Fix: once EXE-19/EXE-20 land, add subprocess `check --plan` success cases
  to `tests/plan-staged-reword-group.test.js`: staged with a partial `files` list still
  commits every unit and reports `newFiles` from the index diff; reword output has
  `newFiles: []`. Slice: PLN-05, EXE-19, EXE-20.
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
  streaming, retained memory bounded by the Q19 and Q10 caps) is neither met nor testable.
  No seam in testing-seams.md observes retained memory. M10 also decides summary-only after
  the patch pass (`withBodyRules` in `change-set.mjs`): the `size` rule needs a size read
  after the stream. So a summary-only file's body is held until `snapshot` returns and is
  dropped only then. Only the added lines stay bounded (1 MB per file, CHG-16). A capped
  file's body is kept on purpose (Q19: the cap limits the worker's context, not the tool
  output; CHG-20 splits a capped file by its ranges), so it is outside this row. Fix: read
  the sizes from a `--raw` pass before the patch pass, then decide per file in the reader
  (`finishSection`). Relaxing the criterion to "bodies dropped before M13" instead would
  amend Q11 and M10, a user decision. Slice: CHG-17 (criterion 4).
- **KD-R88.** CHG-17's review-Medium-2 case in `tests/plan-summary-cap.test.js` ("M10 keeps
  the body of a capped unit") calls `snapshot` in-process, outside testing-seams.md's
  user-confirmed seam list, the same gap KD-R77 names for M2/M11. Seam 1 cannot observe a
  capped unit's body today: M13 leaves it out of `hunks.txt`, and `stage` still adds whole
  files. Fix: once CHG-20 stages a capped file split across two groups from its ranges, prove
  it at Seam 1 and drop this case; or add an "in-process adapter" seam (a user decision, as
  KD-R77's). This row is scoped to that one case; the earlier `tests/change-set-*.test.js`
  files call M10 in-process the same way and remain unrecorded. Slice: CHG-20.

## Coverage

- **KD-R30.** EXE-10 may leave the phase (c) `diff-changed` uncovered, which fails INT-31
  unless the README lists it. EXE-10 adds the accepted-gap entry.
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
- **KD-R43.** EXE-06 states the first-parent rule without its `reword` exception. Add it.
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
  Where: C:commit-release `unstaged`, CHG-20's `unstagedAfterReset`, EXE-11's report,
  RUN-23's repair. RUN-23 also needs a decision: if its "staged" check for the repair uses
  `--ita-visible-in-index`, a path that was intent-to-add before the run started reads as
  unstaged after the kill, falls outside the killed group's paths, and turns the repair
  into `killedLeftover` instead of a plain reset. Fix: read the stored `stagedNew` for
  i-t-a paths still uncommitted when building `unstaged`, or accept and document the loss.
  Slices: EXE-11, CHG-20, RUN-23.

- **KD-R83.** `commitCheckedGroups` (INT-02) skips `check`'s in-process commit, keeping the
  run with the pre-INT-02 output, whenever any group has a hunk-level file entry
  (`hunks !== null`): M16's (c) apply stages whole paths today, so routing a hunk-level group
  through it would also commit the file's other hunks, `notIncluded` ones included
  (review-INT-02 Medium-2). Removal is owned by INT-18's criterion, after CHG-20's hunk
  `stage` lands. Where: `plugin/scripts/lib/workflows.mjs` `commitCheckedGroups`. Fix: once
  CHG-20's `stage` commits only a group's own hunks, lift the gate as part of INT-18 (its
  criterion names this). Slices: CHG-20, INT-18, RUN-18.


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

## Bookkeeping

- **KD-R53.** CFG-03 lacks a wrong-JSON-type case such as `body: 1` → `config` (not
  `body: "required"`).
- **KD-R55.** CHG-17's Gates line restates its PRE-15 blocker. Delete the line.
- **KD-R56.** CHG-16 states the 1 MB rule it hands to SCN-13; CHG-12's Sources omit story
  219.
- **KD-R57.** The README claims the blocking edges were checked against each slice's
  criteria (KD-R5 to KD-R7 disprove it).
- **KD-R59.** Sources lines omit stories their criteria cite: CFG-10 (112), INT-18 (91),
  INT-24 (176, 177), INT-29 (19), INT-30 (63), WRK-02 (228), WRK-06 (43, 47-49, 79, 151,
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
7. Edges: KD-R7, KD-R30, KD-R10.
8. Test mechanisms: KD-R21, KD-R22, KD-R23, KD-R26.
9. The rest of the text and bookkeeping items.
