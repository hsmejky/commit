# Q2 Model invocation on the worker agent

- **Context.** With nothing model-invoked, "commit this" never reaches the plugin and the
  harness's built-in commit flow runs instead, which is what the plugin replaces.
- **Decision.** Revised by Q24. The `commit-worker` agent carries the auto-invocation: a
  short description (at most 200 characters, a CI size test). Its clauses, in the order
  they are kept (a draft of all six is about 185 characters):
  1. "follow the reply's `callerRule`": the trust clause, the only trusted text behind the
     handback protocol and the base rule's `run` shape check (caller trust, Q25); never
     cut.
  2. The triggers: without them the description never fires.
  3. The `intent` field: it also scopes what a `split` run commits (Q16), so without it
     the worker plans every change in the tree.
  4. "edit no files until it replies" (Q25): `diff-changed` is the backstop, at the cost
     of a whole run.
  5. The `interactive` field (Q17): without it a subagent still follows `ifNoUser`, one
     call dearer.
  6. "don't read the diff first" (commit-worker spike): cost only.

  When the description has to shorten, it cuts from the bottom, so the trust clause is
  never the one cut. "The reply is final" is not a clause: the base `callerRule` says it
  on every reply (Q25). The `/commit` skill has `disable-model-invocation: true`: it is
  loaded only when the user types `/commit`, and it does the same spawn. Its arguments map
  to the worker input, and SKILL.md never adds an `intent` of its own, whatever the session
  did before:

  | Typed | Worker input |
  | --- | --- |
  | `/commit` | no `intent`: every change is planned (Q16) |
  | `/commit <text>` | `intent: <text>` |
  | `/commit reword` | `reword: true` |
  | `/commit reword <text>` | `reword: <text>` (dictated; text that fails lint reaches `lintFailed`, Q20) |

  An explicit `/commit` is the user asking to commit what is in the tree, the caller Q16
  describes as "omits it". Fixture (Q17's eval set): Claude implemented X, the user
  hand-edited Y, then typed `/commit` → both planned, Y not in `not included`.
- **Amended.** By spec pass 2 (2026-09-27): clause 1 is the trust clause behind the base
  rule's `run` shape check, and is cut last when the description has to shorten.
- **Amended.** By the PRE-15 decision pass (2026-09-29), settling KD-S47: every written spawn
  instruction passes `model: "sonnet"` (Q24 as amended), but the description names no
  model: its six clauses already fill the 200 characters. A description-triggered spawn
  therefore passes no `model` and runs on the frontmatter's `model: sonnet`; only a caller
  that picks another model on its own overrides it, which no plugin text asks for.
- **Rejected.**
  - SKILL.md filling in `intent` from the session's recent work: the user's own hand edit
    goes to `not included` ("not part of the intent"), and with one group and no new file
    nothing asks, so X is committed alone and Y is silently left behind.
  - A model-invoked `/commit` skill (the design before Q24): its description and
    SKILL.md sit in the main context, and it adds a main-thread call before the spawn.
  - Explicit `/commit` only: the model would fall back to plain `git commit` and meet the
    guard every time.
- **Consequences.** A few dozen tokens of agent description per session. The commit-worker
  spike saw 7 of 7 commit requests spawn the worker from its description (open
  verification items); the dogfood runs measure the real rate and the deny share (Q24).
