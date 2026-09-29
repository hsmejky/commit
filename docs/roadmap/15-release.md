# 15 Release

The release manifests, the README and the 0.1.0 release gate: manifests wire every plugin
component under `commit@commit`, the README states requirements, allow rules, public
surface, the one accepted-gaps list and an overview for a first-time reader, and the
release slice collects CI and every hand-test. The episode-analysis tools (Q24) and the story 205 dogfood gate belong to the
1.0.0 gate and are not here. Sources: Prompt-only and manifest blocks "README" and
"Manifests", public surface, Out of Scope, Q1, Q8, Q14, Q15, Q16, Q22, Q24, Q25.

## REL-01: Manifests wire every component for a local-marketplace install

**What to build:** the plugin and marketplace manifests complete for 0.1.0: the plugin
exposes the worker agent, `/commit`, `/commit-config` and the hook registration, and a
local marketplace installs it as `commit@commit`.

**Blocked by:** WRK-01, WRK-05, FND-02, GRD-18, INF-08.

**Status:** ready-for-agent

**Sources:** Q8, Q15, public surface, Prompt-only and manifest blocks "Manifests" and
"Hook registration", Further Notes "Other notes" (versioning).

- [ ] FND-02's identity and version test is extended, not copied: identity `commit@commit`
      and one version 0.1.0 across the plugin manifest, the marketplace entry and the
      package
- [ ] That test also finds the agent `commit-worker`, the skills `commit` and
      `commit-config`, and the hook registration where the plugin loader looks for them,
      and nothing packaged from the tools directory
- [ ] A local-marketplace install listing the three components is checked by hand in WRK-06


## REL-02: README install section: requirements and allow rules

**What to build:** the README's install steps: Node 22+ and git 2.34+ as hard
requirements, the Q16 allow rules as a required step with what fails without them,
personal-skill removal, worktree isolation and `.commit-plan/` for watchers; CI keeps the
documented allow rules equal to the command form the script is called with.

**Blocked by:** REL-01, GRD-13, PRE-12, PRE-06, FND-07, FND-08.

**Status:** ready-for-agent

**Sources:** Q1, Q8, Q9, Q16, Q22, Q24, Prompt-only and manifest blocks "README", Story
verification (install, README and opt-out), stories 197, 199, 200, 202, 203, 223.

- [ ] Requirements: Node 22+ (the native installer ships none) and git 2.34+, no npm
      dependencies and no install step (stories 202, 203); Git Bash only if the
      worker-shell spike made it one
- [ ] The minimum Claude Code version PRE-06 found (recorded in Q3/Q13) is stated in the
      requirements
- [ ] Allow rules as a required step: the anchored node rule for both shells and the
      run-folder `Edit` rule; why a bare `node *commit.cjs*` rule is unsafe; that without
      them the worker's calls stall on permission prompts (stories 199, 223)
- [ ] A round-trip test: each documented node rule matches S2 `build`'s output for every
      subcommand, and a lookalike script path does not match
- [ ] Remove any personal commit skill (story 200); worktree isolation for parallel
      implementers (story 197); `.commit-plan/` added to file-watcher and sync ignore lists
- [ ] The privacy-guard test passes on the README (no local paths or user names)


## REL-03: README public surface, opt-out and accepted gaps

**What to build:** the README's remaining blocks: the one-line public worker spawn with
`model: "sonnet"`, `intent`, `interactive` and `reword` and the `callerRule` rule, the per-repo opt-out line,
and the accepted gaps as one list taken from Out of Scope, including the managed-settings
gap.

**Blocked by:** REL-02, PRE-15, CFG-11.

**Status:** ready-for-agent

**Sources:** Q5, Q14, Q25, public surface, Out of Scope (accepted gaps), stories 8, 116,
198, 201.

- [ ] One line: spawn `commit:commit-worker` with `model: "sonnet"` and `intent: …` (and
      `interactive`, `reword`), and a caller follows the reply's `callerRule` (story 8); the
      README joins WRK-01's model-equality test (Q24 as amended by PRE-15)
- [ ] The opt-out line: `"commit@commit": false` under `enabledPlugins` in the repo's
      `.claude/settings.local.json` (story 198)
- [ ] One accepted-gaps list, the same entries as Out of Scope, including the Q25 gaps
      (story 201, tagged Q25 by PRE-15)
- [ ] `managed-settings.json` honoured; the policy sources the script does not read
      (managed drop-in directory, MDM profile, registry, server-managed) named (story 116)
