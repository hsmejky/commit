# Modules S1-S2 and G1-G3

**S1 Heartbeat.** The guard writes `{ ts, cwd, command }` to `commit-guard/heartbeat.json`
(location pending the heartbeat-under-sandbox spike, Open items)
under the Claude home (glossary) when a classified segment is a script call to `plan`,
before deciding. The write goes to a temporary file named with the pid and a random suffix
and is renamed into place, so a reader never sees a partial file and parallel sessions
never share a temporary name. `command` is stored redacted: the script-call form only
(subcommand and flags), cut to 200 characters, so arguments a caller passed on the command
line do not persist. `plan` judges `active` (under 15 minutes old,
and the realpathed hook `cwd` inside the toplevel or vice versa) versus `not-seen`.
`writeHeartbeat({ claudeHome, cwd, command, now })`; `guardState({ claudeHome, toplevel, now
})`; pure `samePathTree(a, b, { caseFold })` over already-realpathed paths, `caseFold` true
on Windows and macOS. Sources: Q23, C:guard.

**S2 ScriptCall.** The single definition of a script call (C:guard): `node` or `node.exe`
(optionally after `&`), a token whose basename is the commit entry point's, a subcommand
from the fixed list, compared after quote removal. `build({ scriptPath, subcommand, args })`
emits the one quoted form (absolute forward-slash path in double quotes) that the anchored
README allow rules match. It escapes nothing: the commit entry point refuses (`env`) an
install path containing `$`, a backtick, `"`, `\` or a typographic double quote
(U+201C-U+201E) before any work, so no shell can expand or mangle the path. The check runs on the path `build` emits, after the Windows separators
are converted to `/`, so a native Windows path is not refused for its separators; a `\`
left after the conversion can only be part of a POSIX file name (`build` reads a path with
a drive letter or a UNC start as Windows, one starting with `/` as POSIX). `build` throws a
`TypeError` for a path that is not absolute or not to `commit.cjs`, a path holding a
character the step 2 exemption keeps out of the quoted path (`"`, U+201C-U+201E, `$`, a
backtick, `!` or a control character), a subcommand outside the list, or an argument outside
the step 2 exemption's word characters, so its output is always in the exemption form; `recognise(tokens) → { subcommand, args } | null`, the arguments being
the words after the subcommand up to the first operator token, redirections dropped. Sources: Q16,
Q23, Q25, C:guard, C:reply-and-handback.

