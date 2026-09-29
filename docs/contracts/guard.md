# Guard

**Input:** the `PreToolUse` hook JSON on stdin. Decision inputs: `tool_name` (`Bash`,
`PowerShell`), `tool_input.command`, `cwd`, and `agent_type` (the worker-only rule below).
`agent_id` is for the debug log only.

**Script call:** a segment (parsing step 2) whose first command token, optionally after the
`&` call operator, has the basename `node` or `node.exe`, whose next token has the basename
`commit.cjs`, and whose token after that is the subcommand (`plan`, `check`, `commit`,
`release`, `infer`). Basename: the part of a token after the last `/` or `\`, in both shells
(a Bash `commit.cjs` invocation may still carry a Windows-style path, e.g. through a quoted
`"C:\...\commit.cjs"` argument, Q3). Tokens are compared after the shell's quote removal, so the quoted form
every handback and worker uses (`node "C:/…/commit.cjs" plan`, Q16) matches like the unquoted
one. Substring matches on the raw command (`commit.cjs plan`) are not used: the quoted form
never contains them. The quoted path is never escaped: the commit entry point refuses with
exit 1 `env` an install path that contains `$`, a backtick, `"`, `\`, or U+201C–U+201E
([CLI](cli-and-exit-codes.md)), so no shell can expand or mangle it. The check runs on the
path after Windows separators are converted to `/` (the form the quoted call uses), so a
native Windows path is not refused; the `"` and `\` fixtures are POSIX only. Fixtures: quoted and
unquoted, Bash and PowerShell, `& node …`, `node.exe` at an absolute path,
`cd sub && node …`, `echo "node commit.cjs plan"` (not a script call), and a quoted backslash
path in Bash (e.g. `node "C:\Program Files\...\commit.cjs" plan`, matching by basename on `\`).

**Output:** exit 0 always.

- Deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<message>"}}`
- Otherwise: no output. The guard never returns `allow`.
- Crash or unreadable input: no output (fail open), no heartbeat.
- Node older than 22: no output (fail open), no heartbeat; the guard entry point checks
  `process.versions.node` before it loads the shared library (Q1).
- Debug log: with `COMMIT_GUARD_DEBUG=1`, a stderr line holding `agent_id`, the decision,
  the deny reason and the command redacted like the heartbeat's (the script-call form, or
  the matched `git commit` segment's options; never message text or other segments), cut to
  200 characters. A crash or unreadable input logs the same way (one line, with the fields
  known so far), still with no stdout and exit 0.
