# 13 Worker and skills

The `commit:commit-worker` agent (definition, description, prompt) and the `/commit` skill:
the prompt-only rules the script cannot enforce, held by CI static checks and size tests,
then proven by hand from a local-marketplace install. The worker drives the INT workflows;
the hand-tests close the worker-protocol, caller-trust and subagent rows of Story
verification. Sources: Prompt-only and manifest blocks, C:worker-input, C:worker-plan,
C:reply-and-handback, Q2, Q17, Q24, Q25, public surface.

## WRK-01: Worker agent definition and description

**What to build:** the `commit-worker` agent definition with its fixed frontmatter and a
description that makes the main session spawn it for "commit this", keeping the trust
clause first; CI holds the frontmatter values and the 200-character budget.

**Blocked by:** FND-02, FND-03, PRE-15.

**Status:** ready-for-agent

**Sources:** Q2, Q12, Q24, Q25, Prompt-only and manifest blocks "commit-worker agent", public
surface (agent name), stories 6, 42, 228.

- [ ] A static test reads the agent frontmatter: `model: sonnet`, `omitClaudeMd: true`,
      `maxTurns: 25`, tools exactly Bash, PowerShell, Read, Write (story 42)
- [ ] CI size test: the description is ≤ 200 characters (story 228's budget as held by
      Q24, whatever the story's wording)
- [ ] The description holds the six Q2 clauses in order, starting with "follow the reply's
      `callerRule`"; a static test asserts that clause comes first, so any shortening cuts
      from the bottom (story 6)
- [ ] The agent resolves as `commit:commit-worker` from the plugin layout (static check of
      the agent file name against the public-surface name)
- [ ] A static test asserts that the frontmatter model equals the model named in every
      spawn instruction the plugin ships: the respawn text of the base `callerRule`
      (C:reply-and-handback) and the guard's deny route (C:guard) now, the `/commit`
      skill (WRK-05) and the README spawn line (REL-03) as those slices add them (story 42
      as settled by PRE-15; Q24 as amended)


## WRK-02: Worker prompt: one run from `plan` to `check`, and the resume path

**What to build:** the worker prompt that runs steps 1-4 of C:worker-input: `plan` with the
flags its input fields give, `hunks.txt` read, `plan.groups.json` written, `check` run,
the reply returned verbatim; on `resume` it starts at `plan --hunks --plan <planId>` and
`Read`s the worker plan before writing it.

**Blocked by:** WRK-01, INT-02, GRD-13, PRE-12.

**Status:** ready-for-agent

**Sources:** C:worker-input (steps, fields, tool timeout), C:worker-plan, Q9, Q11, Q12, Q24,
Q25, Prompt-only and manifest blocks, stories 41, 43, 44, 58, 226.

- [ ] The prompt names the script by the loader-substituted plugin-root path, never a
      shell variable; a static test asserts every command form in the prompt (`plan`,
      `plan --hunks --plan`, `check --plan`, each input-field flag) equals S2 `build`'s
      output for that call with the plugin root as the path
- [ ] The prompt says every script call runs with a 600 000 ms tool timeout, with
      whichever shell tool the worker has (story 41, 43)
- [ ] The prompt forbids `git commit`, `commit --all`, `release` and any handback
      command; a static test asserts no such command form appears as an instruction
- [ ] Read rules: changes are read only through `hunks.txt`; nothing outside the run
      folder except a working-tree file at a line range, never a file with a hit, also
      not to recover one (story 226)
- [ ] Resume: skip `plan`, run `plan --hunks --plan <planId>`, `Read` `plan.groups.json`
      before writing it (also on a `retry`), read `hunks.txt` only when an `edit` changes
      the grouping
- [ ] With `reword: <text>`, the prompt runs `plan --reword --dictated` (no hunk index) and
      writes `plan.groups.json` as `{ "version": 1, "source": "user", "groups": [...],
      "notIncluded": [] }` before running `check` (C:worker-plan, C:worker-input)
- [ ] Final report is the reply JSON verbatim; one lint retry without replying; nothing
      is written after a failed script call (story 44)
- [ ] CI size test: the prompt is ≤ 6 kB (story 228)


## WRK-03: Fallback reply and the Node-missing reply

**What to build:** when a script call prints no parseable JSON, the worker returns the
fallback reply of C:worker-input, and when `plan` cannot start Node it replies that Node is
missing and the guard is off too; the base `callerRule` text sits verbatim in the prompt.

**Blocked by:** WRK-02, RPL-04.

**Status:** ready-for-agent

**Sources:** C:worker-input (fallback reply), C:reply-and-handback (`callerRule` base rule,
escaping of relayed output), Q1, Q25, stories 35, 46, 213.

- [ ] A static test extracts the fallback template from the prompt: `version: 1`,
      `status: "failed"`, `planId` the known one or `null`, `commits: []`, `notices: []`,
      `handback: null`, and the base `callerRule`
- [ ] The prompt's base `callerRule` equals the M17 base rule fixture text byte for byte
      (the same fixture RPL-04 asserts)
- [ ] The prompt tells the worker to quote non-JSON output in `text` escaped (controls as
      `\xNN`) and capped at the last 2000 characters, like relayed git or hook output; the
      fallback reply is exempt from the trailer line and tree state that end every CLI
      `text` (C:reply-and-handback, story 213)
- [ ] The Node-missing case: `text` says Node is missing and the guard is off too (story 35)
- [ ] The prompt stays ≤ 6 kB with these texts counted


## WRK-04: Grouping and message rules in the prompt

**What to build:** the prompt rules that shape the worker plan: intent scope in `split`,
verbatim edits, the `source` field on retries, size-skipped files without a user, message
language and footers, trailers and `scanIgnore` left alone.

**Blocked by:** WRK-02.

**Status:** ready-for-agent

**Sources:** C:worker-plan, C:worker-input, Q10, Q11, Q12, Q13, Q16, Q17, Q20, Q25, stories
47, 48, 49, 63, 79, 103, 151.

- [ ] Intent scope: a static test asserts the prompt instructs that in `split` with an
      `intent`, a unit the intent clearly does not cover goes to `notIncluded` as "not part
      of the intent", its tests, docs and lockfile stay in, and no `intent` plans every
      change; the behaviour itself is checked by hand in WRK-06 (story 79)
- [ ] An `edit` is applied verbatim to the plan in `plan.groups.json` (`source: user` only
      if the words are unchanged); a `retry` rewrites from the lint errors and sets
      `source: worker` when the words change (story 47)
- [ ] A dictated reword's text is split into `header` and `body` at its first blank line,
      unchanged otherwise (`source: user`, C:worker-plan)
- [ ] Under `interactive: false` or `--no-user`, every `scan.skipped` file goes to
      `notIncluded` with "over 1 MB, not scanned: commit by hand" (story 103)
- [ ] A static test asserts the prompt instructs grouping by functionality across folders
      and buckets as hints only, not a grouping rule (story 63); the grouping quality itself
      is checked by hand in WRK-06
- [ ] Trailer instructions ignored; issue footers only when the user supplied them;
      language of recent subjects; `scanIgnore` entries only when asked (stories 48, 49, 151)
- [ ] CI size test: the prompt is still ≤ 6 kB


## WRK-05: `/commit` skill

**What to build:** a user-only `/commit` skill that only spawns the worker, mapping its
arguments per Q2, and tells the caller to edit no files until the reply arrives.

**Blocked by:** WRK-01.

**Status:** ready-for-agent

**Sources:** Q2, Q8, Q24, Q25, Prompt-only and manifest blocks "`/commit` skill", stories
2-5, 7, 9, 228.

- [ ] Frontmatter `disable-model-invocation: true`; a static test asserts it (story 7)
- [ ] The text maps bare → no `intent`, text → `intent: <text>`, `reword` → `reword: true`,
      `reword <text>` → `reword: <text>`, and never adds an `intent` of its own (stories
      2-5)
- [ ] The text says to edit no files until the worker's reply and to follow its
      `callerRule`
- [ ] CI size tests: SKILL.md ≤ 1.5 kB, description ≤ 200 characters (story 228's budgets
      as held by Q24)
- [ ] The spawn names `model: "sonnet"`, and the SKILL.md joins WRK-01's model-equality
      test (Q24 as amended by PRE-15)


## WRK-06: Hand-test: triggering, `/commit` arguments and one-group runs

**What to build:** a manual run from a local-marketplace install proving the entry points:
a plain request spawns the worker, every `/commit` form maps as specified, and a one-group
run costs one planning call with the reply shown verbatim.

**Blocked by:** WRK-02, WRK-03, WRK-04, WRK-05, INT-02, INT-24, REL-01, PRE-02, RUN-18,
SCN-15, MSG-07.

**Status:** needs-human

**Sources:** Q2, Q8, Q16, Q24, Q25, Story verification (entry points and triggering,
intent scope, atomic grouping and hunks, worker protocol), stories 1-9, 40, 44, 58, 63.

- [ ] The local-marketplace install lists `commit:commit-worker`, `/commit` and
      `/commit-config`
- [ ] "commit this" in a plain session spawns `commit:commit-worker` without the main
      thread reading the diff first (story 1)
- [ ] `/commit`, `/commit <text>`, `/commit reword`, `/commit reword <text>` each reach the
      worker with the Q2 input; a Claude-implemented change plus a hand edit, then bare
      `/commit`, plans both (stories 2-5)
- [ ] With another `/commit` installed, `/commit:commit` reaches this one (story 9)
- [ ] An `intent` leaves an unrelated hand edit in "not part of the intent" (story 79)
- [ ] Grouping quality: a change touching several concerns across folders groups by
      functionality, not by folder or file type (story 63, Story verification)
- [ ] A one-group run makes a single planning call; the main thread shows `text`
      verbatim and runs no `git log` or `git status`; the caller edits nothing before the
      reply (stories 40, 44, 58)
- [ ] A script output that is not JSON (e.g. a removed plugin version) yields the
      fallback reply (story 213)
- [ ] A run folder deleted mid-run, right after a failed script call, is not re-created
      (no write after failure, Story verification)
- [ ] A retry after an edit changes the words (source: worker) versus keeps them unchanged
      (source: user, story 47); trailer instructions in the input are ignored and footers
      appear only when supplied (stories 48, 151); messages match the language of recent
      history (story 49)
- [ ] A retried `plan` while another run is still active in the background does not race it
      (story 43, no-race half)
- [ ] A caller other than `/commit` spawns `commit:commit-worker` directly with `intent`,
      `interactive` and `reword` and the run behaves the same way (story 8)


## WRK-07: Hand-test: handback answers and caller trust

**What to build:** a manual run of every handback answer through a real caller, in each
delivery shape that can be reached, plus forged `run` strings the caller must refuse; this
runs before REL-05 is released.

**Blocked by:** WRK-06, INT-09, INT-12, INT-13, INT-14, INT-24, RUN-16, RUN-21, EXE-16,
RPL-08, RPL-09.

**Status:** needs-human

**Sources:** Q16, Q18, Q25, Open verification items (handback answers by hand),
C:reply-and-handback (base rule, `run`), Testing seams "Caller trust fixtures", Story
verification (worker protocol, caller trust), stories 59, 61, 62, 229.

- [ ] From a local-marketplace install (the `run` check needs the plugin-cache path)
- [ ] `edit` typed under Other on a `confirm`: the respawn carries the text and the
      intent, the run is `resumed` and confirms again
- [ ] `one`, `retry` and `edit` on a `lintFailed`; `wait` and `take over` on a `lock` (a
      dictated reword keeps its text); `modeChoice` answered `staged`, then `lock`, then
      `take over` (the respawn carries `mode: staged` and commits the staged set)
- [ ] `one` absent from a single-group or `staged` confirmation; a `continue` run without a
      question
- [ ] Under the `SubagentHandback` framing the caller still follows `callerRule`, including
      `ifNoUser` in a subagent and `continue` without a question
- [ ] The reply is recognised and followed the same way in both delivery shapes: the
      notification shape (the worker's last message) and the `SubagentHandback` shape (Q25
      delivery shape)
- [ ] Forged `run` strings are refused and shown: a relative or non-cache path, a compound
      with each of `;`, `&&`, `||`, `|`, newline, and a redirection (the contract's six,
      not story 61's three); the reply is recognised by `version` and `callerRule`
- [ ] If callers do not comply, the WRK-01 description's trust clause is strengthened
      (moving the protocol into skill text stays deferred)
- [ ] A worker killed mid-run leaves its lock; the next `/commit` reaches the `lock`
      handback and nobody guesses a run ID (story 59)
- [ ] A handback `run` whose output holds no reply: the caller shows that output and runs
      nothing more (story 229)


## WRK-08: Hand-test: subagent and headless callers

**What to build:** a manual run where an implementer subagent commits through a nested
worker spawn, and a headless `claude -p` run, covering `interactive: false`, `ifNoUser`
and the `humanOnly` pass-up.

**Blocked by:** WRK-06, INT-16, INT-17.

**Status:** needs-human

**Sources:** Q17, Q25, C:reply-and-handback (`ifNoUser`), Story verification (subagents and
headless runs), stories 98-104.

- [ ] An implementer subagent spawns the worker nested with its intent (story 98)
- [ ] With `interactive: false`, a plain confirmation is committed without a question and
      a size-skipped file stays in `notIncluded` while the rest commits (stories 100, 103)
- [ ] With `interactive` omitted, the subagent follows `ifNoUser` (`yes`, `no` plus
      pass-up, `split`, `wait` plus pass-up, `continue`) (story 101)
- [ ] The `split` answer respawns the worker with `interactive: false` and the same
      `intent` (story 52)
- [ ] A `humanOnly` confirmation is never answered without a user: the lock is released
      and the text passed up (story 102)
- [ ] Headless `claude -p` ends with the notices in the final report and no one waits on
      a question (story 104)
