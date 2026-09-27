# 01 Foundation

The repo skeleton every other group builds on: package and plugin manifests with no
dependencies, the CI matrix, the process-seam harness (Seam 1 and Seam 2 inputs, temp git
repos with fixed identities), the stepping clock for Seam 1 time tests, and the
privacy-guard test. Seam 3 needs nothing beyond `node:test`. Sources: Q1, Q15, Dependency
policy, What makes a good test, Seams, Modules and how ("Other checks", CI).

## FND-01: Repo skeleton with a first green test run

**What to build:** the package manifest (no dependencies, Node 22 floor, `node --test` as
the test command), the MIT licence and the Q15 layout, with one real test: the static check
that the package lists no dependencies.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Sources:** Q1, Q15, story 203, Dependency policy, Modules and how "Other checks".

- [ ] The test command runs `node:test` over the tests directory and passes on Node 22 and 24.
- [ ] A static test fails when the package manifest lists any `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`, and passes on the skeleton (story 203).
- [ ] The package declares the Node 22 floor; version is 0.1.0.


## FND-02: Plugin and marketplace manifest skeleton

**What to build:** the plugin manifest and the marketplace manifest with identity
`commit@commit` at 0.1.0, so a local marketplace can install the (still empty) plugin.

**Blocked by:** FND-01.

**Status:** ready-for-agent

**Sources:** Q8, Q15, Prompt-only and manifest blocks "Manifests", Further Notes "Other notes" (versioning).

- [ ] A static test asserts the plugin name is `commit`, the marketplace name is `commit`, the marketplace lists the plugin's directory, and the plugin, marketplace entry and package all carry version 0.1.0.
- [ ] Where the installed Claude Code offers manifest validation, both manifests pass it.


## FND-03: CI matrix

**What to build:** the CI workflow running the test command on ubuntu, windows and macos ×
Node 22 (oldest and latest) and Node 24, plus the minimum-git job in an `ubuntu:22.04`
container.

**Blocked by:** FND-01.

**Status:** ready-for-agent

**Sources:** Q15, Modules and how (CI paragraph), Dependency policy "Built-ins and version fences".

- [ ] The matrix has nine legs (three OSes × Node 22 oldest, 22 latest, 24) and each runs FND-01's tests green.
- [ ] The container job's first step fails unless `git --version` is 2.34.x, then runs the test command.
- [ ] On the windows leg, a step asserts both `powershell.exe` and `pwsh` are available (the guard's PowerShell oracle runs under each, GRD-06).


## FND-04: Process-seam harness (Seam 1 and Seam 2 inputs)

**What to build:** test helpers that give each case a temp OS home, Claude home and git repo
with fixed author, committer and dates, spawn an entry point with argv, env and stdin, and
return its stdout, stderr, exit code and (for Seam 1) its single JSON object.

**Blocked by:** FND-01, FND-03.

**Status:** ready-for-agent

**Sources:** Q15, What makes a good test, Seams (Seam 1, Seam 2), Architectural decisions "Injected environment".

- [ ] A self-test builds a temp repo, commits through plain git, and `git log` shows the fixed author, committer and dates on every OS leg.
- [ ] The spawned process sees only the temp OS home, Claude home (`CLAUDE_CONFIG_DIR`) and `CLAUDE_PROJECT_DIR` the case sets; no host git config, Claude settings or user identity leaks in (checked by a stub entry point in the test tree that prints what it sees).
- [ ] The Seam 1 helper fails a case whose stdout is not exactly one JSON object and reports stdout length (for the size budgets); the Seam 2 helper feeds `PreToolUse` JSON on stdin and reads the heartbeat file from the temp Claude home.
- [ ] Temp directories are removed after each case, also on failure.


## FND-05: Stepping clock for Seam 1 time tests

**What to build:** the test-tree preload that replaces `Date.now` with a stepping clock read
from a schedule file, so budget and kill-timeout cases need no real waiting and the shipped
CLI gains no switch.

**Blocked by:** FND-04.

**Status:** ready-for-agent

**Sources:** Q9, Q18, Seams "Clock at Seam 1", Architectural decisions "Injected environment".

- [ ] Driving a stub entry point in the test tree: the first `Date.now()` returns real time (`callStarted`); before the first step later reads run in real time; after a step the value is frozen at `callStarted + elapsed` until the next step.
- [ ] Steps are keyed to observable events (a path that exists, a reflog entry count); a step whose event holds at start applies from the second call on; the schedule never counts `Date.now()` calls.
- [ ] A boundary step (exactly 60 000 ms elapsed) reads back exactly.
- [ ] The preload lives only in the test tree; the packaged plugin directory contains no reference to it.


## FND-06: Settle the privacy test's file set and segment matcher

**What to build:** a spec decision, recorded in Q15 and Testing Decisions, of which files
the privacy-guard test and its self-test scan and where the runner-name segment check lives.

**Blocked by:** None (can start immediately).

**Status:** needs-human

**Sources:** Q10, Q15, C:scan-patterns (`local-path`), Modules and how "Other checks", M8.

- [ ] One file set is named for both the test and its self-test (docs, README, manifests, test sources; whether fixtures are in it), and whether it is tracked files only or also untracked files that are not excluded (so a new, not yet added doc is checked, and excluded review reports are not).
- [ ] The docs state whether the runner-name segment check is a matcher the test owns (with its reason against "do not duplicate library logic") or an exemption-off option of M8 `scanText`, since `scanText` always applies the service-user list that holds `runner` and `root`.
- [ ] The "any user name" wording of the `local-path` part is aligned with C:scan-patterns' placeholder and service-user exemptions.


## FND-07: Privacy guard: runner name as a path segment, with self-test

**What to build:** the CI test that fails when the runner's user name appears as a path
segment in the privacy file set, and a self-test that runs the same check locally with the
name set to `runner` and to `root`.

**Blocked by:** FND-03, FND-06, PRE-01.

**Status:** ready-for-agent

**Sources:** Q15, Q10, story 138, Modules and how "Other checks".

- [ ] On the CI legs, the runner's name matched as a segment (`/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\`, any other path) fails the test, without service-user or length exemptions; the bare word never does.
- [ ] The self-test with the name `runner` and with `root` passes on today's docs and fails on a planted literal runner path (a fixture built at run time, not committed).
- [ ] The file set is exactly the one FND-06 decided.


## FND-08: Privacy guard: `local-path` and every scan pattern

**What to build:** the privacy-guard test's scan part: `local-path` over docs, README,
manifests and test sources, and every other scan pattern over test sources, through the
scanner.

**Blocked by:** FND-07, SCN-06, SCN-07, SCN-08, SCN-09, SCN-11.

**Status:** ready-for-agent

**Sources:** Q10, Q15, C:scan-patterns, Modules and how "Other checks".

- [ ] A home-directory path with a non-exempt user name is caught on every OS leg, not just the runner's own form (Windows, macOS and Linux shapes each planted at run time).
- [ ] Test sources holding a literal token of any scan pattern fail the test; a token built at run time does not.
- [ ] The current repo passes on every CI leg.
