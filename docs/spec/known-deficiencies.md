# Known deficiencies

Open defects in the design documents (spec, contracts, decisions) that are known but not yet
fixed. Each item names the problem, where it lives, its impact, the suggested resolution
and, where one exists, the roadmap slice that settles it. Citations follow the spec
convention: `Qn` is a decision in [decisions](../decisions/README.md), `C:<section>` a file
in [contracts](../contracts/README.md). Plan-level defects are in the
[roadmap's known deficiencies](../roadmap/known-deficiencies.md). When an item is fixed,
delete it here; IDs are never reused.

## Concurrency and takeover (Q9, Q22)

Settle these before the takeover slices; most belong to [RUN-20b](../roadmap/09-runs.md).

- **KD-S1. Unbuildable takeover test case.** The run-integrity case "a takeover whose
  index repair resets the killed group's staging and leaves a mixed index → `modeChoice`"
  cannot occur: the repair is `git reset -q`, which leaves the index equal to HEAD. Where:
  [testing-modules.md](testing-modules.md) (M18 takeover cases), Q22 amendment,
  [C:run-folder](../contracts/run-folder.md). Impact: a specified fixture fails as written.
  Fix: replace it with `killedLeftover` → forced `modeChoice` carrying the takeover,
  `killedLeftover` and `unstaged` notices, and a reset under `--take-over X --staged` →
  `staged-empty` carrying the reset notice; amend Q22. Slice: RUN-20b (5).
- **KD-S2. A failed index repair is undefined.** If the takeover's repair fails (a
  foreign `index.lock`, a timeout), nothing says whether `finishTakeover` runs: if it
  does, the evidence is deleted with the index unrepaired; if not, the old folder is left
  unlocked (KD-S4's state). Where: [C:run-folder](../contracts/run-folder.md),
  [C:plan](../contracts/plan.md) step 3, M12 and M18 ([modules-m10-m13.md](modules-m10-m13.md),
  [modules-m14-m19.md](modules-m14-m19.md)). Impact: a killed group's staging can be lost
  or left unguarded. Fix: on a repair failure keep the taken-over folder, the renamed lock
  and the run's own lock so the next takeover follows the chain; reply with the notices
  collected so far; add a fixture. Slice: RUN-20b (3).
- **KD-S3. `--take-over` of a run that already ended.** Reachable through the `lock`
  handback (the run ends while the user decides). The `call.lock` rule then maps the
  `ENOENT` to `taken-over` ("taken over by another /commit"), which is false; Q22's
  rename-`ENOENT` "retry the link" rule is in neither the contracts nor M12 `acquire`, and
  Q9's rejection argues the case is unreachable. Where: Q9, Q22,
  [C:run-folder](../contracts/run-folder.md), [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md),
  M12. Impact: false message, two inconsistent `ENOENT` rules. Fix: define it as `ended`
  ("that run has already ended"), or carry the retry rule into contracts and M12 with a
  fixture; correct Q9's rationale. Slice: RUN-20b (4).
- **KD-S4. Orphan renamed lock after a kill.** A kill between renaming the lock to
  `lock.<planId>` and linking the new lock leaves no `lock`; the next `peek` takes the
  no-takeover path, the repair never runs and a `--staged` run could commit the killed
  group's partial staging. Where: [C:run-folder](../contracts/run-folder.md), Q22, M12
  `acquire`/`peek`. Fix: `peek` treats an orphan `lock.<planId>` as a stale lock and
  follows the chain, or the window is recorded as an accepted gap. Slice: RUN-20b (1).
- **KD-S5. `finishTakeover` deletion order unspecified.** A kill midway can leave a renamed
  lock pointing at a deleted folder, so a pending `killedLeftover` is forgotten. Where: M12
  ([modules-m10-m13.md](modules-m10-m13.md)), [C:run-folder](../contracts/run-folder.md).
  Fix: delete folders first, the renamed lock last; a renamed lock without its folder is
  removed. Slice: RUN-20b (2).
- **KD-S6. `modeChoice` answer vs the call's mode flag.** A respawn carries its answer plus
  the producing call's mode flag, so a forced `modeChoice` from `plan --take-over X
  --staged` answered `split` carries both; no rule says which wins, and the handback table
  still gives the `modeChoice` source as "`plan` without a mode flag". Where:
  [C:plan](../contracts/plan.md), [C:reply-and-handback](../contracts/reply-and-handback.md),
  Q9, [testing-modules.md](testing-modules.md). Impact: a `split` choice may run as
  `staged`. Fix: the answer replaces the flag; fix the table row; add a `split`-answer
  fixture. Slice: RUN-20 (6).
- **KD-S7. "A `--take-over` respawn cannot fall back to a `modeChoice`" overstated.** False
  when the refused call was a bare first-spawn `plan`. Where: [C:plan](../contracts/plan.md),
  [C:reply-and-handback](../contracts/reply-and-handback.md). Fix: qualify it with "when
  the refused call had a mode flag". Slice: RUN-20b (7).
- **KD-S8. `notices` omits unstored takeover notices.** The reply `notices` definition
  covers "the notices `plan` stored", not the step-3 takeover notices of an early ending.
  Where: [C:reply-and-handback](../contracts/reply-and-handback.md),
  [C:run-folder](../contracts/run-folder.md). Fix: add them to both definitions. Slice:
  RUN-20b (8).
- **KD-S9. Q9 body rewritten in place.** Its amendment quotes a sentence no longer in the
  body, unlike other decisions. Fix: restore the original sentence and let the amendment
  supersede it. Slice: RUN-20b (9).
- **KD-S10. "Between the inventory and taking the lock" wrong on the takeover path.** After
  a step-3 takeover the lock is taken before the inventory. Where: `head-moved` and
  `diff-changed` rows of [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md),
  [C:plan](../contracts/plan.md) step 7. Fix: say "since the inventory". Slice: RUN-20 (12).

## Error handling and cleanup

- **KD-S11. A throw between `create` and `acquire` leaks the provisional folder.** The
  try/finally covers only steps after `acquire`; an `internal` throw at steps 3-7 leaves
  the folder to the 24-hour sweep, against "no outcome without a lock leaves a folder".
  Where: [domain-code-cli-kind.md](domain-code-cli-kind.md), M18,
  [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md) `internal` row,
  [C:run-folder](../contracts/run-folder.md). Fix: discard the provisional run on such a
  throw, in spec and contract.
- **KD-S13. "Cannot leave `git commit` as an orphan" is unqualified.** Out of Scope accepts
  that a hard kill can orphan a commit, tool-call termination is an open verification
  item, and Windows delivers no catchable SIGTERM. Where:
  [architectural-decisions.md](architectural-decisions.md), [out-of-scope.md](out-of-scope.md).
  Fix: add "when the harness delivers a catchable signal". Disposition: accepted for 0.1.0.
- **KD-S14. Timeout text hard-codes "9 min".** A later group may start with 480 s left.
  Where: M16, [C:commit-release](../contracts/commit-release.md), Q18. Fix: compute the
  minutes or say "within the call's time budget". Disposition: accepted for 0.1.0.

## Error tables and API contract

- **KD-S15. `lock` error row incomplete.** Missing: a persisting link error whose hard-link
  probe succeeds → `busy`, and a late `ENOENT` on `call.lock` or the folder →
  `taken-over` (only C:run-folder and architectural-decisions prose have it). Where:
  [domain-code-cli-kind.md](domain-code-cli-kind.md),
  [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md). Impact: the tables are not
  a complete cause list for tests. Fix: add both causes to both tables. Slice: RUN-20 (11),
  which wrongly records this as settled (roadmap KD-R9).
- **KD-S18. No field for domain sub-codes.** The failure JSON has `kind` and `message`
  only, so `held`, `busy`, `taken-over`, `index-changed` … differ only by text; the spec
  table uses codes the contracts never define. Fix: add `error.code` and list every code
  in the contract, or state that sub-codes live only in `message`.
- **KD-S20. `infer` missing from the spec error table.** C:infer refuses outside a repo or
  in a bare repo; [domain-code-cli-kind.md](domain-code-cli-kind.md) has no `infer` rows,
  and unborn HEAD (success with zero samples?) is implicit. Fix: add the rows, state the
  unborn outcome in [C:infer](../contracts/infer.md) and Q7.
- **KD-S21. Error table heading "owned by M18".** The table also holds M1 `usage` rows and
  the entry point's `env` row. Fix: retitle.
- **KD-S22. `git-failed` producer cell garbled.** It names `check` as a producer. Fix:
  `git commit` non-zero (M16) plus the temporary-index `git add` (M10 via M18 in `plan`
  and `plan --hunks`, via M16 in commit phase b); align both contract tables.
- **KD-S23. Worker input cannot carry multi-line text.** `key: value` lines cannot hold a
  multi-paragraph dictated reword or `edit`; `reword: true` is ambiguous. Where:
  [C:worker-input](../contracts/worker-input.md). Fix: make `reword`/`edit` run to the end
  of the prompt, or define a block form; add a two-paragraph fixture.

## Module interfaces

- **KD-S25. No M12 operation removes `call.lock`.** M12 says it is removed at call end and
  by the signal handler; no function owns it. Where: [modules-m10-m13.md](modules-m10-m13.md),
  [C:run-folder](../contracts/run-folder.md). Fix: an idempotent, `ENOENT`-tolerant
  `run.close()` called from M18's `finally` and the signal handler. Slice: RUN-20 (10).

## Testing

Privacy-guard test (Q15); settled by [FND-06](../roadmap/01-foundation.md):

- **KD-S30. Self-test file set wider than the guard's.** The self-test scans all tracked
  files, including fixtures that legitimately hold service-user paths, so it fails where
  the guard passes. Where: [testing-modules.md](testing-modules.md), Q15. Fix: use the
  guard's file set.
- **KD-S31. The segment check cannot use `scanText`.** `scanText` always applies the
  service-user list (`runner`, `root`) and the length rule, so it finds nothing by
  construction. Fix: the test owns a one-line segment regex (stated, with its reason), or
  `scanText` gains an exemption-off option.
- **KD-S32. Tracked-only scan skips new files** until `git add`. Fix: say so, or also scan
  non-excluded untracked files in the set.
- **KD-S33. Main privacy test scans "docs" unscoped**, so untracked review reports fail a
  local `npm test`. Fix: scan `git ls-files`, the self-test's set.
- **KD-S34. "Any user name" overstates `local-path`**, which skips placeholder and
  service-user names. Fix: reword.

Other test gaps ([testing-modules.md](testing-modules.md), [testing-seams.md](testing-seams.md)):

- **KD-S35. PATH git shims cannot work on Windows.** Shell-less spawn finds only
  `.com`/`.exe`; no case is marked POSIX-only and no `git.exe` shim or argv log is
  specified. Fix: specify a compiled Windows shim and the log format, or mark the cases
  POSIX-only. Disposition: accepted for 0.1.0 (roadmap KD-R21).
- **KD-S36. No oracle-skip class for PowerShell 5.1 `&&`/`||`.** Fix: an edition-specific
  skip class; only the oracle differs per edition. Disposition: resolved by PRE-03: the
  oracle reads command elements whatever parse errors are reported (`p51-and` matches;
  C:guard, Oracle-skip classes).
- **KD-S37. Hook registration check ignores the `if` condition** (Q13); a mismatch
  silently disables the heartbeat. Fix: assert `if` matches every S2 `build` output.
  Disposition: accepted for 0.1.0.
- **KD-S39. Heartbeat and stderr redaction untested** (story 21). Fix: canary text absent
  from both outputs; a 300-character command cut to 200. Disposition: accepted for 0.1.0.
- **KD-S40. git-2.34 container job prerequisites unstated**: Node install, `openssh-client`
  for the M11 probe, skipped cases. Disposition: accepted for 0.1.0.
- **KD-S41. Kill-timeout cases leave about 5 s of real time** (clock stepped to 535 s);
  flaky on cold Windows runners. Fix: step to 530 s for hook-recording cases.
- **KD-S42. No test rows for `scanIgnoreChanged` and the backstop `--text` pass**: another
  key edited → false, invalid JSON → true, multi-hunk config, config renamed away,
  attribute-hidden `--text`. Fix: add them to the M4 and M6-M9 rows. Disposition: accepted
  for 0.1.0.

## Performance

- **KD-S43. 4 kB `text` budget ignores the multi-group confirm block** (20 files per
  group, uncapped groups); the size test has no confirm fixture. Where: Q24,
  [C:reply-and-handback](../contracts/reply-and-handback.md). Fix: exempt the confirm lists,
  or add a group cap or larger budget with a multi-group fixture. Disposition: accepted
  for 0.1.0.

## Decision fidelity and provenance

- **KD-S44. Open items labelled "introduced by this spec"** in [further-notes.md](further-notes.md)
  (guard cold start, tool-call termination) are already in
  [open verification items](../decisions/open-verification-items.md); the story-217 gate
  and revision rule have no source. Fix: drop the labels, record or drop the rule.
- **KD-S45. Worker prompt lacks "no git diff of its own"** (Q12): only `Read` is limited.
  Where: [prompt-only-and-manifest-blocks.md](prompt-only-and-manifest-blocks.md). Fix:
  read changes only through `hunks.txt` and run no other git command. Slice: WRK-02.
- **KD-S46. Dogfood gate lacks Q24's diff-size formula** (`git diff HEAD --numstat` plus
  `hunks.txt` tokens) and "the price-weighted ratio is a proxy only". Where:
  [story-verification.md](story-verification.md). Disposition: accepted for 0.1.0.
- **KD-S48. Heartbeat relocation drops Q23's constraints**: writer and reader both reach
  it, and not `os.tmpdir()`. Where: [further-notes.md](further-notes.md),
  [open verification items](../decisions/open-verification-items.md). Slices: GRD-15,
  GRD-17.
- **KD-S49. Code-level mechanics in Implementation Decisions** (`os.userInfo()`,
  `spawnSync`, `process.kill(pid, 0)`, `%SystemRoot%\System32` …), against the spec's own
  rule and Q15's wording. Fix: restate as behaviour. Disposition: accepted for 0.1.0.
- **KD-S50. Bare-name privacy gap missing from Out of Scope**, which claims to be the one
  gap list (Q15 accepts it). Disposition: accepted for 0.1.0.
- **KD-S51. The review-report exclude line (Q15) is not mentioned** in
  [further-notes.md](further-notes.md). Disposition: accepted for 0.1.0.
- **KD-S52. Three superseded texts remain in decision bodies**: Q9's `env` path set lacks
  Q16's typographic quotes; Q11's NUL-byte binary rule (limited by Q10); Q17's oversized
  subagent file rule (narrowed to no-user runs). Fix: amend or mark superseded.

## Story wording

Each story below disagrees with the decision or contract it cites, so a test written from
the story would assert the wrong behaviour. [PRE-15](../roadmap/00-prerequisites-and-spikes.md)
settles them. Files: [entry and guard](stories-entry-and-guard.md),
[worker and grouping](stories-worker-and-grouping.md),
[config, messages and scan](stories-config-messages-scan.md),
[failures and runs](stories-failures-and-runs.md).

| ID | Story | What is wrong | Fix |
| --- | --- | --- | --- |
| KD-S53 | 65 | every unit "with ID, path, kind and range"; summary-only entries have no kind or range (C:plan-hunks) | except summary-only entries |
| KD-S54 | 110 | misses a non-integer `maxSubjectLength` and an empty `types` (Q6); M4 test row too | add both |
| KD-S56 | 52 | omits that every respawn repeats `mode` (and `takeOver` only from `lock`); says "resumed run" | name both; "respawned run" |
| KD-S57 | 51, 53 | no story says a handback `run` output holds a new reply handled the same way | state it |
| KD-S58 | 57 | every notice repeated in `text`; lists cap at 10 plus "+N more" | add the cap |
| KD-S60 | 62 | "run nothing"; contract adds "show the whole message" | append it |
| KD-S61 | 40 | single planning call only for "a one-group run"; it applies to every first spawn | reword |
| KD-S62 | 103 | treats `--no-user` as a caller option; it is the worker's flag under `interactive: false` | reword |
| KD-S63 | 150 | misses `**` inside a segment, `\`, empty pattern, `..` segment; tag lacks Q6 | add them and Q6 |
| KD-S64 | 185 | not-a-repo or bare "reported as an error"; it is a `state` refusal (exit 6) | reword |
| KD-S65 | 67 | identical hunks only "in the same group"; also all in `notIncluded` (Q11, C:check); M14 too | "same placement" |
| KD-S66 | 147 | all `GIT_*` ignored; Q9 keeps a keep-set for script calls and strips only redirecting variables for `git commit` | name the keep-set |
| KD-S68 | 58 | "until the reply"; a handback is a reply, callerRule says "final reply" | "final reply" |
| KD-S69 | 54 | "with no extra logic"; `edit` goes under Other, `question: null` is never asked | "the callerRule alone tells me how" |
| KD-S70 | 44 | final report always the script's reply; the fallback reply is worker-built | add the fallback |
| KD-S71 | 61 | lists three separators; the contract refuses six, redirection included | list all six |
| KD-S72 | 228 | omits the 200-character description and 1.5 kB `SKILL.md` budgets (Q24) | add both |
