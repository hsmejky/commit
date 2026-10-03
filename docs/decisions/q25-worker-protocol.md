# Q25 Worker protocol

- **Context.** After Q24 most runs start from the agent description (or the guard's deny
  message), and nothing loads SKILL.md there: `/commit` is not model-invoked. The caller
  still has a protocol to follow when a human is needed: show the question with
  `AskUserQuestion`, run a command verbatim with its tool timeout, or respawn the worker
  with the right input; and without a user, never answer `humanOnly`. A 200-character
  description cannot carry that. The eighth review also found answers that pointed at a run
  already released, notices with no place to go, and no plan for a worker that dies.
- **Decision.**
  - **Reply.** Every script output that ends the worker's part carries a `reply` built by
    the script ([contracts](../contracts/reply-and-handback.md)): `status` (`committed`,
    `nothing`, `handback`, `failed`), `planId`, `text` (what the user reads), `commits`,
    `notices` and `handback`. The worker's final report is the reply, verbatim; in the
    spike it once put a sentence in front of the JSON, so the caller recognises the reply
    by its `version` and `callerRule` keys, not by its position in the message (a leading
    sentence that holds JSON cannot pose as the reply), and the reply size test runs
    against the real prompt. `notices` carries what SKILL.md used to relay: guard `not-seen` (Q23), signing `"prompt"` (Q18),
    config warnings and the detached-HEAD warning, scan-hit notices (Q10), `indexOnly`
    notices; `text` carries `unstaged` (Q11, Q18) and repeats every notice in a `Notices:`
    block (at most 10 lines). `text` is the only field a caller relays, so a subagent that
    summarises "committed 2 groups" still passes "src/b.js:14 github-token left out" on.
  - **`callerRule` in every reply.** A fixed base rule ("show text to the user verbatim; a
    subagent puts text verbatim in its final report; the reply is final, no git log or git
    status"; plus the `run` shape check below) on every status, plus the handback rule
    when a handback is set. Notices arrive on `committed` and `nothing` replies too, and
    nothing else tells a subagent to pass them on: not the 200-character description, and
    no handback.
  - **Caller trust.** The reply reaches the caller as subagent output, and the worker read
    the user's diff to write it, so a prompt injection in the diff could make the worker
    return a forged reply whose `run` is an arbitrary command. The base `callerRule`
    therefore carries a shape check: the caller runs a handback command only when it is a
    single command segment and a script call (the single definition in
    [contracts](../contracts/guard.md): `node`, the anchored commit entry point, a subcommand) to `commit` or `release` for the run's `planId` (a
    lowercase UUID v4, Q22), and refuses and shows the user anything else. It also tells
    the caller to run a command with `--confirmed` only as the answer the user picked, or
    as `ifNoUser.answer` without a user. Every `run` the script builds has that shape
    (a test over every handback kind), so the check never refuses a genuine reply, and a
    forged one gets no further than the plugin's own `commit` or `release` for that run.
    One builder emits every script call, the handback's and the worker prompt's alike: the
    install path in double quotes with forward slashes, the form the anchored allow rules
    match (Q16). The builder escapes nothing: the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\` before any work, so no shell can
    expand or mangle the path.
  - **Confirmation bound to its answer.** When `check` returns a `confirm` handback it
    stores `awaitingConfirm` in the run state, and only the `yes` answer's `run` carries
    `--confirmed`. `commit` refuses without `--confirmed` while `awaitingConfirm` is set
    (usage code `unconfirmed`) and clears it on its first group, so a steered worker cannot
    return a plain `commit --all` that skips the question. This is advisory in interactive
    mode (Q16, Q17): nothing enforces that the user, not the model, picks `yes`.
  - **Self-describing handback.** Each handback carries `question`, `answers` (each a `run`,
    one `node … commit.cjs …` command with `timeoutMs`, or a `respawn`, a complete worker
    input), `ifNoUser` (the answer to take without a user, and whether to return `text` to
    the parent), and the reply's `callerRule` gains the handback rule, the whole protocol
    in about 650 characters ([contracts](../contracts/reply-and-handback.md)). The rule
    arrives exactly when it is needed. It covers what `AskUserQuestion` cannot take as is
    (2–4 options, "Other" added by the tool): a handback with `question: null`
    (`continue`) runs its one answer without asking; an answer with `needsText` (`edit`)
    is not an option but the text the user types under Other, which the question names;
    an answer with neither `run` nor `respawn` (`wait`) ends the run; and a `run`'s output
    holds a new reply, handled the same way (a `continue`, notices).

    | Kind | When | Answers |
    | --- | --- | --- |
    | `confirm` | a Q16 trigger, interactive | `yes` (run `commit --all --confirmed`), `one` (respawn; `split` with more than one group only, Q16), `no` (run `release`); `edit` under Other (respawn) |
    | `modeChoice` | index plus other changes, no mode flag (Q9) | `staged`, `split` (respawn) |
    | `lock` | a live lock, interactive (Q22) | `take over` (respawn), `wait` |
    | `lintFailed` | second lint failure, or the first on dictated text; interactive (Q18) | `retry` (respawn with the errors), `no` (run `release`); `edit` under Other (respawn), except when every error is a shape error (the worker plan is not valid JSON or not its shape): dictated text cannot fix a shape. The text quotes each rejected message with every scan-hit span replaced by `[<pattern-id>]` |
    | `handedBack` | `humanOnly` without a user, run already released (Q17) | none: `text` says "nothing committed — run /commit to plan again" |
    | `continue` | `commit --all` out of budget (Q18) | `continue` (run the same command, no question) |

    An answer never points at a released run: `handedBack` has none, and the others exist
    only while the lock is held.
  - **Where each rule comes from.**

    | Entry path | Spawn rule | Handback rule |
    | --- | --- | --- |
    | model-invoked, main thread | agent description | `callerRule` |
    | model-invoked, subagent | agent description (plus Q17's `interactive`) | `callerRule`, `ifNoUser` |
    | `/commit` | SKILL.md | `callerRule` |
    | guard deny (Q3) | deny message | `callerRule` |
    | workflow skill | its own text, with the public input fields | `callerRule` |

  - **Worker input.** `key: value` lines in the Agent prompt, all optional: `intent`,
    `interactive`, `reword`, `mode`, `takeOver`, `resume`, `edit`
    ([contracts](../contracts/worker-input.md)). The agent type `commit:commit-worker` and the
    fields `intent`, `interactive` and `reword` are **public surface**: `/commit` is not
    model-invocable, so a third-party workflow skill has to spawn the worker itself, and
    those three are all it needs. `mode`, `takeOver`, `resume` and `edit` are internal:
    they appear only in script-built `respawn` values, which belong to the handback shape,
    and the contracts mark them "respawn-only, do not write by hand". The README documents
    the one-line spawn ("spawn commit:commit-worker with `intent: …`").
  - **Respawns carry the caller's own fields.** The script builds each `respawn`, and
    repeats in it the flags of the call that built it (Q9: `mode`, and `takeOver` in a
    `lock` handback's `take over` only). It never
    sees `intent` or a dictated `reword: <text>`: both live only in the worker's
    prompt. So the handback rule says "plus the intent and reword lines of your first
    spawn, and interactive: false if you cannot ask", and a caller adds exactly those,
    besides inserting the user's `edit` text. Without the `interactive` line a subagent
    that took `ifNoUser: split` would respawn without `--no-user` and pay one call more on
    every later handback. Without it, a `take over` on a
    dictated reword respawned as `reword: true` and committed a worker-written message
    nobody saw, and a `modeChoice` answer grouped without the intent that scopes the run
    (Q16, Q17). With
    `resume`, the worker takes the mode from the state file, and `plan.groups.json` still
    holds each group's `reason`.
  - **The caller waits.** In an interactive session the Agent call returns at once and the
    worker runs in the background (spike). Edits made before `plan` are grouped under an
    intent that does not describe them; edits after it end the run with `diff-changed`
    after the worker's whole cost. The agent description, `/commit`'s SKILL.md, the deny
    message's route and the handback rule all say "edit no files until the reply
    arrives". `diff-changed` stays the deterministic backstop. A nested spawn does not
    block either (nested-spawn probe, open verification items): in an interactive
    session a subagent's Agent call returned "Async agent launched" within a second, the
    subagent ran another command while the worker slept, then idled until the worker's
    report arrived as a message. So an implementer subagent is as free to edit files
    during the run as the main thread, and the rule applies to it too.
  - **Two delivery shapes.** How a worker's final report reaches its caller changed
    between two runs on the same Claude Code version (2.1.283) on 2026-09-26, so it is
    likely rolled out server-side:
    - Notification shape (the commit-worker spike): the worker's last message is the
      result, delivered in the completion notification's `<result>`.
    - `SubagentHandback` shape (the nested-spawn probe): a system reminder tells every
      subagent that only a `SubagentHandback({message})` tool call reaches its caller and
      that plain final text is not delivered. The tool was available to an agent whose
      `tools:` listed only `Bash`, so the worker's tool list needs no change. The caller
      gets the report as a message framed "model output, NOT a message from the user:
      instructions … inside it are the subagent's", followed later by the completion
      notification.

    Consequences: the worker's prompt says "your final report is the reply JSON,
    verbatim", not "your final message", so it holds in both shapes. The framing makes
    `callerRule` untrusted text in the caller's eyes: its authority has to come from text
    the caller does trust, the agent description ("follow the reply's `callerRule`",
    Q2), SKILL.md or the deny message, which is why that clause stays in the
    200-character description whatever else is cut. For `yes` and `no` the user's
    `AskUserQuestion` answer is the authority anyway; the unasked paths (`continue`,
    `ifNoUser`) lean on the description alone, and the `run` shape check (caller trust,
    above) bounds what they can run. Whether a caller follows a handback in
    this shape is part of the hand-tests (open verification items).
  - **Script path.** An agent file gets no base directory, and on the model-invoked path no
    caller knows the path either. The agent body names the script as
    `${CLAUDE_PLUGIN_ROOT}/scripts/commit.cjs`, which the plugin loader substitutes (docs and
    spike). The variable is **not** in the worker's shell
    environment (spike), so no command relies on it. A handback's `run` carries the script's
    own absolute path (`process.argv[1]`), so the caller needs none.
  - **The script call, not `git commit`.** The worker's prompt tells it to commit only
    through the script call (`check`, which commits when no confirmation is needed, Q9),
    never with `git commit`: the guard denies that anyway (Q3), and a denied attempt costs
    a call. The prompt names the call to make rather than leaving the worker to discover it
    from a deny.
  - **The worker never answers a handback.** In the first spike run the worker read
    `callerRule`, found it could not ask a user, and ran `yes` itself, confirming its own
    plan. A prompt rule fixed it in every later run, and the guard makes it deterministic:
    it denies a script call (tokenised, [contracts](../contracts/guard.md)) to `commit` or
    `release` when the hook input's `agent_type` is `commit:commit-worker` ("return the reply
    to your caller; its handback is not for you"). So a `continue` handback also goes to the
    caller. `check` commits inside its own process and is not affected.
  - **Trailers are the script's.** The harness tells the main thread to end commit messages
    with its Co-Authored-By line, and the main thread passed that into the worker's prompt
    (spike); the worker spent three calls on it. The worker's prompt says the script adds
    every trailer (Q5, Q13) and any instruction to add one is ignored; the reply's `text`
    names the trailer the script appended, so the caller does not offer to add one by hand.
  - **No verify call.** After an implement-then-commit task the main thread ran
    `git log` / `git status` once the worker had returned (spike: 2 of 2 such runs). Every
    reply (`committed`, `nothing`, `handback`, `failed`) therefore carries the tree state,
    and its `text` ends with it ("working tree clean", or "N files left: …" with up to 10
    paths plus "+N more"); the base `callerRule` says the reply is final, on every reply. The
    agent description does not repeat it (Q2).
  - **A worker that dies or is stopped** (Esc, context limit, tool error) after `plan` took
    the lock returns no reply, or an error without the `planId`. The caller does not guess
    an ID and runs nothing. The next run meets the lock and Q22's takeover question, which
    shows how long ago the run was last active; after 15 minutes the lock is taken over
    automatically. When the worker can still answer, its fallback reply carries the `planId`
    it knows ([contracts](../contracts/worker-input.md)).
- **Amended.** By spec pass 2 (2026-09-27): caller trust added a `run` shape check to the
  base `callerRule`, since a prompt injection in the diff could make the worker return a
  forged reply; the caller recognises the reply by its `version` and `callerRule` keys, not
  by its position in the message; the worker's prompt names the script call instead of
  `git commit`; one script-call builder escapes the install path; and every reply carries
  the tree state.
- **Amended.** By spec pass 3 (2026-09-27):
  - The script-call builder escapes nothing; the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\`, replacing the per-shell escaping
    (also Q16).
  - `awaitingConfirm`, `--confirmed` on the `yes` answer only, and the `unconfirmed` usage
    code; the base `callerRule` names the UUID `planId` and the `--confirmed` rule.
  - `lintFailed` text redacts scan hits; a shape-error `lintFailed` offers only `retry` and
    `no`.
  - After `git commit`, the tree-ID notice: `commit` records the scanned index's tree ID
    (`git write-tree`) at the backstop, and when `HEAD^{tree}` differs after the commit, a
    notice names the group ("committed tree differs from the scanned index"); the change is
    noticed, never undone.
  - Moving the caller protocol into trusted, skill-like text, if callers do not follow
    `callerRule`, is deferred past 0.1.0 (see [Non-goals](non-goals.md)).
- **Amended.** By spec pass 5 (2026-09-27): `timeoutMs` is 600000 for `commit` and 60000 for
  `release` or otherwise, since `release` never waits on a git call; the caller passes it as
  the tool timeout. `busy` (another call's `call.lock` already held) is an immediate
  refusal, never a wait. Accepted gap: `--confirmed` stops a steered (prompt-injected)
  worker from returning the confirmed command itself, but such a worker can still
  misdescribe the plan in its own reply `text`, even though the `run` shape check bounds
  what it can actually execute.
- **Amended.** By spec pass 6 (2026-09-27): handbacks work only from a marketplace install,
  because the caller's `run`-shape check requires the script path to be inside the Claude
  plugin cache (the contracts already state this rule); with `--plugin-dir` the caller cannot
  get a matching path, so it shows the command to the user instead of running it — an
  accepted gap (recorded in the spec's [Out of Scope](../spec/out-of-scope.md), not this decision). The already-resolved
  spikes (Agent frontmatter, Nested spawn blocking, The commit worker, below) do not depend
  on this path check, so their results still hold even though they ran under
  `--plugin-dir`.
- **Amended.** By spec pass 7 (2026-09-27): the `release` reply keeps `treeState` (Q25's own
  rule that every reply carries the tree state), paired with the 60 s `release` timeout
  (pass 5): its status read (M10) gets its own 45 s budget, below that 60 s ceiling. When the
  budget runs out the reply omits `treeState`; the release itself has already completed by
  then, so only the reply's completeness is affected, not the outcome.
- **Amended.** By spec pass 9 (2026-09-27):
  - Output that is not JSON. When a worker's script call prints output that is not JSON,
    the fallback reply's `text` quotes it with the escaping and the 2000-character cap of
    relayed git or hook output. The handback rule gains the clause "if it holds no reply,
    show it and run nothing more" for a `run` whose output holds no reply (the rule was
    silent, and only the worker prompt had a non-JSON rule); the lock is left to Q22's
    takeover question, as after a dead worker.
  - Accepted gap: a steered worker can forge a `confirm` reply whose `ifNoUser.answer`
    picks `yes` (`commit --all --confirmed`) on a `humanOnly` confirmation. A caller without
    a user that spawned the worker without `interactive: false` runs it, because
    `callerRule` travels inside the reply, and `commit` accepts it while `awaitingConfirm`
    is set. Mitigation: spawn with `interactive: false` when no user can answer, so `check`
    hands a `humanOnly` run back and releases it. Refusing `--confirmed` on a `humanOnly`
    run without a user, or allowing it only on a picked `yes`, was considered; the gap is
    documented instead (spec [Out of Scope](../spec/out-of-scope.md)).
- **Amended.** By the PRE-15 decision pass (2026-09-29), settling KD-S47, KD-S59, KD-S67
  and KD-S74:
  - Respawn model. The handback rule's respawn text and the caller rule of C:worker-input
    name `model: "sonnet"` explicitly (Q24 as amended), like the `/commit` skill's spawn.
  - Tool failure in the worker. When a `Write` or `Read` the worker needs fails (the worker
    plan or a message file cannot be written, `hunks.txt` or `hunks.json` cannot be read),
    the worker returns the fallback reply with the `planId` (or `null` before `plan` minted
    one), as when a script call prints no output it can parse; it does not retry. The lock
    is left to Q22's takeover question (C:worker-input).
  - Tree state. The rule that every reply ends with the tree state has three exceptions: the
    worker-built fallback reply (the worker has no tree read of its own), a `release` reply
    whose status read ran past its 45 s budget (pass 7), and a `state` refusal for
    `not-a-repo` or a bare repository (there is no working tree to read)
    (C:reply-and-handback).
  - `humanOnly` without a user holds for an honest worker only; a forged `ifNoUser` answer
    stays the accepted gap of pass 9 (story 102, glossary).
- **Amended.** By the GRD-13 review (2026-10-03): a script call has two widths
  ([contracts](../contracts/guard.md), Script call). The guard's wide recogniser, for the
  worker-only rule and the heartbeat only, matches `node`, `node.exe` and `commit.cjs` in any
  case and after a leading `(`/`{` group, Bash `!` or `time`, or a PowerShell `&`/`.`; it
  never skips an assignment or a runner (`X=1`, `NODE_OPTIONS=…`, `env`). The caller's `run`
  shape check and the step 2 exemption accept only the narrow form S2 `build` emits, so
  nothing new passes. The worker-only rule is defence in depth, not the deterministic
  boundary "the guard makes it deterministic" above suggests: `node -- "…/commit.cjs"`,
  `bash -c '…'`, a copied or linked `commit.cjs` and the interpreter gap stay documented
  gaps; the prompt rule and the caller's planId-bound shape check remain.
- **Rejected.**
  - The protocol in the agent description: it does not fit in 200 characters and would be
    resident in every session.
  - The protocol in the worker, with the worker asking the user: a subagent has no
    `AskUserQuestion` (Q17), and a worker in the background may not reach the user.
  - `interactive` as the only signal: a caller that forgets it gets a handback it has no
    instructions for. Dropping `interactive` and always handing back: one more call at full
    context per confirmation in every implementer (Q17).
  - Answers kept after a release (a `humanOnly` hand-back whose `yes` runs `commit --all`):
    the command fails with "this run has already ended".
  - The worker writing its own reply: the shape drifts, notices get dropped, and the size
    cannot be tested.
  - An internal spawn contract that third-party skills rely on anyway: a silent change
    would break them.
  - Releasing the lock from the caller when the worker died: the caller has no reliable
    `planId`, and a guessed one could release another run's lock.
  - The worker storing `intent` in `plan.groups.json` for `resume`: it covers only one of
    the three respawns, since `modeChoice` and `lock` end before any plan file exists.
    `plan --intent <text>`: brings back the shell-escaping problem (Q9).
  - `edit` as an `AskUserQuestion` option: an option has no text field, so a user who
    picks it leaves the caller without `{text}`. A `lintFailed` with `edit` and `no` only:
    one option is below `AskUserQuestion`'s minimum of two, hence `retry`.
  - The caller taking the first JSON object in the worker's message as the reply (the
    design before spec pass 2): a leading sentence that holds JSON would pose as it.
  - `callerRule` only on handbacks (the design before the ninth review): notices on a
    `committed` reply had no rule that carried them past a subagent.
  - All seven input fields as public surface (the design before the tenth review): a
    workflow skill needs only `intent`, `interactive` and `reword`, and freezing the
    respawn-only fields would have blocked the respawn fix (Q9) and any later protocol
    change without a major version.
  - Respawns that hold only their own answer, with the caller adding `intent` and
    `reword` (the design before the tenth review): a takeover after a mode choice looped
    (Q9).
- **Consequences.** Every entry path follows the same rule text, and the rule is tested
  once, in the script. Public surface grows by the agent name and three input fields; the
  respawn-only fields, the reply and the handback shapes stay internal (`version: 1`), since
  they describe themselves. A worker that dies costs the user one takeover question, or 15
  minutes.
