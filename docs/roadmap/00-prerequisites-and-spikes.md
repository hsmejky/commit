# 00 Prerequisites and spikes

Every spike and manual check the spec leaves open (Further Notes "Open items", Open
verification items, and the manual checks of Testing Decisions "Other checks"), plus the
repo-config prerequisite and the removal of any personal commit skill. Each slice names the
later capability it gates; a slice that does not depend on an item does not wait for it.
Spikes settle behaviour and amend the decisions and contracts; their probe code is thrown
away, never merged into the plugin. PRE-15 settles the story wording and recorded texts that
gate exact-text assertions. The handback hand-test lives in WRK-07, and the lock put-back
and hard-link manual checks in RUN-26 and RUN-10.

## PRE-01: Commit the repo config that ignores test fixtures

**What to build:** the repo's own `.claude/commit.json` with `scanIgnore` holding the
fixtures glob, committed on its own before any commit that adds a fixture, so every later
commit is scanned under HEAD rules that already ignore fixtures. (A follow-up added
`body: "optional"`, since repo commits carry explanatory prose bodies.)

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q6, Q10, Q15, C:scanignore-globs, Further Notes "Prerequisite of the first slice".

- [x] The committed repo config holds `scanIgnore` with the single entry `tests/fixtures/**` and no key outside Q6's key set.
- [x] The glob is valid under C:scanignore-globs (it has a literal character, no braces or classes).
- [x] The commit is a Conventional Commits commit that touches only the repo config, and it precedes every commit that adds a file under the fixtures directory.


## PRE-02: Remove any personal commit skill before spikes and dogfooding

**What to build:** the maintainer's machine has no personal skill or command named `commit`
competing with the plugin, so trigger probes, the handback hand-test and dogfooding measure
the plugin alone.

**Blocked by:** None (can start immediately).

**Status:** needs-human

**Sources:** Q8, Q24, Further Notes "Other notes" (Dogfooding).

- [ ] No user-level skill or command named `commit` exists; a fresh session's skill list shows no `commit` entry besides the plugin's own.
- [ ] Done before PRE-04, PRE-06, PRE-12 and WRK-07, and before the repo starts committing through its own plugin.


## PRE-03: Tokenizer spike (G2)

**What to build:** a throwaway prototype of the hand-written G2 design run against the hard
cases, confirming the decided behaviours and producing the case list that seeds the Seam 3
tokenizer fixtures.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q3, Q1, C:guard (Parsing), Dependency policy "Tokenizer spike", Further Notes "G2 tokenizer spike".

Gates: GRD-03 and every later tokenizer or classifier slice (GRD-06 to GRD-12).

