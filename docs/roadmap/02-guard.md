# 02 Guard

The `PreToolUse` guard: the thin guard entry point over G1 hook I/O, G2 shell tokenizer,
G3 classifier and deny catalogue, S2 script-call recognition and building, S1 heartbeat,
and the hook registration. It denies an agent's direct `git commit` with a route to the
worker, never allows, fails open on a crash or unreadable input while failing closed on
commands it does not parse (the blanket rule), and writes the heartbeat for `plan` calls. Tested at Seam
2 (the real hook process) and Seam 3 (`runHook`, G2 `segments`, S2 `build`). Sources: Q3,
Q4, Q13, Q23, Q25, C:guard, stories 10-39, Modules S1-S2 and G1-G3.

## GRD-01: Guard tracer: early exit end to end

**What to build:** the thin guard entry point (`plugin/scripts/guard.cjs`, CommonJS) and G1
`runHook` (in the ES module library, `plugin/scripts/lib/*.mjs`): stdin read to its end, and a
command that does not contain `commit` (after removing quotes, `\`, backticks and
typographic quotes, case-insensitive) ends with no output and exit 0.

**Blocked by:** FND-04.

**Status:** done

**Sources:** Q3, Q13, Q1, C:guard (Output, Parsing step 1), stories 17, 22, Architectural decisions "Code split", "Entry points survive an old Node", "Module type fixed by extension".

- [x] Seam 2: `ls -la` as Bash and as PowerShell → empty stdout, exit 0, no heartbeat file.
- [x] Seam 2: a large stdin payload delivered in several chunks is read whole (no synchronous read of descriptor 0).
- [x] Seam 3: `runHook` with injected `claudeHome` and `now` gives the same result as Seam 2 for the same input.
- [x] A static check asserts the guard entry point's import graph reaches only G1-G3, S1 and S2, and that the entry point checks the Node version before its dynamic import of the library.
- [x] A static check scans the guard entry point's own source text (the part that runs before the dynamic `import()`) for syntax newer than Node 12 parses (optional chaining `?.`, nullish coalescing `??`, top-level `await`, an `import()` outside that guarded line) and fails if any appears.
- [x] A static check greps the guard's reachable source (G1-G3, S1, S2, entry point) for the string `allow` used as a `permissionDecision` value, and fails if any code path can emit it; only `deny` and no-output are possible outputs.
- [x] A static check greps the same reachable source for `node:child_process` / `child_process` and fails if it appears — no guard module may spawn a process (Architectural decisions, Code split).


## GRD-02: Fail open on unreadable input or a crash

**What to build:** unreadable, malformed or incomplete hook input, and any throw inside the
guard, end silently; under `COMMIT_GUARD_DEBUG=1` one stderr line records it.

**Blocked by:** GRD-01.

**Status:** done

**Sources:** Q3, Q1, C:guard (Output), stories 18, 20.

- [x] Seam 2: non-JSON stdin, empty stdin, JSON without `tool_input.command`, an unknown `tool_name` → no stdout, exit 0, no heartbeat.
- [x] Seam 2 with `COMMIT_GUARD_DEBUG=1`: exactly one stderr line holding the fields known so far (`agent_id` when present); without the variable, no stderr.


## GRD-03: Bash tokenizer and the first deny

**What to build:** G2 for Bash (`\` escapes, literal single quotes, `\"` `\\` `\$` in double
quotes, `$'…'` with its backslash escapes decoded and a decoded NUL ending its value, quote
removal, segments on `&&`, `||`, `;`, `|`, `&`, newlines), preceded by the step 2 script-call exemption and blanket
rule for both shells (a command that is not one plain script call and holds a substitution, heredoc, here-string, comment or
Bash typographic quote is denied untokenized), and the thinnest G3, so `git commit -m x` in
Bash is denied with the routing text.

**Blocked by:** GRD-01, PRE-01, PRE-03.

**Status:** done

**Sources:** Q3, Q8, Q24, C:guard (Parsing step 2 script-call exemption and blanket rule, and Bash column, Deny messages), stories 10, 11, 12, 13, 15.

