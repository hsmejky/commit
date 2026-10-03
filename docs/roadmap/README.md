# Implementation roadmap for 0.1.0

Tracer-bullet vertical slices for the `commit@commit` plugin, one file per group. Each slice
names what it builds, its exact blockers (`Blocked by`), its status (`ready-for-agent` or
`needs-human`), its sources (decisions Q1-Q25, contracts `C:<name>`, spec sections, stories)
and checkable acceptance criteria at the seam the spec assigns. Slices cite sections and file
names, never line numbers.

IDs are `<PREFIX>-<NN>`, numbered in dependency order within a group, and the rule "a blocker
in the same group always has a lower number" still holds for every edge. IDs are never
renumbered: a removed or merged slice leaves a gap (for example SCN-08, SCN-10, GRD-09,
RPL-10 and INT-03), and a new slice takes the next free number in its group. A slice that
must come before an existing one takes a letter suffix and sorts just after its base ID:
CHG-03b comes after CHG-03 and before CHG-04, RUN-20b after RUN-20 and before RUN-21. The
dependency graph has no cycles and every ID a `Blocked by` line names exists; FND-09 checks
this mechanically as a repo test, and the blocking edges were checked against each slice's
criteria during the review refinement (not just for existence). Known open defects of the
plan are listed in [known-deficiencies.md](known-deficiencies.md) (KD-R IDs): check it before
starting a slice it names.

## Groups

| File | Prefix | Slices | needs-human | Delivers |
| --- | --- | --- | --- | --- |
| 00-prerequisites-and-spikes.md | PRE | 16 | 12 | spikes, manual checks, repo config prerequisite, story and text wording (PRE-15), managed-settings path and CI permissions spike (PRE-16) |
| 01-foundation.md | FND | 10 | 0 | repo skeleton, seam harnesses, stepping clock, fault-injection preload (FND-10), CI matrix, privacy guard, manifest skeleton, roadmap graph check (FND-09) |
| 02-guard.md | GRD | 20 | 1 | S1 heartbeat, S2 ScriptCall, G1-G3, deny catalogue, hook registration; GRD-08 also covers the former GRD-09 |
| 03-message-grammar.md | MSG | 8 | 0 | M6 message grammar, lint, trailers, reword carry-over |
| 04-config-and-attribution.md | CFG | 11 | 1 | M4 config loader, M5 attribution resolver |
| 05-scanner.md | SCN | 15 | 0 | M7 glob matcher, M8 scanner; the prefixed, connection and generic pattern rows are one slice (SCN-06) |
| 06-git-adapters.md | GIT | 12 | 0 | M2 process adapter (missing git at Seam 1 in GIT-01), M3 repo-state probe, M11 signing probe |
| 07-change-set.md | CHG | 24 | 0 | M9 path classifier, M10 change-set engine, M13 hunk index; step 7's run lock and ordered state writes (CHG-03b) |
| 08-plan-validation.md | PLN | 7 | 0 | M14 plan validator |
| 09-runs.md | RUN | 28 | 4 | M12 run, lock, folder, takeover; M15 run policy; the run-lock (RUN-20) and takeover (RUN-20b) decision passes |
| 10-commit-executor.md | EXE | 24 | 1 | M16 commit executor, reword, failures, hooks and signing at commit time |
| 11-reply-and-cli.md | RPL | 9 | 0 | M1 CLI and envelope, domain code → CLI kind, M17 reply and handback, lock replies under `--no-user` (RPL-05) |
| 12-integration.md | INT | 21 | 2 | M18 workflows no component slice builds: walking skeleton (INT-01), first end-to-end commit (INT-02), widenings, handback kinds, round trips, domain-code row coverage (INT-31) |
| 13-worker-and-skills.md | WRK | 8 | 3 | commit-worker agent, `/commit` skill, worker protocol, hand-tests |
| 14-infer-and-commit-config.md | INF | 9 | 1 | M19 inference, `infer`, `/commit-config` skill |
| 15-release.md | REL | 6 | 2 | manifests, README (with the first-time-reader overview, REL-03b), 0.1.0 release checks |
| **Total** | | **228** | **27** | |

Not a group: [known-deficiencies.md](known-deficiencies.md) lists open defects of the plan
(KD-R IDs) with the slices they affect and a suggested fix order.

Component slices build their own behaviour, wire it into the subcommand that uses it and test
it at Seam 1 themselves (RUN, EXE, CHG and RPL each hang their M12, M15, M16, M10 or M17
call on the M18 step that needs it). INT keeps only the paths no component slice builds: the
walking skeleton, the first end-to-end commit and the widenings of it, the handback kinds
that span several components, the round trips, the hand-tests and the domain-code row
coverage. INT-01 is the walking skeleton (`plan` on a clean repo prints a reply): every
component tested only at Seam 1 hangs its tracer on it. INT-02, the first end-to-end commit
(the "First slice" of Further Notes), closes `plan` → `check` → `commit` for one group of
modified tracked files, with no confirmation, trailer, scan wiring or guard notice; later
slices widen it.

## Can start immediately

Agent work: none (PRE-01, PRE-03, PRE-09, PRE-10 and FND-01 are done).
Human work: PRE-02, PRE-05, PRE-11, PRE-13, PRE-16.