- [x] The prototype is run on heredocs, `$(...)`, backticks, `bash -c '…'`, reordered flags, PowerShell here-strings, unterminated quotes, escaped newlines (Bash `\` and PowerShell backtick plus newline), subshells such as `( git commit )`, and case variants of `git` and `commit`.
- [x] Each case's segments are compared with bash's own words (`printf '%s\0'`) and with the PowerShell parser API (5.1 and 7 where available); every difference is classed either as one of the deliberate oracle-skip classes (Testing Decisions, "Parser oracles") or as fragility.
- [x] The already-decided behaviours are confirmed: case-insensitive `git` basename, `commit` substring and subcommand; `(` and `)` as tokens; heredocs blanket-denied (round 8).
- [x] Any fragility found is answered by a wider fail-closed rule or a documented false positive, recorded as a Q3 amendment and in C:guard; the case list is handed to GRD-03 as the fixture seed.
- [x] If the hand-written design proves fragile, the unbash question (a Q1 amendment) is raised with the user, not adopted by the spike.


## PRE-04: Spike: hook `if` condition on compound commands

**What to build:** a probe plugin's `PreToolUse` hook with the `if` conditions of Q13 shows
whether a condition matches when any subcommand of a compound command matches, including
the quoted script-call forms the heartbeat needs.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q13, Q23, Q3, Open verification items (first item), Prompt-only and manifest blocks "Hook registration".

Gates: GRD-18 (whether hook registration carries an `if` condition).

- [ ] With `Bash(git *)`, `PowerShell(git *)`, `Bash(node *commit.cjs*)` and `PowerShell(node *commit.cjs*)` as conditions, the probe logs whether the hook fired for `cd x && git commit`, `& git commit`, `a; git commit`, `a | git commit`, a newline-separated command, `cd sub && node "<path>/commit.cjs" plan` and the quoted script-call form, in both shells.
- [ ] The verdict picks one of Q13's two variants and is recorded as a Q13 amendment and in the hook-registration block; G1's early exit stays either way.


## PRE-05: Spike: heartbeat under the sandbox

**What to build:** confirmation that a sandboxed shell command can read the heartbeat file
the unsandboxed hook writes under the Claude home, or a new location both sides reach.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q23, Q5, C:guard (Heartbeat), S1, Open verification items (heartbeat under the sandbox).

Gates: GRD-15 (heartbeat write) and GRD-17 (`env.guard` read side).

- [x] On macOS (Seatbelt) and Linux (bubblewrap) with the sandbox on, a hook writes `commit-guard/heartbeat.json` under the Claude home and a sandboxed Bash command reads it; also with `CLAUDE_CONFIG_DIR` set.
- [x] If either side cannot reach it, the spike picks a location both reach and amends Q23, C:guard and the S1 block; otherwise the pending-location remark in S1 is removed.
- [x] If the heartbeat moves, the relocation constraints (both sides can reach it, per-user,
      no repo path) are recorded in Q23 (n/a: no move)

**Linux result:** confirmed on WSL2 Ubuntu 24.04 (bubblewrap 0.9.0) — a sandboxed Bash
command reads the heartbeat under the default Claude home and under `CLAUDE_CONFIG_DIR`,
but the Claude home is mounted read-only inside the sandbox, so it can neither write nor
forge the file; no relocation needed on Linux.

**macOS result:** confirmed on GitHub Actions macos-latest (macOS 26.6.2, Seatbelt, Claude
Code 2.1.288) — same probe: the sandboxed Bash command reads the heartbeat under the
default Claude home and under `CLAUDE_CONFIG_DIR`; writing next to it and touching `$HOME`
fail with `Operation not permitted`, touching a file in the project succeeds. No relocation
needed; the pending-location remark in S1 is removed.


## PRE-06: Spike: exec-form hooks in a plugin

**What to build:** proof that a plugin's hook registered in exec form (`node` as the
command, the guard entry point as the only argument, the plugin-root variable substituted)
runs on all three OSes, and the minimum Claude Code version that supports it.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q3, Q13, Open verification items (exec-form hooks), Prompt-only and manifest blocks "Hook registration".

Gates: GRD-18 (hook registration), REL-02 (the README's Claude Code version requirement).

- [ ] A probe plugin installed under a path containing a space runs its exec-form hook on Windows, macOS and Linux, and the hook receives the `PreToolUse` JSON on stdin.
- [ ] The minimum Claude Code version is found (docs, changelog, or probing) and recorded in Q3/Q13; if exec form is not supported in a plugin, the user is asked before any fallback is chosen; a shell-form fallback would reopen Q3's path-quoting decision, GRD-18's hook registration and REL-02's requirements section, and is recorded as such if it happens.


## PRE-07: Measure the guard's cold start and set the target

**What to build:** measured cold-start time of the exec-form guard on all three OSes, and a
target the user sets from it, so story 22 can be claimed.

**Blocked by:** GRD-16, GRD-12, GRD-14, PRE-06.

**Status:** needs-human

**Sources:** Q13, story 22, Open verification items (cold-start time), Further Notes "Guard cold-start time".

Gates: GRD-19 (the cold-start target test).

- [ ] Median and 95th percentile of a guard invocation (process start to exit) are measured on ubuntu, windows and macos for an early-exit command and for a `git commit -m x` command, with the Node versions of the CI matrix.
- [ ] The user sets the target; it is recorded in Q13 and in story 22's open item. `module.enableCompileCache` stays deferred.


## PRE-08: Spike: tool output limits

**What to build:** the current Claude Code's Bash and PowerShell output cut-off and the
`Read` tool's line cap and default page size, confirming or amending the 20 000-character
stdout budget and the hunk-bodies paging.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q9, Q19, C:plan-hunks, Open verification items (tool output limits).

Gates: CHG-18 (stdout budget and spill to `hunks.json`), INT-02 (first end-to-end commit, reply within the stdout budget), RPL-05 (reply size budgets).

- [x] Recorded for the current Claude Code version (2.1.284, 2026-09-29): the Bash and PowerShell tool output cut-off is no longer a silent character cut — past roughly 29-31 KB it spills the full output to a file with a head preview (`<persisted-output>`), on both tools alike. Driving a nested headless `claude -p` session with `BASH_MAX_OUTPUT_LENGTH` set to 60 000 and 100 000 did not raise the threshold (31-78 KB outputs still spilled), so the env var has no observed effect on it in this version. `Read` showed no per-line character cut up to a 10 000-character line; it instead enforces a whole-call token budget (~25 000 tokens, roughly 50 000 characters) and errors rather than truncating when a requested range is over it, and a default call (no offset/limit) on a 5000-line file returned the whole file rather than stopping at 2000 lines.
- [x] Q9 and Q19 are amended with the version and the confirmed budget (see their Amended bullets); C:plan-hunks is unchanged since no number came back lower than 20 000.


## PRE-09: Git check: the temporary index

**What to build:** proof on git 2.34 and the current release that the temporary index
behaves as Q11 step 1 assumes.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q11, Open verification items (temporary index), Further Notes "Git and tool checks".

Gates: CHG-05 (temporary index), INT-02 (first end-to-end commit).

- [x] `git diff -M` against an index copy with `git add -N` entries shows each intent-to-add path as `A` with its content.
- [x] A deleted path plus an intent-to-add path pair as `R`, both for a plain `mv` and a `git mv` after the reset.
- [x] `git diff --cached --no-renames --diff-filter=A` lists a `git mv`'s new path and works on an unborn HEAD.
- [x] Each result holds on git 2.34 (the `ubuntu:22.04` distribution git) and the current release; a difference is recorded as a Q11 amendment.


## PRE-10: Git check: filtered files and LFS

**What to build:** proof that an LFS-tracked change behaves as Q11 assumes, on git 2.34 and
the current release.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q11, Open verification items (filtered files), Further Notes "Git and tool checks".

Gates: CHG-10 (filtered files and `linguist-generated`), CHG-21 (whole-file staging edge cases), INT-20 (filtered/LFS widening).

- [x] With `git-lfs` installed, `git diff` shows an LFS-tracked change as a pointer diff.
- [x] `git add` of the whole file stores the object under the LFS objects directory, and the staged diff then matches the planned hash.
- [x] Both hold on git 2.34 and the current release; a difference is recorded as a Q11 amendment.


## PRE-11: Spike: project directory and `CLAUDE_PROJECT_DIR`

**What to build:** which directory the harness reads project settings from when Claude runs
in a subfolder of a repo, and whether `CLAUDE_PROJECT_DIR` reaches the main thread's shell
tools.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q5, Open verification items (project directory), Further Notes.

Gates: CFG-10 (settings layer precedence and the project directory).

- [x] With Claude launched in a repo subfolder and different project settings at the launch directory and the toplevel, the settings the harness applies are identified.
- [x] Whether `CLAUDE_PROJECT_DIR` is set in the main thread's Bash and PowerShell tool environments is recorded (a subagent's is already known not to be).
- [x] Q5 and the M5 resolution order are amended to match.

**Finding:** no walk-up and no merge across layers: a launch directory's own `.claude/`
settings apply on their own, and a launch directory without `.claude/` gets no project
settings at all; the toplevel is never consulted. `CLAUDE_PROJECT_DIR` is unset in the main
thread's shell tools, same as a subagent's.


## PRE-12: Spike: README allow rules and the worker's shell

**What to build:** confirmation that the anchored allow rules let a run ask nothing on every
OS and shell, and that the worker runs on a Windows setup without Git Bash.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q16, Q24, Q1, story 41, Open verification items (README allow rules).

Gates: WRK-02 (the worker prompt that runs `plan` to `check`), REL-02 (README install section: requirements and allow rules).

- [ ] The anchored `PowerShell(…)` node rule (quoted path, `*` version segment) and the run-folder `Edit` rule let a stub run through the PowerShell tool on Windows with no prompt.
- [ ] The Bash node rule does the same on macOS and Linux.
- [ ] On Windows without Git Bash, a worker listing Bash, PowerShell, Read and Write runs a whole run through PowerShell with no prompt; with both shells present, listing both changes nothing.
- [ ] If a listed tool the session lacks breaks the agent, Git Bash becomes a documented requirement (Q1 and README amendment).


## PRE-13: Spike: how a tool call is terminated

**What to build:** how Claude Code ends a Bash or PowerShell tool call on Esc and on a tool
timeout, per OS, and whether a detached child survives.

**Blocked by:** None (can start immediately).

**Status:** needs-human

**Sources:** Q9, Q18, story 217, Open verification items (tool-call termination), Architectural decisions (asynchronous process adapter).

Gates: GIT-08, EXE-24 (story 217, signal handler and tree kill on Esc or session end).

- [ ] On Linux, macOS and Windows, a probe script records which signal it receives (process-group `SIGTERM`, `SIGKILL`, tree kill) on Esc and on a tool timeout, in both shells.
- [ ] Whether a `detached` child (a sleeping stand-in for git and a hook) survives is recorded.
- [ ] If the script gets no catchable signal, the signal handler design and story 217 are revised with the user and recorded in Q9/Q18.


## PRE-14: Hand-test: the openpgp signing note

**What to build:** a manual check that a repo with openpgp signing enabled gets the
signing "prompt" note, since the openpgp probe is deferred past 0.1.0.

**Blocked by:** GIT-10.

**Status:** needs-human

**Sources:** Q18, Open verification items (openpgp probe), Story verification ("Failures, hooks, signing").

Gates: REL-05 (0.1.0 release).

- [ ] In a repo with `commit.gpgsign=true` and openpgp format, a run's reply carries the signing prompt note, and the commit then goes through the user's normal signing flow.


## PRE-15: Settle story wording and recorded texts

**What to build:** a decision pass (human) over wording left open in [known
deficiencies](../spec/known-deficiencies.md) (KD-S53 to KD-S72, the story-wording rows
still open), so that slices can assert exact texts. (1) The user stories whose wording
disagrees with the settled decisions or contracts: stories 34, 40, 42, 44, 46, 51, 52, 53,
54, 56, 57, 58, 61, 62, 65, 67, 102, 103, 110, 147, 150, 185, 201 and 213, and story 228
against the Q24 budgets (200-character agent description, 1.5 kB skill); also the
glossary's "never answered without a user" line, which disagrees with the same settled
decision as story 102 (KD-S74). (2) Texts not recorded in a contract: the `signing-locked`
text and the six refusal texts emitted by M3, M11, M15 and M16, and Q23's guard notice. Fix
each story or record each text; a slice not gated here follows the contract. Story 196's
run-folder asserts moved to RUN-05.

**Progress:** the PRE-15 decision pass (2026-09-29) recorded the texts in the
[C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md) recorded-texts table, settled
the policy items (explicit `model: "sonnet"` on every spawn, Q2, Q12, Q24, Q25;
`signing-locked`, Q18; the worker's tool-failure fallback and the tree-state exceptions,
Q25) and fixed stories 34, 42, 46, 56, 102, 201 and 213 and the glossary line (KD-S16,
KD-S17, KD-S38, KD-S47, KD-S55, KD-S59, KD-S67, KD-S73 to KD-S76). A second pass
(2026-09-29) reworded the remaining stories that yield to their decision or contract —
40, 44, 51, 52, 54, 57, 58, 61, 62, 65, 67, 103, 110, 147, 150, 185 and 228 — settling
KD-S53, KD-S54, KD-S56 to KD-S58, KD-S60 to KD-S66 and KD-S68 to KD-S72 (KD-S54 and
KD-S65's non-story parts, the M4 testing-modules row and the M14 identical-hunks line,
follow too); the "Story wording" table in known deficiencies is now empty and dropped.

**Blocked by:** None (can start immediately)

**Status:** done

**Sources:** Q18, Q21, Q24, M3, M11, M15, M16, the four story files, story verification.

Gates: GRD-17, CHG-17, PLN-03, INT-17, WRK-01, REL-03, GIT-12 (slices that assert the settled
story texts and recorded refusal texts).

- [x] Every listed story agrees with the decision or contract it cites, or the story is
      amended
- [x] The `signing-locked` text and the six refusal texts are recorded verbatim in the
      C:cli-and-exit-codes recorded-texts table
- [x] GRD-17, CHG-17, PLN-03, INT-17, WRK-01, REL-03 and GIT-12 cite the settled texts


## PRE-16: Spike: managed-settings directory path and CI write permissions

**What to build:** the managed-settings directory's fixed path on macOS, Windows and Linux,
and the CI permissions needed to write a file there for the managed-layer fixture.

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q5, M5, glossary (managed directory), story 116.

Gates: CFG-11 (managed settings layer).

- [x] The managed-settings directory's fixed path is found for macOS, Windows and Linux.
- [x] The CI permissions (or workaround) needed to write `managed-settings.json` there on
      hosted runners are found; if none exist, the CFG-11 fixture design is revised with the
      user.
- [x] Both are recorded as a Q5 amendment and in the glossary's "managed directory" entry.
