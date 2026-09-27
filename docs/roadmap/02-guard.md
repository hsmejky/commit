# 02 Guard

The `PreToolUse` guard: the thin guard entry point over G1 hook I/O, G2 shell tokenizer,
G3 classifier and deny catalogue, S2 script-call recognition and building, S1 heartbeat,
and the hook registration. It denies an agent's direct `git commit` with a route to the
worker, never allows, fails open, and writes the heartbeat for `plan` calls. Tested at Seam
2 (the real hook process) and Seam 3 (`runHook`, G2 `segments`, S2 `build`). Sources: Q3,
Q4, Q13, Q23, Q25, C:guard, stories 10-39, Modules S1-S2 and G1-G3.

## GRD-01: Guard tracer: early exit end to end

**What to build:** the thin guard entry point and G1 `runHook`: stdin read to its end, and a
command that does not contain `commit` (after removing quotes, `\`, backticks and
typographic quotes, case-insensitive) ends with no output and exit 0.

**Blocked by:** FND-04.

**Status:** ready-for-agent

**Sources:** Q3, Q13, Q1, C:guard (Output, Parsing step 1), stories 17, 22, Architectural decisions "Code split", "Entry points survive an old Node".

- [ ] Seam 2: `ls -la` as Bash and as PowerShell → empty stdout, exit 0, no heartbeat file.
- [ ] Seam 2: a large stdin payload delivered in several chunks is read whole (no synchronous read of descriptor 0).
- [ ] Seam 3: `runHook` with injected `claudeHome` and `now` gives the same result as Seam 2 for the same input.
- [ ] A static check asserts the guard entry point's import graph reaches only G1-G3, S1 and S2, and that the entry point checks the Node version before its dynamic import of the library.
- [ ] No code path emits an `allow` decision.


## GRD-02: Fail open on unreadable input or a crash

**What to build:** unreadable, malformed or incomplete hook input, and any throw inside the
guard, end silently; under `COMMIT_GUARD_DEBUG=1` one stderr line records it.

**Blocked by:** GRD-01.

**Status:** ready-for-agent

**Sources:** Q3, Q1, C:guard (Output), stories 18, 20.

- [ ] Seam 2: non-JSON stdin, empty stdin, JSON without `tool_input.command`, an unknown `tool_name` → no stdout, exit 0, no heartbeat.
- [ ] Seam 2 with `COMMIT_GUARD_DEBUG=1`: exactly one stderr line holding the fields known so far (`agent_id` when present); without the variable, no stderr.


## GRD-03: Bash tokenizer and the first deny

**What to build:** G2 for Bash (`\` escapes, literal single quotes, `\"` `\\` `\$` in double
quotes, quote removal, segments on `&&`, `||`, `;`, `|`, `&`, newlines) and the thinnest G3,
so `git commit -m x` in Bash is denied with the routing text.

**Blocked by:** GRD-01, PRE-01, PRE-03.

**Status:** ready-for-agent

**Sources:** Q3, Q8, Q24, C:guard (Parsing step 2 Bash column, Deny messages), stories 10, 11, 12, 13.

- [ ] Seam 2: `git commit -m x` → the deny JSON of C:guard with `Direct git commit is blocked. <route>` and the fixed personal-skill line; exit 0.
- [ ] Seam 3: `cd x && git commit -m x`, `a; git commit -m x`, `a | git commit -m x`, `a & git commit -m x` and a newline-separated form are denied; `git co''mmit -m x` is denied (not an early exit); `git commit -m "a\"b"` is one message argument.
- [ ] Seam 3: G2 `segments` golden fixtures for Bash (seeded from PRE-03); in CI each is cross-checked against bash's own words (`printf '%s\0'`), with the deliberate classes oracle-skipped.
- [ ] No deny text anywhere in the catalogue names `/commit`.


## GRD-04: Q4 allowlist and the generic deny

**What to build:** G3 expands `commit`'s arguments (short clusters, attached values,
`--opt=value`) and applies the Q4 allowlist; every other flag or argument is denied naming
it.

**Blocked by:** GRD-03.

**Status:** ready-for-agent

**Sources:** Q4, Q21, C:guard (Parsing step 5, Deny messages), stories 23, 24, 25, 26, 29, 33.

