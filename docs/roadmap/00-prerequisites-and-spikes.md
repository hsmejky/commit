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
commit is scanned under HEAD rules that already ignore fixtures.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Sources:** Q6, Q10, Q15, C:scanignore-globs, Further Notes "Prerequisite of the first slice".

- [ ] The committed repo config holds `scanIgnore` with the single entry `tests/fixtures/**` and no key outside Q6's key set.
- [ ] The glob is valid under C:scanignore-globs (it has a literal character, no braces or classes).
- [ ] The commit is a Conventional Commits commit that touches only the repo config, and it precedes every commit that adds a file under the fixtures directory.


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

**Status:** ready-for-agent

**Sources:** Q3, Q1, C:guard (Parsing), Dependency policy "Tokenizer spike", Further Notes "G2 tokenizer spike".

Gates: GRD-03 and every later tokenizer or classifier slice (GRD-06 to GRD-12).

- [ ] The prototype is run on heredocs, `$(...)`, backticks, `bash -c '…'`, reordered flags, PowerShell here-strings, unterminated quotes, escaped newlines (Bash `\` and PowerShell backtick plus newline), subshells such as `( git commit )`, and case variants of `git` and `commit`.
- [ ] Each case's segments are compared with bash's own words (`printf '%s\0'`) and with the PowerShell parser API (5.1 and 7 where available); every difference is classed either as one of the deliberate oracle-skip classes (Testing Decisions, "Parser oracles") or as fragility.
- [ ] The already-decided behaviours are confirmed: case-insensitive `git` basename, `commit` substring and subcommand; `(` and `)` as tokens; heredoc bodies dropped.
- [ ] Any fragility found is answered by a wider fail-closed rule or a documented false positive, recorded as a Q3 amendment and in C:guard; the case list is handed to GRD-03 as the fixture seed.
- [ ] If the hand-written design proves fragile, the unbash question (a Q1 amendment) is raised with the user, not adopted by the spike.


## PRE-04: Spike: hook `if` condition on compound commands

**What to build:** a probe plugin's `PreToolUse` hook with the `if` conditions of Q13 shows
whether a condition matches when any subcommand of a compound command matches, including
the quoted script-call forms the heartbeat needs.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q13, Q23, Q3, Open verification items (first item), Prompt-only and manifest blocks "Hook registration".

Gates: GRD-18 (whether hook registration carries an `if` condition).

- [ ] With `Bash(git *)`, `PowerShell(git *)`, `Bash(node *commit.js*)` and `PowerShell(node *commit.js*)` as conditions, the probe logs whether the hook fired for `cd x && git commit`, `& git commit`, `a; git commit`, `a | git commit`, a newline-separated command, `cd sub && node "<path>/commit.js" plan` and the quoted script-call form, in both shells.
- [ ] The verdict picks one of Q13's two variants and is recorded as a Q13 amendment and in the hook-registration block; G1's early exit stays either way.


## PRE-05: Spike: heartbeat under the sandbox

**What to build:** confirmation that a sandboxed shell command can read the heartbeat file
the unsandboxed hook writes under the Claude home, or a new location both sides reach.

**Blocked by:** None (can start immediately).

**Status:** needs-human

**Sources:** Q23, Q5, C:guard (Heartbeat), S1, Open verification items (heartbeat under the sandbox).

Gates: GRD-15 (heartbeat write) and GRD-17 (`env.guard` read side).

- [ ] On macOS (Seatbelt) and Linux (bubblewrap) with the sandbox on, a hook writes `commit-guard/heartbeat.json` under the Claude home and a sandboxed Bash command reads it; also with `CLAUDE_CONFIG_DIR` set.
- [ ] If either side cannot reach it, the spike picks a location both reach and amends Q23, C:guard and the S1 block; otherwise the pending-location remark in S1 is removed.
- [ ] If the heartbeat moves, the relocation constraints (both sides can reach it, per-user,
      no repo path) are recorded in Q23


## PRE-06: Spike: exec-form hooks in a plugin

**What to build:** proof that a plugin's hook registered in exec form (`node` as the
command, the guard entry point as the only argument, the plugin-root variable substituted)
runs on all three OSes, and the minimum Claude Code version that supports it.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q3, Q13, Open verification items (exec-form hooks), Prompt-only and manifest blocks "Hook registration".

Gates: GRD-18 (hook registration), the README's Claude Code version requirement (needs REL: README requirements).

- [ ] A probe plugin installed under a path containing a space runs its exec-form hook on Windows, macOS and Linux, and the hook receives the `PreToolUse` JSON on stdin.
- [ ] The minimum Claude Code version is found (docs, changelog, or probing) and recorded in Q3/Q13; if exec form is not supported in a plugin, the user is asked before any fallback is chosen.


## PRE-07: Measure the guard's cold start and set the target

**What to build:** measured cold-start time of the exec-form guard on all three OSes, and a
target the user sets from it, so story 22 can be claimed.

**Blocked by:** GRD-01.

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

**Status:** ready-for-agent

**Sources:** Q9, Q19, C:plan-hunks, Open verification items (tool output limits).

Gates: needs CHG: hunk index spill and paging (M13); needs INT: first slice (reply within the stdout budget); needs RPL: reply size budgets.

- [ ] Recorded for the current Claude Code version: the Bash and PowerShell tool output cut-off (default and with `BASH_MAX_OUTPUT_LENGTH`), which end is cut, the `Read` line cap and default page size.
- [ ] Q9 and Q19 (and C:plan-hunks if the numbers change) are amended with the version and the confirmed or new budget.


## PRE-09: Git check: the temporary index

**What to build:** proof on git 2.34 and the current release that the temporary index
behaves as Q11 step 1 assumes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Sources:** Q11, Open verification items (temporary index), Further Notes "Git and tool checks".

Gates: needs CHG: temporary index (M10); needs INT: first slice.

- [ ] `git diff -M` against an index copy with `git add -N` entries shows each intent-to-add path as `A` with its content.
- [ ] A deleted path plus an intent-to-add path pair as `R`, both for a plain `mv` and a `git mv` after the reset.
- [ ] `git diff --cached --no-renames --diff-filter=A` lists a `git mv`'s new path and works on an unborn HEAD.
- [ ] Each result holds on git 2.34 (the `ubuntu:22.04` distribution git) and the current release; a difference is recorded as a Q11 amendment.


## PRE-10: Git check: filtered files and LFS

**What to build:** proof that an LFS-tracked change behaves as Q11 assumes, on git 2.34 and
the current release.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Sources:** Q11, Open verification items (filtered files), Further Notes "Git and tool checks".

Gates: needs CHG: staging a filtered or LFS file; needs INT: filtered/LFS widening.

- [ ] With `git-lfs` installed, `git diff` shows an LFS-tracked change as a pointer diff.
- [ ] `git add` of the whole file stores the object under the LFS objects directory, and the staged diff then matches the planned hash.
- [ ] Both hold on git 2.34 and the current release; a difference is recorded as a Q11 amendment.


## PRE-11: Spike: project directory and `CLAUDE_PROJECT_DIR`

**What to build:** which directory the harness reads project settings from when Claude runs
in a subfolder of a repo, and whether `CLAUDE_PROJECT_DIR` reaches the main thread's shell
tools.

**Blocked by:** None (can start immediately).

**Status:** needs-human

**Sources:** Q5, Open verification items (project directory), Further Notes.

Gates: needs CFG: attribution resolver (M5) project-layer lookup.

- [ ] With Claude launched in a repo subfolder and different project settings at the launch directory and the toplevel, the settings the harness applies are identified.
- [ ] Whether `CLAUDE_PROJECT_DIR` is set in the main thread's Bash and PowerShell tool environments is recorded (a subagent's is already known not to be).
- [ ] Q5 and the M5 resolution order are amended to match.


## PRE-12: Spike: README allow rules and the worker's shell

**What to build:** confirmation that the anchored allow rules let a run ask nothing on every
OS and shell, and that the worker runs on a Windows setup without Git Bash.

**Blocked by:** PRE-02.

**Status:** needs-human

**Sources:** Q16, Q24, Q1, story 41, Open verification items (README allow rules).

Gates: needs WRK: the slice in which the worker runs the script; needs REL: README allow rules and requirements.

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

Gates: needs EXE: the slice that claims story 217 (signal handler and tree kill on Esc or session end).

- [ ] On Linux, macOS and Windows, a probe script records which signal it receives (process-group `SIGTERM`, `SIGKILL`, tree kill) on Esc and on a tool timeout, in both shells.
- [ ] Whether a `detached` child (a sleeping stand-in for git and a hook) survives is recorded.
- [ ] If the script gets no catchable signal, the signal handler design and story 217 are revised with the user and recorded in Q9/Q18.


## PRE-14: Hand-test: the openpgp signing note

**What to build:** a manual check that a repo with openpgp signing enabled gets the
signing "prompt" note, since the openpgp probe is deferred past 0.1.0.

**Blocked by:** INT-25.

**Status:** needs-human

**Sources:** Q18, Open verification items (openpgp probe), Story verification ("Failures, hooks, signing").

Gates: needs REL: 0.1.0 release.

- [ ] In a repo with `commit.gpgsign=true` and openpgp format, a run's reply carries the signing prompt note, and the commit then goes through the user's normal signing flow.


## PRE-15: Settle story wording and recorded texts

**What to build:** a decision pass (human) over wording the last spec review left open, so
that slices can assert exact texts. (1) The user stories whose wording disagrees with the
settled decisions or contracts: stories 34, 40, 42, 44, 46, 51, 52, 53, 54, 57, 58, 61, 62,
65, 67, 102, 103, 150, 201 and 213, and story 228 against the Q24 budgets (200-character
agent description, 1.5 kB skill). (2) Texts not recorded in Q18 or Q21: the `signing-locked`
text and the six refusal texts emitted by M3, M11, M15 and M16. Fix each story or record
each text; a slice not gated here follows the contract.

**Blocked by:** None (can start immediately)

**Status:** needs-human

**Sources:** Q18, Q21, Q24, M3, M11, M15, M16, the four story files, story verification.

- [ ] Every listed story agrees with the decision or contract it cites, or the story is
      amended
- [ ] The `signing-locked` text and the six refusal texts are recorded verbatim in Q18 or
      Q21
- [ ] GRD-17, CHG-17, PLN-03, INT-17, WRK-01, REL-03 and GIT-11 cite the settled texts
