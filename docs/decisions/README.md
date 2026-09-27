# Design decisions

Architecture decision records for `commit`. Each entry gives the context, the decision, the
alternatives that were rejected, and the consequences. Q1–Q16 come from the original design
review; the entries were refined over ten design reviews on 2026-09-26 (the reports are
kept out of history, Q15). Q24 (token budget) moved the run into one worker agent and
supersedes Q12 in part; Q25 fixes the worker protocol. Data shapes, grammars and
classification tables live in [contracts](../contracts/README.md).

## Contents

- [Q1 Skill plus a deterministic script](q01-skill-plus-a-deterministic-script.md): Two Node entry points (commit script and guard) share one module library and do deterministic work; no npm dependencies, Node 22+ required.
- [Q2 Model invocation on the worker agent](q02-model-invocation-on-the-worker-agent.md): The worker agent's auto-invocation description carries the trust clause, triggers and the `intent` field; revised by Q24's single-worker design.
- [Q3 Guard hook against direct git commit](q03-guard-hook-against-direct-git-commit.md): A PreToolUse hook tokenizes shell commands and denies direct `git commit`, steering the agent to the worker; it steers, not a security boundary.
- [Q4 Hook allowlist, no env switch](q04-hook-allowlist-no-env-switch.md): A strict allowlist permits only `--no-edit` and plain `--fixup=<commit>` forms of `git commit`; every other form, including bare `-m`, is denied.
- [Q5 Configurable rules, inferred from history](q05-configurable-rules-inferred-from-history.md): Commit rules are configurable; the attribution trailer follows Claude Code's own settings layering (managed, project, user) to pick a trailer.
- [Q6 Config layers and keys](q06-config-layers-and-keys.md): Two config layers, user and repo `commit.json`, override per key; fixed keys (`types`, `scope`, `body`, `scanIgnore`, ...) are validated on load.
- [Q7 commit-config skill](q07-commit-config-skill.md): The `commit-config` skill infers scope, body, case, length and type conventions from the last 200 commits and writes a config only after confirmation.
- [Q8 Naming](q08-naming.md): Everything is named `commit` (repo, marketplace, plugin, skills; install `commit@commit`); a personal commit skill must be removed first.
- [Q9 Script interface](q09-script-interface.md): Defines the script's subcommands (`plan`, `plan --hunks`, `check`, `commit`, `release`, `infer`) and the run-folder-based protocol with the worker.
- [Q10 Secret and local-path scan](q10-secret-and-local-path-scan.md): Scans diffs and commit messages for secrets and local paths with fixed patterns; only `scanIgnore` globs from the repo config at HEAD are exempt.
- [Q11 Atomic commits by functionality](q11-atomic-commits-by-functionality.md): Grouping into atomic commits by functionality is the worker's job at hunk level, using opaque unit IDs and a temporary index for untracked files.
- [Q12 Planner subagent and model](q12-planner-subagent-and-model.md): Superseded in part by Q24: the original `commit-planner` subagent design is replaced by one `commit-worker` agent that runs the whole run itself.
- [Q13 Hook performance and trailers](q13-hook-performance-and-trailers.md): The guard's hook `if` condition is used only if it reliably matches compound commands; footers are parsed and appended by a hand-written grammar.
- [Q14 Per-repo opt-out](q14-per-repo-opt-out.md): Per-repo opt-out uses Claude Code's built-in `enabledPlugins` setting to disable the whole plugin; no plugin-specific opt-out code.
- [Q15 Repository layout](q15-repository-layout.md): Fixes the repository layout: thin entry points over a shared module library, docs split per topic, and a CI matrix with a minimum-git container job.
- [Q16 One confirmation at most](q16-one-confirmation-at-most.md): At most one confirmation per run, computed deterministically by `check` from fixed triggers (multiple groups, new files, `humanOnly` items).
- [Q17 Commits from a subagent](q17-commits-from-a-subagent.md): Revised by Q24 and Q25: a caller without `AskUserQuestion` self-confirms plain questions (`interactive: false`) or follows the handback's `ifNoUser`.
- [Q18 Failures, repo hooks and signing](q18-failures-repo-hooks-and-signing.md): `check` lints every group before the first commit; `commit` stops at the first failing group, verifies each staged diff, and never disables signing.
- [Q19 Large diffs](q19-large-diffs.md): Files past fixed size or line thresholds become summary-only; hunk bodies are capped at 3000 changed lines total and paged through `hunks.txt`.
- [Q20 Reword via amend](q20-reword-via-amend.md): Rewording the last commit runs only on explicit request, via `git commit --amend --only -F -`; pushed, unborn and merge-commit HEADs are refused.
- [Q21 Repo states](q21-repo-states.md): `plan` detects repo state (unborn HEAD, an in-progress merge, rebase or bisect, wrong commit encoding, etc.) and refuses to commit mid-operation.
- [Q22 Concurrent runs](q22-concurrent-runs.md): A run lock plus a per-call lock serialize concurrent commit runs; a lock stale for 15+ minutes can be taken over, with index repair on takeover.
- [Q23 Guard heartbeat](q23-guard-heartbeat.md): A heartbeat file the guard writes when it sees a `plan` call lets `plan` detect and warn when the guard hook did not actually run.
- [Q24 Token budget](q24-token-budget.md): Supersedes Q12: measured token costs justify moving the whole run into one `commit-worker` agent launched via the Agent tool.
- [Q25 Worker protocol](q25-worker-protocol.md): Defines the worker protocol: script-built reply and handback objects, caller-trust rules, respawn fields, and handling for both delivery shapes.
- [Non-goals](non-goals.md): Lists what 0.1.0 excludes: pushing, setting up signing, non-Conventional-Commits repos, folding into existing commits, and deferred roadmap items.
- [Public surface](public-surface.md): Lists the fields, paths and names fixed as public surface (config paths and keys, plugin and agent identity, worker input fields, scan pattern IDs).
- [Open verification items](open-verification-items.md): Lists spikes and probes, resolved or open, that verify guard, worker and protocol assumptions (tokenizer, heartbeat, handback shape) before release.
