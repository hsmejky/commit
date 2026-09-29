# 11 Reply and CLI

M1 (CLI and envelope), the domain code → CLI kind table, and M17 (reply and handback). M1
and M17 are tested only through Seam 1, so after the M1 tracer and the reply tracer, each
M17 slice is verified on the INT path that first emits the output it shapes; the reply
variant a path introduces is built in that INT slice, and RPL holds the rules that cut
across all replies. Sources: C:cli-and-exit-codes, C:reply-and-handback, Domain code → CLI
kind, M1, M17, Q9, Q16, Q22, Q24, Q25. The walking skeleton INT-01 builds the minimal reply,
the envelope path and the base `callerRule`; RPL-04 adds the `failed` variant.

## RPL-01: Commit entry point and envelope tracer

**What to build:** the commit entry point (`plugin/scripts/commit.cjs`, CommonJS; M1 and
the modules below it are `plugin/scripts/lib/*.mjs`) checks the Node version first (syntax any Node
since 12 parses), resolves the injected environment once, loads the library, and M1
`main(argv, env)` prints exactly one JSON object with `version: 1` and the exit code; a call
with no or an unknown subcommand is a `usage` refusal.

**Blocked by:** FND-01, FND-04.

**Status:** ready-for-agent

**Sources:** M1, architectural decisions "Entry points survive an old Node" and "Injected
environment", "Module type fixed by extension", C:cli-and-exit-codes, Q1, Q9.

- [ ] Seam 1: no subcommand and an unknown subcommand → exit 1, one JSON object
      `{ version: 1, ok: false, error: { kind: "usage", … } }`, nothing else on stdout
- [ ] Debug output goes to stderr only; the entry point never reads stdin (a test with an
      open stdin pipe returns without waiting)
- [ ] The Node check returns the `env` JSON refusal before any library import


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
- [ ] Seam 1: two mode flags together on `plan` (`--staged` with `--split`, or `--reword`
      with `--staged`) → exit 1 `usage`; `check`, `commit` and `release` without `--plan` →
      exit 1 `usage`; `commit --plan <id>` without `--all` → exit 1 `usage`; `--confirmed` on
      `plan` or `check` → exit 1 `usage`
- [ ] No refused call creates `.commit-plan` or runs git (asserted on the temp repo)
- [ ] Every legal synopsis line parses, asserted by not being refused `usage`
- [ ] No CLI flag or environment variable exists that turns the scan off (story 146; checked
      by a review of the argv/usage table and the entry point's env reads).


## RPL-03: Error table and exit codes

**What to build:** the single domain code → CLI kind table used by M18, M1's kind → exit
code map 0-6 and the failure shape; the first reachable row is `usage` (RPL-01); rows added
later by GIT-01 and the rest of the roadmap (`state` outside a repo among them) are not
reachable yet. INT-31 owns the completeness test over every row once the roadmap has built
them.

**Blocked by:** RPL-01.

**Status:** ready-for-agent

**Sources:** Domain code → CLI kind, C:cli-and-exit-codes (exit table, failure shape),
architectural decision "Typed results and one error table".

- [ ] Every domain code row maps to its kind and exit code in one table; a test lists, for
      each row already reachable through this slice's blockers (RPL-01's `usage` refusals),
      the Seam 1 case that reaches it; rows not yet built are left to INT-31
- [ ] Only M18 maps domain codes; modules below it return typed results with domain codes


## RPL-04: Reply tracer: a `failed` reply for a pre-folder refusal

**What to build:** M17 `reply(facts, { scriptPath, argv })` builds the `failed` variant for
a `plan` refused on an in-progress merge: `version`, `status`, `planId: null`, `text` with
the reason and the tree state, empty `commits` and `notices`, the base `callerRule`
verbatim, `handback: null`. INT-01 built the minimal reply and the base `callerRule`; this
slice adds the `failed` variant.

**Blocked by:** RPL-03, GIT-03, CHG-04, INT-01.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`callerRule` base rule, `text`), Q25, stories 50, 56.

- [ ] Seam 1: `plan` during a merge → exit 6 `state`, output carries `reply` with the fields
      above; the base rule text equals the fixture text from C:reply-and-handback
- [ ] `text` ends with the tree state ("N files left: …" or "working tree clean")
- [ ] The reply without `text` is ≤ 2 kB
- [ ] Every pre-folder refusal, not only the merge case, carries a `failed` reply with the
      base `callerRule` and no handback


## RPL-05: Reply text layout, list caps and size budgets

**What to build:** the shared `text` layout for every status: the variant's lines, lists
capped at 10 plus "+N more", the `Notices:` block, the trailer line (or "no trailer" with its
attribution source) and the tree state; messages never cut; CI size fixtures at every cap.

