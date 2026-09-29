# Q12 Planner subagent and model

- **Status.** Superseded in part by [Q24](q24-token-budget.md) (2026-09-26). The context
  below is refuted by measured data: the diff is a negligible share of a commit's cost, and
  each main-thread API call the caller-driven flow adds costs far more than the diff it
  keeps out. What changed: the planner becomes `commit-worker`, one agent that runs the
  whole run (`plan`, grouping, `check`, commit) and is spawned by the model or by
  `/commit`; the caller no longer runs `plan`, `check` or `commit` except the `run` command
  of a handback answer (Q25); lint retries loop inside the worker, a user's `edit` or `one`
  respawns it; the frontmatter is `model: sonnet`, and the model key is dropped (Q6, after
  the commit-worker spike); every spawn instruction also names `model: "sonnet"` (Q24 as
  amended by the PRE-15 decision pass, below). What stands: the single-author rule, the diff never entering
  the main context, the choice of Sonnet over Haiku by default, and the Haiku eval. The
  failure reply below was replaced by Q25's script-built `reply` (`status: "failed"`) and
  its no-guess rule. The rest of this entry records the design as of the seventh review;
  its `planner.json` is now `plan.groups.json` ([contracts](../contracts/worker-plan.md)).
- **Context.** The main cost of reading a diff in the main thread is not the model price: the
  diff stays in context for every later turn.
- **Decision.** *Superseded by Q24 and Q25 (see Status): the agent is `commit-worker`,
  `model: sonnet`, and it runs the whole run itself.* The plugin ships an agent
  `commit-planner` (frontmatter `model: inherit`, tools
  `Bash`, `Read` and `Write`). The caller runs `plan`, then spawns the planner with the
  `planId`, a mode, the script path and a one-to-three sentence intent summary (what was
  changed and why). The intent is `null` when the caller does not know it (`/commit` in a
  fresh session); the planner then infers it from the diff alone.
  - Script path: an agent file, unlike a skill, gets no base directory, so the caller passes
    `script`, the absolute path of `commit.cjs` from the skill's base directory, with forward
    slashes (`C:/Users/<you>/…/commit.cjs`), which Node, Git Bash and PowerShell all accept. If
    `${CLAUDE_PLUGIN_ROOT}` turns out to expand in an agent file, it replaces `script`
    (open verification item).
  - The planner runs `plan --hunks --plan <planId>`, which prints the absolute `runDir` and
    `hunksFile` (Q9), `Read`s `hunks.txt` in pages (Q19), and uses `Read` on a working-tree
    file only for summary-only files and for hunks past the cap (Q19).
  - *Superseded (Q24, Q25): the worker writes the [worker plan](../contracts/worker-plan.md) to
    `plan.groups.json` and runs `check` itself.* It writes the planner output to
    `<runDir>/planner.json` with `Write`, and returns only `done` and a one-line
    summary. The caller never reads the diff or the planner JSON; it runs `check`, whose
    output carries everything the confirmation needs (Q16).
  - Failure reply: when a script call exits non-zero (`plan --hunks` refused with
    `diff-changed`, `head-moved` or `lock`, or a `usage` / `internal` error), the planner
    writes nothing and replies `failed: <kind> <message>`, with the script's message. The
    caller relays the message and does not run `check`. It is not a failed attempt: no
    retry planner, since the same call would be refused again. `diff-changed` and
    `head-moved` have already ended the run (lock released, folder deleted); after any other
    kind the caller runs `release`, a no-op when the lock is not this run's.

  Modes (fixed by `plan` in the state file):
  - `split` (default): groups with header, optional body, hunks or files, and a one-line
    reason; a `not included` list.
  - `staged` (pre-staged set, Q16): index diff only, exactly one group covering the set; only
    the message is the planner's.
  - `reword` (Q20): HEAD's own diff and message, exactly one group; only the message.

  *Superseded (Q24): lint retries loop inside the worker, which re-reads
  `plan.groups.json`.* The caller runs `check`, which lints every group and computes
  `confirm`. On a lint error a **new** planner is spawned with the same `planId` and the `check` errors; it reads the
  previous plan from `planner.json` itself and overwrites it. One retry, then Q18. Hunk IDs
  stay valid across re-plans (Q9). A missing or unparseable `planner.json` is a lint error
  and counts as a failed attempt; after the retry the caller runs `release`.

  *Superseded (Q6 Rejected, Q24): the model key is dropped and the frontmatter is
  `model: sonnet`.* `plannerModel` mapped onto the Agent call: `"sonnet"` and `"haiku"` were
  passed as `model`; `"inherit"` omitted `model`, so the frontmatter `inherit` applied.
- **Amended.** By spec pass 2 (2026-09-27): the Haiku planner eval is a 1.0.0-roadmap item
  with its own harness and thresholds; no 0.1.0 verifier depends on it.
- **Rejected.**
  - `model:` in the skill frontmatter (switches the main session model and does not help with
    context); `context: fork` for the whole skill (cannot ask for confirmation).
  - Haiku by default (grouping is semantic and lint cannot catch a bad split).
  - Frontmatter `model: sonnet` with `"inherit"` meaning "omit `model`": omission falls back to
    the frontmatter, so "inherit" would not be reachable.
  - The planner running its own `git diff`: it follows the user's git config
    (`diff.external`, `diff.context`, `diff.noprefix`, colour), so its hunks may not match the
    script's.
  - The planner deciding `confirm` itself: whether a human is asked must not depend on an LLM.
  - The caller writing the pre-staged message from the file list: breaks the single-author
    rule and gives poor messages for a set the user staged.
  - Retrying through `SendMessage` to the same planner: depends on it staying alive.
  - Returning the planner JSON as the agent's reply: the caller would have to copy it into
    `check`'s input, which brought back stdin (Q9), and it would sit in the main context.
  - Only `done` as a reply, with a refusal left to `check`: after a `diff-changed` the
    planner's `Write` re-creates the deleted run folder as an orphan, `check` then reports
    `lock` ("taken over", the wrong cause), and the missing-`planner.json` rule spawns a
    retry that hits the same refusal.
- **Consequences.** Roadmap: an eval set of fixture diffs with known correct splits to measure
  Haiku against Sonnet. Version 1.0.0 waits on that eval. The eval, its harness, fixtures and
  thresholds are a 1.0.0-roadmap item: no 0.1.0 story is verified by it, and in 0.1.0 the
  manual hand-test and the dogfood gate (Q24) stand in for it.
- **Amended.** By spec pass 7 (2026-09-27): corrects the Consequences above: the dogfood gate
  is itself a 1.0.0 gate (30+ episodes, Q24), not a 0.1.0 check standing in for the eval —
  Q24's tooling for it is built only after 0.1.0 ships. In 0.1.0 only the manual hand-test
  verifies grouping quality; nothing measures Haiku against Sonnet until 1.0.0.
- **Amended.** By the PRE-15 decision pass (2026-09-29), settling KD-S47: the worker's model
  is fixed by the frontmatter and by an explicit `model: "sonnet"` in every spawn
  instruction (the `/commit` skill, the README, the respawn text, the guard's route), since
  an Agent call's `model` parameter overrides the frontmatter (Q24 as amended).