- [ ] A static test: every accepted gap in Out of Scope has a README entry, matched by its
      text (not every gap carries a decision tag), so the lists cannot drift


## REL-03b: README overview: purpose, components and flow

**What to build:** the README's opening, placed before the install section, for a reader
who sees the plugin for the first time: what problem it solves, one table of the packaged
components with the role of each, what fails without it and the decision behind it, and
the flow of one `/commit` run.

**Blocked by:** REL-03.

**Status:** ready-for-agent

**Sources:** Problem Statement, Solution, Glossary, Modules, Prompt-only and manifest
blocks "README", Q1, Q3, Q5, Q6, Q7, Q9, Q15, Q22, Q24, Q25.

- [ ] A short opening states the problem (agent-run `git commit` groups badly, leaks
      secrets and local paths, drifts from the repo's style, fails unexplained) and the
      solution, consistent with Problem Statement and Solution
- [ ] One component table: `/commit` skill, `commit:commit-worker` agent, `commit.cjs`,
      the `lib/` module library, the guard hook (`guard.cjs`), `/commit-config`, the
      `commit.json` user and repo layers and the `.commit-plan/` run folder; each row
      gives the role, what fails without the component and the deciding Q (for example:
      without the guard an agent bypasses the plugin with a direct `git commit`, Q3)
- [ ] The flow of one run: `/commit` spawns the worker, the worker calls `plan`, groups
      the units and writes messages, `check` lints and either commits or returns a
      confirmation handback, the caller asks the user and runs the answer's command, and
      the guard denies any other `git commit` throughout
- [ ] The overview links to Solution and to the decisions index for detail and does not
      restate contract shapes (reply fields, grammars), so it cannot drift from them
- [ ] A static test: every component REL-01's manifest test finds (the agent, both skills,
      the hook registration) is named in the overview table
- [ ] The privacy-guard test passes on the README (no local paths or user names)


## REL-04: Hand-test: opt-out and README

**What to build:** a manual check that the opt-out line disables the plugin in one repo
and that a new user following only the README gets a run that asks no permission.

**Blocked by:** REL-03, REL-03b, WRK-06.

**Status:** needs-human

**Sources:** Q14, Q16, Story verification (install, README and opt-out), stories 198, 199,
223.

- [ ] With the opt-out line in a repo's `.claude/settings.local.json`, "commit this" does
      not spawn the worker and a direct `git commit` is not denied there; another repo is
      unaffected
- [ ] Following the README install steps on a fresh setup, a one-group run asks no
      permission in Bash and in PowerShell
- [ ] The README line on the worker spawn and `callerRule` and the gaps list read
      correctly to someone new to the plugin
- [ ] Someone new to the plugin can say, from the README overview alone, what the plugin
      is for, what each component does and why it is needed
- [ ] By hand (CI cannot produce this): with Node below 22, `/commit` ends with the reply
      the contract gives for that case, never a stack trace; a PATH without git is
      CI-testable (see GIT-01) and not repeated here


## REL-05: Release 0.1.0

**What to build:** the 0.1.0 release: CI green on the full matrix with every size test,
every hand-test and manual check done and recorded, then the tag.

**Blocked by:** REL-04, WRK-06, WRK-07, WRK-08, INT-29, INT-30, PRE-14, RUN-10, RUN-26,
INF-09, GRD-21, FND-09, INT-31, RPL-05, CHG-18.

**Status:** needs-human

**Sources:** Q15, Q24, Story verification (budget and release), Further Notes, stories 202,
228.

- [ ] CI green on ubuntu, windows and macos with Node 22 (oldest and latest) and 24, and in
      the git-2.34 `ubuntu:22.04` container
- [ ] Every story 228 size test green (reply, `text`, list caps, `plan` fields, `plan
      --hunks`, worker prompt, skill and descriptions), including the RPL-05 `lintFailed`
      cap fixture and the CHG-18 size cases
- [ ] Each needs-human slice above has its result recorded; the handback hand-test (WRK-07)
      ran before this release
- [ ] Every issue recorded by the dogfood check (INT-30) closed or deferred by decision
- [ ] The roadmap graph check (FND-09) reports every other slice in `docs/roadmap/` as
      `Status: done`
- [ ] Version 0.1.0 tagged; the episode-analysis tools and the story 205 dogfood gate
      stay on the 1.0.0 roadmap
