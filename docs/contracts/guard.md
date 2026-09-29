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
   it builds the word at runtime, such as `git $(echo com)mit`, PowerShell
   `git ('com'+'mit')` or a PowerShell 7 `` `u{…} `` escape (`` git co`u{6d}mit ``) (Q3, not fixed in 0.1.0), and a `commit` split by an escaped newline
   (`git com\` plus newline plus `mit`, or PowerShell backtick plus newline), since the
   newline stays in the checked text (spec story 22).
2. Remove escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline) outside
   single quotes. Tokenise with the quoting rules of `tool_name`, then split into segments
   on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. Redirection operators (`>`,
   `>>`, `<`, `2>&1`, `>&` and the like) outside quotes become tokens of their own, dropped
   together with their target, so they are never read as commit arguments or options; the
   `&` inside `2>&1` or `>&` is not a separator. An unquoted `(` or `)` becomes a token of
   its own the same way (not dropped), except inside a `$(…)` substitution, which stays in
   its word up to its matching `)` (brackets counted outside quotes; when bash may end it
   elsewhere, the unsure-end rule below applies): step 3 then finds the `git` token of
   `(git commit -m x)`,
   a `(` among git's arguments is denied (step 4), and a `)` token ends git's arguments
   (steps 4 and 5), so `(git commit --no-edit)` stays allowed. Bash process substitution
   `<(` or `>(` outside quotes becomes a `(` token (not a redirection, so the next word is
   not its target): `diff <(git commit -m x) f` gives `diff`, `(`, `git`, `commit`, `-m`,
   `x`, `)`, `f` and is denied. In PowerShell an unquoted `{` or `}` becomes a token of its
   own the same way (not dropped), except in a `${…}` variable name and inside a `$(…)`
   subexpression, so a script block glued to its first word (`&{git commit -m x}`,
   `if ($true) {git commit -m x}`) is denied and a `}` token ends git's arguments like
   `)`. In Bash `{` and `}` stay in their word (brace expansion, step 4), a backtick
   substitution stays in its word up to the next backtick not escaped by `\`, like `$(…)`,
   and so does a Bash 5.3 `${` followed by a space, a tab, a newline or `|` (`${ cmd; }`,
   `${| cmd; }`, a command substitution run in the current shell), up to the first `}` word,
   outside quotes and nested `${…}`, that is the first word of a command (after the body's
   start, a newline, `;`, `&`, `&&`, `||` or `|`); its body is the text after that blank or
   `|`. When bash may end it elsewhere, the unsure-end rule below applies.
   A command substitution is read twice: it stays in its word, and its body is also
   tokenised as a command of its own, with the same rules and recursively, into segments that
   come right after the segment holding it, before the next segment of the text (after those
   of substitutions earlier in that segment), so steps 3 to 5 classify the commands it runs:
   `echo $(git commit -m x)` gives `echo` and `$(git commit -m x)`, then `git`, `commit`,
   `-m`, `x`, and is denied. The extra segments only add denies (fail closed). Bash reads
   `$(…)` (and `$((…))`, read the same way), a `${ …; }` or `${| …; }` substitution and a
   backtick substitution (its body with `\\`, `` \` `` and `\$` unescaped) unquoted, inside
   double quotes, inside `${…}`, and in the body of a heredoc whose delimiter is unquoted (its
   segments come right after the segment holding the `<<`); not inside single quotes, `$'…'` or a heredoc
   with a quoted delimiter. PowerShell reads `$(…)` unquoted, inside double quotes and inside
   an `@"…"@` here-string; not inside single quotes, `@'…'@` or after `--%`.
   **Unsure end (fail closed).** The shell may end a `$(…)`, `${ …; }` or `${| …; }`
   substitution after the `)` or `}` found above, when that one sits in a comment, a case
   pattern, a nested `{ …; }` group or a function body, or before it, at a `}` after a
   compound command (`${ (:) }`, `${ if :; then :; fi }`); the text in between is then read
   in the wrong context, and a command there, in double quotes or a heredoc body, was never
   classified. Verified 2026-09-29 with bash 5.3, each of these runs `git commit -m x`:
   `echo "${ { :; }; git commit -m x; }"`, `echo "${ f(){ :; }; git commit -m x; }"`,
   `echo "${ : # ; }` plus newline plus `git commit -m x; }"`,
   `echo "${ case } in a) ;; }) git commit -m x;; esac; }"`, `echo "$( : # )` plus newline
   plus `git commit -m x )"` and `echo "$(case x in x) git commit -m x;; esac)"`; and with
   PowerShell 5.1 and 7, `Write-Output $( 1 # ) "`, then the lines `git commit -m x`, `# "`
   and `)`. So the end is unsure when the body found above holds, after quote removal and
   anywhere in it (a redirection target and a heredoc delimiter count as words), a word
   that starts with `{` or `#` or is `case`, `esac`, `fi`, `done` or `]]`, or a `{` token
   (PowerShell), or, in a `${ …; }` or `${| …; }` body, a `(` or `)` token (a `$(…)` counts
   its brackets, so `$((n+1))` is not unsure), or when no closing `)` or `}` is found.
   Then the substitution's word (or the heredoc body holding it) runs to the end of the
   whole command, the rest of the command written as it is, and no later segment of the
   enclosing text is read; the body is
   the whole rest of the command after the `$(`, or after the blank or `|` of `${`, with
   step 1's characters removed (so no quote in it, such as the one that closes an enclosing
   double quote, can hide a later command, whichever way the shell reads it), tokenised as a
   body like any other. Steps 3 to 5 classify its segments; when none is denied and that
   rest holds `commit` (step 1's check), the command is denied with the unsure-end message
   (deny table), since the words the shell runs there are unknown. Guessing the real end
   would need bash's grammar; the rule costs false positives only in a command that
   mentions `commit` after such a substitution (documented false positives, below). A word
   such as `${x}`, `${#x}` or `$#` does not start with `{` or `#`, so `$(echo ${#x})` and
   `$(git log -1)` keep the rules above. In PowerShell a `$(…)` inside a string ends at its
   matching `)` even after `#` (verified 2026-09-29); the rule applies there too, as to
   every `$(…)`. In PowerShell a
   word equal to `--%` after escape removal, not inside quotes (`--%`, `` `--% ``,
   `` -`-% ``), stops parsing: the rest of its line, up to the next `|`, `&&` or `||`,
   is split into words on whitespace only, so quotes, backticks, `$`, brackets, `;`, `&`,
   `#`, redirection operators and here-string openers are characters of their word and no
   substitution body is read; the newline still ends the segment. So
   `git --% -c x.y=; commit -m x` is one segment (`git`, `--%`, `-c`, `x.y=;`, `commit`, `-m`,
   `x`; PowerShell runs `git -c x.y=; commit -m x`), and `Write-Output --% @'` followed by the
   line `git commit -m x` gives that line a segment of its own, as PowerShell runs it, and so
   does `` Write-Output `--% @' `` (verified 2026-09-29 with PowerShell 5.1 and 7). A quoted
   `'--%'` does not stop parsing (step 4 denies it among git's arguments). Comments are not
   recognised in either shell: `#` and the words after it, and a PowerShell `<# … #>` block,
   are read like any other text (documented false positives, below). The one exception: a
   word starting with `#` in a substitution body makes its end unsure (above), since the
   comment may hide the `)` or `}` that seemed to close it:

   | Rule | `Bash` | `PowerShell` |
   | --- | --- | --- |
   | escape character | `\` (outside `'…'`) | `` ` `` (outside `'…'`); `` `u{…} `` with one to six hex digits is the character of that code point, as in PowerShell 7; `` `0 `` and a `` `u{…} `` whose value is 0 (`` `u{0} ``, `` `u{00} ``, `` `u{000000} ``) are a NUL that ends the token's value there, as the native command line is cut at it; the tokenizer emits a `cut` token (`{"op":"cut"}`) after the cut token, which ends git's arguments (step 4): steps 4 and 5 read no token past it, but the tokens after it stay in the segment for step 3, since the shell cuts only that one native command's line and a nested command still runs (`` git commit`0x -m x ``, `` git commit`0 --no-edit `` and `` git commit`u{00} --no-edit `` are a bare `git commit`; `` Write-Output x`0 (git commit -m x) `` and `` if ("x`0") {git commit -m x} `` are denied; verified 2026-09-29 with PowerShell 5.1 and 7; Windows PowerShell 5.1 has no `` `u{…} `` escape: it reads `` `u `` as `u` and the braces as a script block, passed to git as `-encodedCommand …` arguments git rejects) |
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
   and `&{git commit --no-edit}` (no output); substitutions: Bash `echo $(git commit -m x)`,
   `` echo `git commit -m x` ``, `echo "$(git commit -m x)"`, `echo $(echo $(git commit -m x))`,
   `echo ${x:-$(git commit -m x)}`, `cat <<EOF` with the body line `$(git commit -m x)`,
   `echo "${ git commit -m x; }"`, `echo ${| git commit -m x; }` and `cat <<EOF` with the
   body line `${ git commit -m x; }` (deny), `echo '$(git commit -m x)'`, the same heredoc
   with `<<'EOF'`, `echo $(git commit --no-edit)` and `echo "${ git commit --no-edit; }"`
   (no output); PowerShell `$(git commit -m x)`, `Write-Output "$(git commit -m x)"` and its
   `@"…"@` form (deny); unsure end: each form verified above, `cat <<EOF` with the body line
   `${ { :; }; git commit -m x; }`, and with the body lines `$( : # )` and
   `git commit -m x )`, and with the body line `$(case x in x) git commit -m x;; esac)`,
   `echo "${ { :; }; echo '"'; }" ; git commit -m x` (a quote after the real end would hide
   the commit if the rest kept its quotes), `echo "${ if :; then :; fi }" ; git commit -m x`
   (no `}` found) and Bash `echo $( : # ) "` with the lines `git commit -m x`, `# "` and `)`
   (deny), `echo "${x}" "$(git log -1)" && git commit --no-edit`,
   `echo "${ git log -1; }" && git commit --no-edit`,
   `echo "$(echo ${#x})" && git commit --no-edit` and PowerShell
   `Write-Output "$(git log -1)"; git commit --no-edit` (no output); stop-parsing:
   `git --% -c x.y=; commit -m x`, the
   `Write-Output --% @'` case and its `` Write-Output `--% @' `` form (deny), and
   `Write-Output --% (git commit -m x)` (no output: PowerShell passes the brackets as text).
   Documented false positives (fail closed): a comment that mentions `git commit`,
   `git commit --no-edit # done`, `# git commit -m x` on its own line, PowerShell
   `<# git commit -m x #> git status` (deny), a `git` word after another command's `--%`
   (`Write-Output --% git commit -m x`, deny), and a substitution whose end is unsure (a
   group, a function definition, a comment or `case` in its body) in a command that mentions
   `commit` after it (`echo "${ { :; }; }"; git commit --no-edit`, deny).
