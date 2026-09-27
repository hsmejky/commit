# Q17 Commits from a subagent

- **Context.** A common workflow: the main thread spawns an implementer subagent, and that
  subagent commits. Verified 2026-09-26: in a subagent the `Skill` tool works and nested
  `Agent` calls work, but `AskUserQuestion` is not available, not even as a deferred tool. Hook
  input carries `agent_id` and `agent_type` for subagent calls.
- **Decision.** Revised by Q24 and Q25.
  - Same flow everywhere: the implementer spawns `commit:commit-worker` nested under it (from the
    agent description, or because its workflow skill names it), passing the intent.
  - Knowing whether a user can be asked: `AskUserQuestion` is absent from the caller's tool
    list **and** from the deferred-tool list in its system reminders (spike: absent in both
    for a subagent, absent from a headless `-p` session's tools; the docs say it is removed
    from every subagent). No ToolSearch call:
    it costs one more call in a large context. That covers a subagent and a headless run
    (`claude -p`, the Agent SDK, CI) alike; both take the subagent path. In a headless run
    "return to the parent" means the final report. A main interactive session where the
    user denied or disallowed `AskUserQuestion` (`permissions.deny`, `--disallowedTools`)
    takes the subagent path too. Accepted gap; the README says so.
  - Two ways to run without a user; both are safe:
    - `interactive: false` in the worker input (the cheap path, one call fewer). The worker
      runs `plan --split --no-user` (or `--reword --no-user`), so it never asks for a mode
      and never passes `--take-over` (Q22; the automatic takeover of a lock untouched for
      15 minutes applies like to any run). `check` then commits a confirmation that
      is not `humanOnly` without asking: the worker's grouping is confirmed by nobody else.
      After two failed lints (one on dictated text) `check` releases the lock and the
      reply carries the errors (Q18).
    - `interactive` omitted: the worker returns handbacks as for a user, and the caller
      follows the handback's `ifNoUser` (Q25): `yes` for a plain confirmation (the
      implementer, who knows the task, has seen the grouping), `no` plus hand-back for
      `humanOnly` and a `lintFailed`, `split` for a mode choice, `wait` plus hand-back for
      a lock (`returnToParent: true`), and `continue` for a `continue` handback, run without
      asking; the full column is in [contracts](../contracts/reply-and-handback.md).
      One call more per confirmation, in the implementer's context.
  - `humanOnly` is never answered without a user: nothing is committed, the lock is
    released (by `check` with `--no-user`, by the `no` answer otherwise), and the reply's
    `text` goes verbatim to the parent, which shows it to the user; the user then runs
    `/commit`, which plans afresh. The `handedBack` handback has no answers, so nothing in
    it points at the ended run. Scan-hit notices (Q10) are passed on the same way, but do
    not stop the commit: every notice is part of `text`, and every reply's `callerRule`
    says a subagent puts `text` verbatim in its final report (Q25), on `committed` and
    `nothing` replies too.
- **Amended.** By spec pass 2 (2026-09-27): the caller-trust eval fixture set is a
  1.0.0-roadmap item; the manual hand-test stands in for it in 0.1.0.
- **Amended.** By spec pass 4 (2026-09-27): the `ifNoUser` list matches
  contracts (`wait` returns to the parent; `continue` runs without a user).
- **Amended.** By spec pass 5 (2026-09-27): a file skipped for size (over 1 MB added, Q10)
  in a run without a user (`interactive: false` or `--no-user`): the worker leaves it out,
  in `notIncluded` with the reason "over 1 MB, not scanned: commit by hand", and commits the
  rest, since including it would make the run `humanOnly` and commit nothing.
- **Amended.** By spec pass 9 (2026-09-27): a run without a user can still take over a
  stale lock automatically, and the takeover can find `killedLeftover` (the user staged
  beyond the killed group's paths after the kill, Q22's pass-6 amendment), which in an
  interactive run forces a `modeChoice`. Nobody could answer that question here, so:
  - `--no-user` without `--reword` → a refusal, exit 6 `state`, domain code
    `killed-leftover`, whose text names the killed group's paths still staged; the index is
    left untouched, the lock is released and the folder deleted. The run still never gets
    a `modeChoice`, and the parent relays the text like any refusal.
  - `--reword` (with or without `--no-user`) → no forced `modeChoice`: `--amend --only`
    never touches the index, so the leftover cannot be committed; the run goes on, and a
    notice names the killed group's paths still staged.
  - Interactive `split` and `staged` runs keep the forced `modeChoice`.
- **Rejected.**
  - An inline mode where the subagent plans itself: a second code path to test. The intent
    summary recovers most of what the implementer knows.
  - Inline planning only when the caller runs on Sonnet or Haiku: hook input has no model
    field, and `model: inherit` makes self-reported models vary, so the branch would be
    probabilistic and double the test paths.
  - A plan file handed from the subagent to the main thread (`/commit --plan <file>`): more
    surface for a rare path; re-planning is cheap.
  - The guard rewriting `commit.js plan` via `updatedInput` to inject the caller kind from
    `agent_id`: deterministic, but makes the hook mutate commands for low stakes, since a
    pattern hit is blocked by the backstop in every context (Q10).
  - A plain-text question as fallback when `AskUserQuestion` is missing: the caller cannot
    tell a main session with the tool denied from a headless run, where nobody would answer.
  - Reading the caller kind from the heartbeat's `agent_id` (Q23): one heartbeat file per
    machine, overwritten by parallel runs, so the answer could belong to another run.
  - The `interactive: false` worker making one `edit` of its own before `yes` (the first
    Q24 draft): a second planning pass by the same agent with no new information.
  - Keeping the lock through a `humanOnly` hand-back, so the parent's user could answer the
    live handback: parallel implementers (the case Q22 exists for) would be refused with
    `lock` for up to 15 minutes while the question travels up.
  - ToolSearch `select:AskUserQuestion` to detect a user: one more call at full context.
- **Consequences.** The agent-confirmed path cannot commit a pattern hit. With
  `interactive: false`, grouping in subagent commits is judged by the agent that proposed
  it; a caller that wants to judge it itself omits `interactive` and pays one call. A wrong
  self-check about the user affects only the non-blocking Q10 items. A file a subagent's run
  leaves out (hit, oversized, collapsed, not part of the intent, Q16) does not stop it from
  committing the rest. Eval fixtures (Q12's set, run on every worker model; a 1.0.0-roadmap
  item with its own harness and thresholds, so no 0.1.0 verifier depends on them): an
  unrelated modified file next to the intended change, spawned with an `intent` and
  `interactive: false` (→ the unrelated file in `not included`, "not part of the intent",
  left in the working tree, the rest committed); the same tree without an `intent` (→ both
  planned); a test file and a lockfile of the intended change (→ planned with it); a hand
  edit by the user next to Claude's change, run through a bare `/commit` (→ both planned,
  Q2).
