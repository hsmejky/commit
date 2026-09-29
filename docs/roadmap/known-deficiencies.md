# Known deficiencies in the roadmap

Open defects in the slicing, blockers and acceptance criteria of this plan. None blocks the
frontier; check this file before starting a slice it names. Design-level defects are in the
[spec's known deficiencies](../spec/known-deficiencies.md) (KD-S IDs). When an item is
fixed, delete it here; IDs are never reused.

## Slicing

- **KD-R1. CHG-03 is a horizontal slice** (07). Its one criterion, "no path is parsed out
  of patch text", names no seam or observable and cannot fail, yet CHG-03 is on the INT-02
  and REL-05 critical paths. Fix: move it into CHG-03b as a Seam 1 case with a path patch
  headers render differently (a tab, or `a b/c`), asserting `hunks.hunks[].path` equals the
  raw path; merge CHG-03 into CHG-03b (update counts and critical paths) or label it
  build-only.
- **KD-R2. INT slices repeat component criteria** (12, 09, 10). INT-13 repeats RUN-13,
  INT-05 repeats RUN-07's `peek` cases, INT-09's `unconfirmed` case repeats EXE-22; INT-05
  promises an untested "race lost at `acquire`". Fix: keep only handback-shape assertions
  in INT; test or drop the race.
- **KD-R3. EXE-24 re-asserts GIT-08's teardown.** Fix: limit EXE-24 to "no commit after the
  kill" and the `indexReset` case.
- **KD-R4. INF-07 waits needlessly** behind CFG-07 (and so EXE-01, needs-human)
  though it needs only the `scanIgnore` glob compile. Optional fix: a CFG-03b "`validateLayer`
  compiles `scanIgnore`" blocked by CFG-03 and SCN-03, blocking CFG-07 and INF-07.

## Blocking edges

- **KD-R5.** CHG-11 needs CHG-09 (symlink `T` unit); CHG-21 needs CHG-09 and CHG-14. Add the
  edges.
- **KD-R6.** CHG-11's scan criteria (secret found, `scan.skipped` over 1 MB) need CHG-16 and
  SCN-13, which it does not reach. Move them to SCN-16 or add the blockers.
- **KD-R7.** SCN-12's symlink-target case needs SCN-13. Add the edge or drop the case.
- **KD-R8.** EXE-01 asks PLN-06, EXE-06, EXE-13, EXE-16, EXE-17, INT-07, INT-15 to cite its
  decisions, but EXE-06 and EXE-16 are not blocked by it and INT-31 is blocked but not
  listed. Align the list with the edges.
- **KD-R9. RUN-20 over-gates GIT-08 and misfiles items** (09, 06). GIT-08 waits on item 6,
  which it does not use; item 12 is takeover-only but sits in the basics pass; item 11 is
  marked settled though the error tables lack late `ENOENT` → `taken-over` (KD-S15, KD-S10).
  Fix: drop RUN-20 from GIT-08, move item 12 to RUN-20b, reopen item 11 as a doc sync.
- **KD-R10.** RUN-23, RUN-24, RUN-25 list RUN-20b directly although RUN-21 already carries
  it. Drop the edges or note they are kept for reading.

## Acceptance criteria

- **KD-R11. Criteria no test can observe.** GIT-01's `windowsHide` and "never decodes
  stdout"; PLN-06's static signature test (needs a Seam 1 `local-path` case, SCN-11 as
  blocker, and M14's signature, KD-S24); four WRK-04 worker-behaviour bullets. Fix: a
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
- **KD-R20.** RUN-20b demands an **Amended** bullet for items 5, 8 and 9 (KD-S1, KD-S8,
  KD-S9), which change no decision. Allow a documentation-sync note.

## Test mechanisms

- **KD-R21. PATH git shims** (RUN-06, RUN-12, GIT-01, GIT-05, EXE shim cases) do not work on
  Windows and their argv/env log is undefined (KD-S35). Fix: a shim paragraph in
  testing-seams (POSIX script, compiled `.exe`, log format) or mark cases POSIX-only.
- **KD-R22.** RUN-12's first clock step fires before the provisional folder exists, so the
  discard is never exercised; its `plan --hunks` deadline case has no clock setup or
  observable. Tie the step to "folder exists, no lock"; add setup and exit code.
- **KD-R23.** RUN-09's Windows retry-window holder releases on an unnamed event (timing
  dependent). Name a marker file.