**Blocked by:** EXE-11, INT-02, INT-05, INT-09, INT-15, MSG-07, RUN-16.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`text`, size), Testing modules (size fixtures), Q24,
stories 55, 56, 57, 60, 228.

- [ ] Seam 1 cap fixtures: a `committed` reply with 11 commits, 11 not-included entries, 11
      `unstaged` paths, 11 files left and 11 notices → each list shows 10 plus "+1 more"
- [ ] A `lintFailed` with three groups with bodies and 11 errors
- [ ] Size tests: reply without `text` ≤ 2 kB; `text` ≤ 4 kB not counting quoted messages
- [ ] Every notice appears in `text` under `Notices:` on every status (story 57); the trailer
      line names the appended trailer or "no trailer" with its source (story 55)
- [ ] A `not-a-repo` refusal's reply carries no tree state at all (it has no tree to read); a
      `release` reply past its 45 s budget omits the tree state too, distinct from "working
      tree clean"
- [ ] Seam 1: a live lock met by `plan --no-user` → `status: "failed"`, `text` with no
      takeover question and no handback (RUN-07 covers the refusal's other fields)
- [ ] An unparseable lock, or one with a malformed `planId`, met by `--no-user` →
      `status: "failed"`, `text` naming the automatic takeover time (`touched` plus 15
      minutes) (RUN-07 covers `planId` and `created`)


## RPL-06: Escaping paths and relayed git or hook output

**What to build:** every path rendered in `text` has C0, DEL and C1 controls written as
`\xNN`; git and hook output keeps `\n` and `\t`, escapes the rest, and is capped at its last
2000 characters with the "[… N characters cut]" marker, the full output staying in
`gitOutput`.

**Blocked by:** EXE-12, INT-02.

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

**Blocked by:** INT-15, RUN-16.

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

**Blocked by:** EXE-16, GRD-13, INT-09, RUN-01, RUN-16.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`run`, base rule), Testing seams "Caller trust
fixtures", Q16, Q25, Testing seams "ScriptCall round trip", stories 51, 53, 54, 61, 62, 204,
208, 229.

- [ ] Seam 1: every `run` this slice's blockers reach (`confirm`'s `yes` and `no`, `continue`,
      `lintFailed`'s `no`) passes the base rule's shape predicate (one segment, an absolute
      path under the plugin cache in the fixture layout, a UUID `planId`)
- [ ] A `lintFailed` handback offers `retry` (`respawn` `resume`, `edit: fix these lint
      errors: <errors>`, at most 500 characters), `edit` (`needsText`, `respawn` `resume`) and
      `no` (`run release`) only, none when every error is a shape error; `ifNoUser` is
      `answer: "no"`, `returnToParent: true`; the question text is exactly "Lint failed. Let a
      new worker fix it, or stop? To dictate the message, type it under Other." (RUN-16 builds
      the lint-failure counter this handback answers, including its `--no-user` release)
- [ ] `--confirmed` appears only in a `confirm`'s `yes`; `continue` never carries it
- [ ] A fixture worker message with two objects that both hold `version` and `callerRule`:
      the base rule text tells the caller to run nothing (story 62)
- [ ] Every answer has a `run`, a `respawn` or neither (story 54)
- [ ] Seam 1: the scripts copied under a path with each forbidden character → exit 1 `env`
      (`"` and `\` POSIX only; the typographic quote on both); a native Windows path → no
      refusal (story 204)
- [ ] The handback rule text tells the caller to show a `run`'s output that holds no reply
      and to run nothing more (story 229)


## RPL-09: Respawn prompts carry the answer and the mode flag

**What to build:** each `respawn` is a worker-input prompt holding the answer's own fields
plus the `mode` flag of the `plan` call that built it (read from `argv`); `takeOver` only in a
`lock` handback's `take over`; never `intent` or `reword`.

**Blocked by:** INT-05, INT-13, RUN-20, RUN-22.

**Status:** ready-for-agent

**Sources:** M17, C:reply-and-handback (`respawn`), C:worker-input, Q9, Q22, stories 52, 190.

- [ ] Seam 1: a live lock plus `plan --staged` → `take over` respawn holds `mode: staged` and
      `takeOver: <planId>`
- [ ] `plan --take-over <planId>` on a mixed index answered `staged` → respawn holds
      `mode: staged` and no `takeOver`; running that `plan --staged` finds no lock and plans
      `staged`
- [ ] No respawn holds `intent` or `reword`; `edit` respawns mark the user's text as `{text}`
- [ ] The answer's own mode wins over the refused call's mode flag (as RUN-20 item 6 settles)
