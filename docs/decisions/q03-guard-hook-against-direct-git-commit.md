# Q3 Guard hook against direct git commit

- **Context.** Description-based triggering is probabilistic; in practice the agent often
  commits without the plugin unless told to use it.
- **Decision.** A tuned description plus a `PreToolUse` hook, matcher `Bash|PowerShell`, that
  denies a direct `git commit` and tells the agent to spawn the `commit-worker` agent (Q24;
  messages in [contracts](../contracts/guard.md)). The message never offers `/commit`: the
  model cannot invoke it (Q2), and it is the user's entry point. The worker commits through
  the script, which calls git via `child_process`, so the hook does not see it as a direct
  commit. The hook fires for subagent tool calls as well.
  - Detection tokenises the command ([contracts](../contracts/guard.md)) with the quoting rules
    of the shell named in `tool_name` (Bash: `\` escapes, `'…'` literal, `$'…'` read with
    its backslash escapes, a decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends the
    `$'…'` span's value there, as in Bash (`git $'commit\0x'` is `git commit`,
    `$'ab\0cd'ef` is `abef`); PowerShell: `` ` `` escapes, where `` `0 `` (and `` `u{0} ``)
    is a NUL that ends the token's value there, as the native command line is cut at it, so
    the words after it in the segment are dropped too (`` git commit`0x -m x `` is
    `git commit`), `''` inside `'…'`, here-strings),
    segments split on `&&`, `||`, `;`, `|`, `&` and newlines. Unquoted `(` and `)` are
    tokens of their own, and so are Bash `<(` / `>(` (read as `(`) and PowerShell `{` / `}`,
    so a `git` inside a subshell, a process substitution or a script block is found.
    Escaped newlines (Bash `\` plus newline, PowerShell backtick plus newline) are removed
    outside single quotes before splitting, so a continued line stays one segment. An
    unterminated quote or here-string makes the rest of its line one quoted token and
    scanning goes on, so a `git commit` before it is still denied.
    Redirection operators outside quotes (`>`, `>>`, `<`, `2>&1` and the like) become tokens
    of their own and are dropped with their target, so `git commit … 2>&1` is still denied
    and a redirect target is never read as a commit argument or option;
    `git` / `git.exe` at any path, the basename compared case-insensitively (the early-exit
    substring `commit` is matched case-insensitively too, and is looked for after every `'`,
    `"`, `\` and backtick is removed from the command, so `git co''mmit` and `git COMMIT` are
    not early exits),
    with or without the `&` call operator; git global options (`-C`, `-c`, `--git-dir`,
    `--work-tree`, `--no-pager`, `-P`, …) skipped before the subcommand. An unknown global
    option followed by a `commit` token is denied (fail closed), and so is a subcommand
    token that contains `$` (a variable or substitution such as `git $c`, in a command that
    mentions `commit` elsewhere) or a backtick, or, in PowerShell, starts with `@` (a
    splat), since it may expand to `commit`.
  - Output: a `deny` decision with a fixed message, or nothing. The hook never returns
    `allow`, so the user's permission prompts still apply. A crash or unreadable hook input
    exits 0 with no output (fail open): a guard bug must not block every shell call.
  - False positives such as `echo git commit` (unquoted) and a comment that mentions it
    (`git commit --no-edit # done`, `# git commit -m x`) are accepted; a deny costs one turn.
- **Amended.** By spec pass 1 (2026-09-27): an unterminated quote or here-string turns the
  rest of its line into one quoted token and scanning continues on the next line, so a
  truncated `git commit -m "…` is still denied. By spec pass 2 (2026-09-27): redirection
  operators outside quotes become tokens of their own and are dropped along with their
  target, so a redirect target is never read as a commit argument or option.
- **Amended.** By spec pass 3 (2026-09-27): escaped newlines are removed
  before splitting, and the `git` / `git.exe` basename is compared case-insensitively while
  the early-exit substring `commit` stays case-sensitive, so `GIT.EXE commit` and a
  continued line cannot slip past; the tokenizer spike only confirms them. `.git/config`
  and `.git/hooks` recorded as an accepted gap (below).
- **Amended.** By spec pass 4 (2026-09-27): the early-exit substring check
  runs after removing `'`, `"`, `\` and backticks, so split quotes cannot skip parsing; a
  subcommand token holding `$` (or a PowerShell `@` splat) is denied; other paths to a
  commit (`git commit-tree`, `git am`, stash and cherry-pick replays, MCP shells) and a
  `commit` split by an escaped newline recorded as accepted gaps (below).
- **Amended.** By spec pass 5 (2026-09-27): the guard closes three more bypasses: after the
  `commit` substring check passes, a `{`, `(` or glob char (`*`, `?`, `[`) in the subcommand
  position right after `git` is denied (fail closed; covers Bash brace expansion
  `git {commit,-m,x}` and PowerShell `git (…)`); typographic quotes (`“` `”`
  `‘` `’`) are treated as quotes (PowerShell does); the dashed binary `git-commit`
  (any directory, `.exe`, case-insensitive basename) matches as `git commit`. Accepted gap: a
  command whose text never contains `commit` literally (`git $(echo com)mit`, PowerShell
  `git ('com'+'mit')`) passes the early exit and is not denied; `sudo -u git git commit` is
  not addressed (negligible). The PowerShell rules hold for both Windows PowerShell 5.1 and
  PowerShell 7+, and the guard's PowerShell tests run under each (Q15).
- **Amended.** By spec pass 7 (2026-09-27): the early-exit substring check for `commit` is
  case-insensitive (it previously stayed case-sensitive while the `git`/`git.exe` basename
  check and the dashed `git-commit` match, pass 5, were already case-insensitive), so a
  variant such as `git-COMMIT.exe` cannot skip the early exit and reach the dashed-binary
  match unseen.
- **Amended.** By spec pass 8 (2026-09-27): unquoted `(` and `)` become tokens of their own
  (like redirection operators, but kept; a `$(…)` substitution stays in its word), so
  `(git commit -m x)` is denied instead of passing as the token `(git`; a `(` in the
  subcommand position stays denied, and a `)` token ends `commit`'s arguments, so
  `(git commit --no-edit)` stays allowed. The subcommand is compared with `commit`
  case-insensitively (fail closed), so `git COMMIT -m x` is denied like `git commit -m x`.
  A Bash heredoc body is dropped, never read as a command (the body ends at the line equal
  to its delimiter), so a script written through `cat <<'EOF'` that contains `git commit`
  is not denied. The PowerShell reading of typographic quotes (pass 5) was verified on
  2026-09-27 with the PowerShell 7 parser, where `git co‘’mmit` parses to `commit`.
- **Amended.** By the tokenizer spike (PRE-03, 2026-09-29), which ran a prototype of the
  contract's parsing against 143 cases cross-checked with bash's own words and the
  PowerShell 5.1 and 7 parser API. The decided rules held (case-insensitive `git`, `commit`
  and subcommand; `(` and `)` as tokens; heredoc bodies dropped); its seven findings are
  settled, each with a wider fail-closed rule, a documented false positive or an accepted
  gap, none needing a parser beyond the hand-written design (unbash stays unvendored):
  - A subcommand token holding a backtick is denied (fail closed). An unquoted Bash
    backtick substitution splits into several tokens (`` git `echo commit` -m x `` gives
    `` `echo `` then `` commit` ``), so neither the `$` rule nor a literal `commit` caught
    it; a backtick is the same signal as `$`. In PowerShell a backtick survives quote
    removal only inside `'…'`, so the rule costs nothing there.
  - Bash `$'…'` (ANSI-C quoting) is read, with its backslash escapes decoded as Bash does.
    Read as `$` plus a single-quoted span, `$'\''` looked like an unterminated quote that
    swallowed the rest of the line, so `echo $'\'' ; git commit -m x` passed: a fail open
    that one more quoting form closes. As a bonus `git $'commit'` reads as the literal
    `commit`, as bash does. A decoded NUL (`\0`, `\x00`, `\u0000`, `\c@`, …) ends the
    `$'…'` span's value there (`git $'commit\0x'` is `git commit`, `$'ab\0cd'ef` is
    `abef`): Bash cuts the decoded string at the NUL, so reading on past it would hide
    `commit`.
  - A PowerShell NUL escape outside `'…'` (`` `0 ``, and `` `u{0} `` in PowerShell 7) ends
    the token's value there, and the words after it in the segment are dropped. Windows
    PowerShell 5.1 and PowerShell 7 both pass the native command line cut at the NUL
    (verified 2026-09-29), so `` git commit`0x -m x `` and `` git commit`0 --no-edit ``
    both run a bare `git commit`. Reading on past the NUL would hide `commit` in the first
    and keep an allowlisted `--no-edit` that git never sees in the second: two fail opens.
  - PowerShell unquoted `{` and `}` are tokens of their own, like `(` and `)`, and a `}`
    token ends `commit`'s arguments like `)`. PowerShell lets a script block glue its
    brace to the first word (`&{git commit -m x}`, `if ($true) {git commit -m x}`), so
    `git` was hidden in the token `{git`. Bash keeps braces in the word: there `{a,b}` is
    brace expansion (pass 5's subcommand rule relies on it) and a `{ …; }` group needs
    spaces anyway.
  - Bash process substitution `<(` / `>(` is read as `(`, not as a redirection. It runs its
    command like a subshell, and as a redirection its target was the `git` token, dropped
    with it, so `diff <(git commit -m x) f` passed.
  - Comments stay words, a documented false positive (fail closed):
    `git commit --no-edit # done` and `# git commit -m x` are denied in both shells, as is
    a PowerShell `<# … #>` block. Recognising comments needs word-start rules (`a#b`, `$#` and `${#x}`
    are not comments) and multi-line block comments; getting one wrong could hide a
    commit, while a false deny costs one turn and agents rarely comment a shell command.
  - Expansion in the command position (Bash brace expansion `{git,commit,-m,x}`, a glob
    such as `/usr/bin/gi? commit -m x`) joins the accepted gap of `$(echo git) commit`
    (below). An agent does not reach these forms by accident, the hook steers rather than
    guards, and denying every brace or glob in a command's first word would hit ordinary
    commands.
  - C:guard's example for the `$` rule, `git $c -m x`, never reaches the rule: its text
    has no `commit`, so the early exit ends it. The rule applies only when `commit` appears
    elsewhere in the command (`c=commit; git $c -m x`), as story 15 and GRD-12 already
    said; the contract's wording was fixed, the behaviour is unchanged.

  The case list, with the amended decisions, is GRD-03's fixture seed
  (`tests/fixtures/guard/segments-seed.json`), and the classes of case where the oracle
  deliberately differs from the tokenizer are listed in C:guard.
- **Rejected.**
  - Description tuning alone; the hook alone.
  - Git-native enforcement (a `pre-commit` / `commit-msg` hook, e.g. via `core.hooksPath`).
    It would also hit manual commits, needs a per-repo install, and clashes with husky and
    other hook managers.
- **Consequences.** The hook **steers** the agent to the worker; it is not a security boundary.
  Lint and scan are a gate only on the plugin path. Accepted gaps:
  - Every allowed form (`--no-edit`, `--amend --no-edit`, `--fixup=<commit>`, Q4) commits the
    current index unscanned: `git add . && git commit --amend --no-edit` gets past lint and
    scan.
  - Aliases (`git ci`), `git -c alias.x=commit x`.
  - Commands run through another interpreter: `sh -c '…'`, `bash -c '…'`, `cmd /c`, `pwsh -c`,
    scripts that wrap git (`xargs git commit` is denied: unquoted, it tokenizes to separate
    `git` and `commit` tokens).
  - Command substitution (`$(…)`, backticks) and variables anywhere but the subcommand
    position (`$(echo git) commit`), and Bash brace expansion or a glob in the command
    position (`{git,commit,-m,x}`, `/usr/bin/gi? commit -m x`); `GIT_DIR` / `GIT_WORK_TREE`
    redirection;
    config injected through env prefixes (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
    `GIT_CONFIG_VALUE_<n>`).
  - `.git/config` and `.git/hooks` are trusted as git itself trusts them: an untrusted repo
    can run code through `core.fsmonitor`, `filter.*.clean`, `core.hooksPath` or
    `gpg.program` during any git call the plugin makes.
  - Other paths to a commit that never run `git commit`: `git commit-tree`, `git am`, the
    replays of `git stash` and `git cherry-pick`, and shells provided by MCP servers (the
    hook's matcher covers only `Bash` and `PowerShell`).
  - A `commit` split by an escaped newline (Bash `\` plus newline, PowerShell backtick plus
    newline, as in `git com\` newline `mit`): the early-exit check removes the `\` or
    backtick but keeps the newline, so the command exits early unparsed, although the
    tokenizer would join the line.

  The hook sees only agent tool calls. Commits made by hand in a terminal, and `!`-prefixed
  prompt commands (verified 2026-09-26: they do not fire `PreToolUse`), are unaffected; they
  are the human-only channel Q10 relies on.
