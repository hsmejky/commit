# Modules

| Module | Kind | Depends on |
| --- | --- | --- |
| M1 CLI and envelope | effectful (stdout, exit code) | M18, M12 (pure `isValidPlanId` only) |
| M2 Process adapter | effectful | — |
| M3 Repo-state probe | effectful, read-only | M2 |
| M4 Config loader | effectful, read-only; pure merge and validation | M2, M7 |
| M5 Attribution resolver | effectful, read-only | M6 |
| M6 Message grammar | pure | — |
| M7 Glob matcher | pure | — |
| M8 Scanner | pure | M7 |
| M9 Path classifier | pure | — |
| M10 Change-set engine | effectful (temporary and real index) | M2, M9 |
| M11 Signing probe | effectful | M2 |
| M12 Run | effectful | M2, M10 |
| M13 Hunk index renderer | pure | — |
| M14 Plan validator | pure | M6, M8 |
| M15 Run policy | pure | — |
| M16 Commit executor | effectful (clock injected) | M3, M6, M7, M8, M10, M12, M15 |
| M17 Reply and handback | pure | S2 |
| M18 Subcommand workflows | effectful orchestration | all M modules except M1; S1 |
| M19 History inference | pure | M4 (pure `validateLayer` and `DEFAULT_VALUES` only), M6 |
| S1 Heartbeat | effectful | — |
| S2 ScriptCall | pure | — |
| G1 Hook I/O | effectful (Claude home, now injected) | G2, G3, S1 |
| G2 Shell tokenizer | pure | — |
| G3 Command classifier and deny catalogue | pure | S2 |

No cycles; an edge from a pure module reaches only pure exports (M19 uses M4's pure
`validateLayer` and `DEFAULT_VALUES`, never its file reads). The former G4 (deny messages) is
data inside G3, so a new deny case edits one module. The finer split (M7 apart from M4, M11
apart from M3, M13 apart from M17) is kept because each of those modules has its own
contracts table as a test oracle and its own consumers (M7 also serves M8; M13 renders for
the worker, M17 for the caller). The episode-analysis tools (Q24) are a maintainer utility
outside the plugin package and outside this module map. Decisions for them: the input is
Claude Code session transcripts (the source of the Q24 baseline), the worker's own
transcripts included for worker tokens; an episode (glossary) starts at the first
main-thread commit attempt after a user prompt (a `git commit` shell call, denied or not, or
an Agent call spawning `commit:commit-worker`) and ends at the main-thread turn that presents
the last reply before the next user prompt that is not an answer to a handback question; each
episode records its delivery shape and episode class, and the output is the Dogfood gate's
measures ([Story verification](story-verification.md)).
The tools are built for the 1.0.0 gate, after 0.1.0 ships; no 0.1.0 slice depends on them.
