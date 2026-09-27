# 11 Reply and CLI

M1 (CLI and envelope), the domain code → CLI kind table, and M17 (reply and handback). M1
and M17 are tested only through Seam 1, so after the M1 tracer and the reply tracer, each
M17 slice is verified on the INT path that first emits the output it shapes; the reply
variant a path introduces is built in that INT slice, and RPL holds the rules that cut
across all replies. Sources: C:cli-and-exit-codes, C:reply-and-handback, Domain code → CLI
kind, M1, M17, Q9, Q16, Q22, Q24, Q25. The walking skeleton INT-01 builds the minimal reply
and the envelope path; RPL-04 adds the `failed` variant and the base `callerRule`.

## RPL-01: Commit entry point and envelope tracer

**What to build:** the commit entry point checks the Node version first (syntax any Node
since 12 parses), resolves the injected environment once, loads the library, and M1
`main(argv, env)` prints exactly one JSON object with `version: 1` and the exit code; a call
with no or an unknown subcommand is a `usage` refusal.

**Blocked by:** FND-01, FND-04.

**Status:** ready-for-agent

**Sources:** M1, architectural decisions "Entry points survive an old Node" and "Injected
environment", C:cli-and-exit-codes, Q1, Q9.

- [ ] Seam 1: no subcommand and an unknown subcommand → exit 1, one JSON object
      `{ version: 1, ok: false, error: { kind: "usage", … } }`, nothing else on stdout
- [ ] Debug output goes to stderr only; the entry point never reads stdin (a test with an
      open stdin pipe returns without waiting)
- [ ] The Node check returns the `env` JSON refusal before any library import (the old-Node
      case is covered by the entry-point env note; see the group notes)


## RPL-02: Per-subcommand argv and flag combinations

**What to build:** M1 peels the subcommand and runs one strict `parseArgs` per subcommand
(`no-user` declared literally, never `allowNegative`), rejecting every illegal combination
and malformed `planId` as `usage` before any git call.

**Blocked by:** RPL-01.

**Status:** ready-for-agent

**Sources:** M1, C:cli-and-exit-codes (synopsis and flag rules), C:run-folder (`planId`
form), Q9, Q17, story 206.

- [ ] Seam 1, one case per rule: `--dictated` without `--reword`; `--no-user` with
      `--staged`, with `--take-over`, or without `--split`/`--reword`; `--no-no-user`;
      unknown flags; a `--plan` value that is not a lowercase UUID v4 (uppercase, traversal,
      absolute path) → exit 1 `usage`
- [ ] No refused call creates `.commit-plan` or runs git (asserted on the temp repo)
- [ ] Every legal synopsis line parses (asserted by reaching the next step's refusal outside a
      repo)


## RPL-03: Error table and exit codes

**What to build:** the single domain code → CLI kind table used by M18, M1's kind → exit
code map 0-6 and the failure shape; the first reachable rows are `usage` (RPL-01) and
`state` outside a repo (GIT-01).

**Blocked by:** RPL-01.

**Status:** ready-for-agent

**Sources:** Domain code → CLI kind, C:cli-and-exit-codes (exit table, failure shape),
architectural decision "Typed results and one error table".

- [ ] Every domain code row maps to its kind and exit code in one table; a test lists each
      row with the Seam 1 case (in this group or INT) that reaches it, and fails on a row with
      none
- [ ] Only M18 maps domain codes; modules below it return typed results with domain codes


## RPL-04: Reply tracer: a `failed` reply for a pre-folder refusal

**What to build:** M17 `reply(facts, { scriptPath, argv })` builds the `failed` variant for
a `plan` refused on an in-progress merge: `version`, `status`, `planId: null`, `text` with
the reason and the tree state, empty `commits` and `notices`, the base `callerRule`
verbatim, `handback: null`. INT-01 built the minimal reply; this slice adds the `failed`
variant and the base `callerRule`.

**Blocked by:** RPL-03, GIT-03, CHG-04, INT-01.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`callerRule` base rule, `text`), Q25, stories 50, 56.

- [ ] Seam 1: `plan` during a merge → exit 6 `state`, output carries `reply` with the fields
      above; the base rule text equals the fixture text from C:reply-and-handback
- [ ] `text` ends with the tree state ("N files left: …" or "working tree clean")
- [ ] The reply without `text` is ≤ 2 kB


## RPL-05: Reply text layout, list caps and size budgets

**What to build:** the shared `text` layout for every status: the variant's lines, lists
capped at 10 plus "+N more", the `Notices:` block, the trailer line (or "no trailer" with its
attribution source) and the tree state; messages never cut; CI size fixtures at every cap.

**Blocked by:** INT-02, INT-09, INT-15, INT-21, MSG-07.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`text`, size), Testing modules (size fixtures), Q24,
stories 55, 56, 57, 228.

- [ ] Seam 1 cap fixtures: a `committed` reply with 11 commits, 11 not-included entries, 11
      `unstaged` paths, 11 files left and 11 notices → each list shows 10 plus "+1 more"