3. In each segment, find a token whose basename (the part after the last `/` or `\`, in both
   shells, e.g. `git.exe` out of a Bash-quoted `"C:\Program Files\Git\cmd\git.exe"`) is `git`
   or `git.exe`, compared
   case-insensitively (`Git.exe`), optionally after the `&` call operator. Every such token
   in the segment is classified by steps 4 and 5, and the segment is denied when any of them
   is: a git command can run inside another command's argument (PowerShell
   `git status (git commit -m x)`, `` git commit --no-edit`0 (git commit -m x) ``). A token whose
   basename (any directory, an optional `.exe`, compared case-insensitively) is
   `git-commit` — git's own dashed form, runnable straight off `PATH` — classifies the
   segment as a `commit` straight away, skipping steps 4 and 5's global-option and
   subcommand scan: the tokens after it are `commit`'s own args, expanded and checked
   against the allowlist as in step 5.
   Known gap: expansion in the command position, where no token is `git` until the shell
   expands it, passes with no output (Q3): `$(echo git) commit`, Bash brace expansion
   `{git,commit,-m,x}`, a glob such as `/usr/bin/gi? commit -m x`, a variable there (Bash
   `$GIT commit -m x`, PowerShell `& $g commit -m x`), and a PowerShell expression there,
   `& ('git') commit -m x` (its `git` token is followed by the `)` that ends its arguments,
   step 4). A substitution's body is read (step 2), but not what it prints.