- [x] Seam 2: `git commit -m x` → the deny JSON of C:guard with `Direct git commit is blocked. <route>` and the fixed personal-skill line; exit 0.
- [x] Seam 3: `cd x && git commit -m x`, `a; git commit -m x`, `a | git commit -m x`, `a & git commit -m x` and a newline-separated form are denied; `git co''mmit -m x` is denied (not an early exit); `git commit -m "a\"b"` is one message argument.
- [x] Seam 3: G2 `segments` golden fixtures for Bash (seeded from PRE-03); in CI each is cross-checked against bash's own words (`printf '%s\0'`), with the deliberate classes oracle-skipped.
- [x] No deny text anywhere in the catalogue names `/commit`.
- [x] Seam 3: `echo git commit` (text that only mentions `git commit`) is denied — the documented false positive (Out of Scope); so is the comment form `# git commit -m x` (the blanket rule, Q3 as amended by PRE-03 round 8).
- [x] Seam 3: the blanket rule: each blanket seed case (oracle `blanket`) is denied with the blanket message when it mentions `commit` and has no output otherwise (`echo "$(date)" && git status`); it yields no segments, no script call and no heartbeat.
- [x] Seam 3: `echo $'\'' ; git commit -m x` is denied (the `$'…'` span ends at its unescaped `'`), and `git $'commit' -m x` segments as `git`, `commit`, `-m`, `x`.
- [x] Seam 3: `git $'commit\0x' -m x`, `git $'commit\x00' -m x` and `git $'commit\u0000' -m x` are denied: a decoded NUL ends the `$'…'` span's value, as in Bash, so the word is `commit`.


## GRD-04: Q4 allowlist and the generic deny

**What to build:** G3 expands `commit`'s arguments (short clusters, attached values,
`--opt=value`) and applies the Q4 allowlist; every other flag or argument is denied naming
it.

**Blocked by:** GRD-03.

**Status:** done

**Sources:** Q4, Q21, C:guard (Parsing step 5, Deny messages), stories 23, 24, 25, 26, 29, 33.

- [x] No output for `git commit --no-edit`, `--amend --no-edit`, `--no-edit -q`, `--no-edit --quiet`, `--fixup=<sha>`, `--fixup=<sha> -q`, and reordered flag forms of these.
- [x] `Direct git commit is blocked. <route>` (the bare/`-m` row, already asserted for plain `-m` in GRD-03): bare `git commit`, `-F`, `--message`, `--file`, `-mfoo` (expanded to `-m foo`, no other flag present).
- [x] Denied, naming the flag, the generic row `git commit <flag> is not allowed here. <route>`: `-t`, `-a`, `--allow-empty`, `--allow-empty-message`, a pathspec, `--`.
- [x] Precedence per C:guard (D2): `-am x` (expanded to `-a -m`) → the generic row naming `-a`, not the bare/`-m` text, since the generic "any other flag or argument" row outranks the bare/`-m`/`-F`/`--message`/`--file` row, which applies only when nothing else matches.
- [x] Seam 3: `git commit --no-edit # done` is denied by the blanket rule (a `#`, Q3 as amended by PRE-03 round 8), while `git commit --no-edit` alone has no output.
- [x] A deny case run with `COMMIT_GUARD=off` and similar variables set is still denied (no env switch).


## GRD-05: Deny catalogue: the specific rows

**What to build:** the remaining rows of the C:guard message table, each with its fixed
text.

**Blocked by:** GRD-04.

**Status:** ready-for-agent

**Sources:** Q4, Q18, Q20, C:guard (Deny messages), stories 27, 28, 30, 32.

