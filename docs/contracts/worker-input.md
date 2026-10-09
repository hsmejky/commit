# Worker input

The Agent prompt that spawns `commit:commit-worker`: `key: value` lines, one per field, every field
optional, each value on one line; a caller whose argument spans several lines (a pasted
multi-paragraph reword, a multi-line intent) joins it onto one line before writing the field.
`intent`, `interactive` and `reword` and their meaning are public surface (Q25); a
workflow skill spawns the worker with them. `mode`, `takeOver`, `resume` and `edit` are
internal: respawn-only, do not write by hand. They appear only in a handback's `respawn`
and may change in a minor release.

```
intent: Added the stage subcommand and documented it.
interactive: false
```

| Field | Surface | Values | Meaning |
| --- | --- | --- | --- |
| `intent` | public | one to three sentences | what was changed and why; absent when the caller does not know it or the user asked for every change (a bare `/commit`, Q2), the worker then infers it from the diff. `/commit <text>` passes the text as the intent. Also scopes a `split` run (Q16): a unit the intent clearly does not cover goes to `notIncluded` with the reason "not part of the intent"; without `intent` every change is planned. A caller whose user wants every change committed says so here, or omits the field |
| `interactive` | public | `true` (default), `false` | `false`: the caller cannot ask a user (Q17); the worker runs `plan --split --no-user` or `plan --reword --no-user` |
| `reword` | public | `true`, or the dictated text | reword the last commit (Q20); with text, the worker runs `plan --reword --dictated` (no hunk index) and writes the text as `"source": "user"` worker plan. Ignored with `resume` (the mode comes from the state file) |
| `mode` | respawn-only | `staged`, `split` | from a `modeChoice` answer (which replaces the refused call's mode flag, Q9), or repeated from the refused call in a `lock` handback's `respawn` |
| `takeOver` | respawn-only | a `planId` | from a `lock` handback's `take over` only (a `modeChoice` never repeats it: the takeover has already finished at `plan` step 3, [mode](plan.md)); the worker runs `plan --take-over <planId>` with the `mode` flag if one is given |
| `resume` | respawn-only | a `planId` | from a `confirm` or `lintFailed` handback's `respawn`; the worker skips `plan` and starts at `plan --hunks --plan <planId>`, which marks the run `resumed`, so its next `check` always asks (Q16) |
| `edit` | respawn-only | free text, or `one` | with `resume`: the user's instruction; `one` means "single group, all included files" (Q16). Applies to the plan in `plan.groups.json` |

Handback `respawn` values are prompts built by the script. Each holds the answer's own
fields plus the `mode` flag of the `plan` call that built it (a `modeChoice` answer's own
`mode` replaces that flag), and `takeOver` in a `lock`
handback's `take over` only (Q9). The caller
passes them verbatim, inserting the user's text for `edit` where the handback says, and adds
the `intent` and `reword` lines of its first spawn (the script never sees them) and
`model: "sonnet"` (Q24 as amended by the PRE-15 decision pass), plus
`interactive: false` when it cannot ask ([Reply and handback](reply-and-handback.md)). The
agent type is
`commit:commit-worker` (namespaced by the plugin). The worker's prompt names the script as
`${CLAUDE_PLUGIN_ROOT}/scripts/commit.cjs`, substituted by the plugin loader; the variable is
not in the worker's shell (Q25, spike). Its tools are `Bash, PowerShell, Read, Write`: it
runs each script call with whichever shell tool it has, since every call is one
`node "<script>" …` command that runs the same in both (Q24). The prompt tells the worker
to commit only through these script calls and never to run `git commit` itself (the
script stages and commits; the guard denies a direct `git commit`, Q3), and to `Read` nothing
outside the run folder except a working-tree file at a line range, never a file with a hit
(Q11). The worker runs every script call it makes itself (`plan`, `plan --hunks`, `check`)
with a tool timeout of 600 000 ms, above `plan`'s 540-second deadline ([plan](plan.md)); it
never runs `commit --all` or `release` itself — those come only from a handback's `run` in
the caller ([Reply and handback](reply-and-handback.md)).

The worker's steps:

1. Unless `resume`: `plan` with the flags the fields give (`--dictated` for a dictated
   reword); if the output has `reply`, return it. Otherwise its `hunks` is the
   `plan --hunks` output (`null` with `--dictated`).
2. With `resume` only: `plan --hunks --plan <planId>`; on failure return its `reply`.
3. Read `hunks.txt` (with `resume`, only when `edit` changes the grouping; a message-only
   `edit` works from `plan.groups.json` alone) and write `<runDir>/plan.groups.json` with
   `Write`. With `resume`, `Read` `plan.groups.json` before writing it, also on a `retry`
   whose errors are already in the `edit` text: the `Write` tool refuses to overwrite a
   file the agent has not read, and the refusal costs a turn. In `split`, apply the
   intent scope (Q16) when grouping. A dictated reword writes the `"source": "user"` output
   instead. After an
   `edit`, `source` stays `user` only when the worker writes the user's words unchanged.
4. `check --plan <planId>`. On a lint failure without a `reply` (exit 2), fix
   `plan.groups.json` from `errors` and run `check` once more. Return the `reply`.
   A lint failure of `"source": "user"` text always carries a `reply`, so the worker never
   rewrites dictated text on its own (Q20). Never run a handback's commands: the guard
   denies a script call to `commit` or `release` from the worker (Q25).

The worker's final report is the `reply` JSON, verbatim and nothing else: its last message
in the notification delivery shape, the `message` of its `SubagentHandback` call in the
other (Q25). When a script
call fails without output it can parse, or prints an `ok: false` output with no `reply` that
the worker does not handle itself (anything but a first lint failure, step 4: `env` and
`internal` from the entry point are the cases), or a `Write` or `Read` the worker needs fails (the
worker plan or a message file cannot be written, `hunks.txt` or `hunks.json` cannot be
read), it returns the fallback reply (story 46) without a retry
`{ "version": 1, "status": "failed", "planId": <the planId if known, else null>, "text":
"<what happened>", "commits": [], "notices": [], "callerRule": "<the base rule>",
"handback": null }`. Like every reply it carries `version` and `callerRule` (story 50), so
the caller recognises it by the same keys; the base rule text is in the worker's prompt,
verbatim. Its `text` has no trailer line or tree state (the worker makes no git call); when
the call printed output that is not JSON, `text` quotes it with the escaping and the
2000-character cap of relayed git or hook output ([reply](reply-and-handback.md)). The
lock is then left to Q22 (takeover question on the next run). A `Write` after a failed
script call never happens, so a deleted run folder is not re-created.
