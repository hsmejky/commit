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
native Windows path is not refused; the `"` and `\` fixtures are POSIX only. An install
path holding a step 2 blanket-rule construct the entry point does not refuse does not get
the plain call the worker and every handback run blanket-denied: that call is in the
script-call exemption's form (step 2). The same path in any other command that mentions
`commit` (a chained `cd sub && node …`, a word outside the exemption's form), or a path
that also holds `!` or a control character, is blanket-denied (a documented false positive,
Q3). Fixtures: quoted and
unquoted, Bash and PowerShell, `& node …`, `node.exe` at an absolute path,
`cd sub && node …`, `echo "node commit.cjs plan"` (not a script call), and a quoted backslash
path in Bash (e.g. `node "C:\Program Files\...\commit.cjs" plan`, matching by basename on `\`).

**Output:** exit 0 always.

- Deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<message>"}}`
- Otherwise: no output. The guard never returns `allow`.
- Crash or unreadable input: no output (fail open), no heartbeat.
- Node older than 22: no output (fail open), no heartbeat; the guard entry point checks
  `process.versions.node` before it loads the shared library (Q1).
- Debug log: with `COMMIT_GUARD_DEBUG=1`, one JSON object on one stderr line, with keys
  `agent_id`, `decision`, `reason` and `command`, each key left out when unknown (so an
  early fail-open logs `{}` or `{"agent_id":"…"}` only). `command` is redacted like the
  heartbeat's (the script-call form, or the matched `git commit` segment's options; never
  message text or other segments), cut to 200 characters. A blanket deny (parsing step 2)
  logs the decision and the trigger kind instead of the command. A crash or unreadable input
  logs the same way (one line, with the fields known so far), still with no stdout and exit
  0. GRD-16 extends this with the same keys once deny decisions are logged; it defines no
  new ones.
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
  its git toplevel or the toplevel is inside the hook's `cwd`. A blanket-denied command
  (parsing step 2) has no segments, so it writes no heartbeat.

**Parsing:**

1. Early exit (no output) when the command's mention text does not contain `commit`,
   compared case-insensitively (so it does not miss a dashed `git-COMMIT`-style variant that
   step 3's own case-insensitive match would otherwise catch downstream). The mention text
   is the command with, in this order: every NUL and carriage return removed (Bash drops
   every NUL of its input; the Windows/Cygwin bash also drops every carriage return, C:guard
   class `carriage-return`); every escaped newline of either shell removed regardless of
   quotes (a `\` or a backtick, then a newline — its carriage return, if any, is already
   gone by the step above); every `$` directly before a quote character (`'`, `"`, U+2018–U+201E) removed;
   every `'`, `"`, `\`, backtick and Unicode quote character U+2018–U+201B (‘ ’ ‚ ‛) and
   U+201C–U+201E (“ ” „) removed. The removal is for this check only, so split quotes
   (`git co''mmit`, ``git com`mit``, `git co$'m'mit`, PowerShell `git co‘’mmit`) and a
   `commit` split by an escaped newline (`git com\` plus newline plus `mit`, PowerShell
   `` git com` `` plus newline plus `mit`) still reach parsing. Fixtures: each of these
   forms (deny) and a case variant (`git COMMIT`, deny).
   Known gap: text that never contains the literal substring `commit` passes here even when
   it builds the word at runtime, such as `git $(echo com)mit`, `git co${x}mmit`,
   `git co$'\x6d'mit`, PowerShell `git ('com'+'mit')` or a PowerShell 7 `` `u{…} `` escape
   (`` git co`u{6d}mit ``) (Q3, not fixed in 0.1.0; spec story 22). Also a known gap:
   variable indirection, where a single variable holds a whole command word-split at
   runtime (Bash `x='git commit'; $x`), and arithmetic-evaluation command execution, where a
   variable set by an earlier, separately-guarded command is later read in an arithmetic
   context (Bash `((`, `$(())`) that runs it — the guard classifies one command's text at a
   time and does not track variables across calls (Q3, fail-open, Out of Scope).