- **KD-R24.** RUN-09's stubbed probe failure and `busy` cases have no mechanism and end in a
  hedge. Base them on FND-10 (`EPERM` → retries → probe → `busy`; `ENOTSUP` →
  `run-folder`); fix a probe basename prefix or move the case to RUN-10 as a gap.
- **KD-R25.** CHG-04 fires the `clean` filter during the inventory, which precedes the
  fingerprint, so no `diff-changed` fires. Fire it during the step-5 snapshot diff, or fix
  the step order in C:plan.
- **KD-R26.** RUN-04's late-`ENOENT` → `taken-over` case has no trigger (the stub call ends
  at once) and cites a row that lacks it (KD-S15). Move it after EXE-02 or add an FND-10
  fault mode.
- **KD-R27.** RUN-06's HEAD-moving shim cannot tell step 7's HEAD read from step 1's. Key it
  to the first HEAD read after `.commit-plan/lock` exists.
- **KD-R28.** CFG-07's direct `validateLayer` call is an in-process test Seam 3 does not
  allow. Drop it (INF-07 covers it) or add M4 to Seam 3 and amend group 04's header.
- **KD-R29.** FND-10's ESM check does not import `node:fs/promises`; add it.

## Coverage

- **KD-R30.** EXE-10 may leave the phase (c) `diff-changed` uncovered, which fails INT-31
  unless the README lists it. EXE-10 adds the accepted-gap entry.
- **KD-R31.** GRD-05 and GRD-11 test deny precedence only against the bare row. Add pairs
  such as `--amend --squash=HEAD`, `--squash -n`, `-n --fixup=amend:x`, `git -c k=v commit
  --amend`, `git --unknown commit --amend`.
- **KD-R32.** EXE-20 has only the negative reword case; add a `post-commit` hook commit that
  fires the mismatch notice.
- **KD-R33.** RUN-12's `internal`-throw path to `cleanupDeadline` is untested; combine an
  FND-10 `EIO` on the `plan.json` rename with a clock step past 540 s.

## Design sync

Plan text that depends on a design fix; fix the design and the slice together.

- **KD-R34. Cleanup budget contradiction** (CHG-03b, RUN-12, EXE-17). The slices say release
  and delete take no `timeoutMs`; M15, the `internal` row and C:plan time them against
  `cleanupDeadline`, and EXE-17 agrees with those. Fix: only git calls take the budget;
  amend M15 and both contracts, align EXE-17 (related KD-S12).
- **KD-R35.** RUN-12's "the reply still comes" past `cleanupDeadline` has no reply shape
  for a skipped tree-state read (KD-S67). Add the omission rule to C:reply-and-handback.
- **KD-R36.** Same as KD-R9's item 11: add late `ENOENT` to both error tables (KD-S15).
- **KD-R37.** M12's `provisional` has no write, yet CHG-03b requires `state.json` written
  before `acquire`. Add `provisional.write`.
- **KD-R38.** C:plan and C:run-folder say `plan.json` holds `hunks`; M18 writes it at step 8,
  before `plan --hunks`. Pick one.
- **KD-R39.** MSG-03 and INF-04 use an M6 case-check export the spec does not list. Add it.
- **KD-R40.** CHG-03b's "no folder after a throw before `acquire`" rests on a general
  sentence (KD-S11). Add `internal` to C:run-folder's lockless outcomes.
- **KD-R41. Tree notice alongside the first-parent notice** (EXE-06, EXE-14). Both checks
  are independent, so a hook commit fires both. State that the tree check runs only when
  the first parent matches; assert no tree notice in EXE-06. Q4's body was also rewritten
  in place (as KD-S9): restore it.
