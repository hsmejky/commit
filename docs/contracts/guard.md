# Guard

**Input:** the `PreToolUse` hook JSON on stdin. Decision inputs: `tool_name` (`Bash`,
`PowerShell`), `tool_input.command`, `cwd`, and `agent_type` (the worker-only rule below).
`agent_id` is for the debug log only.

**Script call:** a segment (parsing step 2) whose first command token, after any leading
prefixes, has the basename `node` or `node.exe`, whose next token has the basename
`commit.cjs`, both compared case-insensitively, and whose token after that is the
subcommand (`plan`, `check`, `commit`, `release`, `infer`), compared exactly. The leading
prefixes skipped are those that cannot change what node runs: the group openers `(` and
`{`, Bash `!` and `time` (with `-p`), and the PowerShell call operators `&` and `.` (so
`( node … )`, `& { node … }` and `time -p node …` are script calls). An assignment or a
runner (`X=1`, `NODE_OPTIONS=…`, `env`, `command`, `exec`) is never skipped. This is the
wide recogniser (S2 `recognise`): the guard uses it for the heartbeat only, where
matching more is fail-closed (more denies, a heartbeat from a guard
that really ran), and it never feeds an allow. The narrow form is S2 `build`'s output, the
step 2 script-call exemption's form (case-sensitive `node`, nothing before it but a
PowerShell `&`): the exemption and the caller's `run` shape check (Q25) accept only that.
The worker-only rule scans wider still (S2 `named`): any
token in any segment with the basename `commit.cjs`, compared case-insensitively, directly
followed by `commit` or `release`, compared exactly, whatever word starts the command (an
assignment, a runner such as `env`, `exec` or `nohup`, a Bash `if`/`for`/`case`/function
body or `coproc`, a PowerShell `$r =` or `if`/`foreach`/`try` block, `node --`, `cmd /c`).
Documented gaps of that scan, so the worker-only rule is defence in depth and not the
deterministic boundary: a call inside a quoted nested shell or evaluated string (`bash -c
'node …'`, `sh -c "…"`, `eval '…'`, `iex '…'`, `cmd /c "node …"`), a path or subcommand
from a variable or expansion (`node $P commit`), a copy or link of `commit.cjs` under
another name, and the interpreter gap (Out of Scope). Matching more is fail-closed: any
worker command with a word naming `commit.cjs` followed by `commit` or `release` is denied,
even one that does not run it (`echo x/commit.cjs commit`). Basename: the part of a token after the last `/` or `\`, in both shells
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
Q3); S2 `build` throws on a path holding any character the exemption keeps out of the
quoted path, so it never emits such a call. Fixtures: quoted and
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
   it builds the word at runtime, such as `git $(echo com)mit`, `git co${x}mmit`, Bash brace
   expansion (`git {com,-}mit`, expands to `git commit -mit` and commits), a glob
   matching a file named `commit` in the working directory (`git [c]ommit -m x`,
   `git c?mmit -m x`; in PowerShell this glob expansion happens only in pwsh 7 on
   Linux/macOS),
   `git co$'\x6d'mit`, PowerShell `git ('com'+'mit')` or a PowerShell 7 `` `u{…} `` escape
   (`` git co`u{6d}mit ``), or an argv[0] value built the same way
   (`exec -agit-c{,o}mmit git -m x`, step 3) (Q3, not fixed in 0.1.0; spec story 22). Also a known gap:
   variable indirection, where a single variable holds a whole command word-split at
   runtime (Bash `x='git commit'; $x`), and arithmetic-evaluation command execution, where a
   variable set by an earlier, separately-guarded command is later read in an arithmetic
   context (Bash `((`, `$(())`) that runs it — the guard classifies one command's text at a
   time and does not track variables across calls (Q3, fail-open, Out of Scope).
2. **Size cap (fail closed).** A command that passed step 1 and is longer than 262,144
   characters (256 Ki UTF-16 code units, about 256 KiB of ASCII) is a blanket deny of kind
   `size`, with its own row (deny table), exempt form or not: it is checked first and never
   tokenized. The cap bounds the time and memory the readings and the pattern body walk
   below can take; running the heap out crashes the guard, which fails open (review GRD-04
   round 10: a carriage return, then 16 nested patterns around a 2.8 MB body, did). Real
   commands stay far below it; a longer one that mentions `commit` is an accepted false
   deny (write the long text to a file first).

   **Script-call exemption.** A command that is, in full, one script call of this form
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
   is not exempt is denied with the blanket message (deny table) when its text, with that
   shell's escaped newlines removed regardless of quotes (Bash `\` then a newline;
   PowerShell backtick, optionally followed by a carriage return, then a newline), holds
   anywhere, inside quotes or not, one of the constructs below. For Bash the rule is checked
   on each of the two readings described below, and a trigger in either denies: the text
   with every NUL and carriage return dropped, then its escaped newlines removed; and, when
   the command holds a carriage return, the text with only every NUL dropped, then its
   escaped newlines removed. On that second reading a `\` before a carriage return escapes
   the carriage return and is no line continuation, so `<<`, `\`, CR, LF, `<` is a heredoc
   there (delimiter CR) while the first reading sees the here-string `<<<`. The constructs:
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
   already escapes a backslash and does not extend to the character after it; a PowerShell
   backtick immediately followed by a carriage return then a newline counts as the same
   escaped newline, while a Bash `\` immediately followed by a carriage return is, on the
   reading where the CR survived, an escaped carriage return (a word character) and the
   newline after it still ends the line, as in Linux and macOS bash; a trailing unquoted `\` (or
   backtick) at the very end of the command, with nothing after it, is dropped rather than
   read as a literal character (C:guard oracle class `unterminated`). Tokenise with the
   quoting rules of `tool_name`, then split into segments on `&&`, `||`, `;`, `|`, `&` and
   newlines outside quotes. A PowerShell call operator `&` at a command's start is a word
   (step 3's prefix token `'&'`), not a separator there (GRD-06); a lone `&` after a word
   is a separator. A raw NUL character in an unquoted PowerShell word or string reads like
   the `` `0 `` escape (step 2 table): it ends the token's value and a `cut` token follows,
   since PowerShell 5.1 and 7 cut the native command line there (`git commit` plus a NUL plus
   `x -m x` passes git only `commit`). A word matching `{name}` or `{name[subscript]}` (bash 4.1+'s
   named file-descriptor form) immediately followed by `<` or `>` is read as that
   redirection's descriptor prefix, like leading digits, so the redirection and its target
   are dropped together and never read as commit arguments. Redirection operators (`>`, `>>`, `<`, `2>&1`, `>&` and the like)
   outside quotes become tokens of their own, dropped together with their target, so they
   are never read as commit arguments or options; the `&` inside `2>&1` or `>&` is not a
   separator. In PowerShell a redirection operator starts only at a token's start: inside a
   word it is a character of that word (`a2>b` is one word, as PowerShell passes it). An
   unquoted `(` or `)` becomes a token of its own the same way (not dropped):
   step 3 then finds the `git` token of `(git commit -m x)`, a `(` among git's arguments is
   denied (step 4), and a `)` token ends git's arguments (steps 4 and 5), so
   `(git commit --no-edit)` stays allowed. Bash process substitution `<(` or `>(` outside
   quotes becomes a `(` token (not a redirection, so the next word is not its target):
   `diff <(git commit -m x) f` gives `diff`, `(`, `git`, `commit`, `-m`, `x`, `)`, `f` and
   is denied. In PowerShell an unquoted `{` or `}` becomes a token of its own the same way
   (not dropped), so a script block glued to its first word (`&{git commit -m x}`,
   `if ($true) {git commit -m x}`) is denied and a `}` token ends git's arguments like `)`.
   In Bash `{` and `}` stay in their word (brace expansion, step 4). In Bash an unquoted `(`
   directly after an unquoted `@`, `!`, `+`, `*` or `?` (an extglob opener), in a command's
   first word (the segment's start, right after a `(`/`)` token, after a reserved word
   that may start a command: `!`, `{`, `if`, `then`, `elif`, `else`, `while`, `until`,
   `do`, `time`, `time -p`, a `--` after `time` or `time -p`, `function` (its name is
   read as a first word, so `function !(git commit -m x); \!` denies) and `coproc`; after
   `function NAME`, `coproc` and `coproc NAME` bash still takes a reserved word, and any of
   those words keeps first position there: `function f if !(git commit -m x); then :; fi`
   and `coproc C while !(…)` deny; `then`, `do`, `else` and `elif` keep first position
   after any word, an argument included, since bash takes them after `]]`, `}`, `fi`,
   `done`, `esac` and (`do`) `for NAME` or `select NAME`: `if [[ x ]] then !(git commit -m
   x); fi` and `for x do !(…); done` deny; an assignment does not keep first position, nor
   any other reserved word after an argument), ends that word
   with the `(` kept in it, and is also a `(` token of its own: with `extglob` on (which an
   earlier line can set, like `expand_aliases`) bash reads an extglob pattern that may match
   a file named `commit`; with `extglob` off bash rejects the pattern, except a `!(` that
   starts a command, which is `!` plus a subshell (`!(git commit -m x)` runs the commit),
   and the `(` token keeps step 3 finding that `git`. Elsewhere — an argument or a
   redirection target — the same opener reads the pattern through its matching unquoted `)`
   as one word (nested `(` counted, quotes and `\` respected: `echo @(a\)|b) x` is `echo`,
   `@(a)|b)`, `x`), its spaces, `|`, `;`, `&` and newlines included, with no `(` token and
   no segment split inside it: bash reads it so with `extglob` on, and inside `[[ … ]]` even
   with it off, so the word holds `(` and is not literal (step 4; `git @(commit) -m x` gives
   `git`, `@(commit)`, `-m`, `x`, no `git` `commit` pair, so no output until GRD-12's
   literal-subcommand row denies it); elsewhere, with `extglob` off, the pattern is a syntax
   error and the whole command never runs. An unquoted `<(` or `>(` inside such a pattern
   is a process substitution bash runs: G2 returns the blanket kind
   `substitution` instead of segments (fail closed, the blanket deny), so
   `[[ x == @(a|>(git commit -m x)) ]]`,
   `echo @(<(git commit -m x))`, `case x in @(a|>(git commit -m x))) ;; esac` and
   `cat >@(>(git commit -m x))` are denied; a quoted or escaped `<(` inside a pattern is a
   plain character. Such a pattern whose unquoted brackets nest more than 16 deep (an
   unquoted `(` that opens level 17, plain brackets counted, quoted or escaped ones not) is
   the blanket kind `nesting` (fail closed, a blanket deny with its own row): it bounds the
   body walk below, which reads a body once for each pattern around it, to at most 17
   readings of any character and 16 nested levels, so deep input cannot overflow the stack,
   which fails open (review GRD-04 round 9; real patterns nest a few levels). It does not
   bound memory: each reading builds its own copy of the body, so a long enough body at
   full depth runs the heap out; the size cap above keeps the input below that, and the
   walk's time well under the hook's timeout (review GRD-04 round 10). An opener with no
   matching `)` (or an unterminated quote inside the pattern) ends the word right after the
   `(`, with no `(` token following it, and the rest of the command is tokenized normally
   from there: an unbalanced extglob such as `xargs echo @(a | git commit --no-edit` gives no guard output,
   because bash itself rejects the whole command as a syntax error (`extglob` on) and git
   never runs — the reading differs from bash only where nothing executes either way.
   Defense in depth, whatever position the tokenizer gave the word: the body of each
   balanced pattern read as one word in an argument or a redirection target (between its
   opener's `(` and its matching `)`) is also tokenized as a command text of its own,
   nested patterns included, and its segments follow the segment holding the word, so
   step 3 classifies any `git` the body would run as a command, as at a command's first
   position: `echo a !(git commit -m x)` and `ls @(a|!(git commit -n))` deny, while
   `ls @(git commit --no-edit)`, a quoted or escaped body (`echo @('git commit -m x')`,
   `echo @(git\ commit -m x)`) and a plain glob (`ls !(*.txt)`, `rm @(git|svn)`) give no
   output. A body that reads as a denied form denies even where bash only matches it as a
   pattern (`[[ $m == @(git commit -m x) ]]`, `case $m in @(git commit -a)) ;; esac`,
   `A=1 !(git commit -m x)`): an accepted false deny. A body that is an allowed form as a
   command can still commit through a runner that re-splits the word:
   `xargs env -S A=@( git commit --fixup=HEAD'\c')` gives no output, the `env -S`
   interpreter gap (step 3, known gap; Q3; Out of Scope). In PowerShell a `!` or `+`
   before `(` is a word of its own (`!(1)` passes `!` and `1`). In PowerShell a word
   equal to `--%` after escape removal, not inside quotes (`--%`, `` `--% ``, `` -`-% ``),
   stops parsing: the rest of its line, up to the next `|`, `&&` or `||`, is split into
   words on whitespace only, so quotes, backticks, `$`, brackets, `;`, `&` and redirection
   operators are characters of their word; the newline still ends the segment. So
   `git --% -c x.y=; commit -m x` is one segment (`git`, `--%`, `-c`, `x.y=;`, `commit`,
   `-m`, `x`; PowerShell runs `git -c x.y=; commit -m x`). A quoted `'--%'` does not stop
   parsing (step 4 denies it among git's arguments):

   | Rule | `Bash` | `PowerShell` |
   | --- | --- | --- |
   | escape character | `\` (outside `'…'`) | `` ` `` (outside `'…'`); `` `0 `` is a NUL that ends the token's value there, as the native command line is cut at it; the tokenizer emits a `cut` token (`{"op":"cut"}`) after the cut token, which ends git's arguments (step 4): steps 4 and 5 read no token past it, but the tokens after it stay in the segment for step 3, since the shell cuts only that one native command's line and a nested command still runs (`` git commit`0x -m x `` and `` git commit`0 --no-edit `` are a bare `git commit`; `` Write-Output x`0 (git commit -m x) `` and `` if ("x`0") {git commit -m x} `` are denied; verified 2026-09-29 with PowerShell 5.1 and 7). `` `e `` and `` `u{ `` (case-sensitive; `` `E `` and `` `U{41} `` are `E` and `U{41}`) are the blanket kind `escape`, found while tokenizing (a redirection target's word included), with a deny row of its own: PowerShell 7 reads `` `e `` as ESC and `` `u{…} `` as a code point (a zero one cuts the native command line like `` `0 ``), while Windows PowerShell 5.1 reads `` `e `` as `e` and `` `u{0} `` as the text `u{0}` in a string or as `u` and a script block in a bareword (`` git commit --fixup ":/`u{0}" --no-verify `` passes `--no-verify` to git in 5.1; verified 2026-10-03), so G2 picks no reading (fail closed) |
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
   `node "/home/app/‘q’/commit.cjs" plan` and `node "/opt/x@(y)/commit.cjs" plan` (the `@(`
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
   case-insensitively (`Git.exe`), optionally after the `&` call operator, once the path is
   normalised Win32-style in both shells: a leading drive `C:` (any letter) dropped, then
   split on `/` and `\`, each component's trailing
   spaces and dots dropped, empty and `.` components dropped, a `..` dropping the component
   before it; the basename is the last component left. Windows normalises a program's path
   that way, so PowerShell `& 'git ' commit -m x`, `& "C:\…\git.exe." commit -m x`,
   `& 'C:\…\git.exe\.' commit -m x`, `& 'C:\…\git.exe\x\..' commit -m x` and the
   drive-relative `C:git.exe commit -m x` (`& 'C:git.exe' …`, the cwd on drive C holding
   git.exe) run git
   (verified 2026-10-03 with PowerShell 5.1 and 7), and so do Git Bash
   `/mingw64/bin/git/. commit` and `/mingw64/bin/git.exe/ commit`; where a shell does not
   (Linux bash), the same reading is an accepted false deny (`'git ' commit -m x`,
   `/usr/bin/git/. commit -m x`). Every such token
   in the segment is classified by steps 4 and 5, and the segment is denied when any of them
   is: a git command can run inside another command's argument (PowerShell
   `git status (git commit -m x)`, `` git commit --no-edit`0 (git commit -m x) ``). A token whose
   basename (any directory, an optional `.exe`, compared case-insensitively, the path
   normalised as above) is
   `git-commit` — git's own dashed form, runnable straight off `PATH` — classifies the
   segment as a `commit` straight away, skipping steps 4 and 5's global-option and
   subcommand scan: the tokens after it are `commit`'s own args, expanded and checked
   against the allowlist as in step 5. Such a token is a commit wherever it stands in its
   command, not only in the command word: the command before it may run it (`xargs`,
   `man -P`, `rg --pre`, `git bisect run`), and telling those apart would take a list of
   commands known not to run their arguments. Accepted false denies (fail closed): a
   `git-commit` word as a plain argument, e.g. Bash `grep -rn git-commit docs/` (the generic
   row naming `docs/`), `man git-commit`, `ls /usr/lib/git-core/git-commit`,
   `git help git-commit` (the wrapper row naming `man`, `ls`, `git`) and PowerShell
   `Select-String -Path docs\*.md -Pattern git-commit` (naming `Select-String`). Workaround:
   a pattern no token reads as `git-commit` (`grep -rn 'git-[c]ommit' docs/`) or
   `git help commit`.
   git runs `git-<x>` read from argv[0]'s basename as `<x>`, and Bash `exec -a NAME` or
   coreutils `env -a NAME` / `--argv0=NAME` sets argv[0], so Linux bash commits on
   `(exec -agit-commit git --allow-empty -m e)` though no token reads `commit` after `git`
   (Git Bash does not pass argv[0] to the native git.exe). So a `git` token whose command
   holds, before it, an `exec`, `env` or `genv` (Homebrew coreutils) word (by basename)
   followed by an argv[0] option, a token starting `-` whose option cluster holds `a` (`-a`,
   `-aNAME`, `-caNAME`, `-la`) or `S` (`env -S` splits its value into options, an argv[0]
   one among them: `env -S-agit-commit git -m x`), or starting `--a` (`--argv0`) or `--s`
   (`--split-string`), any abbreviation, denies with the wrapper row naming that
   word, whatever follows the token and whatever the option's value (fail closed; PRE-03):
   `(exec -a"git-commit" git -m x)`, `env -i -agit-commit /usr/bin/git -m x`. A `git` token
   followed by `commit`, or a `git-commit` token, is classified as usual: the argv[0] option
   is then a possible wrapper and the rows rank as in Precedence, an `-a` option that is
   the first unfit token being named by its `env` word (`exec -a x git commit --no-edit`
   names `exec`, `env -a x git commit --no-edit` names `env`, `exec -a git-commit git
   --no-edit` gets the generic row on `git`). Accepted false denies: an option cluster
   holding `a` or `S` with another meaning (`env -uname git log --grep=commit`) and any
   value (`exec -a x git log --grep=commit`). Known gap: an argv[0] value that never spells
   `commit` passes the early exit unparsed (Parsing step 1's gap), and Bash keeps the last
   `-a`, so `exec -agit-c{,o}mmit git -m x` and `exec -agit-$'\x63'ommit git -m x` commit
   in Linux bash with no output.
   Every token before the `git` token in its command must fit the prefix allowlist below
   (fail closed). The first token that does not is a possible wrapper: it denies a `commit`
   that steps 4 and 5 would allow or give the bare row, with the wrapper row naming it as it
   reads after quote removal (an operator token as its operator, e.g. `)`). A program that
   runs git may append words from its input or its own arguments, so
   `printf -- -n | xargs git commit --no-edit` runs `git commit --no-edit -n` and skips the
   hooks; a denylist of such programs and of the tokens an expansion may turn into one kept
   missing some (`env -S`, `watch`, `rush`, a function), so only known-safe prefixes pass.
   `git`'s command starts at the segment's start or, when a bracket is still open at `git`,
   right after the innermost one: in Bash a `(` token (a subshell, `<(…)`, `>(…)` or an
   extglob opener in a command's first word — elsewhere the pattern is one word with no `(`
   token, so it never resets this), in PowerShell a `(` or `{` token (a grouping expression, a
   subexpression or a script block). G2 reads every unquoted `{` and `}` as a token, a script
   block passed as data included, so the commands in it are classified like those of any
   script block (fail closed, GRD-06): `Write-Output { git commit --amend --no-edit }` gives
   no output, though a block passed to a native exe is stringified (pwsh passes it as
   `-encodedCommand`). In PowerShell, a Start-Process word anywhere in a command that
   mentions commit denies it with the wrapper row naming it, whatever follows the word and
   whether or not any `git` or `commit` token is read (fail closed, KD-S81). A Start-Process
   word is a token reading, after quote and escape removal and compared case-insensitively,
   as `Start-Process`, `saps` or `start` (also module-qualified
   `Microsoft.PowerShell.Management\Start-Process`), alone or after an `=` in the same token
   (`$p=saps`); the row names it without that prefix. Start-Process runs the program its
   `-FilePath` names, with a command line it builds from its own parameters, and that program
   can hide in many forms: `-FilePath:git`, `-f:git`, `-FilePath:'git'`, `'git '` and
   `git.exe.` (Windows trims a trailing space or dot), `-FilePath ('git')`, a variable
   (`$a='git'; Start-Process $a …`), splatting, or `$PSDefaultParameterValues` set in an
   earlier statement. And the word runs in any statement form: `$p = Start-Process …` (the
   idiomatic way to read an exit code with `-PassThru`), `$null = …`, `$p += …`,
   `[object]$p = …`, `return …`, `. saps …`, `& ('Start-Process') …` or inside
   `if (…) { … }`. So no target or position is read. Every other row ranks above it, the bare
   row below it (Precedence): `saps git commit --no-verify` keeps the `--no-verify` row, while
   `saps git commit -m x` gets the wrapper row, and `Start-Process git -ArgumentList { git
   commit -m x }` the literal-arguments row (step 4: the `{` token after `-ArgumentList` is
   not literal). Accepted false
   denies: `start https://github.com/o/r/commit/abc`, `npm start` in a command that mentions
   commit, `git log --grep start --grep commit`, and
   `Start-Process -ArgumentList { git commit --amend --no-edit }`.
   Redirections are dropped before this step (step 2).
   The prefix allowlist:
   - Bash, in this order: reserved words that may start a command (`!`, `{`, `if`, `then`,
     `elif`, `else`, `while`, `until`, `do`), a `(` token and `time` with an optional `-p`,
     any number of them; then literal assignments `NAME=value` whose value holds none of
     step 4's non-literal characters (`$`, a backtick, `{`, `(`, `*`, `?`, `[`) and no tilde
     expansion (`~` at the start of the word or after `=` or `:`); then any number of
     runners, each with its fixed option grammar: `nice` (an optional `-n <integer>` or
     `-<integer>`), `nohup`, `command` (no option) and `env` (any `-i` and `-u <NAME>`,
     then literal assignments). Names compare exactly as they read (no directory, no
     `.exe`, case-sensitive).
   - PowerShell: the `&` call operator alone. The bracket reset lets `if (…) { … }`,
     `foreach (…) { … }`, `else { … }`, `try { … }`, `&{ … }` and `. { … }` through.
   A substitution before `git` or around it (`$(…)`, a backtick, `${…}`) never reaches this
   step: the blanket rule denies the command (step 2), even `echo $(git commit --no-edit)`.
   In a process substitution `git` as its first word fits (`diff <(git commit --no-edit) f`,
   `tee >(git commit --no-edit)`), and the tokens before it are checked like any command's
   (`diff <(xargs git commit --no-edit) f` names `xargs`). `!(git commit --no-edit)` fits:
   with `extglob` off it is the `!` keyword before a subshell; with it on it is a glob
   pattern in the command position, so git never runs as git there (the command-position
   gap below). A form that steps 4 and 5 deny on another row keeps that row (Precedence).
   `find … -exec git commit … {} +` (or `-execdir`, or a `{}` anywhere in git's arguments)
   is denied by step 4: its placeholder holds `{`.
   Accepted false denies (fail closed, documented false positives): `echo git commit` (the
   wrapper row naming `echo`); runners outside the list (`sudo`, `timeout`, `stdbuf`,
   `strace`, `exec`, `watch`, `/usr/bin/env`, `command -p`, `nice` or `env` with another
   option such as `env -C`); a function definition (`f() { git commit --no-edit; }` naming
   `f`, `function f { … }` naming `function`); a `case … in pat) git commit --no-edit;;` arm
   (naming `case`); an assignment whose value may expand (`a='*' git …`,
   `GIT_AUTHOR_DATE=$d git …`, `GIT_DIR=~/r/.git git …`); and in
   PowerShell `. git commit --no-edit` (naming `.`), an environment prefix,
   `& ('xargs') git …` (naming `(`) and any Start-Process word (above, naming it).
   Fixtures: `xargs git commit --no-edit`, `printf -- -n | xargs git commit --no-edit`,
   `parallel git commit --no-edit`, `/usr/bin/xargs git commit --no-edit` (naming
   `/usr/bin/xargs`), `busybox xargs git commit --no-edit` (naming `busybox`),
   `xargs nice git commit --no-edit`, `xargs git commit`,
   `/usr/bin/x[a]rgs.exe git commit --no-edit`, `xargs{,} git commit --no-edit`,
   `x@(z|a)rgs git commit --no-edit` (naming `a`), `$W git commit --no-edit`,
   `~- git commit --no-edit`, `env -Sxargs git commit --no-edit` (naming `-Sxargs`),
   `env -S 'xargs -r' git commit --no-edit` (naming `-S`),
   `watch 'xargs -r' git commit --no-edit`, `rush git commit --no-edit`,
   `sudo git commit --no-edit`, `command -v git commit --no-edit` (naming `-v`),
   `nice A=1 git commit --no-edit` (naming `A=1`), `(xargs git commit --no-edit)`,
   `{ xargs git commit --no-edit; }`, `diff <(xargs git commit --no-edit) f`,
   `echo git commit` and the false denies above (the wrapper row);
   `$(echo xargs) git commit --no-edit` and `echo $(git commit --no-edit)` (the blanket
   row); `xargs git commit -a` (the generic row naming `-a`);
   `find . -exec git commit --no-edit {} +` (the literal-arguments row);
   `git commit --no-edit | xargs echo` (no output: the wrapper is in another segment); and
   with no output (every token before `git` fits): `{ git commit --no-edit; }`,
   `!(git commit --no-edit)`, `! git commit --no-edit`, `(cd sub && git commit --no-edit)`,
   `if git commit --no-edit; then :; fi`, `for f in *.md; do git commit --no-edit; done`,
   `[ -f a ] && git commit --no-edit`, `time -p git commit --no-edit`,
   `diff <(git commit --no-edit) f`, `tee >(git commit --no-edit)`,
   `f() (git commit --no-edit)`, `GIT_EDITOR=: git commit --no-edit`,
   `>out.txt git commit --no-edit`, `>!(z) git commit --no-edit` (a redirection target's
   extglob pattern is one word, not a reset), `nice -n 5 git commit --no-edit`,
   `env -i -u HOME A=1 git commit --fixup=1a2b3c4`,
   `A=1 nice -n 5 nohup env B=2 command git commit --no-edit`, and PowerShell
   `if ($ok) { git commit --no-edit }`, `&{ git commit --no-edit }` and
   `& git commit --no-edit`.
   Known gap: a wrapper reached through an allowlisted word passes with no output (Q3): a
   Bash alias (with `expand_aliases`) for an allowlisted word, or a function or a script
   earlier on `PATH` named `nice`, `nohup` or `env` (`command` skips aliases and functions,
   not `PATH`); and since the tokenizer drops quoting, a quoted reserved word or assignment
   (`'!'`, `'{'`, `'if'`, `"A"=x`), which bash runs as a command of that name, fits too.
   A wrapper that runs git from a string (`sh -c '…'`, `eval`, PowerShell `iex` or
   `Invoke-Expression`, a script, or a runner that re-splits one string argument into a new
   command line, `env -S 'git commit --fixup=HEAD'`) holds no `git` token: the interpreter
   gap (Q3; `iex 'git commit -m x'` gives no output, KD-S80). .NET `Process.Start` in
   PowerShell is the same gap: `[Diagnostics.Process]::Start('git','commit --no-verify -m x')`
   holds no `git` token (its arguments read as one token holding `,`) and gives no output,
   and a type or method name can be built at run time, so no token test closes it (KD-S80).
   An extglob pattern in an argument whose
   body is an allowed form as a command (step 2 reads it as one), re-split by such a runner,
   is the same gap (`env -S A=@( git commit --fixup=HEAD'\c')`).
   Known gap: expansion or aliasing in the command position, where no token is `git` until
   the shell expands it, passes with no output (Q3): Bash brace expansion
   `{git,commit,-m,x}`, a glob such as `/usr/bin/gi? commit -m x` (PowerShell resolves one in
   the command word too: `& 'C:\…\gi[t].exe' commit -m x` runs git in 5.1 and 7) or an extglob
   `@(git) commit -m x` (with `extglob` on; its `git` token is followed by the `)` that ends
   its arguments), a variable there (Bash
   `$GIT commit -m x`, PowerShell `& $g commit -m x`), a PowerShell expression there,
   `& ('git') commit -m x` (its `git` token is followed by the `)` that ends its arguments,
   step 4; `& ('Start-Process') git …` is denied by its Start-Process word, but a name built
   at run time, `& ('Start-'+'Process') git …` or `& ('g'+'it') commit …`, is the same gap), and a shell alias or function for git (Bash `shopt -s expand_aliases` and
   `alias c=git` on an earlier line, then `c commit -m x`; PowerShell
   `Set-Alias g git; g commit -m x`). A substitution there (`$(echo git) commit`) is denied
   by the blanket rule (step 2).
4. Skip git global options: `-C <path>`, `-c <k=v>`, `--config-env[=]<k=env>`,
   `--git-dir[=]<p>`, `--work-tree[=]<p>`,
   `--namespace[=]<n>`, `--attr-source[=]<tree>`, `--exec-path=<p>` (joined value only),
   `--no-pager`, `-P`, `-p`, `--paginate`, `--bare`, `--no-replace-objects`,
   `--literal-pathspecs`, `--no-literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`,
   `--icase-pathspecs`, `--no-optional-locks`, `--no-advice`, `--no-lazy-fetch`. Git
   matches each by its exact spelling; a value-taking one takes
   the next token as its value (`-C commit status` runs `status`), a long one also a value
   joined with `=`. Git older than an option rejects it (exit 129) before running any
   subcommand. Any other token starting with `-` is an unknown option (`-Cdir`,
   `--NO-PAGER`, bare `--exec-path`, `--shallow-file`, `--super-prefix`, and `--help`,
   `-h`, `--version`, `-v`, which git turns into its help or version command). An unknown
   option may still be one a newer git accepts, and which token after it is a value or the
   subcommand is not known: so every token after it up to the end of git's arguments must
   be literal (a non-literal one → the literal-arguments row, whether or not a `commit`
   token follows: `git --bogus $x; echo commit` is an accepted false deny), and a literal
   `commit` token among them → deny with the unknown-option row. PowerShell
   splits an unquoted `-name.rest` token at the dot (`git -C. commit -m x` runs
   `git -C . commit -m x` in 5.1 and 7); G2 keeps it one token, an unknown option, so it is
   denied when a `commit` token follows, and the `.rest` part can never be the subcommand
   `commit`. Verified 2026-10-03 with git 2.54, Git Bash, Windows PowerShell 5.1 and
   PowerShell 7 running each spelling against a real repository. The first
   token after the global options is the subcommand. Steps 4 and 5
   read git's arguments from the token after `git` up to the segment's end, a `cut` token
   (step 2), or a `)` token or, in PowerShell, a `}` token; no option value, subcommand or
   `commit` argument is read past it. Every token read there, as a global option, a token
   after an unknown option, an
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
     arguments on Linux and macOS); a `{` that expands to nothing is denied too (fail closed:
     `git {1x}>/dev/null commit -m x` is an accepted false deny);
   - in PowerShell, holds `,` or `@`, or is `--%`: a comma makes an array literal, which
     Windows PowerShell 5.1 passes as separate arguments (`git -C . ,commit -m x`,
     `git -C . , commit -m x` and `git commit, -m x` run a commit there; PowerShell 7 passes
     the comma on); a leading `@` is a splat (`git @a`, `git commit --fixup @s`); `--%`
     stops parsing (step 2) and expands `%NAME%` in the rest of the line (`$env:X='commit'; git --% %X% -m x`), and a quoted `'--%'` is dropped from
     the native command line (`git '--%' commit -m x` runs `git commit -m x`). A token
     starting with `,` right after a value-taking option's value joins that value into an
     array (`git -C . ,commit -m x` and `git -C . , commit -m x` pass `-C . commit -m x` in
     5.1), so it is the value that is not literal: the literal-arguments row, not the
     literal-subcommand row; after `git` or an option without a value the comma starts an
     array of its own in the subcommand's place (`git --no-advice ,commit -m x` → the
     literal-subcommand row);
   - in PowerShell, is empty, holds `"` or ends in `\`: Windows PowerShell 5.1's legacy
     native-argument passing drops an empty argument, passes an embedded `"` unescaped (git
     splits the argument there: `git commit --fixup ':/!-\" --no-verify'` passes
     `--no-verify`) and wraps an argument holding whitespace in `"…"`, where a trailing `\`
     escapes the closing quote and the arguments after it run together
     (`git commit --fixup 'x y\' 'p --no-verify'`). Empty tokens between `git` and `commit`
     are denied with this row too (`git '' commit --no-verify` runs `git commit --no-verify`
     in 5.1); verified 2026-10-03 with a fake git logging its argv.
   Verified 2026-09-29 with bash 5.3, Windows PowerShell 5.1 and PowerShell 7. In Bash `,`,
   `@` and `--%` are ordinary characters (`git commit --fixup @~1`). The tokenizer does not
   record quoting, so a quoted form is denied too (fail closed; documented false positives:
   `git -C "$dir" commit --no-edit`, `git commit --fixup "$sha"`; write the value
   literally). A non-literal token in the subcommand position is denied with the
   literal-subcommand message, whatever follows it and whether or not it would run `commit`
   (`git $sub status; echo commit` is an accepted false deny), anywhere else with the
   literal-arguments message (deny table). A variable holding an option takes the
   subcommand's place too, since the guard cannot tell (`$o='--no-pager'; git $o commit -m x`,
   `opt=--no-pager; git "$opt" commit -m x`, `git {--no-pager,commit} -m x`, PowerShell
   `git -C . --no-advice $null commit -m x`, where PowerShell drops `$null`). The tokens after a literal subcommand other than `commit` are not read, so
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
   `git commit --squash=HEAD --no-edit` → deny. The generic row names an empty argument
   (`git commit --no-edit ""`) as `""`.
   An option that takes a value (`-m`, `-F`, `-C`, `-c`, `-t`, `-U` and the long options with
   a required value, among them `--squash`, `--reuse-message`, `--reedit-message`,
   `--author` and `--trailer`) takes the next argument as its value, as git does, so a value
   never matches a row of its own (`--author -n --no-edit` → the generic row naming
   `--author`; `-m --amend` → the bare row). Long options match by their full name: an
   abbreviation git accepts (`--amen`) gets the generic row naming it, and a value it takes
   is read as an argument of its own (denied either way). An abbreviation of an option with
   a required value (`--auth` of `--author`) does not match that full name, so it does not
   consume the next token either: `--auth -n` gives the `-n` row, not the generic row, even
   though git itself reads `-n` as `--author`'s value. Denied either way. `--amend` or
   `--no-verify` given a
   value (`--amend=x`) keeps its row; `--no-edit=x` is not `--no-edit`.
   PowerShell reading (Windows PowerShell 5.1 and PowerShell 7, verified with a node argv
   echo): an unquoted argument of a native command that starts with a single `-` is split
   at a `.` into two arguments (`-x.y` → `-x`, `.y`; `-q.x` → `-q`, `.x`); one starting
   with `--` is not (`--no-edit.x`, `--fixup=v1.0`). G2 leaves such a word unsplit on
   purpose (GRD-06), since the classifier stays safe without the split: its own flags stay
   denied (`-q.x` expands to `-q -. -x` and is denied), and the one mismatch is a `--fixup` value written as the next argument: `--fixup -x.y` is
   allowed while git receives `--fixup -x .y`. The split-off part starts with `.`, so git
   reads it as a pathspec, never an option, and `-x` does not resolve to a commit.

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
| `extglob` | Bash | a `(` directly after `@`, `!`, `+`, `*` or `?` in a command's first word ends that word with the `(` kept and is also a `(` token; elsewhere it reads the whole pattern through its matching `)` as one word, no `(` token; bash (`extglob` off) rejects the pattern as a syntax error, or runs `!(…)` at a command's start as a negated subshell |
| `escaped-newline-in-word` | PowerShell | a backtick plus newline inside a word is removed (step 2); PowerShell keeps the newline in the word |
| `ps-nul` | PowerShell | a NUL escape (`` `0 ``) or a raw NUL ends its token's value and a `cut` token follows it, ending git's arguments while the later tokens stay in the segment; the parser keeps the NUL and the rest in the word and has no `cut` there (the native command line is cut only when the command runs) |
| `carriage-return` | Bash | a carriage return is a character of its word in one reading; the Windows (Cygwin) bash drops every carriage return in the other, not only ones before a newline |

**Deny messages:** `<route>` stands for `Spawn the commit:commit-worker agent (model:
sonnet; pass intent: <what you changed and why>). Edit no files until it replies.` It names
the model like every spawn instruction (Q24 as amended by the PRE-15 decision pass). It
never names `/commit`: the
reason goes to the model, which cannot invoke `/commit` (`disable-model-invocation`, Q2), and
a `Skill("commit")` call could resolve to a personal commit skill (Q8). Every message
that contains `<route>` ends with a `\n` and then the fixed line `If a personal commit skill
sent you here, remove it (see the commit plugin README).` (Q8; nothing is detected).

Worker-only rule (defence in depth: its scan's documented gaps, Script call above, are not
covered): when `agent_type` is `commit:commit-worker` and any segment holds a token with the
basename `commit.cjs` directly followed by `commit` or `release` (S2 `named`), deny with `The handback is for your caller:
return the reply verbatim and stop.` (Q25). Everything else the worker runs is left to the
normal rules. A blanket-denied command (parsing step 2) has no segments, so this rule does
not apply to it; it gets its blanket row. The rule is checked before any `git commit` row: a
worker command that holds both such a call and a denied `git commit` gets the handback
text, so the instruction to stop is never hidden by another deny.

**Precedence:** when a `commit` segment's expanded arguments match more than one row below,
the most specific wins, in this order: `-c` / `--config-env` before `commit`; the
literal-subcommand row; the literal-arguments row; unknown global option; `--amend` without `--no-edit`; `--squash` in
any form; `-n` / `--no-verify` / `--no-gpg-sign`; `--fixup=amend:` / `--fixup=reword:`; the
generic "any other flag or argument" row (also covers `-C` / `-c` after `commit`); the
wrapper row (step 3); the bare/`-m`/`-F`/`--message`/`--file` row, only
when no other row matches. A tie within one row
goes to the first matching token in argv order. So `-am x` denies on `-a` (the generic row:
`git commit -a is not allowed here. <route>`), `--amend -m x` denies on `--amend`, `-n -m x`
on `-n`, `--squash -m x` on `--squash`, `xargs git commit -a` on `-a`, and
`xargs git commit -m x` and `echo git commit` on the wrapper. A blanket-denied command (step 2) is never
tokenized, so it gets its blanket row (the `nesting` row, the `size` row, the `escape` row,
or the construct row for every other kind) and no other.

| Case | Message |
| --- | --- |
| bare commit, `-m`, `-F`, `--message`, `--file` | `Direct git commit is blocked. <route>` |
| `--amend` without `--no-edit` | `To reword the last commit: <route> Ask it to reword. To add changes, make a new commit the same way.` |
| `--squash` in any form | `git commit --squash opens an editor. <route>` |
| `-n`, `--no-verify`, `--no-gpg-sign` | `<flag> is not allowed. Fix the hook or signing setup instead.` |
| `--fixup=amend:` / `--fixup=reword:` | `--fixup=<kind>: opens an editor. Use plain --fixup=<commit>, or: <route>` |
| any other flag or argument | `git commit <flag> is not allowed here. <route>` |
| a possible wrapper before `git` in its command: the first token outside the prefix allowlist (step 3) | `git commit run by <wrapper> is not allowed: it can append arguments. <route>` (`<wrapper>` is that token as it reads after quote removal, an operator token as its operator, e.g. `)`) |
| `-c` / `--config-env` before `commit` | `git -c … commit is not allowed. <route>` |
| subcommand that is not literal (step 4) | `Write the git subcommand literally. <route>` |
| any other token among git's arguments that is not literal (step 4) | `Write git's arguments literally. <route>` |
| `-C` / `--reuse-message`, `-c` / `--reedit-message` (after `commit`) | `git commit <flag> is not allowed here. <route>` (the generic row) |
| unknown global option | `Could not parse git options before 'commit'. <route>` |
| a blanket-rule construct in a command that mentions `commit` (step 2; every blanket kind but `nesting`, `size` and `escape`) | `This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: <route>` |
| an extglob pattern nested more than 16 deep (step 2, blanket kind `nesting`) | `This command mentions commit and holds an extglob pattern nested more than 16 levels deep, which the guard does not parse. Keep it out of a command that mentions commit, or to commit: <route>` |
| a command longer than 262,144 characters that mentions `commit` (step 2 size cap, blanket kind `size`) | `This command mentions commit and is longer than 262144 characters, which the guard does not parse. Keep a command that mentions commit shorter (write long text to a file first), or to commit: <route>` |
| a PowerShell `` `e `` or `` `u{…} `` escape in a command that mentions `commit` (step 2, blanket kind `escape`) | `This command mentions commit and holds a `e or `u{…} escape, which Windows PowerShell 5.1 and PowerShell 7 read differently. Keep them out of a command that mentions commit, or to commit: <route>` |