**G1 Hook I/O.** Read the `PreToolUse` JSON from stdin to its end (not a synchronous read of
descriptor 0, which throws on Windows pipes); exit early with no output when the command's
mention text lacks `commit` (checked case-insensitively): the command, for this check only,
with every escaped newline of either shell (`\` or a backtick, optionally a carriage
return, then a newline) removed regardless of quotes, then every `$` directly before a quote
character removed, then every `'`, `"`, `\`, backtick and typographic quote
(U+2018-U+201B, U+201C-U+201E) removed (C:guard step 1); then tokenise (G2) → classify (G3) → when the classification's
`scriptCalls` holds a `plan` call, write the heartbeat (S1) before the decision is emitted
(C:guard: "before deciding"), so a denied compound command that also calls `plan` still
counts → emit the deny JSON or nothing, never `allow`. A crash anywhere, including in the classifier, fails open (exit 0, no output, no
heartbeat); under `COMMIT_GUARD_DEBUG=1`, `formatDebugLine` writes one JSON object on one
stderr line, with keys `agent_id`, `decision`, `reason` and `command`, each key left out
when unknown; `command` is in the same redacted form as the heartbeat (script-call form or
the matched `git commit` segment's options, never message text or other segments), cut to
200 characters; for a blanket deny (G2) the trigger kind instead of the command. A crash or
unreadable input writes the same one-key-subset object under debug, with the fields known
so far (down to `{}`), and still no stdout; the guard entry point writes that same `{}`
itself when the crash happens before the library loads at all (GRD-02). GRD-16 extends the
object with the same keys, defining no new ones.
`runHook(stdinText, { env, claudeHome, now }) → { stdout, stderr }`; `formatDebugLine(fields)
→ string`. Sources: Q1, Q3, Q23, C:guard.

**G2 Shell tokenizer.** First the size cap (C:guard step 2): a command longer than
`MAX_COMMAND_LENGTH` (262,144 characters) is the blanket kind `size`, exempt form or not,
so time and memory stay bounded (a heap exhaustion fails open; review GRD-04 round 10).
Then the script-call exemption (C:guard step 2, Q3 as amended): a
command that is, in full, one script call in the exempt form (optional surrounding spaces,
in PowerShell an optional `& `, `node` or `node.exe`, a double-quoted path ending in
`/commit.cjs` or `\commit.cjs` without `"`, U+201C-U+201E, `$`, backtick, `!` or a control
character, a subcommand, then words of `[A-Za-z0-9._:=-]` only) skips the blanket rule and
is tokenized, so an install path holding `#` does not deny the worker's own calls. Then
the blanket rule: a command holding anywhere, inside quotes or not, `$(`, `${` or `#` (both
shells), a backtick, a run of two or more `<` other than exactly three (a heredoc) or a
typographic quote U+2018-U+201E (Bash), or `@(` or an `@` directly followed by `'`, `"` or
U+2018-U+201E (PowerShell) is not tokenized, each checked with that shell's escaped
newlines removed regardless of quotes. PowerShell checks one reading (backtick, optionally
followed by a carriage return, then a newline, removed). Bash checks two readings, a
trigger in either denying it: the text with every NUL and carriage return dropped, then
`\` plus newline removed; and, when the command holds a carriage return, the text with only
every NUL dropped, then `\` plus newline removed, where on this second reading a `\` before
a kept carriage return escapes it instead of continuing the line. G2 returns the trigger
kind instead of segments, and G3 maps it to the blanket deny with no segments and no script
calls (so no heartbeat and no worker-only rule). Otherwise tokenise per `tool_name` with the
rules of
C:guard (Bash: `\` escapes, literal single quotes, `\"` `\\` `\$` in double quotes, `$"…"`
read as `"…"`, a `(` directly after `@`, `!`, `+`, `*` or `?` in a command's first word kept
in that word and also a `(` token (extglob); elsewhere (an argument or a redirection
target) the same opener reads the pattern through its matching `)` as one word, no `(`
token, no segment split inside it — unbalanced, the word ends after the `(` with no `(`
token, and the rest tokenizes normally (review GRD-04 round 5); the body of each balanced
pattern read so is also tokenized as a command text, nested patterns included, its
segments right after the segment holding the word (defense in depth, review GRD-04 round
8); an unquoted `<(` or `>(`
inside such a pattern makes G2 return the blanket kind `substitution` instead of segments
(fail closed, review GRD-04 round 6), and an unquoted `(` opening its bracket level 17
(`MAX_PATTERN_DEPTH` 16) the blanket kind `nesting`, which bounds the body walk's depth
(review GRD-04 round 9; the size cap bounds its memory); the word after `function` is read as a first word,
and a reserved word that opens a command (`!`, `{`, `if`, `while`, `until`, `time`, …)
keeps a command's first position after `function NAME`, `coproc` or `coproc NAME`, as
does a `--` after `time` or `time -p` (review GRD-04 round 7), and `then`, `do`, `else`
and `elif` open it after any word, an argument included (bash takes them after `]]`, `}`,
`fi`, `done`, `esac`, `for NAME`; review GRD-04 round 8), `$'…'`
with its backslash escapes decoded, a decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends
the `$'…'` span's value there, as in Bash (`git $'commit\0x'` is `git commit`,
`$'ab\0cd'ef` is `abef`); PowerShell: backtick escapes (`` `e `` and `` `u{ ``, which 5.1 and 7 read differently,
are the blanket kind `escape`), where `` `0 `` is a NUL
that ends the token's value there, as the native command line is cut at it, and a `cut`
token follows the cut token, ending git's arguments while the later tokens stay in the
segment (`` git commit`0x -m x `` is `git commit`; a raw NUL character reads the same),
`''` and `""`, typographic quotes as
quotes (‘ ’ ‚ ‛ single, “ ” „ double, so `git co‘’mmit` is `commit`; two of one class in a
row inside a string of that class are one escaped quote, any one closes it; Q3 as
amended)); escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline)
removed outside single quotes and Bash `$'…'` spans as the tokenizer reads them, before
splitting; quote removal; split into segments on `&&`, `||`, `;`,
`|`, `&` and newlines outside quotes. An unterminated quote makes the rest of its line one
quoted token and scanning continues on the next line (Q3 as amended). Redirection
operators (`>`, `>>`, `<`, `2>&1` and the like) outside quotes become tokens of their own
that G3 and S2 drop together with their target, so they are never read as commit
arguments or options; `<<<` is one of them. An unquoted `(` or `)` becomes a token of its
own too (not dropped); so G3 finds the `git` of `(git commit -m x)`, and a `)` token ends
git's arguments. Bash process substitution `<(` / `>(` becomes a `(` token (not a
redirection), and in PowerShell an unquoted `{` or `}` becomes a token too (a script
block passed as data, as to `Start-Process`, included: fail closed), so G3 finds
the `git` of `diff <(git commit -m x) f` and `&{git commit -m x}`, and a PowerShell `}`
token ends git's arguments like `)`. In PowerShell a `--%` word after escape removal, not
inside quotes, makes the rest of its line, up to `|`, `&&` or `||`, words split on
whitespace only. `segments(command, shell) → Token[][] | { blanket: <trigger kind> }`. G2
also exports `blanketTrigger(command, shell) → <trigger kind> | null`, the trigger-kind check
before tokenizing alone (the size cap `size` and the construct kinds; the kinds found only
while tokenizing, `substitution` inside a pattern, `nesting` and PowerShell's `escape`, come from `segments`, so
G1's debug log, which names the trigger kind instead of the command for a blanket deny,
takes it from the `segments` result) and `isExemptScriptCall(command, shell) → boolean`, the script-call
exemption check alone (both reasonable to expose next to `segments`, which composes them);
and, as a test seam only, `segmentSpans(command, shell) → [start, end][] | null`, each
segment's span in the command text, feeding the oracle cross-check that lets the shell read
each span on its own.
Sources: Q3, C:guard.