4. Skip git global options: `-C <path>`, `-c <k=v>`, `--config-env[=]<k=env>`,
   `--git-dir[=]<p>`, `--work-tree[=]<p>`,
   `--namespace[=]<n>`, `--no-pager`, `-P`, `-p`, `--paginate`, `--bare`, `--no-replace-objects`,
   `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`,
   `--no-optional-locks`. An unknown option starting with `-` followed later by a `commit`
   token → deny. The first token after the global options is the subcommand. Steps 4 and 5
   read git's arguments from the token after `git` up to the segment's end, a `cut` token
   (step 2), or a `)` token or, in PowerShell, a `}` token; no option value, subcommand or
   `commit` argument is read past it. Every token read there, as a global option, an
   option's value, the subcommand or one of `commit`'s arguments or their values, must be
   literal: a token the shell may turn into another word or into several arguments is denied
   (fail closed), since it may resolve to `commit` or smuggle in an option. A token is not
   literal when it:
   - is a `(` token or, in PowerShell, a `{` token: a grouping expression, an `@(…)` array
     or a script block is an argument of the native command, which may turn into several
     (`git -C (Get-Location) commit -m x` runs `git -C <dir> commit -m x`,
     `git commit --fixup ("HEAD","--no-verify")` runs `git commit --fixup HEAD --no-verify`,
     a script block becomes `-encodedCommand …`);
   - holds `$` or a backtick: a variable or a substitution, which Bash word splitting or a
     PowerShell array value may split into several arguments (`c=commit; git $c -m x`,
     `` git `echo commit` -m x ``, `git commit --fixup $s`, PowerShell
     `git commit --fixup $('HEAD','--no-verify')` runs `--fixup HEAD --no-verify`);
   - holds `{`, `(` or a glob character (`*`, `?`, `[`): brace expansion, an expression or
     a glob may give another word or several (`git -C {.,commit} status` runs
     `git -C . commit status`, `git {commit,-m,x}`, PowerShell 7 expands globs in native
     arguments on Linux and macOS);
   - in PowerShell, holds `,` or `@`, or is `--%`: a comma makes an array literal, which
     Windows PowerShell 5.1 passes as separate arguments (`git -C . ,commit -m x`,
     `git -C . , commit -m x` and `git commit, -m x` run a commit there; PowerShell 7 passes
     the comma on); a leading `@` is a splat or an array (`git @a`,
     `git commit --fixup @s`); `--%` stops parsing (step 2) and expands `%NAME%` in the rest
     of the line (`$env:X='commit'; git --% %X% -m x`), and a quoted `'--%'` is dropped from
     the native command line (`git '--%' commit -m x` runs `git commit -m x`).
   Verified 2026-09-29 with bash 5.3, Windows PowerShell 5.1 and PowerShell 7. In Bash `,`,
   `@` and `--%` are ordinary characters (`git commit --fixup @~1`). The tokenizer does not
   record quoting, so a quoted form is denied too (fail closed; documented false positives:
   `git -C "$dir" commit --no-edit`, `git commit --fixup "$sha"`; write the value
   literally). A non-literal token in the subcommand position is denied with the
   literal-subcommand message, anywhere else with the literal-arguments message (deny
   table). The tokens after a literal subcommand other than `commit` are not read, so
   `git log --format=%h,%s $x; echo commit` gives no output. So the `)` or `}` that ends
   git's arguments closes a bracket opened before `git` (`(git commit --no-edit)`,
   `&{git commit --no-edit}`), or is a stray one the shell rejects as a syntax error; in
   Bash a `(` after a command word is a syntax error too. Every match of a token against
   `commit` here and in step 5 is case-insensitive, fail closed (`git COMMIT -m x` → deny).
   This step is reached only when the command's text holds `commit` somewhere (step 1):
   `git $c -m x` alone exits early with no output (the step 1 gap). Fixtures: each form
   above in its shell (deny), among them Bash `` git "`echo commit`" -m x `` and
   `git -C $dir commit -m x`, the two quoted false positives (deny), and `git $c -m x`
   alone, `git -C .,commit status` in Bash, `(git commit --no-edit)` and
   `&{git commit --no-edit}` (no output).
   `-c` and `--config-env` are skipped for other subcommands but remembered:
   if the subcommand is `commit`, deny.
