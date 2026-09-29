# Prompt-only and manifest blocks

- **commit-worker agent.** Frontmatter `model: sonnet`, `omitClaudeMd: true`, `maxTurns: 25`,
  tools Bash, PowerShell, Read, Write. Description ≤ 200 characters with the clauses in Q2
  order ("follow the reply's `callerRule`" first and never cut; the triggers; `intent`;
  "edit no files until it replies"; `interactive`; "don't read the diff first"); when it
  must shorten, it cuts from the bottom. Prompt ≤ 6 kB, obliging the worker to:
  - run steps 1-4 of C:worker-input, and on `resume` start at `plan --hunks --plan <planId>`
    and `Read` the worker plan before writing it;
  - name the script by the loader-substituted plugin-root path, because the variable is not
    in its shell and S2 recognises a script call by that path; commit only through the script
    call (`check`, which commits when no confirmation is needed), never `git commit`, which the
    guard denies;
  - `Read` nothing outside the run folder except a working-tree file at a line range, when a
    hunk needs more context, and never a file that has a hit, also not to recover a hit;
  - on an `edit`, apply the user's text verbatim (`source: user`); on a `retry`, rewrite the
    message from the lint errors and set `source: worker` when the words change (the script
    does not compare them; C:worker-plan);
  - under `interactive: false` or `--no-user`, leave every file skipped for size
    (`scan.skipped`) out, in `notIncluded` with the reason "over 1 MB, not scanned: commit
    by hand", so the rest commits (story 103, Q17);
  - run each script call with whichever shell tool you have, every one of them (`plan`,
    `plan --hunks`, `check`) with a 600 000 ms tool timeout (Q9);
  - fix lint failures without replying; your final report is the reply JSON, verbatim;
    never run a handback's commands; write nothing after a failed script call;
  - when a script call fails without JSON output (a Node too old to parse the entry point, before 12; a removed plugin version),
    return the fallback reply (stories 46 and 213) with the output as its `text` (escaped and capped
    like relayed git or hook output: controls as `\xNN`, the last 2000 characters), the known `planId` or
    `null`, and the base `callerRule`, whose text the prompt carries verbatim (counted in the
    6 kB);
  - reply that Node is missing and the guard is off too when `plan` cannot start Node;
  - ignore trailer instructions; write issue footers only when the user supplied them; follow
    the language of recent subjects; add `scanIgnore` entries only when asked.
  Sources: Q2, Q9, Q10, Q11, Q12, Q13, Q18, Q24, Q25.
- **`/commit` skill.** User-only (`disable-model-invocation: true`); spawns the worker only,
  mapping its arguments per Q2 (bare → no `intent`; text → `intent`; `reword [<text>]`),
  always with `model: "sonnet"` (Q24 as amended by the PRE-15 decision pass), and tells
  the caller to edit no files until the worker's reply arrives (Q25); ≤ 1.5 kB, description ≤ 200 characters (Q24).
  Sources: Q2, Q24, Q25.
- **`/commit-config` skill.** User-only. Runs `infer`, shows the proposal with its numbers,
  asks for repo or user level, and after confirmation writes that layer's `configJson` text
  verbatim; if that layer has `errors`, shows them and writes nothing. Below 20 commits it
  proposes nothing and recommends the defaults; below 50% Conventional Commits it says the
  repo is out of scope and points to the opt-out line. Description ≤ 200 characters (Q24).
  Sources: Q6, Q7, Q14, Q24.
- **Hook registration.** `PreToolUse` on `Bash|PowerShell`, exec form (`node` as the command,
  the guard entry point as the only argument), so that no shell quotes the plugin path. The
  `if` condition (`Bash(git *)`, `PowerShell(git *)`, plus the script-call forms for the
  heartbeat) is added only if the spike confirms it covers compound commands; G1's early
  exit stays as the backstop either way. Sources: Q3, Q13, Q23.
- **README.** An overview for a first-time reader, placed first: the problem and the
  solution in a few sentences (Problem Statement, Solution), one table of the packaged
  components (role, what fails without it, the deciding Q) and the flow of one `/commit`
  run. One line saying the plugin spawns the public worker `commit:commit-worker` with
  `model: "sonnet"`, `intent`, `interactive` and `reword`, and that a caller follows the reply's `callerRule`;
  the allow rules of Q16 (anchored node rule for both shells, run-folder `Edit` rule; no
  bare rule), the personal-skill removal, the opt-out line, worktree isolation, Node as a
  hard requirement (the native installer ships none, Q1), `.commit-plan/` for the ignore
  lists of file watchers and sync tools (Q9), and the
  accepted gaps listed in Out of Scope (the one gap list; story 201 points there too).
- **Manifests.** Plugin and marketplace identity `commit@commit`, version 0.1.0.
