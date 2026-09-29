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
left after the conversion can only be part of a POSIX file name; `recognise(tokens) → { subcommand, args } | null`. Sources: Q16,
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
heartbeat); a stderr log with `agent_id` when `COMMIT_GUARD_DEBUG=1`, holding the
decision, the deny reason and the command in the same redacted form as the heartbeat
(script-call form or the matched `git commit` segment's options, never message text or
other segments), cut to 200 characters; for a blanket deny (G2) the trigger kind instead of
the command. A crash or unreadable input writes the same one
line under debug, with the fields known so far, and still no stdout.
`runHook(stdinText, { env, claudeHome, now }) → { stdout, stderr }`. Sources: Q1, Q3, Q23, C:guard.

**G2 Shell tokenizer.** First the blanket rule (C:guard step 2, Q3 as amended): with that
shell's escaped newlines removed regardless of quotes (Bash `\`, PowerShell backtick, each
optionally followed by a carriage return, then a newline), a command holding anywhere,
inside quotes or not, `$(`, `${` or `#` (both shells), a backtick, a `<<` not part of `<<<`
or a typographic quote U+2018-U+201E (Bash), or `@(` or an `@` directly followed by `'`,
`"` or U+2018-U+201E (PowerShell) is not tokenized: G2 returns the trigger kind instead of
segments, and G3 maps it to the blanket deny with no segments and no script calls (so no
heartbeat and no worker-only rule). Otherwise tokenise per `tool_name` with the rules of
C:guard (Bash: `\` escapes, literal single quotes, `\"` `\` `\$` in double quotes, `$'…'`
with its backslash escapes decoded, a decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends
the `$'…'` span's value there, as in Bash (`git $'commit\0x'` is `git commit`,
`$'ab\0cd'ef` is `abef`); PowerShell: backtick escapes, `` `u{…} `` read as its code point
(PowerShell 7), where `` `0 `` and a zero `` `u{…} `` (`` `u{0} ``, `` `u{00} ``) are a NUL
that ends the token's value there, as the native command line is cut at it, and a `cut`
token follows the cut token, ending git's arguments while the later tokens stay in the
segment (`` git commit`0x -m x `` is `git commit`), `''` and `""`, typographic quotes as
quotes (‘ ’ ‚ ‛ single, “ ” „ double, so `git co‘’mmit` is `commit`; Q3 as amended));
escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline) removed outside
single quotes before splitting; quote removal; split into segments on `&&`, `||`, `;`,
`|`, `&` and newlines outside quotes. An unterminated quote makes the rest of its line one
quoted token and scanning continues on the next line (Q3 as amended). Redirection
operators (`>`, `>>`, `<`, `2>&1` and the like) outside quotes become tokens of their own
that G3 and S2 drop together with their target, so they are never read as commit
arguments or options; `<<<` is one of them. An unquoted `(` or `)` becomes a token of its
own too (not dropped); so G3 finds the `git` of `(git commit -m x)`, and a `)` token ends
git's arguments. Bash process substitution `<(` / `>(` becomes a `(` token (not a
redirection), and in PowerShell an unquoted `{` or `}` becomes a token too, so G3 finds
the `git` of `diff <(git commit -m x) f` and `&{git commit -m x}`, and a PowerShell `}`
token ends git's arguments like `)`. In PowerShell a `--%` word after escape removal, not
inside quotes, makes the rest of its line, up to `|`, `&&` or `||`, words split on
whitespace only. `segments(command, shell) → Token[][] | { blanket: <trigger kind> }`.
Sources: Q3, C:guard.

**G3 Command classifier and deny catalogue.** Per segment: find every token whose basename (the
part after the last `/` or `\`, in both shells) is `git` or `git.exe`, compared
case-insensitively (optionally after `&`), or whose basename is
the dashed `git-commit` (with or without `.exe`, in any directory, compared
case-insensitively), which classifies as `git commit`; skip the
known global options; remember `-c` and `--config-env`; compare the subcommand with
`commit` case-insensitively (`git COMMIT` is a commit, fail closed); deny an unknown option before
`commit`; read git's arguments up to the segment's end, a `cut` token, a `)` token or (in
PowerShell) a `}` token, and deny any of them that is not literal (fail closed, C:guard
step 4): a `(` or (in PowerShell) `{` token, a token holding `$`, a backtick, `{`, `(` or a
glob character (`*`, `?`, `[`), and in PowerShell a token holding `,` or `@` or equal to
`--%`, with the literal-subcommand text in the subcommand position; expand commit arguments and apply
the Q4 allowlist; a segment is denied when any of its `git` tokens is;
a blanket result from G2 gives the blanket deny and nothing else;
detect script calls with S2; the worker-only rule (`agent_type` `commit:commit-worker` and a
script call to `commit` or `release` → deny). The fixed deny texts of C:guard, `<route>`
expansion and the trailing personal-skill line are data here; no text names `/commit`.
`classify(segmentsOrBlanket, { agentType, shell }) → { decision: "deny" | "none", message?,
scriptCalls, matched?: { options } }`, where `matched` holds the matched `git commit`
segment's options for G1's debug log.
Sources: Q3, Q4, Q8, Q24, Q25, C:guard.