- [ ] `--amend` without `--no-edit` → the reword route text, which never suggests `--amend --no-edit`.
- [ ] `--squash` in any form, including `--squash=HEAD --no-edit` → the squash text.
- [ ] `-n`, `--no-verify`, `--no-gpg-sign` → `<flag> is not allowed. Fix the hook or signing setup instead.`
- [ ] `--fixup=amend:<sha>`, `--fixup=reword:<sha>` → the fixup-kind text; `-C`, `--reuse-message`, `-c <commit>`, `--reedit-message` → the generic row.
- [ ] Every message containing `<route>` ends with the personal-skill line; the others do not.
- [ ] Precedence per C:guard (D2), the full row order (`-c`/`--config-env` before `commit`; literal-subcommand; literal-arguments; unknown global option; `--amend`; `--squash`; `-n`/`--no-verify`/`--no-gpg-sign`; `--fixup=amend:`/`--fixup=reword:`; the generic row; the bare/`-m`/`-F`/`--message`/`--file` row last, ties broken by argv order): `--amend -m x` → the amend text, not the bare/`-m` text.
- [ ] `-n -m x` → the `-n` text, not the bare/`-m` text.
- [ ] `--squash -m x` → the squash text, not the bare/`-m` text.


## GRD-06: PowerShell tokenizer

**What to build:** G2 for PowerShell (backtick escapes, among them the NUL escape `` `0 ``
/ a zero `` `u{…} ``, `''` and `""`, the `&` call operator emitted as a word token `'&'`
rather than an operator — the classifier already accepts either shape — and a script block
passed as data, such as `Start-Process -ArgumentList { … }`, left as plain words, not `{`/`}`
tokens, since it is stringified inside the Start-Process interpreter gap, not a command;
here-strings are blanket-denied), so the same denies hold for PowerShell commands.

**Blocked by:** GRD-03, GRD-04.

**Status:** ready-for-agent

**Sources:** Q3, Q3 (PRE-03 amendment), Q15, C:guard (Parsing step 2 PowerShell column),
stories 13, 14.

