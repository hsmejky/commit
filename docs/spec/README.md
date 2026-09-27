# Spec: commit plugin 0.1.0

What the `commit@commit` plugin does, for whom, and how it is split into modules.
[decisions](../decisions/README.md) (Q1-Q25, the why) and [contracts](../contracts/README.md) (data shapes,
grammars, tables) are the source of truth. Decisions this spec introduced beyond those
documents are recorded there as `**Amended.**` bullets.

Citations: `Qn` is a decision, file `qNN-*.md` in [decisions](../decisions/README.md);
`C:<section>` is a contracts section, file `<section>.md` in [contracts](../contracts/README.md).

## Contents

- [Problem Statement](problem-statement.md): Why agent-run `git commit` goes wrong: bad grouping, leaked secrets, message drift, shell-quoting breaks, and unexplained failures.
- [Solution](solution.md): How `commit@commit` works: a worker groups changes via a deterministic script that scans, lints, confirms and commits, behind a guard hook.
- User Stories
  - [User stories: entry points and guard](stories-entry-and-guard.md): Stories 1-39: `/commit` entry points and triggering, and the guard's detection, allowlist and heartbeat rules.
  - [User stories: worker, grouping and confirmation](stories-worker-and-grouping.md): Stories 40-104: worker protocol and handback, caller trust, atomic grouping into hunks, intent scope, and confirmation.
  - [User stories: config, messages and scan](stories-config-messages-scan.md): Stories 105-159: config layers, attribution trailers, message lint, `commit-config` inference, and secret/path scanning.
  - [User stories: failures, repo states and runs](stories-failures-and-runs.md): Stories 160-229: failures, hooks and signing, time budgets, reword via amend, repo states, and concurrent runs.
- Implementation Decisions
  - [Glossary](glossary.md): Defines terms used throughout the spec: run, episode, worker, intent, unit, mode, reply, handback, and more.
  - [Constraints](constraints.md): Hard limits: no npm dependencies, which external processes are spawned, and the guard's behavior on every shell call.
  - [Architectural decisions](architectural-decisions.md): Cross-cutting design: module layering, typed results, injected environment, async processes, run ownership and locking.
  - [Domain code → CLI kind (owned by M18)](domain-code-cli-kind.md): Table mapping each domain failure code to its CLI kind and exit code, plus post-`acquire` cleanup and takeover logic.
  - [Modules](modules.md): Dependency table for all modules (M1-M19, S1-S2, G1-G3) and the rules governing the module graph.
  - [Modules M1-M9](modules-m1-m9.md): M1 CLI, M2 process adapter, M3 repo probe, M4 config loader, M5 attribution, M6 message grammar, M7 glob matcher, M8 scanner, M9 path classifier.
  - [Modules M10-M13](modules-m10-m13.md): M10 change-set engine, M11 signing probe, M12 run and lock management, M13 hunk index renderer.
  - [Modules M14-M19](modules-m14-m19.md): M14 plan validator, M15 run policy, M16 commit executor, M17 reply and handback, M18 subcommand workflows, M19 history inference.
  - [Modules S1-S2 and G1-G3](modules-shared-and-guard.md): S1 heartbeat, S2 script-call recognizer, G1 hook I/O, G2 shell tokenizer, G3 command classifier and deny catalogue.
  - [Prompt-only and manifest blocks](prompt-only-and-manifest-blocks.md): Prompt text for the commit-worker agent, the `/commit` and `/commit-config` skills, hook registration, README and manifests.
  - [Other repo configurations](other-repo-configurations.md): How case-only renames, sparse checkout/skip-worktree, and non-UTF-8 commit encoding repos are handled.
  - [Dependency policy](dependency-policy.md): Why the plugin has zero npm dependencies, which Node built-ins it relies on, and which candidate libraries were rejected.
- Testing Decisions
  - [What makes a good test](testing-good-tests.md): What a good test asserts (external behavior only), its oracle, and the test tooling (`node:test`, temp git repos).
  - [Seams (confirmed by the user)](testing-seams.md): Defines the three test seams (subprocess, guard stdin, in-process table-driven), plus clock, round-trip and time-budget tests.
  - [Modules and how](testing-modules.md): Per-module test coverage across the seams, plus large case lists for the scanner, run integrity, and guard bypasses.
  - [Story verification](story-verification.md): Maps each story group to how it is verified (seam, manual hand-test, dogfood), plus the 1.0.0 dogfood-gate criteria.
  - [Prior art](prior-art.md): Borrowed and credited test cases and bypass patterns from other open-source projects; no direct prior art for this plugin.
- [Out of Scope](out-of-scope.md): Non-goals, accepted gaps (the guard is not a security boundary, scan limits, etc.), and features deferred past 0.1.0.
- [Further Notes](further-notes.md): Open spikes and manual checks, the first slice's scope, and other notes on versioning, dogfooding and risks.