- [ ] No output for `git commit --no-edit`, `--amend --no-edit`, `--no-edit -q`, `--no-edit --quiet`, `--fixup=<sha>`, `--fixup=<sha> -q`, and reordered flag forms of these.
- [ ] Denied, naming the flag: `-m`, `-F`, `--message`, `--file`, bare `git commit`, `-am x` (expanded to `-a -m`), `-mfoo`, `-t`, `-a`, `--allow-empty`, `--allow-empty-message`, a pathspec, `--`.
- [ ] A deny case run with `COMMIT_GUARD=off` and similar variables set is still denied (no env switch).


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


## GRD-06: PowerShell tokenizer

**What to build:** G2 for PowerShell (backtick escapes, `''` and `""`, here-strings closing
at column 0, the `&` call operator), so the same denies hold for PowerShell commands.

**Blocked by:** GRD-05.

**Status:** ready-for-agent

**Sources:** Q3, Q15, C:guard (Parsing step 2 PowerShell column), stories 13, 14.

- [ ] Seam 3: ``git commit -m "a`"b"``, `& git commit -m x`, a compound PowerShell command → denied; a here-string holding `git commit` piped into another command → no output.
- [ ] Seam 2: one PowerShell deny case end to end.
- [ ] G2 golden fixtures for PowerShell are cross-checked in CI against the PowerShell parser API under both `powershell.exe` and `pwsh`, deliberate classes oracle-skipped.


## GRD-07: Escaped newlines and unterminated quotes

**What to build:** escaped newlines are joined before splitting, and an unterminated quote
or here-string turns the rest of its line into one quoted token while scanning continues.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing steps 1-2), stories 13, 16, 22.

