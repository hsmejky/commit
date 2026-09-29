# 01 Foundation

The repo skeleton every other group builds on: package and plugin manifests with no
dependencies, the CI matrix, the process-seam harness (Seam 1 and Seam 2 inputs, temp git
repos with fixed identities), the stepping clock for Seam 1 time tests, the
privacy-guard test, and a graph check that keeps the roadmap's own blocking edges honest.
Seam 3 needs nothing beyond `node:test`. Sources: Q1, Q15, Dependency
policy, What makes a good test, Seams, Modules and how ("Other checks", CI).

## FND-01: Repo skeleton with a first green test run

**What to build:** the package manifest (no dependencies, Node 22 floor, `node --test`
scoped to `tests/*.test.js` as the test command) and the MIT licence, with one real test:
the static check that the package lists no dependencies. Git cannot track empty
directories, so the Q15 layout directories are created by later slices as they add files
to them, not here as placeholders. The manifest has no `"type"` field: tests stay
CommonJS `.js`, and the plugin's files take their module type from the extension (entry
points `.cjs`, library `.mjs`; Q1, Q15 as amended by this slice's review).

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q1, Q15, story 203, Dependency policy, Modules and how "Other checks".

- [x] The test command runs `node:test` over the tests directory and passes on Node 22 and 24 (verified manually on Node 22.0.0 and 24.15.0; CI coverage in FND-03).
- [x] A static test fails when the package manifest lists any `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `bundleDependencies` or `bundledDependencies`, and passes on the skeleton (story 203).
- [x] The package declares the Node 22 floor; version is 0.1.0.


## FND-02: Plugin and marketplace manifest skeleton

**What to build:** the plugin manifest and the marketplace manifest with identity
`commit@commit` at 0.1.0, so a local marketplace can install the (still empty) plugin.

**Blocked by:** FND-01.

**Status:** done

**Sources:** Q8, Q15, Prompt-only and manifest blocks "Manifests", Further Notes "Other notes" (versioning).

- [x] A static test asserts the plugin name is `commit`, the marketplace name is `commit`, the marketplace lists the plugin's directory, and the plugin, marketplace entry and package all carry version 0.1.0.


## FND-03: CI matrix

**What to build:** the CI workflow running the test command on ubuntu, windows and macos ×
Node 22 (oldest and latest) and Node 24, plus the minimum-git job in an `ubuntu:22.04`
container.

**Blocked by:** FND-01.

**Status:** ready-for-agent

**Sources:** Q15, Modules and how (CI paragraph), Dependency policy "Built-ins and version fences".

- [ ] The matrix has nine legs (three OSes × Node 22 oldest, 22 latest, 24) and each runs FND-01's tests green.
- [ ] The container job's first step fails unless `git --version` is 2.34.x, then runs the test command with Node 22 installed in the container.
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

- [ ] One file set is named for both the test and its self-test (docs, README, manifests, test sources; whether fixtures are in it): tracked files only (`git ls-files`), per Q15 and testing-modules.md.
- [ ] The docs state whether the runner-name segment check is a matcher the test owns (with its reason against "do not duplicate library logic") or an exemption-off option of M8 `scanText`, since `scanText` always applies the service-user list that holds `runner` and `root`.
- [ ] The "any user name" wording of the `local-path` part is aligned with C:scan-patterns' placeholder and service-user exemptions.


## FND-07: Privacy guard: runner name as a path segment, with self-test

**What to build:** the CI test that fails when the runner's user name appears as a path
segment in the privacy file set, and a self-test that runs the same check locally with the
name set to `runner` and to `root`.

**Blocked by:** FND-03, FND-06.

**Status:** ready-for-agent

**Sources:** Q15, Q10, story 138, Modules and how "Other checks".

- [ ] On the CI legs, the runner's name matched as a segment (`/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\`, any other path) fails the test, without service-user or length exemptions; the bare word never does.
- [ ] The self-test with the name `runner` and with `root` passes on today's docs and fails on a planted literal runner path (a fixture built at run time, not committed).
- [ ] The file set is exactly the one FND-06 decided.


## FND-08: Privacy guard: `local-path` and every scan pattern

**What to build:** the privacy-guard test's scan part: `local-path` over docs, README,
manifests and test sources, and every other scan pattern over test sources, through the
scanner.

**Blocked by:** FND-07, SCN-06, SCN-07, SCN-09, SCN-11.

**Status:** ready-for-agent

**Sources:** Q10, Q15, C:scan-patterns, Modules and how "Other checks".

- [ ] A home-directory path with a non-exempt user name is caught on every OS leg, not just the runner's own form (Windows, macOS and Linux shapes each planted at run time).
- [ ] Test sources holding a literal token of any scan pattern fail the test; a token built at run time does not.
- [ ] The current repo passes on every CI leg.


## FND-09: Roadmap graph check

**What to build:** a test under `tests/` that parses the group files `docs/roadmap/NN-*.md`
(each `## <ID>:` slice heading and its blocking-edge line) and checks the graph: no
duplicate or missing ID, no cycle, every in-group blocker has a lower number than the slice
it blocks, and `README.md`'s slice counts match the files; it reports blocking edges that
are already reachable through another blocker (transitively implied) without failing on
them. A release mode reports every slice, other than REL-05, whose `**Status:**` line is
not `**Status:** done`.