- **KD-R42.** The tree check has no reference tree in `reword` (EXE-20). Skip it there or
  compare with the expected HEAD's tree.
- **KD-R43.** EXE-06 and EXE-01 state the first-parent rule without its `reword` exception.
  Add it.
- **KD-R44.** The mismatch notice says "later groups refused" in single-group modes. Drop
  the clause there (contract, Q18, criteria).
- **KD-R45.** A hook-made commit is reported with the hook's SHA (EXE-06); no disposition is
  recorded. Record one in Q18 or the README.
- **KD-R46.** No M3 operation reads HEAD's first parent (GIT-02, EXE-06). Add
  `parentOf(sha)` or a `firstParent` field; root commit → `null`.
- **KD-R47.** The `infer` state refusal is only in C:infer and C:cli-and-exit-codes: M18's
  `infer` steps lack it, the table sources it to M15, no Q7/Q21 amendment (KD-S20).
- **KD-R48. README dispositions contradict slices** (README, PRE-15, RUN-20). Stories 185,
  147 and 196 (KD-S64, KD-S66, KD-S38) are "settled" or "accepted" yet on PRE-15's list;
  the fallback reply's tree-state exemption (KD-S67) has no Q25 amendment. Pick one
  disposition each and amend Q25.
- **KD-R49.** The Q4 and Q18 amendments say "By spec pass 9"; they came later. Relabel.
- **KD-R50.** C:guard precedence is not in Q4's amendment; the `-c` text also serves
  `--config-env`; GRD criteria cite an undefined "(D2)". Amend Q4, cite "C:guard
  Precedence".
- **KD-R51.** The errno option and ESM sync of the fault preload sit under "Seams
  (confirmed by the user)" without the user's sign-off. Confirm or mark pending.

## Bookkeeping

- **KD-R53.** CFG-03 lacks a wrong-JSON-type case such as `body: 1` → `config` (not
  `body: "required"`).
- **KD-R54.** The README RUN-20 gate row names only one path to RUN-24 (also via RPL-09).
- **KD-R55.** CHG-17's Gates line restates its PRE-15 blocker. Delete the line.
- **KD-R56.** CHG-16 states the 1 MB rule it hands to SCN-13; CHG-12's Sources omit story
  219.
- **KD-R57.** The README claims the blocking edges were checked against each slice's
  criteria (KD-R5 to KD-R7 disprove it).
- **KD-R58.** EXE-01 item 3 and the README's `internal` gap do not name FND-10's `EIO`
  fault as the candidate seam.
- **KD-R59.** Sources lines omit stories their criteria cite: CFG-10 (112), INT-18 (91),
  INT-24 (176, 177), INT-29 (19), INT-30 (63), WRK-02 (228), WRK-06 (43, 47-49, 79, 151,
  213).
- **KD-R60.** CHG-03b cites "C:plan (step 7)" and counts the `plan.json` write in step 7; M18
  writes it at step 8. C:run-folder's "Versioned" bullet omits `plan.json`.

## Suggested order

1. KD-R1 (on both critical paths).
2. KD-R34 (a design sync before RUN-12 or EXE-17), then KD-R35 and KD-R33.
3. KD-R28, KD-R36, KD-R37, then KD-R16, KD-R29, KD-R51 and KD-R4 (optional).
4. The CHG-03b area: KD-R24, KD-R40, KD-R60, KD-R58.
5. KD-R5, KD-R6.
6. Design sync: KD-R38, KD-R39; KD-R41 with KD-R42 to KD-R44 and KD-R18; KD-R46; KD-R47;
   KD-R9, KD-R48 and KD-R36 with the Q25 amendment; KD-R49, KD-R50, KD-R45.
7. Edges: KD-R54, KD-R9, KD-R7, KD-R30, KD-R8, KD-R10.
8. Test mechanisms: KD-R21, KD-R22, KD-R23, KD-R25, KD-R26, KD-R27.
9. The rest of the text and bookkeeping items.