- [ ] `git \`⏎`commit -m x` (Bash) and its backtick form (PowerShell) → denied.
- [ ] `git commit -m "unterminated` in both shells and an unterminated here-string holding a commit → denied.
- [ ] The documented gap: `git com\`⏎`mit` → no output.


## GRD-08: Redirections, parentheses and heredocs

**What to build:** redirections are dropped with their target, `(` and `)` are tokens
(a `$(…)` stays in its word), and Bash heredoc bodies are dropped.

**Blocked by:** GRD-07.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing step 2, heredoc row), stories 13, 15.

- [ ] `git commit -m x 2>&1` and `git commit -m x > log.txt` → denied, one segment, the target not read as an argument; the `&` in `2>&1` does not split.
- [ ] `(git commit -m x)` in both shells → denied; `(git commit --no-edit)` → no output.
- [ ] `cat <<'EOF' > f`, body line `git commit -m x`, `EOF` → no output; `<<-` with tab-indented delimiter, two heredocs on one line, an unterminated body; `<<<` treated as a plain redirection.


## GRD-09: Typographic quotes

**What to build:** U+201C-U+201E read as double quotes and U+2018-U+201B as single quotes in
both shells, and removed for the early-exit check.

**Blocked by:** GRD-08.

**Status:** ready-for-agent

**Sources:** Q3 (pass 5, pass 8), C:guard (typographic quotes row, step 1), stories 15, 22.

- [ ] `git “commit” -m x` (Bash) and PowerShell `git co‘’mmit -m x` → denied.
- [ ] Typographic-quote fixtures are in the Bash oracle-skip class and cross-checked for PowerShell.


## GRD-10: Detecting `git` in every spelling

**What to build:** G3 finds `git` or `git.exe` at any path, case-insensitive, after `&`,
including a quoted Windows path in Bash, and treats the dashed `git-commit` binary as
`git commit`.

**Blocked by:** GRD-09.

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

- [ ] `git -C $dir commit -m x`, `git --no-pager -P commit -m x`, `git --git-dir=x commit -m x` → denied as a commit (generic row); `git -C x status` → no output.
- [ ] `git -c k=v commit --no-edit` and `git --config-env=k=E commit --no-edit` → the `-c` row; `git -c k=v log` → no output.
- [ ] `git --unknown commit` → the "Could not parse git options" row.


## GRD-12: Fail closed on an unreadable subcommand

**What to build:** a subcommand token holding `$`, `{`, `(` or a glob character, or starting
with `@` in PowerShell, is denied; `commit` matches case-insensitively.

**Blocked by:** GRD-11.

**Status:** ready-for-agent

**Sources:** Q3, C:guard (Parsing step 4, Deny messages), story 15.

- [ ] Denied with `Write the git subcommand literally. <route>`: `git $c -m x`, PowerShell `git @a`, `git {commit,-m,x}`, PowerShell `git (…)`, `git c*t -m x` in a command mentioning `commit`.
- [ ] `git COMMIT -m x` → denied as a commit.
- [ ] The documented gap: `git $(echo com)mit` → no output.


## GRD-13: S2 script calls: recognise and build

**What to build:** S2 `recognise` finds a script call in a segment (`node`/`node.exe`,
optionally after `&`, a token whose basename is the commit entry point's, a subcommand from
the fixed list) and S2 `build` emits the one quoted form the allow rules match.

**Blocked by:** GRD-06.

**Status:** ready-for-agent

**Sources:** Q16, Q23, Q25, C:guard (Script call), stories 37, 38.

- [ ] Seam 3 fixtures of C:guard's script-call list: quoted and unquoted, Bash and PowerShell, `& node …`, `node.exe` at an absolute path, `cd sub && node …`, a quoted backslash path in Bash → recognised with subcommand and args; `echo "node commit.js plan"` → not a call.
- [ ] S2 `build` (declared at Seam 3) emits an absolute forward-slash path in double quotes for POSIX and Windows paths (with spaces and drive letters), and its output is recognised back with the same subcommand and args in both shells.
- [ ] A caller's `plan`, `check`, `commit` and `release` script calls produce no guard output outside the worker (story 38).


## GRD-14: Worker-only rule

**What to build:** as `commit:commit-worker`, a script call to `commit` or `release` is
denied with the handback text; everything else the worker runs follows the normal rules.

**Blocked by:** GRD-13.

**Status:** ready-for-agent

**Sources:** Q25, C:guard (Worker-only rule), story 39.

- [ ] Seam 2 with `agent_type: commit:commit-worker`: a `commit` and a `release` script call → `The handback is for your caller: return the reply verbatim and stop.`; `plan` and `check` → no output.
- [ ] The same `commit` call with another or no `agent_type` → no output.


## GRD-15: S1 heartbeat write

**What to build:** when any segment is a script call to `plan`, the guard writes the
heartbeat `{ ts, cwd, command }` under the Claude home before deciding, atomically and
redacted.

**Blocked by:** GRD-13, PRE-05.

**Status:** ready-for-agent

**Sources:** Q23, Q5, C:guard (Heartbeat), stories 21, 36, 37.

- [ ] Seam 2: a `plan` script call in each shell and quoting form writes the file under the temp Claude home (`CLAUDE_CONFIG_DIR` honoured), with `ts` from `now`, the raw `cwd`, and `command` as `commit.js plan <flags>` without the path or other segments, cut to 200 characters.
- [ ] A denied compound command that also calls `plan` still writes the heartbeat; `check`, `commit` or a crash write none.
- [ ] The write goes through a temporary name with pid and random part, renamed into place; no temporary file remains.


## GRD-16: Debug log for decisions

**What to build:** under `COMMIT_GUARD_DEBUG=1`, each decision writes one stderr line with
`agent_id`, the decision, the deny reason and the redacted command.

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

- [ ] Seam 1: a heartbeat under 15 minutes old whose `cwd` is inside the toplevel, or contains it → `active`; older, absent, or another repo → `not-seen` with the "Guard hook did not run" notice, and the run goes on.
- [ ] Path matching is realpathed with `\` → `/`, case-folded on Windows and macOS (a case-differing `cwd` matches there).
- [ ] Round trip: a `plan` call through the Seam 2 guard, then `plan` at Seam 1 with the same Claude home → `active`.


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

**Blocked by:** PRE-07, GRD-18.

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


## GRD-21: Guard hand-test

**What to build:** a manual check of what no seam can reach: the installed guard in a real
session, the human-only channel, and the silent exits.

**Blocked by:** GRD-18, PRE-02.

**Status:** needs-human

**Sources:** Q3, Q1, Q13, Story verification (Guard rows), stories 10, 19, 34.

- [ ] From a local-marketplace install, an agent's `git commit -m x` is denied and the agent spawns the worker with an intent.
- [ ] A commit typed in a terminal and a `!` prompt command are unaffected (story 19).
- [ ] With Node absent from the hook's PATH, and with a Node older than 22, the guard is silent (no output, no heartbeat); the `if` condition's cost, if registered, is noted.