**Blocked by:** FND-01.

**Status:** done

**Sources:** `docs/roadmap/README.md` (the graph claims), to-tickets.

- [x] Only files whose name starts with a two-digit group number (`NN-*.md`) are parsed as
      group files; `README.md` and `known-deficiencies.md` are not, so a slice ID they cite
      is neither a duplicate nor a heading.
- [x] A duplicate `## <ID>:` heading anywhere in the group files fails the test, naming the ID.
- [x] A `**Blocked by:**` entry naming an ID with no matching `## <ID>:` heading fails the test.
- [x] A cycle in the blocking-edge graph fails the test, naming the cycle.
- [x] An in-group blocker whose number is not lower than the slice's own fails the test.
- [x] A letter-suffix ID (e.g. a slice numbered `03b`) sorts just after its base number and
      before the next number in this check (`03` < `03b` < `04`, as `README.md` describes),
      and a gap in a group's numbering left by a removed or merged ID does not fail the
      test.
- [x] The total slice count and each per-group count `README.md` states are compared against the files under `docs/roadmap/`; a mismatch fails the test.
- [x] A blocking edge already reachable through another blocker is listed in the test's output as transitively implied, and does not fail the test.
- [x] Run with a release-mode switch the test file itself defines (an env var read only by the test, not the shipped CLI): the test lists every slice other than REL-05 whose `**Status:**` line is not `**Status:** done`, and fails when the list is non-empty. REL-05 is excluded because its own criterion is that FND-09 reports every *other* slice as done, which would otherwise be circular.


## FND-10: Fault-injection preload for Seam 1

**What to build:** the test-tree preload that injects failures a fixture cannot otherwise
cause: `os.userInfo()` throwing, a named fs boundary (`fs.linkSync`/`fs.renameSync`, and the
callback and promise forms the code path uses) failing with a configured errno code
(default `EIO`) for a target path matching a given basename, and an optional log of those
calls' order to a file. After patching, the preload calls `module.syncBuiltinESMExports()`
so named ESM imports of `fs` and `os` see the faults. The test switches each behaviour on
through environment variables the preload reads; the shipped CLI gains no switch. The
stub that uses named ESM imports is a `.mjs` file, like the library it stands in for; the
stub entry point that drives it in the test tree is `.cjs`, like the real entry points
(Architectural decisions "Module type fixed by extension").

**Blocked by:** FND-05.

**Status:** ready-for-agent

**Sources:** Q9, Seams "Fault-injection preload at Seam 1", Architectural decisions "Injected
environment", "Module type fixed by extension".

- [ ] Driving a stub entry point in the test tree: with the `os.userInfo()` fault set, `os.userInfo()` throws; unset, it returns normally.
- [ ] Driving the stub: with a named fs boundary set to a target basename, `fs.linkSync` and `fs.renameSync` (and the callback and promise forms the code path uses) fail only for a target path matching that basename; a call for any other path succeeds.
- [ ] Driving the stub: with the errno option set to `EEXIST`, and again to `EPERM`, the injected error's `code` equals the configured code; with the option unset it is `EIO`.
- [ ] Driving a stub that uses named ESM imports (`import { linkSync, renameSync } from 'node:fs'`, `import { userInfo } from 'node:os'`): each configured fault fires exactly as it does through a property access on the module object.
- [ ] Driving the stub: with call-order logging on, each intercepted call's target path is appended to the log file in call order; with it off, no log file is written.
- [ ] The preload lives only in the test tree; the packaged plugin directory contains no reference to it.