- [ ] A `lintFailed` with three groups with bodies and 11 errors
- [ ] Size tests: reply without `text` ≤ 2 kB; `text` ≤ 4 kB not counting quoted messages
- [ ] Every notice appears in `text` under `Notices:` on every status (story 57); the trailer
      line names the appended trailer or "no trailer" with its source (story 55)


## RPL-06: Escaping paths and relayed git or hook output

**What to build:** every path rendered in `text` has C0, DEL and C1 controls written as
`\xNN`; git and hook output keeps `\n` and `\t`, escapes the rest, and is capped at its last
2000 characters with the "[… N characters cut]" marker, the full output staying in
`gitOutput`.

**Blocked by:** INT-02, INT-21.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`text`), Q18, stories 163, 218.

- [ ] Seam 1 (POSIX for newline and ESC): a file named with a newline, an ESC and a C1
      character → each written as `\xNN`, no forged "working tree clean" line
- [ ] A hook printing ANSI sequences and 5000 characters → ESC escaped, last 2000 kept with
      the marker, full text in `gitOutput`


## RPL-07: Manual lines for hit units and redacted `lintFailed` text

**What to build:** a unit left out on a hit gets the two manual lines (`!git
--literal-pathspecs add -- <path>`, then `!git commit -m "<message>"`), the path bare or in
single quotes, or only "commit by hand" for a path M17 cannot quote; a `lintFailed` text
replaces every scan-hit span of a quoted message with `[<pattern-id>]`.

**Blocked by:** INT-15, INT-08.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback, C:scan-patterns, Q10, stories 140, 141.

- [ ] Seam 1: a bare path → two lines, unquoted; a path with a space → single-quoted; a path
      with `'` or `’` → only "commit by hand"
- [ ] No `&&` joins the two lines
- [ ] A message whose `generic-secret` span contains a `github-token` span → one
      `[generic-secret]`, no part of the value in any output


## RPL-08: Handback commands and caller-trust fixtures

**What to build:** every handback `run` is built by S2 `build` from the script's own
absolute path (forward slashes, double quotes) with `--plan` of the same reply and its
`timeoutMs` (600 000 for `commit`, 60 000 otherwise); only a `confirm`'s `yes` carries
`--confirmed`. It also adds the first S2-dependent refusal: an install path holding `$`, a
backtick, `"`, `\` or U+201C-U+201E is refused `env` before any work.

**Blocked by:** INT-09, INT-11, INT-22, GRD-13.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`run`, base rule), Testing seams "Caller trust
fixtures", Q16, Q25, Testing seams "ScriptCall round trip", stories 51, 53, 54, 61, 62, 204,
208, 229.

- [ ] Seam 1: every `run` of every handback kind passes the base rule's shape predicate (one
      segment, an absolute path under the plugin cache in the fixture layout, a UUID `planId`)
- [ ] `--confirmed` appears only in a `confirm`'s `yes`; `continue` never carries it
- [ ] A fixture worker message with two objects that both hold `version` and `callerRule`:
      the base rule text tells the caller to run nothing (story 62)
- [ ] Every answer has a `run`, a `respawn` or neither (story 54)
- [ ] Seam 1: the scripts copied under a path with each forbidden character → exit 1 `env`
      (`"` and `\` POSIX only; the typographic quote on both); a native Windows path → no
      refusal (story 204)
- [ ] The base rule text tells the caller to show the output of a handback `run` that holds
      no reply and to run nothing more, leaving the lock to the takeover question (story
      229)


## RPL-09: Respawn prompts carry the answer and the mode flag

**What to build:** each `respawn` is a worker-input prompt holding the answer's own fields
plus the `mode` flag of the `plan` call that built it (read from `argv`); `takeOver` only in a
`lock` handback's `take over`; never `intent` or `reword`.

**Blocked by:** INT-05, INT-13, INT-26, RUN-20.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`respawn`), C:worker-input, Q9, Q22, stories 52, 190.

- [ ] Seam 1: a live lock plus `plan --staged` → `take over` respawn holds `mode: staged` and
      `takeOver: <planId>`
- [ ] `plan --take-over <planId>` on a mixed index answered `staged` → respawn holds
      `mode: staged` and no `takeOver`; running that `plan --staged` finds no lock and plans
      `staged`
- [ ] No respawn holds `intent` or `reword`; `edit` respawns mark the user's text as `{text}`
- [ ] The answer's own mode wins over the refused call's mode flag (as RUN-20 item 6 settles)


## RPL-10: Lock replies without a question

**What to build:** under `--no-user` a `lock` refusal is a plain reply with no takeover answer;
a lock whose holder has no valid `planId` carries no handback, `status: "failed"`, and a text
naming the automatic takeover time (`touched` plus 15 minutes).

**Blocked by:** INT-05, INT-17.

**Status:** ready-for-agent

**Sources:** M17 (`--no-user` lock rule), C:cli-and-exit-codes (`lock`), C:reply-and-handback,
Q22, stories 60, 191.

- [ ] Seam 1: a live lock with `plan --split --no-user` → exit 6 `lock`, `handback: null`
- [ ] An unparseable lock and one with a malformed `planId` → `planId` and `created` null,
      message "the /commit lock is unreadable …", text naming the takeover time
