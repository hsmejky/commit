# Implementation roadmap for 0.1.0

Tracer-bullet vertical slices for the `commit@commit` plugin, one file per group. Each slice
names what it builds, its exact blockers (`Blocked by`), its status (`ready-for-agent` or
`needs-human`), its sources (decisions Q1-Q25, contracts `C:<name>`, spec sections, stories)
and checkable acceptance criteria at the seam the spec assigns. IDs are `<PREFIX>-<NN>`,
numbered in dependency order within a group; a blocker in the same group always has a lower
number. The dependency graph has no cycles and every referenced ID exists.

## Groups

| File | Prefix | Slices | needs-human | Delivers |
| --- | --- | --- | --- | --- |
| 00-prerequisites-and-spikes.md | PRE | 15 | 10 | spikes, manual checks, repo config prerequisite, story and text wording (PRE-15) |
| 01-foundation.md | FND | 8 | 1 | repo skeleton, seam harnesses, stepping clock, CI matrix, privacy guard, manifest skeleton |
| 02-guard.md | GRD | 21 | 1 | S1 heartbeat, S2 ScriptCall, G1-G3, deny catalogue, hook registration |
| 03-message-grammar.md | MSG | 8 | 0 | M6 message grammar, lint, trailers, reword carry-over |
| 04-config-and-attribution.md | CFG | 11 | 1 | M4 config loader, M5 attribution resolver |
| 05-scanner.md | SCN | 16 | 0 | M7 glob matcher, M8 scanner |
| 06-git-adapters.md | GIT | 12 | 0 | M2 process adapter, M3 repo-state probe, M11 signing probe |
| 07-change-set.md | CHG | 23 | 0 | M9 path classifier, M10 change-set engine, M13 hunk index |
| 08-plan-validation.md | PLN | 7 | 0 | M14 plan validator |
| 09-runs.md | RUN | 27 | 3 | M12 run, lock, folder, takeover; M15 run policy |
| 10-commit-executor.md | EXE | 24 | 1 | M16 commit executor, reword, failures, hooks and signing at commit time |
| 11-reply-and-cli.md | RPL | 10 | 0 | M1 CLI and envelope, domain code → CLI kind, M17 reply and handback |
| 12-integration.md | INT | 30 | 2 | M18 workflows: walking skeleton (INT-01), first end-to-end commit (INT-02), widenings, round trips |
| 13-worker-and-skills.md | WRK | 8 | 3 | commit-worker agent, `/commit` skill, worker protocol, hand-tests |
| 14-infer-and-commit-config.md | INF | 9 | 1 | M19 inference, `infer`, `/commit-config` skill |
| 15-release.md | REL | 5 | 2 | manifests, README, 0.1.0 release checks |
| **Total** | | **234** | **25** | |

Component slices own behaviour; INT slices own the wiring. INT-01 is the walking skeleton
(`plan` on a clean repo prints a reply): every component tested only at Seam 1 hangs its
tracer on it. INT-02, the first end-to-end commit (the "First slice" of Further Notes),
closes `plan` → `check` → `commit` for one group of modified tracked files, with no confirmation, trailer, scan
wiring or guard notice; later slices widen it.

## Can start immediately

Agent work: PRE-01, PRE-03, PRE-08, PRE-09, PRE-10, FND-01.
Human work: PRE-02, PRE-05, PRE-11, PRE-13, PRE-15, FND-06, CFG-01, RUN-20, EXE-01.

After FND-01 → FND-03 → FND-04 → RPL-01, the walking skeleton INT-01 opens most groups.

## Critical paths

- Walking skeleton: FND-01 → FND-03 → FND-04 → RPL-01 → INT-01 (5 slices).
- First end-to-end commit (INT-02), 14 slices: INT-01 → GIT-01 → CFG-02 → RUN-05 → GIT-02 → CHG-03 →
  CHG-04 → CHG-05 → EXE-02 → INT-02. It is the thin path only (no confirmation, trailer, scan
  wiring or guard notice); RUN-18, MSG-07, CHG-16/SCN-15 and INT-27 widen it.
- Release (REL-05), 29 slices: INT-01 → GIT-01 → CFG-02 → RUN-05 → GIT-02 → CHG-03 → CHG-06 →
  CHG-08 → CHG-10 → CHG-11 → CHG-16 → SCN-15 → RUN-15 → CHG-14 → PLN-04 → RUN-17 → RUN-18 →
  INT-09 → INT-21 → INT-22 → RPL-08 → INT-28 → INT-29 → INT-30 → REL-05. The change-set chain
  into confirmation (CHG-06 to RUN-18) is the bottleneck: staff it right after CHG-03.

## Open issues and what they gate

Each open item is a `needs-human` slice; nothing it gates may start before it is done.

| Slice | Open item | Gates |
| --- | --- | --- |
| PRE-15 | story wording that disagrees with decisions or contracts; `signing-locked` and six refusal texts not recorded | GRD-17, GIT-11, CHG-17, PLN-03, INT-17, WRK-01, REL-03 |
| CFG-01 | `scanIgnore`: HEAD vs stored patterns in the backstop, which units are flagged, repo-config path for `snapshotBlob`, `scanIgnoreChanged` wording, repo config invalid at HEAD but fixed in the worktree | CFG-07, SCN-14, CHG-16, EXE-13, INT-16 |
| EXE-01 | `osUser` missing from M14/M16 interfaces, cleanup past `cleanupDeadline`, M16 `internal` path trigger, failure JSON examples without `reply` | PLN-06, EXE-13, INT-07, INT-15, INT-21, INT-22 |
| RUN-20 | ten takeover and run-lock items, incl. who removes `call.lock` on exit | GIT-08, RUN-21, RUN-23, RUN-25, RPL-09, INT-06, INT-13 |
| FND-06 | privacy test file set and segment matcher | FND-07 |
| PRE-04, PRE-05, PRE-06, PRE-07, PRE-11, PRE-12, PRE-13 | spikes | GRD-18, GRD-15, GRD-18/REL-02, GRD-19, CFG-10, WRK-02/REL-02, GIT-08/EXE-24/INT-23 |

Hand-tests and manual checks (PRE-14, GRD-21, RUN-10, RUN-26, INT-29, INT-30, WRK-06 to
WRK-08, INF-09, REL-04) gate only the release (REL-05) and each other.

## Story coverage

Every story in the spec (1-229; number 216 does not exist) is cited by at least one slice.
Stories with no automated check: 63 (grouping quality) and 79 (intent scope) are checked
only by hand (WRK-06) and in the dogfood run (INT-30); 205 (main-session cost) is the 1.0.0
dogfood gate and out of scope here.

## Accepted gaps

- The M16 `internal` failure path has no Seam 1 trigger unless EXE-01 adds a test-only fault
  seam.
- Node below 22 and a missing git cannot be produced on the CI runners; checked by hand in
  REL-04.
- A temporary lock left by cleanup on Windows (file in use) is reported, not tested on every
  leg.

## Non-gating doc fix

One open wording question, which INF-01 settles when it starts: C:infer does not say
whether `too-few-commits` also nulls `ccShare` (it nulls `wouldFail` and `proposal`).

## Out of scope for 0.1.0

The episode-analysis tools (Q24), the 1.0.0 dogfood gate (story 205) and the Haiku worker
evals.
