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
- **KD-R14.** CHG-19's "map unchanged" after `diff-changed` has no observable; say "run
  ended".
- **KD-R15.** CFG-07's `isRepoConfigPath` and `REPO_CONFIG_PATH` criterion names no seam
  (its inputs are listed); an in-process M4 call has the same problem as KD-R28.
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

## Test mechanisms

- **KD-R21. PATH git shims** (RUN-06, RUN-12, GIT-01, EXE shim cases) do not work on
  Windows and their argv/env log is undefined (KD-S35). Fix: a shim paragraph in
  testing-seams (POSIX script, compiled `.exe`, log format) or mark cases POSIX-only.
  GIT-05's argument/env case needs no shim: the spawn-record preload logs each spawn's
  `GIT_*` environment (`gitEnv`) on every platform.
- **KD-R22.** RUN-12's first clock step fires before the provisional folder exists, so the
  discard is never exercised; its `plan --hunks` deadline case has no clock setup or
  observable. Tie the step to "folder exists, no lock"; add setup and exit code.
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
- **KD-R28.** CFG-07's direct `validateLayer` call is an in-process test Seam 3 does not
  allow. Drop it (INF-07 covers it) or add M4 to Seam 3 and amend group 04's header.
- **KD-R29.** FND-10's ESM check does not import `node:fs/promises`; add it.

## Coverage

- **KD-R30.** EXE-10 may leave the phase (c) `diff-changed` uncovered, which fails INT-31
  unless the README lists it. EXE-10 adds the accepted-gap entry.
- **KD-R31.** GRD-05 tests deny precedence only against the bare row. Add pairs such as
  `--amend --squash=HEAD`, `--squash -n`, `-n --fixup=amend:x` (GRD-11's pairs, `git -c k=v
  commit --amend` and `git --unknown commit --amend`, are in `tests/guard-global-options.test.js`).
- **KD-R32.** EXE-20 has only the negative reword case; add a `post-commit` hook commit that
  fires the mismatch notice.
- **KD-R33.** RUN-12's `internal`-throw path to `cleanupDeadline` is untested; combine an
  FND-10 `EIO` on the `plan.json` rename with a clock step past 540 s.
- **KD-R64.** RUN-05's `plan` turns a provisional folder it cannot discard into a notice.
  RPL-04's `planRefusalFailure` now passes `plan`'s collected notices into every refusal's
  `reply.notices` (the `nothing` reply already carried them), so this is fixed for refusals,
  RUN-07's `lock` refusal included. An `internal` throw still drops them (the outcome stays
  right). Fix: RUN-12 passes `plan`'s collected notices into its `internal` output.

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
- **KD-R46.** No M3 operation reads HEAD's first parent (GIT-02, EXE-06). Add
  `parentOf(sha)` or a `firstParent` field; root commit → `null`.
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
- **KD-R68.** GIT-09's `rewordFacts` reports `root: true` for a shallow clone's boundary
  (graft) commit, because `rev-list --parents` prints no parents for it, even though that
  commit is not actually a root commit. CHG-15 would then diff it against the empty tree
  instead of its real (unfetched) parent. Where: `plugin/scripts/lib/repo-probe.mjs`
  `rewordFacts` (review-GIT-09 finding 7). In practice almost always masked by `pushed`,
  since such a HEAD is usually on a remote-tracking ref too. Fix: CHG-15 checks `git
  rev-parse --is-shallow-repository`, or this is accepted and documented. Slice: CHG-15.
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

- **KD-R70.** CHG-08 leaves CHG-11's gap interim: a NUL-free text file hidden by `-diff`,
  `binary` or a `diff` driver is reported by git as binary and gets `kind: "binary"`,
  `body: "none"`, hashed over blob IDs, instead of Q11/C:plan-hunks's `kind: "text"` with its
  added lines scanned. The scanner is not wired yet (CHG-16) and CHG-11 fixes the
  classification, so the impact is interim only (review-CHG-08 finding 2). Where:
  `plugin/scripts/lib/change-set.mjs` (binary classification). Fix: none needed beyond
  CHG-11 landing as scheduled; this row documents the gap until then. Slice: CHG-11.

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
2. KD-R34 (a design sync before RUN-12 or EXE-17), then KD-R35, KD-R33 and KD-R64.
3. KD-R28, then KD-R16, KD-R29, KD-R51 and KD-R4 (optional).
4. The CHG-03b area: KD-R60.
5. KD-R5, KD-R6.
6. Design sync: KD-R38, KD-R39; KD-R41 with KD-R42 to KD-R44 and KD-R18; KD-R46; KD-R47;
   KD-R49, KD-R50, KD-R45.
7. Edges: KD-R7, KD-R30, KD-R10.
8. Test mechanisms: KD-R21, KD-R22, KD-R23, KD-R26.
9. The rest of the text and bookkeeping items.
