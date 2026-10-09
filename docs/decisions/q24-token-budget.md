# Q24 Token budget

- **Status.** Decided on 2026-09-26 after a design session; supersedes Q12 where they
  conflict. After the eighth design review the affected entries (Q2, Q3, Q4, Q6, Q8, Q9,
  Q15–Q20, Q22, Q23) and the contracts were rewritten to match, and the worker protocol
  became Q25. The commit-worker spike (open verification items, 2026-09-26) confirmed the
  direction: the description triggers, the worker runs on its own model, nested spawns
  work, and a pure commit prompt costs the main thread 2 calls headless. It moved the run
  folder out of `.git` (Q9), made the allow rules required (Q16) and dropped `workerModel`
  (Q6).
- **Context.** Measured on 2026-09-26 over 414 Claude Code transcripts from one machine,
  none of them from this plugin: 2,368 commit episodes with 3,052 `git commit` calls, made
  without the plugin. Cost is in input-token equivalents (input 1×, cache read 0.1×, 1 h
  cache write 2×, output 5×).

  | Metric | Median | p90 |
  | --- | --- | --- |
  | API calls with tools per episode | 1 | 3 |
  | tokens of git status / diff / log / show output the agent chose to read | 134 | 1,385 |
  | output tokens | 1,668 | 4,084 |
  | context when the episode starts | 288k | — |
  | episode cost | 76k | 196k |

  - Cost is calls × context. Every extra main-thread API call re-reads the whole context
    from cache, about 0.1 × context: 29k at the median. Over all episodes, git output
    was 1.19M tokens against 1.79B tokens of cache reads. A p90 diff carried for 50 more
    turns costs about 7k, less than a quarter of one extra call. Keeping the diff out of
    the main context (Q12's reason for the planner) saves next to nothing.
  - 62% of episodes are a single call, usually `git add … && git commit -F - <<EOF` at the
    end of a TDD step, where the agent already knows what it changed. 39% ran in a
    subagent, whose context is also large (median 230–250k). 16.5% made more than one
    commit.
  - A prompt-only personal commit skill (10 episodes): median 4 calls and 113k, about 1.5×
    the baseline; its body is about 1.3k tokens per invocation.
  - About 2% of commit calls failed. Ten of these were shell quoting or heredoc errors,
    which the `Write`-based `plan.groups.json` removes (Q9). The saving averages under 1k per
    commit.
  - Outliers: a subagent took 22 calls to make 8 commits, diffing and committing file by
    file. A turn after the cache expired re-wrote up to 1.4M tokens. Both make extra calls
    even more expensive.
  - Caveats: episodes are grouped heuristically, and the weights assume 1 h cache writes.
    The git-output row measures what the agent read, which is little when it already knows
    its change; it is **not** the size of the diff at commit time, which was not measured.

  Estimate for the design as of the seventh review, at the median context. The main thread
  makes Skill → `plan` → Agent → `check` → (confirmation) → `commit` × N → reply calls,
  against commit → reply without the plugin:

  | Case | Extra cost | Total | × baseline |
  | --- | --- | --- | --- |
  | one group, no confirmation | +4 calls (~115k), SKILL.md (~8k, then carried), `plan` and `check` JSON (~3k), planner (~20–40k) | ~220k | ~2.9 |
  | two groups, confirmation | two more calls | ~280k | ~3.7 |
  | guard deny first (Q3): the agent reads status, diff and log, is denied, then runs the skill | baseline, plus one deny call, plus the full run | ~300k+ | ~4 |

  A lint retry, an `edit` or a `one` answer spawns a new planner that re-reads the whole
  diff, even when only a header changes. The plugin saves tokens only on long split loops
  (the 22-call case needs about 11 calls) and on quoting failures. Its gains are
  correctness: the scan gate, lint and grouping.
- **Decision.** Resolved in a design session on 2026-09-26, refined after the eighth
  review. The run moves out of the main thread into one worker agent; the main thread spawns
  it and relays.
  - **One worker, no separate planner.** `commit-planner` becomes `commit-worker` (tools
    `Bash`, `PowerShell`, `Read`, `Write`). It runs `plan`, reads `hunks.txt`, writes
    `plan.groups.json`, runs
    `check`, which commits when nobody needs to be asked. It starts with a fresh
    context, so it reads the diff itself; a nested planner would add a second agent prefix
    (about 20k) for nothing. A lint retry loops inside the worker (one, counted by the
    script, Q18). A user's `edit` or `one` arrives after the worker has returned its
    handback, so it is always a respawn with `resume: <planId>` (Q25); the respawned worker
    reads the previous plan from `plan.groups.json` and reads `hunks.txt` only when the edit
    changes the grouping, which it judges from the free text. The diff still never enters
    the main context, and the worker still writes every message (single-author rule, Q12,
    Q17).
  - **Launch through the Agent tool, not a forked skill.** A `context: fork` skill runs on
    the caller's model whatever its `model:` says (Claude Code docs, 2026-09-26), so the
    worker would run on the main session's Opus or Fable; `agent:` in a skill is documented
    for `.claude/agents/` types, not plugin agents. A plugin agent's `model:` is honoured.
    - The model spawns `Agent(commit:commit-worker)` directly, triggered by the agent's
      description (Q2). A plugin agent's type is namespaced by the plugin
      (`commit:commit-worker`, spike); every text that names it uses that form.
    - The `/commit` skill gets `disable-model-invocation: true` (Q2): no resident
      description, loaded only when the user types `/commit`, and it does the same spawn.
      Its SKILL.md is only the spawn, with the argument mapping of Q2; the handback
      carries the rest (Q25).
    - The guard's deny message (Q3, Q4) says "spawn the commit:commit-worker agent (…)",
      never "run /commit": the reason goes to the model, which cannot invoke `/commit`.
    - The worker's model: frontmatter `model: sonnet`, no config key (Q6). The Agent call's
      `model` parameter overrides it (docs and spike), so a caller that passes one wins;
      nothing on the spawn path passes one (superseded by the PRE-15 decision pass, below:
      every spawn instruction passes `model: "sonnet"`). Also in the frontmatter: `omitClaudeMd: true`
      (the worker needs none of the user's CLAUDE.md; listed as a supported plugin-agent
      field in the plugin docs, and verified: it drops both the project's and the user's
      CLAUDE.md, open verification items),
      `maxTurns: 25` as a runaway cap, and `tools: Bash, PowerShell, Read, Write`. Both
      shell tools are listed because a Windows setup may have only the PowerShell tool
      (no Git Bash); every script call is one `node "<script>" …` command that runs the
      same in both, the guard matches both (Q3) and the allow rules exist for both (Q16).
      The worker's prompt says "run each script call with whichever shell tool you have".
      Git Bash is therefore not a requirement next to Node (Q1). Whether a listed tool the
      session lacks is ignored, and a PowerShell-only worker runs, is part of the
      allow-rule spike (open verification items). The spike used 5–7
      calls for a one-group run; paging `hunks.txt` near the 3000-line cap (about 3
      pages), a `Read` of a capped file at a range and one lint retry can double that, and
      25 still leaves room. A worker that hits the cap dies after `plan` and leaves the
      lock (Q25: the takeover question on the next run), so the dogfood list includes a
      fixture run near the cap that must finish under it.
  - **Handback built by the script.** Every script output that needs a human carries a
    self-describing `handback`, and every output that ends the worker's part a `reply`; the
    worker returns the reply verbatim. Kinds, answers, `ifNoUser` and `callerRule` are Q25.
    `yes` and `no` run one script command in the caller and never spawn a worker.
  - **Callers without a user.** Q17: `interactive: false` makes the worker answer a plain
    confirmation itself; omitted, the caller follows the handback's `ifNoUser`. An
    implementer subagent with `interactive: false` makes the same calls as the main thread
    (Agent, reply, plus a notification turn if the spawn runs in the background).
  - **Measured main-thread calls** (spike, interactive, background worker): a run without a
    confirmation 3 (Agent, acknowledgement, reply); a confirmed run 5 (Agent,
    acknowledgement, `AskUserQuestion`, the handback's `run`, reply); `no` the same 5 with
    `release`. The main thread used `AskUserQuestion` and ran the `run` command verbatim,
    without a permission prompt, both times. In the later nested-spawn probe, which got
    the `SubagentHandback` delivery (Q25), the main thread took one turn for the hand-back
    and one more for the completion notification that followed it: 4 for a run without a
    confirmation, if a direct spawn behaves the same (the gate's harness floor, below).
  - **Also adopted:** `commit --plan <planId> --all` (Q9, Q18); `check` committing in the same process; the
    compact `plan` stdout with the rest in `plan.json` (Q9); a dictated reword passed in the
    worker input (Q20); Haiku through the frontmatter default, for every mode, once the
    eval allows it (Q6, Q12); workflow skills that end in a commit (a TDD skill) spawning
    the worker with its public input fields (Q25).
  - **Budget and gates.** The user runs on a Claude subscription: usage counts against plan
    limits whose weighting of cache reads, cache writes and output is unpublished, and Opus
    may be metered separately. So the gates are counted in calls and raw tokens, not in
    price-weighted cost:
    - CI size tests: agent and skill descriptions ≤ 200 characters, `/commit` SKILL.md
      ≤ 1.5 kB, the worker's agent prompt ≤ 6 kB, `plan`'s own stdout fields ≤ 1 kB, the
      `reply` without its `text` ≤ 3 kB (its `callerRule`, `notices` and `handback`
      included), the reply's `text` ≤ 4 kB with every list at its cap (10 entries, then
      "+N more"; the messages a `confirm` block or a `lintFailed` text quotes are not
      counted, since the user has to read them whole), `plan --hunks` stdout ≤ 20 000
      characters. The budgets add up
      and do not nest: `plan`'s stdout is its own fields plus either a `reply` or the
      in-process `hunks` output, each tested against its own limit, and a refusal's
      `error` object counts toward the 1 kB. Starting values; the slice that writes the
      prompts sets the exact limits.
    - 1.0.0 gate, measured **per episode** (the baseline's unit; a two-group run is one
      episode) on at least 30 dogfood episodes, on a machine without a personal commit
      skill (Q8), with the episode analysis (moved to `tools/`, not packaged). An episode
      includes any denied `git commit` attempt before the spawn. Median main-thread API
      calls per episode for the commit itself, gated separately for unconfirmed and
      confirmed episodes: unconfirmed ≤ 3 in an interactive session, where the worker
      runs in the background (Agent, notification turn, reply), and ≤ 2 in a headless
      one, where the Agent call blocks (spike: 2 in every pure commit prompt); confirmed
      ≤ 5 (spike: 5). A third episode class, **question before planning**, holds episodes with a
      `modeChoice` or `lock` handback (Agent, reply, `AskUserQuestion`, respawn, reply: 6
      or more calls before any confirmation), gated against its own harness floor. A
      single median over all of them would fail by construction once more than half the
      episodes confirm. These limits hold for the delivery shape the spike
      measured (the reply arrives in the completion notification). Under the
      `SubagentHandback` shape (Q25) the harness adds a turn the plugin cannot remove, so
      each limit is the **harness floor** for the shape in use: the calls a stub worker
      that replies at once takes in the same shape, measured once per shape (3 and 5
      above for the notification shape). Each episode records its shape. The
      **confirmation share** `c` and its trigger reasons are reported, and next to `c`
      and `d` the `modeChoice` share and the `lock` share. A likely `modeChoice` source is
      an agent that ran `git add` in its own call and was then denied on `git commit`: the
      spawn finds "index plus other changes" and asks about staging the user never did.
      If that share is high, the staged-by-agent case is reconsidered with the data.
      Median tokens
      that reach the main context per episode (cache writes plus output) ≤ the baseline
      plus 2k; the **deny share** (episodes with a guard deny) reported; worker tokens reported
      per model; the diff size at commit time (`git diff HEAD --numstat`, and the tokens of
      `hunks.txt`) recorded, which replaces the assumed worker cost below. The
      price-weighted ratio is reported as a proxy only. The gate sits next to the Haiku eval
      (Q12); 1.0.0 waits on both.

  Estimate, per episode at the median context, as a function of the deny share `d` (the
  share of episodes where the agent first tries `git commit` and is denied): baseline 76k,
  plus the worker (assumed 20–40k on Sonnet until dogfood measures the diff size), plus one
  main-thread call (~29k) if the spawn runs in the background, plus one more (~29k) in the
  `SubagentHandback` delivery shape (Q25: the hand-back turn and the completion
  notification), plus `d` × (one denied call,
  ~29k, and whatever the agent read before it), plus `c` × two main-thread calls (~58k),
  where `c` is the confirmation share of interactive episodes (`AskUserQuestion` and the
  handback's `run`; an `edit` or `one` adds a respawn and a second confirmation), plus `q` ×
  at least two main-thread calls (~58k) for the `modeChoice` and `lock` share `q` (the
  question and the respawn's reply), which the figures below leave at 0. With a
  blocking spawn and `d = c = 0`: about 100–115k (≈ 1.3–1.5×). Background, notification
  shape, `d = 1`, `c = 0`: about 160–175k (≈ 2.1–2.3×); with `c = 0.5`, about 190–205k
  (≈ 2.5–2.7×). The `SubagentHandback` shape adds about 29k to each background figure.
  Q24's own
  data (62% single-call `git add … && git commit` episodes) says `d` stays high unless the
  agent description and workflow skills change the habit. `c` is high by design in TDD work:
  `split` confirms on more than one group or any new file, and a TDD step often adds a test
  file. The new-file trigger stays: it is the only check against a stray scratch file
  (`out.txt`, `debug.log`) the agent never meant to commit, and no deterministic rule tells a
  new test file from junk. The gate measures `d` and `c`, and records every trigger reason, so
  the new-file trigger can be narrowed with data (for example, a new file whose bucket is
  `test` next to a changed or new `code` file in the same group).
- **Amended.** By spec pass 4 (2026-09-27): the episode analysis in
  `tools/` reads Claude Code session transcripts (the source of the baseline above), the
  worker's own transcripts included for worker tokens. An episode starts at the first
  main-thread commit attempt after a user prompt (a `git commit` shell call, denied or not,
  or an Agent call spawning `commit:commit-worker`) and ends at the main-thread turn that
  presents the last reply before the next user prompt that is not an answer to a handback
  question; each episode records its delivery shape and episode class. The tools are built for the
  1.0.0 gate, after 0.1.0 ships; no 0.1.0 slice depends on them.
- **Amended.** By the PRE-15 decision pass (2026-09-29), settling KD-S47: supersedes
  "nothing on the spawn path passes one". Every spawn instruction the plugin writes passes
  `model: "sonnet"` explicitly, equal to the frontmatter: the `/commit` skill's spawn, the
  README's spawn line, the handback rule's respawn text (C:reply-and-handback), the caller
  rule of C:worker-input and the guard's deny route (C:guard). A caller that follows them
  can no longer override the model by passing another, so "the worker runs on sonnet"
  (story 42) is testable: a static test (WRK-01) asserts that the frontmatter model equals
  the model named in every spawn instruction. A description-triggered spawn (Q2) names no
  model, since the 200-character description has no room; the Agent call then carries no
  `model` and the frontmatter's sonnet applies.
- **Rejected.**
  - Treating diff size as the cost driver: git output read in the baseline is about 0.07%
    of cache reads. The Q19 caps stay for the worker's context and the tool output limits,
    not for cost.
  - The caller driving the run with a planner subagent (the design before Q24): about six
    main-thread calls, ~2.9× the baseline.
  - A worker with a nested planner: a second agent prefix and nesting depth for no gain.
  - A `context: fork` skill as the launcher: runs on the caller's model, and `agent:` is not
    documented for plugin agents.
  - A thin model-invocable skill that spawns the worker: three main-thread calls, and a
    SKILL.md loaded into the main context on every commit.
  - The model calling the Agent tool with no `/commit` skill at all: `/commit` must keep
    working for the user (the README's entry point).
  - "or run /commit" in the guard's deny message: the message goes to the model, which
    cannot invoke a `disable-model-invocation` skill; the call is wasted at full context,
    and on a machine with a personal commit skill it resolves to that skill (Q8).
  - Every answer respawning the worker: `yes` would pay an agent prefix to run one command.
  - The worker composing the answer commands: a script-built command cannot drift, and it
    stays a single `node … commit.cjs …` call for the allow rule (Q16).
  - Skipping the diff for a known single slice (`"source": "caller"`): after the worker
    move it costs more main-thread calls (`plan`, `Write`, `check`, reply) than the
    worker saves, and it broke the single-author rule. A proposed header in `intent` with
    the worker skipping `hunks.txt`: the worker would lose its check that the change is one
    slice, and the caller would author the message again (Q12). The earlier cost argument
    ("the median diff is 134 tokens") misread the metric and is withdrawn; the dogfood
    measurement of the diff size can reopen the question on cost alone.
    `"source": "user"` stays only for a reword with dictated text (Q20).
  - A price-weighted ratio (≤ 1.6×) as a hard gate: it rests on API weights that do not
    describe subscription limits.
  - The gate per commit: divides a two-group run's calls by two, while the baseline is per
    episode. Leaving the denied attempt out of the episode: hides the path the data says is
    common.
  - Two or three worker agents, one per model, as the `workerModel` fallback: resident
    descriptions in every session, and Haiku waits on the eval anyway.
  - `CLAUDE_CODE_SUBAGENT_MODEL` as the model switch: global to every subagent.
  - Haiku for the message-only modes (`staged`, `reword`) only: the mode is known only
    after `plan` has run inside the worker, so the first spawn cannot pick the model. A
    `model` field on a script-built `staged` respawn would cover only the runs that went
    through a `modeChoice`, and adds a public field for it.
- **Consequences.** Q12 is superseded where it conflicts (see its status). The estimate
  depends on two numbers the design cannot fix on paper: the deny share and the worker's
  real cost; the gate measures both. The heartbeat (Q23) is unaffected: the worker's `plan`
  call still fires the guard.