- [ ] Seam 3: ``git commit -m "a`"b"``, `& git commit -m x`, a compound PowerShell command → denied; a here-string holding `git commit` piped into another command → denied by the blanket rule (documented false positive).
- [ ] Seam 3: PowerShell `git commit --no-edit # done` and `<# git commit -m x #> git status` → the blanket message (documented false positive), no other row.
- [ ] Seam 3: `` git commit`0x -m x ``, `` git "commit`0" `` `` git commit`0 --no-edit `` and `` git commit`u{00} --no-edit `` → denied: a PowerShell NUL ends the token's value and git's arguments (a `cut` token), as the native command line is cut there.
- [ ] Seam 3: `` Write-Output x`0 (git commit -m x) `` `` if ("x`0") {git commit -m x} `` and `` git commit --no-edit`0 (git commit -m x) `` → denied: the tokens after a NUL stay in the segment, as a nested command still runs.
- [ ] Seam 3: PowerShell spellings of a possible wrapper (C:guard step 3) → the wrapper row: `'-n' | xargs git commit --no-edit`, `` xar`gs git commit --no-edit `` and `& 'xargs' git commit --no-edit` naming `xargs` (review-GRD-04 round 2, finding 3), `& ('xargs') git commit --no-edit` naming `(`, and `. git commit --no-edit` naming `.` (documented false positive); `if ($ok) { git commit --no-edit }`, `if (Test-Path a) { git commit --no-edit }` and `& git commit --no-edit` → no output (the bracket reset and the `&` call operator, emitted as the word token `'&'`, of the prefix allowlist, review-GRD-04 round 4).
- [ ] `Start-Process -ArgumentList { git commit --amend --no-edit }` → no output (the script block is stringified data inside the Start-Process interpreter gap, not a `{`/`}` reset; review-GRD-04 round 5, nit 2).
- [ ] Seam 2: one PowerShell deny case end to end.
- [ ] G2 golden fixtures for PowerShell are cross-checked in CI against the PowerShell parser API under both `powershell.exe` and `pwsh`, deliberate classes oracle-skipped.


## GRD-07: Escaped newlines and unterminated quotes

**What to build:** escaped newlines are joined before splitting (and removed from step 1's
mention text regardless of quotes), and an unterminated quote turns the rest of its line
into one quoted token while scanning continues; step 1's mention text also has every `$`
directly before a quote character removed before the quote characters go.

**Note (GRD-03):** the Bash tokenizer halves of this slice — escaped-newline joining and the
unterminated-quote rule — and AC3 below (step 1's mention text dropping an escaped newline)
already landed in GRD-03's G2 and G1 (review-GRD-03 finding 8). What remains here is the
PowerShell (backtick) form; the Bash ACs are test-only confirmation of existing behavior.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing steps 1-2), stories 13, 16, 22.

- [ ] `git \`⏎`commit -m x` (Bash) and its backtick form (PowerShell) → denied.
- [ ] `git commit -m "unterminated` in both shells → denied.
- [ ] `git com\`⏎`mit -m x` → denied (step 1's mention text drops the escaped newline).
- [ ] Its PowerShell form: `` git com`⏎`mit -m x `` (backtick-newline split) → denied.
- [ ] `git co$'m'mit -m x` (Bash) → denied (step 1 drops the `$` before a quote, so the mention text holds `commit`).


## GRD-08: Redirections, parentheses and typographic quotes

**What to build:** redirections are dropped with their target, `(` and `)` are tokens
as are Bash `<(` / `>(` (read as `(`) and PowerShell `{` / `}` (a `)` or `}` ends git's
arguments, and every `git` token of a segment is classified), `<<<` is a plain
redirection, typographic quotes are removed for the early-exit check, read as quotes in
PowerShell (U+201C-U+201E double, U+2018-U+201B single) and blanket-denied in Bash, and
Bash extglob openers (an unquoted `(` directly after an unquoted `@`, `!`, `+`, `*` or `?`),
in a command's first word, keep the `(` in their word and are also a `(` token of their own;
elsewhere (an argument or a redirection target) the same opener reads the pattern through
its matching `)` as one word, no `(` token, no segment split inside it (review GRD-04 round
5).

**Note (GRD-03):** the Bash tokenizer halves of this slice — redirections, parentheses,
process substitution (`<(`/`>(` read as `(`) and extglob — already landed in GRD-03's G2
(review-GRD-03 finding 8). What remains here is the PowerShell forms (`{`/`}`, typographic
quotes read as PowerShell quotes); the Bash ACs are test-only confirmation of existing
behavior.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q3 (pass 5, pass 8, PRE-03 amendment), C:guard (Parsing step 2, blanket rule, heredoc row, typographic quotes row), stories 13, 15, 22.

- [ ] `git commit -m x 2>&1` and `git commit -m x > log.txt` → denied, one segment, the target not read as an argument; the `&` in `2>&1` does not split.
- [ ] `(git commit -m x)` in both shells → denied; `(git commit --no-edit)` → no output; PowerShell `git status (git commit -m x)` → denied (the inner `git` token is classified too).
- [ ] Bash `diff <(git commit -m x) f` → denied; PowerShell `&{git commit -m x}`, `. {git commit -m x}` and `if ($true) {git commit -m x}` → denied; `&{git commit --no-edit}` → no output.
- [ ] `cat <<'EOF' > f`, body line `git commit -m x`, `EOF` → denied by the blanket rule (documented false positive); `<<<` treated as a plain redirection.
- [ ] `git “commit” -m x` (Bash) and PowerShell `git co‘’mmit -m x` → denied.
- [ ] Bash typographic-quote fixtures are blanket cases (oracle `blanket`); PowerShell ones are cross-checked.
- [ ] Bash extglob: `!(git commit -m x)` → denied (command position); `!(git commit --no-edit)` → no output. `git @(commit) -m x` tokenizes as `git`, `@(commit)`, `-m`, `x` (argument position, one word, no `(` token), its body read as a segment `commit` of its own (review round 8), and is denied once GRD-12's literal-subcommand rule lands.


## GRD-10: Detecting `git` in every spelling

**What to build:** G3 finds `git` or `git.exe` at any path, case-insensitive, after `&`,
including a quoted Windows path in Bash, and treats the dashed `git-commit` binary as
`git commit`.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing step 3), stories 14, 15.

- [ ] Denied: `/usr/bin/git commit -m x`, `GIT.EXE commit -m x`, `& "C:\…\git.exe" commit -m x`, Bash `"C:\Program Files\Git\cmd\git.exe" commit -m x`, `git-commit -m x`, `/usr/lib/git-core/git-COMMIT.exe -m x`.
- [ ] `git-commit --no-edit` → no output (its args go through the allowlist).


## GRD-11: Git global options before the subcommand

**What to build:** known global options are skipped, `-c` and `--config-env` before
`commit` are denied for any key, and an unknown option before a `commit` token is denied.

**Blocked by:** GRD-10.

**Status:** ready-for-agent

**Sources:** Q3, Q4, C:guard (Parsing step 4, Deny messages), stories 14, 15, 31.

- [ ] `git -C $dir commit -m x`, `git --no-pager -P commit -m x`, `git --git-dir=x commit -m x` → `Direct git commit is blocked. <route>` (the bare/`-m` row: a skipped global option is not itself a matched row, per C:guard's precedence, D2); `git -C x status commit` (a pathspec named `commit`) → no output.
- [ ] `git -c k=v commit --no-edit` and `git --config-env=k=E commit --no-edit` → the `-c` row; `git -c k=v log --grep commit` → no output.
- [ ] `git --unknown commit` → the "Could not parse git options" row.


## GRD-12: Fail closed on an unreadable subcommand or argument

**What to build:** a subcommand token holding `$`, a backtick, `{`, `(` or a glob
character, or starting with `@` in PowerShell, is denied; `commit` matches case-insensitively;
every other token among git's arguments that is not literal (a `(` or PowerShell `{` token;
a token holding `$`, a backtick, `{`, `(` or a glob character; in PowerShell a token holding
`,` or `@`, or `--%`) is denied.

**Blocked by:** GRD-11.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing step 4, Deny messages), story 15.

Note: the literal check on `commit`'s own arguments and their values (C:guard step 4, the
literal-arguments row) already landed with GRD-04, since opening the allowlist without it
would let `git commit --fixup $s` through; its Seam 3 cases are in
`tests/guard-allowlist.test.js`. This slice adds the subcommand position and git's global
options (with GRD-11), and the PowerShell forms (with GRD-06).

- [ ] Denied with `Write the git subcommand literally. <route>`: Bash `git @(commit) -m x` and `git !(x) commit -m x` (an extglob pattern in an argument is one word, GRD-04), `git $c -m x`, PowerShell `git @a`, `git {commit,-m,x}`, PowerShell `git (…)`, Bash `git ( -m x`, and `git c*t -m x`, `git c?t -m x`, `git [c]ommit -m x`, Bash `c=commit; git "$c" -m x`, each in a command mentioning `commit`.
- [ ] Denied with `Write git's arguments literally. <route>`: PowerShell `git -C (Get-Location) commit -m x`, `git commit -m ("-q") --no-verify`, `git commit --fixup ("HEAD","--no-verify")` and `git commit --fixup {HEAD --no-verify}`; Bash `git -C {.,commit} status` and `git commit --fixup {HEAD,--no-verify}`.
- [ ] Denied with `Write git's arguments literally. <route>`: Bash `git commit --fixup $s` and `git -C "$dir" commit --no-edit` (documented false positive); PowerShell `git -C . ,commit -m x`, `git -C . , commit -m x`, `git -C .,commit status`, `git --% -c x.y=; commit -m x`, `git '--%' commit -m x` and `git commit --fixup @s`; `git commit, -m x` with the literal-subcommand text.
- [ ] `git COMMIT -m x` → denied as a commit.
- [ ] The documented gap: `git $(echo com)mit` → no output.
- [ ] The documented gap's PowerShell form: `git ('com'+'mit')` → no output.
- [ ] Bash `` git `echo commit` -m x ``, `$(echo git) commit -m x` and PowerShell `git commit --fixup $('HEAD','--no-verify')` / `@("HEAD","--no-verify")` → denied by the blanket rule.
- [ ] The documented command-position gap: `{git,commit,-m,x}` and `/usr/bin/gi? commit -m x` (Bash) and `& ('git') commit -m x` (PowerShell) → no output.


## GRD-13: S2 script calls: recognise and build

**What to build:** S2 `recognise` finds a script call in a segment (`node`/`node.exe`,
optionally after `&`, a token whose basename is the commit entry point's, a subcommand from
the fixed list) and S2 `build` emits the one quoted form the allow rules match.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q16, Q23, Q25, C:guard (Script call), stories 37, 38.

- [ ] Seam 3 fixtures of C:guard's script-call list: quoted and unquoted, Bash and PowerShell, `& node …`, `node.exe` at an absolute path, `cd sub && node …`, a quoted backslash path in Bash → recognised with subcommand and args; `echo "node commit.cjs plan"` → not a call.
- [ ] S2 `build` (declared at Seam 3) emits an absolute forward-slash path in double quotes for POSIX and Windows paths (with spaces and drive letters), and its output is recognised back with the same subcommand and args in both shells.
- [ ] A caller's `plan`, `check`, `commit` and `release` script calls produce no guard output outside the worker (story 38).
- [ ] Seam 3: an `infer` script call is recognised as a script call, like the other four subcommands.
- [ ] Seam 3: `node commit.cjs foo` (an unrecognised subcommand) is not recognised as a script call.
- [ ] Seam 3: `build`'s output is in C:guard's step 2 script-call exemption form; the exemption seed's four `decision: none` cases (`b-exempt-hash`, `b-exempt-typographic`, `p-exempt-hash`, `p-exempt-atparen`: a path holding `#`, `@(` or `‘`) are recognised script calls with no output, and the rest (`b-exempt-appended`, `b-exempt-newline`, `b-exempt-comment`, `b-exempt-bang`, `p-exempt-appended`, `p-exempt-dollar`) are blanket-denied.


## GRD-14: Worker-only rule

**What to build:** as `commit:commit-worker`, a script call to `commit` or `release` is
denied with the handback text; everything else the worker runs follows the normal rules.

**Blocked by:** GRD-13.

**Status:** ready-for-agent

**Sources:** Q25, C:guard (Worker-only rule), story 39.

- [ ] Seam 2 with `agent_type: commit:commit-worker`: a `commit` and a `release` script call → `The handback is for your caller: return the reply verbatim and stop.`; `plan` and `check` → no output.
- [ ] The same `commit` call with another or no `agent_type` → no output.
- [ ] Seam 2 with `agent_type: commit:commit-worker`: `git commit -m x` (not a script call) gets the ordinary `Direct git commit is blocked` deny, not the handback text.


## GRD-15: S1 heartbeat write

**What to build:** when any segment is a script call to `plan`, the guard writes the
heartbeat `{ ts, cwd, command }` under the Claude home before deciding, atomically and
redacted.

**Blocked by:** GRD-13, PRE-05.

**Status:** ready-for-agent

**Sources:** Q23, Q5, C:guard (Heartbeat), stories 21, 36, 37.

- [ ] Seam 2: a `plan` script call in each shell and quoting form writes the file under the temp Claude home (`CLAUDE_CONFIG_DIR` honoured), with `ts` from `now`, the raw `cwd`, and `command` as `commit.cjs plan <flags>` without the path or other segments, cut to 200 characters.
- [ ] A denied compound command that also calls `plan` and holds no blanket-rule construct still writes the heartbeat; a blanket-denied one (`node "…/commit.cjs" plan # x`), `check`, `commit` or a crash write none.
- [ ] The write goes through a temporary name with pid and random part, renamed into place; no temporary file remains.
- [ ] Seam 2: with the case's OS home set (`HOME`/`USERPROFILE`) and `CLAUDE_CONFIG_DIR` unset, the heartbeat lands under `<OS home>/.claude/commit-guard/heartbeat.json` (the shared fallback C:guard gives the guard and `plan`).
- [ ] Seam 2 with `COMMIT_GUARD_DEBUG=1`: a `plan` script call whose Claude home path is an existing file, not a directory, throws on the write, caught by GRD-02's fail-open (no stdout, exit 0, one debug stderr line); without the variable, no stderr.


## GRD-16: Debug log for decisions

**What to build:** under `COMMIT_GUARD_DEBUG=1`, each decision writes one stderr line with
`agent_id`, the decision, the deny reason and the redacted command (for a blanket deny, the
trigger kind instead).

**Blocked by:** GRD-15, GRD-02.

**Status:** ready-for-agent

**Sources:** Q1, Q23, C:guard (Output), G1, stories 20, 21.

- [ ] Seam 3 `runHook`: a deny logs the matched `git commit` segment's options only (never message text or other segments), cut to 200 characters; a `plan` call logs the script-call form; the line carries `agent_id`.
- [ ] Without the variable, stderr is empty; stdout is identical with and without it.


## GRD-17: Guard status seen by `plan`

**What to build:** S1 `guardState` and `samePathTree`: `plan` reports `env.guard: active`
for a fresh, matching heartbeat and `not-seen` with the guard notice otherwise.

**Blocked by:** GRD-15, RUN-06, PRE-15.

**Status:** ready-for-agent

**Sources:** Q23, C:guard (Heartbeat), S1, stories 34, 36.

- [ ] Seam 1: a heartbeat under 15 minutes old whose `cwd` is inside the toplevel, or contains it → `active`; older, absent, or another repo → `not-seen` with the guard notice, verbatim from the C:cli-and-exit-codes recorded-texts table ("Guard hook did not run: `node` missing from the hook's PATH, …"), and the run goes on.
- [ ] Path matching is realpathed with `\` → `/`, case-folded on Windows and macOS (a case-differing `cwd` matches there).
- [ ] Seam 1: with the case's OS home set (`HOME`/`USERPROFILE`) and `CLAUDE_CONFIG_DIR` unset, `guardState` reads the heartbeat from the same `<OS home>/.claude` fallback the guard used (GRD-15), confirming guard and `plan` resolve the Claude home the same way (C:guard).


## GRD-18: Hook registration

**What to build:** the packaged hook file registers the guard as one `PreToolUse` hook on
`Bash|PowerShell` in exec form, with an `if` condition only if PRE-04 confirmed it.

**Blocked by:** FND-02, GRD-01, PRE-04, PRE-06.

**Status:** ready-for-agent

**Sources:** Q3, Q13, Q23, Prompt-only and manifest blocks "Hook registration", Modules and how "Other checks".

- [ ] A static registration check asserts exactly one `PreToolUse` hook, matcher `Bash|PowerShell`, command `node`, the guard entry point via the plugin-root variable as the only argument.
- [ ] The `if` condition is present with Q13's four entries if and only if PRE-04 recorded that it covers compound commands.


## GRD-19: Cold-start target

**What to build:** a CI performance check holding the guard's cold start to the target set
in PRE-07, so story 22 is claimed.

**Blocked by:** PRE-07.

**Status:** ready-for-agent

**Sources:** Q13, story 22.

- [ ] On each OS leg, the median of repeated Seam 2 invocations of an early-exit command stays within the recorded target, with a tolerance stated next to it.


## GRD-20: Prior-art bypass corpus

**What to build:** the bypass cases borrowed from prior art and the closed bypasses of
story 15, credited in fixture headers, each giving the C:guard verdict or matching an
accepted gap in Out of Scope.

**Blocked by:** GRD-12.

**Status:** ready-for-agent

**Sources:** Q3, Prior art, Out of Scope (guard gaps), story 15.

- [ ] Every case (wrappers such as `bash -c`, reordered flags, env prefixes, `xargs git commit`) is a Seam 3 fixture with its expected output; each no-output case names its accepted gap.
- [ ] Fixture headers credit the source project and licence; no code is copied.
- [ ] A static check reads each prior-art fixture header's declared licence and fails unless it is MIT, ISC, BSD, Apache-2.0 (NOTICE kept) or CC-BY-4.0 (Dependency policy).


## GRD-21: Guard hand-test

**What to build:** a manual check of what no seam can reach: the installed guard in a real
session, the human-only channel, and the silent exits.

**Blocked by:** GRD-18, PRE-02, WRK-01, REL-01.

**Status:** needs-human

**Sources:** Q3, Q1, Q13, Story verification (Guard rows), stories 10, 19, 34.

- [ ] From a local-marketplace install, an agent's `git commit -m x` is denied and the agent spawns the worker with an intent.
- [ ] A commit typed in a terminal and a `!` prompt command are unaffected (story 19).
- [ ] With Node absent from the hook's PATH, and with a Node older than 22, the guard is silent (no output, no heartbeat); the `if` condition's cost, if registered, is noted.