After FND-01 → FND-03 → FND-04 → RPL-01, the walking skeleton INT-01 opens most groups.
FND-09 (agent work, the roadmap graph check) also starts right after FND-01.

## Critical paths

- Walking skeleton: FND-01 → FND-03 → FND-04 → RPL-01 → INT-01 (5 slices).
- First end-to-end commit (INT-02), 15 slices: FND-01 → FND-03 → FND-04 → RPL-01 → INT-01 →
  GIT-01 → CFG-02 → RUN-05 → GIT-02 → CHG-03 → CHG-03b → CHG-04 → CHG-05 → EXE-02 → INT-02.
  RPL-03 can take INT-01's place (an equally long chain). CHG-03b takes the run lock at
  step 7; the path is the thin one only (no confirmation, trailer, scan wiring or guard
  notice): RUN-06 (which follows CHG-03b), RUN-18, MSG-07, CHG-16/SCN-15 and INT-27 widen
  it. INT-02's PRE-08 spike (off the chain) is done.
- Release (REL-05), 30 slices: FND-01 → FND-03 → FND-04 → RPL-01 → INT-01 → GIT-01 → CFG-02 →
  RUN-05 → GIT-02 → CHG-03 → CHG-03b → RUN-06 → PLN-01 → PLN-06 → CFG-05 → CFG-06 → CFG-07 →
  SCN-14 → RUN-17 → RUN-18 → EXE-22 → INT-09 → INT-10 → INT-15 → INT-16 → INT-17 → INT-28 →
  INT-29 → INT-30 → REL-05. Here too RPL-03 can take INT-01's place.

## Open issues and what they gate

Each open item is a `needs-human` slice; nothing it gates may start before it is done. The
Gates column lists the slices blocked by it directly; slices marked *(transitive)* reach it
only through another gated slice, named in parentheses.

| Slice | Open item | Gates |
| --- | --- | --- |
| PRE-16 | managed-settings directory path per OS and the CI permissions to write it | CFG-11 |
| PRE-02 | personal commit skill removed before spikes and dogfooding | PRE-04, PRE-06, PRE-12, GRD-21, WRK-06 |
| PRE-04 | spike: hook `if` condition on compound commands | GRD-18 |
| PRE-05 | spike: heartbeat under the sandbox | GRD-15; GRD-17 *(transitive, via GRD-15)* |
| PRE-06 | spike: exec-form hooks in a plugin | PRE-07, GRD-18, REL-02; GRD-19 *(transitive, via PRE-07)* |
| PRE-07 | guard cold start measured, target set | GRD-19 |
| PRE-11 | spike: project directory and `CLAUDE_PROJECT_DIR` | CFG-10 |
| PRE-12 | spike: README allow rules and the worker's shell | WRK-02, REL-02 |
| PRE-13 | spike: how a tool call is terminated | GIT-08, EXE-24 |

Hand-tests and manual checks (PRE-14, GRD-21, RUN-10, RUN-26, INT-29, INT-30, WRK-06 to
WRK-08, INF-09, REL-04) gate only the release (REL-05) and each other.

## Spec deficiencies: dispositions

Minor and nit items of the spec's [known deficiencies](../spec/known-deficiencies.md) that
no decision slice settles. Their disposition for 0.1.0:

- Accepted as written (the slices follow the contract as it stands; no further decision):
  KD-S11, KD-S13, KD-S14, KD-S21 to KD-S23, KD-S35, KD-S37, KD-S39, KD-S40, KD-S42 to
  KD-S44, KD-S46 and KD-S49 to KD-S51.
- Covered at slice level: KD-S45 (changes read only through `hunks.txt`, WRK-02) and
  KD-S48 (heartbeat location, GRD-15 and GRD-17).
- Settled and deleted: the story-wording and text rows by PRE-15, the run-lock rows by
  RUN-20 and the takeover rows by RUN-20b (see those slices' records).
- KD-S20 (`infer` rows missing from the error table): INF-01 follows C:infer; the table rows
  and the unborn-HEAD outcome are a documentation sync.
- KD-S41 (kill-timeout cases): EXE-17 asserts no commit for a killed `pre-commit` hook and a
  reported `sha` for a sleeping `post-commit` hook, as testing-seams Seam 1 now states.
- KD-S52 could not be confirmed (no stale text was pinned down); no slice action.

## Story coverage

Every story in the spec (1-229; number 216 does not exist) is cited by at least one slice.
Story 63 (grouping quality) is checked by hand in WRK-06 and again in the dogfood run
(INT-30); story 79 (intent scope) is checked by hand in WRK-06 only. Story 205 (main-session
cost) is the 1.0.0 dogfood gate and out of scope here.

## Accepted gaps

- Only a Node below 22 cannot be produced on the CI runners; it is checked by hand in
  REL-04. A missing git is produced in CI (a PATH with no git) and tested in GIT-01.
- A temporary lock left by cleanup on Windows (file in use) is reported, not tested on every
  leg.

## Out of scope for 0.1.0

The episode-analysis tools (Q24), the 1.0.0 dogfood gate (story 205) and the Haiku worker
evals.