2. **Script-call exemption.** A command that is, in full, one script call of this form
   skips the blanket rule below and is tokenized: optional leading and trailing spaces
   (U+0020 only); in PowerShell an optional `&` and one space; `node` or `node.exe`; one
   space; a path in ASCII double quotes that ends in `/commit.cjs` or `\commit.cjs`, does not
   start with `-` (so `node "--eval=…//commit.cjs" plan` does not qualify: node would read
   the quoted argument as a flag, not the script path) and holds no `"`, U+201C–U+201E, `$`,
   backtick, `!` or control character (U+0000–U+001F, U+007F, so no CR or LF); one space and
   a subcommand (`plan`, `check`, `commit`,
   `release`, `infer`); then zero or more words, each one space and then one or more
   characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_`, `:`, `=` and `-` (the flags and
   `planId`s of [CLI](cli-and-exit-codes.md), and the form S2 `build` emits). Such a
   command runs one `node` call and nothing else in both shells: inside ASCII double quotes
   Bash treats only `$`, a backtick, `"`, `\` and (with history expansion) `!` specially,
   and PowerShell only `$`, a backtick and the double-quote characters `"` and
   U+201C–U+201E; with all of them but `\` excluded, a Bash `\` can escape only another `\`
   or stand for itself, and the path cannot end in `\` (it ends in `commit.cjs`), so the
   quoted path is one argument and the quote that ends it is the one before the
   subcommand. The words outside the quotes hold no character that ends the call or starts
   another (PowerShell may split a single-dash word at `.`/`:`, e.g. `-Dx.y=z` into `-Dx`
   and `.y=z`, or `-EncodedCommand:x` into `-EncodedCommand:` and `x`; nothing extra runs,
   and the [CLI](cli-and-exit-codes.md) flags start with `--`). Inside the quoted path `#`, `<<`, `@(`, `@'` and typographic single quotes
   U+2018–U+201B are plain characters in both shells, and the tokenizer reads them the same
   way (verified 2026-09-29 with bash 5.3, Windows PowerShell 5.1 and PowerShell 7). The
   exempt command is tokenized and classified like any other: script call, heartbeat and
   worker-only rule apply. A command with anything more is not exempt and gets the blanket
   rule: `node "/opt/a#b/commit.cjs" plan; git commit -m x`, the same call followed by a
   newline and `git commit -m x`, `node "/opt/x/commit.cjs" plan # note`.

   **Blanket rule (fail closed).** Before any tokenizing, a command that passed step 1 and
   is not exempt is denied with the blanket message (deny table) when its text, with (Bash)
   every NUL and carriage return dropped first, then that shell's escaped
   newlines removed regardless of quotes (Bash `\` then a newline; PowerShell backtick,
   optionally followed by a carriage return, then a newline), holds anywhere, inside quotes or not:
   - in both shells: `$(` (so also `$((`), `${`, or `#` (a comment; PowerShell `<# … #>`
     included);
   - in Bash: a backtick; a run of two or more `<` other than exactly three (a heredoc
     `<<` or `<<-`; `<<<` alone is a here-string redirection, `<<<<` counts); a typographic quote
     U+2018–U+201E;
   - in PowerShell: `@(`; an `@` directly followed by `'`, `"` or U+2018–U+201E (a
     here-string opener).

   The shell reads these by rules the tokenizer does not model: where a command
   substitution or a heredoc ends, quotes nested in `${…}`, where a comment starts (PowerShell
   also after an operator glued to it, `$a=1#"`), and Bash reading typographic quotes as
   plain characters; every review round found one more form where the two readings differed
   and a commit ran unclassified (Q3 as amended). A command without `commit` never gets here
   (step 1), so the rule costs nothing there. A blanket-denied command is never tokenized:
   it has no segments, no script call, no heartbeat and no worker-only rule; the debug log
   records the decision and the trigger kind, not the command text.

   A command with none of these, or an exempt one, is tokenized. For Bash, the command is
   first read as one or two readings: every NUL is dropped from it; when what remains still
   holds a carriage return, it is read twice — once with every CR also dropped (the
   Windows/Cygwin bash) and once with each CR kept as an ordinary word character (other bash
   builds, C:guard class `carriage-return`) — and the segments of both readings are
   concatenated (fail closed: a construct either reading runs as a denied `git commit` is
   caught); a command with no CR after NUL removal has one reading. Each reading then gets an
   escaped-newline pre-pass, outside single quotes and outside a Bash `$'…'` span (a `'`
   inside double quotes or escaped, Bash `\'`, PowerShell `` `' ``, opens nothing, and inside
   a `$'…'` span a `\` plus newline stays, like in single quotes; `$"…"` is read like double
   quotes): every `\` (Bash) or backtick (PowerShell) immediately followed by a newline is
   removed; `\\` immediately followed by a newline keeps that newline, since the pair `\\`
   already escapes a backslash and does not extend to the character after it; a `\` (or
   backtick) immediately followed by a carriage return then a newline counts as the same
   escaped newline on the reading where the CR survived; a trailing unquoted `\` (or
   backtick) at the very end of the command, with nothing after it, is dropped rather than
   read as a literal character (C:guard oracle class `unterminated`). Tokenise with the
   quoting rules of `tool_name`, then split into segments on `&&`, `||`, `;`, `|`, `&` and
   newlines outside quotes. A word matching `{name}` or `{name[subscript]}` (bash 4.1+'s
   named file-descriptor form) immediately followed by `<` or `>` is read as that
   redirection's descriptor prefix, like leading digits, so the redirection and its target
   are dropped together and never read as commit arguments. Redirection operators (`>`, `>>`, `<`, `2>&1`, `>&` and the like)
   outside quotes become tokens of their own, dropped together with their target, so they
   are never read as commit arguments or options; the `&` inside `2>&1` or `>&` is not a
   separator. An unquoted `(` or `)` becomes a token of its own the same way (not dropped):
   step 3 then finds the `git` token of `(git commit -m x)`, a `(` among git's arguments is
   denied (step 4), and a `)` token ends git's arguments (steps 4 and 5), so
   `(git commit --no-edit)` stays allowed. Bash process substitution `<(` or `>(` outside
   quotes becomes a `(` token (not a redirection, so the next word is not its target):
   `diff <(git commit -m x) f` gives `diff`, `(`, `git`, `commit`, `-m`, `x`, `)`, `f` and
   is denied. In PowerShell an unquoted `{` or `}` becomes a token of its own the same way
   (not dropped), so a script block glued to its first word (`&{git commit -m x}`,
   `if ($true) {git commit -m x}`) is denied and a `}` token ends git's arguments like `)`.
   In Bash `{` and `}` stay in their word (brace expansion, step 4). In Bash an unquoted `(`
   directly after an unquoted `@`, `!`, `+`, `*` or `?` (an extglob opener) ends that word
   with the `(` kept in it, and is also a `(` token of its own: with `extglob` on (which an
   earlier line can set,
   like `expand_aliases`) bash reads an extglob pattern that may match a file named
   `commit`, so the word holds `(` and is not literal (step 4; `git @(commit) -m x` gives
   `git`, `@(`, `(`, `commit`, `)`, `-m`, `x` and is denied with the literal-subcommand
   message); with `extglob` off bash rejects the pattern, except a `!(` that starts a
   command, which is `!` plus a subshell (`!(git commit -m x)` runs the commit), and the
   `(` token keeps step 3 finding that `git`. In PowerShell a `!` or `+` before `(` is a
   word of its own (`!(1)` passes `!` and `1`). In PowerShell a word
   equal to `--%` after escape removal, not inside quotes (`--%`, `` `--% ``, `` -`-% ``),
   stops parsing: the rest of its line, up to the next `|`, `&&` or `||`, is split into
   words on whitespace only, so quotes, backticks, `$`, brackets, `;`, `&` and redirection
   operators are characters of their word; the newline still ends the segment. So
   `git --% -c x.y=; commit -m x` is one segment (`git`, `--%`, `-c`, `x.y=;`, `commit`,
   `-m`, `x`; PowerShell runs `git -c x.y=; commit -m x`). A quoted `'--%'` does not stop
   parsing (step 4 denies it among git's arguments):

   | Rule | `Bash` | `PowerShell` |
   | --- | --- | --- |
   | escape character | `\` (outside `'…'`) | `` ` `` (outside `'…'`); `` `u{…} `` with one to six hex digits is the character of that code point, as in PowerShell 7; `` `0 `` and a `` `u{…} `` whose value is 0 (`` `u{0} ``, `` `u{00} ``, `` `u{000000} ``) are a NUL that ends the token's value there, as the native command line is cut at it; the tokenizer emits a `cut` token (`{"op":"cut"}`) after the cut token, which ends git's arguments (step 4): steps 4 and 5 read no token past it, but the tokens after it stay in the segment for step 3, since the shell cuts only that one native command's line and a nested command still runs (`` git commit`0x -m x ``, `` git commit`0 --no-edit `` and `` git commit`u{00} --no-edit `` are a bare `git commit`; `` Write-Output x`0 (git commit -m x) `` and `` if ("x`0") {git commit -m x} `` are denied; verified 2026-09-29 with PowerShell 5.1 and 7; Windows PowerShell 5.1 has no `` `u{…} `` escape: it reads `` `u `` as `u` and the braces as a script block, passed to git as `-encodedCommand …` arguments git rejects) |
   | single quotes | literal, no escapes | literal; `''` is one `'` |
   | double quotes | `\"`, `\\`, `\$` escaped; `$"…"` outside double quotes (locale translation) is `"…"` with the `$` removed, while inside double quotes a `$` before the closing `"` is a plain `$` (`git $"commit" -m x` is `git commit -m x`) | `` `" `` and `""` escaped; the double-quote class is `"` and U+201C–U+201E, and inside a string opened by any of them two characters of the class in a row are one escaped quote, the second of the two, while any one character of the class closes it (`"a“"b"` is `a"b`; `“k"l` is `k` and `l`); the same for the single-quote class `'` and U+2018–U+201B inside a single-quoted string (`'e’'f'` is `e'f`); verified 2026-09-29 with PowerShell 5.1 and 7 |
   | ANSI-C quotes | `$'…'` outside double quotes, opened by a `$` that is not the second `$` of an unescaped `$$` pair (`$$` is Bash's PID variable, so `echo $$'a'` reads as `$$` followed by the plain string `a`, opening no quote): the `$` is removed and the span's end is found lexically, before any escape is decoded — from the opening `'`, every `\` pairs with whatever character comes right after it (so in `$'\c\''` the first `\'` does not close the span: its `\` pairs with the `'`, and the span goes on to the next `'`); the span's content is then decoded separately, on its own, as Bash does (`\\`, `\'`, `\"`, `\?`, `\a`, `\b`, `\e`, `\E`, `\f`, `\n`, `\r`, `\t`, `\v`, `\nnn`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\cx`); an unknown escape keeps its `\` (`echo $'\''` is `echo` and `'`; `git $'commit'` is `git commit`); a decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends the `$'…'` span's value there, as in Bash (`git $'commit\0x'` is `git commit`, `$'ab\0cd'ef` is `abef`) | — |
   | here-strings | — | — (blanket rule; `@'` and `@"` reach the tokenizer only inside an exempt script call's quoted path, as plain characters) |
   | heredocs | `<<` and `<<-` reach the tokenizer only inside an exempt script call's quoted path, as plain characters (blanket rule); `<<<` stays a plain redirection | — |
   | unterminated quote | the rest of that line is one quoted token; scanning continues on the next line | same |
   | typographic quotes | plain characters; they reach the tokenizer only inside an exempt script call's quoted path (blanket rule) | “…”, ‘…’, „…“, ‚…‛ treated like `"…"` and `'…'` respectively (literal, no escapes inside): U+201C/U+201D/U+201E as double quotes, U+2018/U+2019/U+201A/U+201B as single quotes (verified 2026-09-27 against the PowerShell 7 parser) |

   Fixtures for both, among them `git commit -m "a\"b"` (Bash), ``git commit -m "a`"b"``
   (PowerShell), `git commit -m "unterminated` in both shells (deny), `git commit -m x 2>&1`
   and `git commit -m x > log.txt` (deny, one segment, the redirection not read as an
   argument), `git \` plus newline plus `commit -m x` and `git com\` plus newline plus
   `mit -m x` in Bash and their backtick forms in PowerShell (deny), `(git commit -m x)` in
   both shells (deny), `(git commit --no-edit)` (no output); Bash `echo $'\'' ; git commit -m x`,
   `git co$'m'mit -m x` and `diff <(git commit -m x) f` (deny); PowerShell
   `&{git commit -m x}`, `. {git commit -m x}` and `if ($true) {git commit -m x}` (deny),
   and `&{git commit --no-edit}` (no output); stop-parsing: `git --% -c x.y=; commit -m x`
   (deny) and `Write-Output --% (git commit -m x)` (no output: PowerShell passes the
   brackets as text). Extglob (oracle class `extglob`): Bash `git @(commit) -m x`,
   `git !(x) commit -m x`, `git +(commit) -m x`, `git *(commit) -m x`,
   `git ?(commit) -m x` and `!(git commit -m x)` (deny), `!(git commit --no-edit)` (no
   output). Quote readings: Bash `git $"commit" -m x`, `git commit -m $'a\` plus newline
   plus `b'` (the `\` and newline kept), `git commit -m "it's\` plus newline plus `fine"`
   and `git commit -m \'a\` plus newline plus `b` (the escaped newline removed) (deny);
   PowerShell `git commit -m "a“"b"` and `git commit -m 'e’'f'` (deny) and
   `git status "x“"; git commit -m x"` (no output: one string argument). Script-call
   exemption (tokenized, no output): Bash `node "/opt/a#b/commit.cjs" plan`,
   `node "/home/u/‘q’/commit.cjs" plan` and `node "/opt/x@(y)/commit.cjs" plan` (the `@(`
   stays a plain character in the quoted path; it is not an unquoted extglob opener), PowerShell
   `& node "C:/a#b/commit.cjs" check --plan <planId>` and
   `node "C:/x@(y)/commit.cjs" plan`; not exempt (blanket, deny): Bash
   `node "/opt/a#b/commit.cjs" plan; git commit -m x`, the same call plus a newline and
   `git commit -m x`, `node "/opt/x/commit.cjs" plan # note` and
   `node "/opt/a!b#/commit.cjs" plan`, PowerShell
   `& node "C:/a#b/commit.cjs" plan; git commit -m x` and
   `node "C:/$(x)/commit.cjs" plan`; not exempt (leading `-`, holds no other blanket
   trigger, so it is simply tokenized and still recognized as a script call by basename, no
   output — the interpreter gap, Out of Scope): Bash `node "-x/commit.cjs" plan`. Blanket rule (each with no segments, oracle `blanket`): every form
   listed in Q3's round-8 amendment, among them Bash `echo ‘ ; git commit -m x ; ‘`,
   `: # "` plus the lines `git commit -m x` and `: # "`,
   `git${IFS}commit${IFS}-m${IFS}x`, `echo $(git commit -m x)`, `` echo `git commit -m x` ``,
   `echo "${ git commit -m x; }"`, `cat <<EOF` with the body line `git commit -m x` and
   `echo "$(git com\` plus newline plus `mit -m x)"`, and PowerShell
   `Write-Output "$(git commit -m x)"`, `<# " #>` plus the lines `git commit -m x` and
   `<# " #>`, and `${"} = 1; git commit -m x; ${"}` (deny); the false positives below (deny);
   and `echo "$(date)" && git status` (no output: no `commit`, step 1).
   Documented false positives (fail closed): every command that mentions `commit` anywhere
   (even in quotes, `commit.cjs` included) and holds a blanket-rule construct, such as
   `git log --format=$(…) | grep commit`, `echo "$(date)" && git commit --no-edit`,
   `echo "${x}" && git commit --no-edit`, `echo "$((n+1))" && git commit --no-edit`,
   `gh pr create --body "$(cat <<'EOF'` … `commit` … `EOF` `)"` (use `--body-file`),
   `git commit --no-edit # done`, `git log --grep "#12" | grep commit`, PowerShell
   `${env:X}; git commit --no-edit`, `Write-Output $( <# ) #> 1 ) ; git commit --no-edit`
   and a `@'…'@` here-string holding `commit` (deny); a script call whose install path
   holds a blanket-rule construct, outside the exemption's form (chained, a word outside
   `[A-Za-z0-9._:=-]`, or a path also holding `!` or a control character,
   `node "/opt/a!b#/commit.cjs" plan`,
   deny); and a `git` word after another command's `--%` (`Write-Output --% git commit -m x`,
   deny).
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
   Known gap: expansion or aliasing in the command position, where no token is `git` until
   the shell expands it, passes with no output (Q3): Bash brace expansion
   `{git,commit,-m,x}`, a glob such as `/usr/bin/gi? commit -m x` or an extglob
   `@(git) commit -m x` (with `extglob` on; its `git` token is followed by the `)` that ends
   its arguments), a variable there (Bash
   `$GIT commit -m x`, PowerShell `& $g commit -m x`), a PowerShell expression there,
   `& ('git') commit -m x` (its `git` token is followed by the `)` that ends its arguments,
   step 4), and a shell alias or function for git (Bash `shopt -s expand_aliases` and
   `alias c=git` on an earlier line, then `c commit -m x`; PowerShell
   `Set-Alias g git; g commit -m x`). A substitution there (`$(echo git) commit`) is denied
   by the blanket rule (step 2).
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
   - is a `(` token or, in PowerShell, a `{` token: a grouping expression or a script block
     is an argument of the native command, which may turn into several
     (`git -C (Get-Location) commit -m x` runs `git -C <dir> commit -m x`,
     `git commit --fixup ("HEAD","--no-verify")` runs `git commit --fixup HEAD --no-verify`,
     a script block becomes `-encodedCommand …`);
   - holds `$` or a backtick: a variable, which Bash word splitting or a PowerShell array
     value may split into several arguments (`c=commit; git $c -m x`,
     `git commit --fixup $s`, PowerShell `$s='HEAD','--no-verify'; git commit --fixup $s`
     runs `--fixup HEAD --no-verify`); a substitution (`` git `echo commit` -m x ``,
     PowerShell `git commit --fixup $('HEAD','--no-verify')` or `@("HEAD",…)`) never gets
     here: the blanket rule (step 2) denies it first;
   - holds `{`, `(` or a glob character (`*`, `?`, `[`): brace expansion, an expression or
     a glob may give another word or several (`git -C {.,commit} status` runs
     `git -C . commit status`, `git {commit,-m,x}`, PowerShell 7 expands globs in native
     arguments on Linux and macOS);
   - in PowerShell, holds `,` or `@`, or is `--%`: a comma makes an array literal, which
     Windows PowerShell 5.1 passes as separate arguments (`git -C . ,commit -m x`,
     `git -C . , commit -m x` and `git commit, -m x` run a commit there; PowerShell 7 passes
     the comma on); a leading `@` is a splat (`git @a`, `git commit --fixup @s`); `--%`
     stops parsing (step 2) and expands `%NAME%` in the rest of the line (`$env:X='commit'; git --% %X% -m x`), and a quoted `'--%'` is dropped from
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
   above in its shell (deny), among them Bash `c=commit; git "$c" -m x` and
   `git -C $dir commit -m x` (Bash `` git "`echo commit`" -m x `` is denied by the blanket
   rule first), the two quoted false positives (deny), and `git $c -m x`
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
| `expansion` | both | `$` variables, brace expansion, globs and process substitution stay unexpanded in their word (process substitution as `(`); the shell expands them |
| `unterminated` | both | an unterminated quote is the rest of its line; a trailing unquoted `\` (or PowerShell backtick) at the command's end is dropped; the shell rejects the command |
| `blanket` | both | the command holds a step 2 blanket-rule construct, so the guard never tokenizes it (denied with `commit`, early exit without); it has no segments |
| `subshell-parens` | both | `(` and `)` are tokens; the shell has no words for a subshell or a grouping expression |
| `ps-scriptblock` | PowerShell | `{` and `}` are tokens; the parser yields a script-block expression, not the commands in it |
| `ps-expression-statement` | PowerShell | assignment and keyword statements (`$m = …`, `if`, `foreach`) are words; the parser yields no command elements for them |
| `splat` | PowerShell | `@name` is a word; the parser yields a splatted variable |
| `ps-stop-parsing` | PowerShell | the rest of the line after a `--%` word (after escape removal, not inside quotes) is split into words on whitespace (step 2); the parser yields it as one verbatim element |
| `ps-array-comma` | PowerShell | a `,` stays in its word or is a word of its own; the parser yields one array-literal element for the words it joins |
| `extglob` | Bash | a `(` directly after `@`, `!`, `+`, `*` or `?` ends that word with the `(` kept and is also a `(` token; bash (`extglob` off) rejects the pattern as a syntax error, or runs `!(…)` at a command's start as a negated subshell |
| `escaped-newline-in-word` | PowerShell | a backtick plus newline inside a word is removed (step 2); PowerShell keeps the newline in the word |
| `ps-nul` | PowerShell | a NUL escape (`` `0 ``, a zero `` `u{…} ``) ends its token's value and a `cut` token follows it, ending git's arguments while the later tokens stay in the segment; the parser keeps the NUL and the rest in the word and has no `cut` there (the native command line is cut only when the command runs); Windows PowerShell 5.1 reads `` `u{…} `` as `u` and a script block |
| `carriage-return` | Bash | a carriage return is a character of its word in one reading; the Windows (Cygwin) bash drops every carriage return in the other, not only ones before a newline |

**Deny messages:** `<route>` stands for `Spawn the commit:commit-worker agent (model:
sonnet; pass intent: <what you changed and why>). Edit no files until it replies.` It names
the model like every spawn instruction (Q24 as amended by the PRE-15 decision pass). It
never names `/commit`: the
reason goes to the model, which cannot invoke `/commit` (`disable-model-invocation`, Q2), and
a `Skill("commit")` call could resolve to a personal commit skill (Q8). Every message
that contains `<route>` ends with a `\n` and then the fixed line `If a personal commit skill
sent you here, remove it (see the commit plugin README).` (Q8; nothing is detected).

Worker-only rule: when `agent_type` is `commit:commit-worker` and any segment is a script
call with subcommand `commit` or `release`, deny with `The handback is for your caller:
return the reply verbatim and stop.` (Q25). Everything else the worker runs is left to the
normal rules. A blanket-denied command (parsing step 2) has no segments, so this rule does
not apply to it; it gets the blanket message.

**Precedence:** when a `commit` segment's expanded arguments match more than one row below,
the most specific wins, in this order: `-c` / `--config-env` before `commit`; the
literal-subcommand row; the literal-arguments row; unknown global option; `--amend` without `--no-edit`; `--squash` in
any form; `-n` / `--no-verify` / `--no-gpg-sign`; `--fixup=amend:` / `--fixup=reword:`; the
generic "any other flag or argument" row (also covers `-C` / `-c` after `commit`); the
bare/`-m`/`-F`/`--message`/`--file` row, only when no other row matches. A tie within one row
goes to the first matching token in argv order. So `-am x` denies on `-a` (the generic row:
`git commit -a is not allowed here. <route>`), `--amend -m x` denies on `--amend`, `-n -m x`
on `-n`, and `--squash -m x` on `--squash`. A blanket-denied command (step 2) is never
tokenized, so it gets the blanket row and no other.

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
| a blanket-rule construct in a command that mentions `commit` (step 2) | `This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: <route>` |