- Heartbeat: when any segment is a script call with subcommand `plan` (below), write
  `<Claude home>/commit-guard/heartbeat.json` (the Claude home is `CLAUDE_CONFIG_DIR` when
  set, else `<os.homedir()>/.claude`; guard and `plan` resolve it the same way) =
  `{ "ts": <ms>, "cwd": "<raw cwd>", "command": "<redacted>" }` before deciding (Q23).
  `command` is redacted: only the script-call form, `commit.cjs <subcommand> <flags>`
  without the script path and any other segment of the command, cut to 200 characters,
  so arguments a caller passed on the command line do not persist. The file is written
  to a temporary name in the same directory, carrying the pid and a random part so two
  hooks never share it, and renamed into place, so a reader never
  sees a partial file. `plan`
  counts it when `ts` is under 15 minutes old; it normalises both paths (realpath, `\` →
  `/`, case-folded on Windows and macOS) and counts a match when the hook's `cwd` is inside
  its git toplevel or the toplevel is inside the hook's `cwd`.

**Parsing:**

1. Early exit (no output) when the command, with every `'`, `"`, `\`, backtick, and the
   Unicode quote characters U+2018–U+201B (‘ ’ ‚ ‛) and U+201C–U+201E (“ ” „) removed, does
   not contain `commit`, compared case-insensitively (so it does not miss a dashed
   `git-COMMIT`-style variant that step 3's own case-insensitive match would otherwise catch
   downstream). The removal is for this check only, so split
   quotes (`git co''mmit`, ``git com`mit``, PowerShell `git co‘’mmit`) still reach parsing.
   Fixtures: both forms (deny), plus PowerShell `git co‘’mmit` (deny), a case variant
   (`git COMMIT`, deny), and `git com\` plus
   newline plus `mit` → no output (the documented escaped-newline gap below).
   Known gap: text that never contains the literal substring `commit` passes here even when
   it builds the word at runtime, such as `git $(echo com)mit` or PowerShell
   `git ('com'+'mit')` (Q3, not fixed in 0.1.0), and a `commit` split by an escaped newline
   (`git com\` plus newline plus `mit`, or PowerShell backtick plus newline), since the
   newline stays in the checked text (spec story 22).
2. Remove escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline) outside
   single quotes. Tokenise with the quoting rules of `tool_name`, then split into segments
   on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. Redirection operators (`>`,
   `>>`, `<`, `2>&1`, `>&` and the like) outside quotes become tokens of their own, dropped
   together with their target, so they are never read as commit arguments or options; the
   `&` inside `2>&1` or `>&` is not a separator. An unquoted `(` or `)` becomes a token of
   its own the same way (not dropped), except inside a `$(…)` substitution, which stays in
   its word up to its matching `)`: step 3 then finds the `git` token of `(git commit -m x)`,
   a `(` in the subcommand position is denied (step 4), and a `)` token ends `commit`'s
   arguments (step 5), so `(git commit --no-edit)` stays allowed. Bash process substitution
   `<(` or `>(` outside quotes becomes a `(` token (not a redirection, so the next word is
   not its target): `diff <(git commit -m x) f` gives `diff`, `(`, `git`, `commit`, `-m`,
   `x`, `)`, `f` and is denied. In PowerShell an unquoted `{` or `}` becomes a token of its
   own the same way (not dropped), except in a `${…}` variable name and inside a `$(…)`
   subexpression, so a script block glued to its first word (`&{git commit -m x}`,
   `if ($true) {git commit -m x}`) is denied and a `}` token ends `commit`'s arguments like
   `)`. In Bash `{` and `}` stay in their word (brace expansion, step 4). Comments are not
   recognised in either shell: `#` and the words after it, and a PowerShell `<# … #>` block,
   are read like any other text (documented false positives, below):

   | Rule | `Bash` | `PowerShell` |
   | --- | --- | --- |
   | escape character | `\` (outside `'…'`) | `` ` `` (outside `'…'`); `` `0 `` (and in PowerShell 7 `` `u{0} ``) is a NUL that ends the token's value there, as the native command line is cut at it, so the words after it in the segment are dropped too (`` git commit`0x -m x `` is `git commit`, and so is `` git commit`0 --no-edit ``; verified 2026-09-29 with PowerShell 5.1 and 7) |
   | single quotes | literal, no escapes | literal; `''` is one `'` |
   | double quotes | `\"`, `\\`, `\$` escaped | `` `" `` and `""` escaped |
   | ANSI-C quotes | `$'…'` outside double quotes: the `$` is removed and the span ends at the first `'` not escaped by `\`; its backslash escapes are decoded as Bash does (`\\`, `\'`, `\"`, `\?`, `\a`, `\b`, `\e`, `\E`, `\f`, `\n`, `\r`, `\t`, `\v`, `\nnn`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\cx`); an unknown escape keeps its `\` (`echo $'\''` is `echo` and `'`; `git $'commit'` is `git commit`); a decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends the `$'…'` span's value there, as in Bash (`git $'commit\0x'` is `git commit`, `$'ab\0cd'ef` is `abef`) | — |
   | here-strings | — (heredoc bodies are not commands, next row) | `@'…'@`, `@"…"@`: one token, from the opening line to a closing `'@` / `"@` at column 0 |
   | heredocs | `<<` or `<<-` outside quotes, with its delimiter word (quoted or not), is dropped like a redirection; the body, from the next line to the first line equal to the delimiter after quote removal (leading tabs stripped with `<<-`), is dropped, not read as commands; several heredocs on one line take their bodies in order; an unterminated body runs to the end of the command; `<<<` is a plain redirection | — |
   | unterminated quote or here-string | the rest of that line is one quoted token; scanning continues on the next line | same |
   | typographic quotes | “…”, ‘…’, „…“, ‚…‛ treated like `"…"` and `'…'` respectively (literal, no escapes inside): U+201C/U+201D/U+201E as double quotes, U+2018/U+2019/U+201A/U+201B as single quotes (verified 2026-09-27 against the PowerShell 7 parser) | same |

   Fixtures for both, among them `git commit -m "a\"b"` (Bash), ``git commit -m "a`"b"``
   (PowerShell), a here-string containing `git commit` piped into another command (not
   a commit), `git commit -m "unterminated` in both shells (deny), an unterminated
   here-string, `git commit -m x 2>&1` and `git commit -m x > log.txt` (deny, one segment,
   the redirection not read as an argument), `git \` plus newline plus `commit -m x`
   in Bash and its backtick form in PowerShell (deny), `(git commit -m x)` in both shells
   (deny), `(git commit --no-edit)` (no output), and a Bash `cat <<'EOF' > f` followed by a
   body line `git commit -m x` and the line `EOF` (no output); Bash
   `echo $'\'' ; git commit -m x` and `diff <(git commit -m x) f` (deny); PowerShell
   `&{git commit -m x}`, `. {git commit -m x}` and `if ($true) {git commit -m x}` (deny),
   and `&{git commit --no-edit}` (no output).
   Documented false positives (fail closed): a comment that mentions `git commit`,
   `git commit --no-edit # done`, `# git commit -m x` on its own line, PowerShell
   `<# git commit -m x #> git status` (deny).
3. In each segment, find a token whose basename (the part after the last `/` or `\`, in both
   shells, e.g. `git.exe` out of a Bash-quoted `"C:\Program Files\Git\cmd\git.exe"`) is `git`
   or `git.exe`, compared
   case-insensitively (`Git.exe`), optionally after the `&` call operator. A token whose
   basename (any directory, an optional `.exe`, compared case-insensitively) is
   `git-commit` — git's own dashed form, runnable straight off `PATH` — classifies the
   segment as a `commit` straight away, skipping steps 4 and 5's global-option and
   subcommand scan: the tokens after it are `commit`'s own args, expanded and checked
   against the allowlist as in step 5.
   Known gap: expansion in the command position, where no token is `git` until the shell
   expands it, passes with no output (Q3): `$(echo git) commit`, Bash brace expansion
   `{git,commit,-m,x}`, a glob such as `/usr/bin/gi? commit -m x`.
4. Skip git global options: `-C <path>`, `-c <k=v>`, `--config-env[=]<k=env>`,
   `--git-dir[=]<p>`, `--work-tree[=]<p>`,
   `--namespace[=]<n>`, `--no-pager`, `-P`, `-p`, `--paginate`, `--bare`, `--no-replace-objects`,
   `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`,
   `--no-optional-locks`. An unknown option starting with `-` followed later by a `commit`
   token → deny. The first token after the global options is the subcommand; every match of
   a token against `commit` here and in step 5 is case-insensitive, fail closed
   (`git COMMIT -m x` → deny). When the subcommand
   contains `$` or a backtick (a variable or substitution, `c=commit; git $c -m x`,
   `` git `echo commit` -m x ``) or, in PowerShell, starts with `@` (a splat, `git @a`),
   deny, since it may expand to `commit`. This step is reached only when the command's text
   holds `commit` somewhere (step 1): `git $c -m x` alone exits early with no output (the
   step 1 gap). A subcommand token holding a
   `{`, `(`, or a glob character (`*`, `?`, `[`) is denied the same way, fail closed, since a
   brace or paren expansion or a glob may also resolve to `commit` (`git {commit,-m,x}` in
   Bash, PowerShell `git (…)`). Fixtures: each form in its shell (deny), among them
   `c=commit; git $c -m x`, Bash `` git `echo commit` -m x `` and
   `` git "`echo commit`" -m x ``, and `git $c -m x` alone (no output); and
   `git -C $dir commit -m x` (deny as a commit; `$dir` is an option value).
   `-c` and `--config-env` are skipped for other subcommands but remembered:
   if the subcommand is `commit`, deny.
5. If the next token is `commit`, expand its args (`-am` → `-a -m`, `-mfoo` → `-m foo`,
   `--opt=v` → `--opt v`; its args end at the segment's end, at a `)` token or, in
   PowerShell, at a `}` token, step 2) and
   apply the allowlist
   ([Q4](../decisions/q04-hook-allowlist-no-env-switch.md)); `--quiet` is allowed wherever `-q`
   is. `--squash` is denied in any form (`--no-edit` does not exempt it). Fixture:
   `git commit --squash=HEAD --no-edit` → deny.

**Oracle-skip classes:** the step 2 `segments` golden fixtures
(`tests/fixtures/guard/segments-seed.json`, seeded by the tokenizer spike, Q3) are
cross-checked in CI against bash's own words for each segment (`printf '%s\0'`) and the
PowerShell parser API's pipeline elements (5.1 and 7). The PowerShell oracle reads the command
elements whatever parse errors the parser reports (5.1 reports `&&` and `||` as parse
errors; `p51-and` matches). A fixture's `oracle` value per shell
is `match` (the words must be equal) or one of these classes, where the tokenizer
deliberately differs from the shell and the check is skipped:

| Class | Shell | Where the tokenizer differs |
| --- | --- | --- |
| `redirection` | Bash | a redirection is a token with its target; the shell applies it and prints no word |
| `heredoc` | Bash | the heredoc body is dropped; the shell feeds it to the command |
| `expansion` | both | `$` variables, `$(…)`, backticks, brace expansion, globs and process substitution stay unexpanded in their word (process substitution as `(`); the shell expands them |
| `unterminated` | both | an unterminated quote or here-string is the rest of its line; the shell rejects the command |
| `subshell-parens` | both | `(` and `)` are tokens; the shell has no words for a subshell or a grouping expression |
| `ps-scriptblock` | PowerShell | `{` and `}` are tokens; the parser yields a script-block expression, not the commands in it |
| `ps-expression-statement` | PowerShell | assignment and keyword statements (`$m = …`, `if`, `foreach`) are words; the parser yields no command elements for them |
| `splat` | PowerShell | `@name` is a word; the parser yields a splatted variable |
| `ps-stop-parsing` | PowerShell | the words after `--%` are tokenised; the parser passes them on verbatim |
| `escaped-newline-in-word` | PowerShell | a backtick plus newline inside a word is removed (step 2); PowerShell keeps the newline in the word |
| `ps-nul` | PowerShell | a NUL escape (`` `0 ``, `` `u{0} ``) ends its token's value and drops the words after it in the segment; the parser keeps the NUL and the rest in the word and keeps the later words (the native command line is cut only when the command runs) |
| `carriage-return` | Bash | a carriage return is a character of its word; the Windows (Cygwin) bash strips it before a newline |
| `typographic-quotes-bash` | Bash | typographic quotes are quotes, as PowerShell reads them; bash keeps them as characters |
| `comment` | both | a comment is read as words (the documented false positives); the shell drops it |

**Deny messages:** `<route>` stands for `Spawn the commit:commit-worker agent (pass intent:
<what you changed and why>). Edit no files until it replies.` It never names `/commit`: the
reason goes to the model, which cannot invoke `/commit` (`disable-model-invocation`, Q2), and
a `Skill("commit")` call could resolve to a personal commit skill (Q8). Every message
that contains `<route>` ends with the fixed line `If a personal commit skill sent you here,
remove it (see the commit plugin README).` (Q8; nothing is detected).

Worker-only rule: when `agent_type` is `commit:commit-worker` and any segment is a script
call with subcommand `commit` or `release`, deny with `The handback is for your caller:
return the reply verbatim and stop.` (Q25). Everything else the worker runs is left to the
normal rules.

**Precedence:** when a `commit` segment's expanded arguments match more than one row below,
the most specific wins, in this order: `-c` / `--config-env` before `commit`; the
literal-subcommand row; unknown global option; `--amend` without `--no-edit`; `--squash` in
any form; `-n` / `--no-verify` / `--no-gpg-sign`; `--fixup=amend:` / `--fixup=reword:`; the
generic "any other flag or argument" row (also covers `-C` / `-c` after `commit`); the
bare/`-m`/`-F`/`--message`/`--file` row, only when no other row matches. A tie within one row
goes to the first matching token in argv order. So `-am x` denies on `-a` (the generic row:
`git commit -a is not allowed here. <route>`), `--amend -m x` denies on `--amend`, `-n -m x`
on `-n`, and `--squash -m x` on `--squash`.

| Case | Message |
| --- | --- |
| bare commit, `-m`, `-F`, `--message`, `--file` | `Direct git commit is blocked. <route>` |
| `--amend` without `--no-edit` | `To reword the last commit: <route> Ask it to reword. To add changes, make a new commit the same way.` |
| `--squash` in any form | `git commit --squash opens an editor. <route>` |
| `-n`, `--no-verify`, `--no-gpg-sign` | `<flag> is not allowed. Fix the hook or signing setup instead.` |
| `--fixup=amend:` / `--fixup=reword:` | `--fixup=<kind>: opens an editor. Use plain --fixup=<commit>, or: <route>` |
| any other flag or argument | `git commit <flag> is not allowed here. <route>` |
| `-c` / `--config-env` before `commit` | `git -c … commit is not allowed. <route>` |
| subcommand with `$` or a backtick, starting with `@` in PowerShell, or holding `{`, `(`, `*`, `?` or `[` | `Write the git subcommand literally. <route>` |
| `-C` / `--reuse-message`, `-c` / `--reedit-message` (after `commit`) | `git commit <flag> is not allowed here. <route>` (the generic row) |
| unknown global option | `Could not parse git options before 'commit'. <route>` |