**G3 Command classifier and deny catalogue.** Per segment: find every token whose basename (the
last component of its path normalised Win32-style in both shells: a leading drive `C:`, `.`,
`..`, empty components and trailing spaces and dots resolved, C:guard step 3) is `git` or
`git.exe`, compared
case-insensitively (optionally after `&`), or whose basename is
the dashed `git-commit` (with or without `.exe`, in any directory, compared
case-insensitively), which classifies as `git commit`; a `git` token after an `exec`,
`env` or `genv` argv[0] option (`-a`, `--argv0`, `env -S`) denies with the wrapper row
naming that word whatever follows it, since git runs `git-commit` from argv[0] as
`commit` (C:guard step 3); skip the
known global options; remember `-c` and `--config-env`; compare the subcommand with
`commit` case-insensitively (`git COMMIT` is a commit, fail closed); deny an unknown option before
`commit`; read git's arguments up to the segment's end, a `cut` token, a `)` token or (in
PowerShell) a `}` token, and deny any of them that is not literal (fail closed, C:guard
step 4): a `(` or (in PowerShell) `{` token, a token holding `$`, a backtick, `{`, `(` or a
glob character (`*`, `?`, `[`), and in PowerShell a token holding `,` or `@` or equal to
`--%`, with the literal-subcommand text in the subcommand position; expand commit arguments and apply
the Q4 allowlist; deny what it would allow (or give the bare row) when a token before `git` in
its command (which starts after a bracket still open at `git`: a `(` token, or an extglob
opener's `(` token in a command's first word only — elsewhere the pattern is one word with
no `(` token) is outside the prefix allowlist
(Bash reserved words and `(`, literal assignments, then `nice`, `nohup`, `command`, `env` with
fixed option grammars; PowerShell `&`), naming the first such token (the wrapper row, C:guard
step 3); a segment is denied when any of its `git` tokens is;
a blanket result from G2 gives the blanket deny and nothing else (the `nesting`, `size` and
`escape` kinds each their own row, every other kind the construct row);
detect script calls with S2; the worker-only rule (`agent_type` `commit:commit-worker` and a
script call to `commit` or `release` → deny). The fixed deny texts of C:guard, `<route>`
expansion and the trailing personal-skill line are data here; no text names `/commit`.
`classify(segmentsOrBlanket, { agentType, shell }) → { decision: "deny" | "none", message?,
scriptCalls, matched?: { options } }`, where `matched` holds the matched `git commit`
segment's options for G1's debug log.
Sources: Q3, Q4, Q8, Q24, Q25, C:guard.