5. If the next token is `commit`, expand its args (`-am` → `-a -m`, `-mfoo` → `-m foo`,
   `--opt=v` → `--opt v`; its args end where git's arguments end, step 4) and
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
is `match` (the words must be equal) or one of these classes (a list of them when several
apply, as in `` Write-Output x`0 (git commit -m x) ``), where the tokenizer
deliberately differs from the shell and the check is skipped:

| Class | Shell | Where the tokenizer differs |
| --- | --- | --- |
| `redirection` | Bash | a redirection is a token with its target; the shell applies it and prints no word |
| `heredoc` | Bash | the heredoc body is dropped; the shell feeds it to the command |
| `expansion` | both | `$` variables, `$(…)`, `${ …; }`, backticks, brace expansion, globs and process substitution stay unexpanded in their word (process substitution as `(`), and a substitution body adds segments of its own after its segment (step 2); the shell expands them and has no words of its own for the body |
| `unterminated` | both | an unterminated quote or here-string is the rest of its line; the shell rejects the command |
| `subshell-parens` | both | `(` and `)` are tokens; the shell has no words for a subshell or a grouping expression |
| `ps-scriptblock` | PowerShell | `{` and `}` are tokens; the parser yields a script-block expression, not the commands in it |
| `ps-expression-statement` | PowerShell | assignment and keyword statements (`$m = …`, `if`, `foreach`) are words; the parser yields no command elements for them |
| `splat` | PowerShell | `@name` is a word; the parser yields a splatted variable |
| `ps-stop-parsing` | PowerShell | the rest of the line after a `--%` word (after escape removal, not inside quotes) is split into words on whitespace (step 2); the parser yields it as one verbatim element |
| `ps-array-comma` | PowerShell | a `,` stays in its word or is a word of its own; the parser yields one array-literal element for the words it joins |
| `escaped-newline-in-word` | PowerShell | a backtick plus newline inside a word is removed (step 2); PowerShell keeps the newline in the word |
| `ps-nul` | PowerShell | a NUL escape (`` `0 ``, a zero `` `u{…} ``) ends its token's value and a `cut` token follows it, ending git's arguments while the later tokens stay in the segment; the parser keeps the NUL and the rest in the word and has no `cut` there (the native command line is cut only when the command runs); Windows PowerShell 5.1 reads `` `u{…} `` as `u` and a script block |
| `carriage-return` | Bash | a carriage return is a character of its word; the Windows (Cygwin) bash strips it before a newline |
| `typographic-quotes-bash` | Bash | typographic quotes are quotes, as PowerShell reads them; bash keeps them as characters |
| `comment` | both | a comment is read as words (the documented false positives); the shell drops it |

**Deny messages:** `<route>` stands for `Spawn the commit:commit-worker agent (model:
sonnet; pass intent: <what you changed and why>). Edit no files until it replies.` It names
the model like every spawn instruction (Q24 as amended by the PRE-15 decision pass). It
never names `/commit`: the
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
literal-subcommand row; the literal-arguments row; unknown global option; `--amend` without `--no-edit`; `--squash` in
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
| subcommand that is not literal (step 4) | `Write the git subcommand literally. <route>` |
| any other token among git's arguments that is not literal (step 4) | `Write git's arguments literally. <route>` |
| `-C` / `--reuse-message`, `-c` / `--reedit-message` (after `commit`) | `git commit <flag> is not allowed here. <route>` (the generic row) |
| unknown global option | `Could not parse git options before 'commit'. <route>` |
| a substitution whose end is unsure, with `commit` in the rest of the command (step 2), when no segment is denied | `Could not tell where a command substitution ends (a group, function, comment or case in it). Keep such substitutions out of this command. <route>` |
