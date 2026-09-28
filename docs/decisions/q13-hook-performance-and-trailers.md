# Q13 Hook performance and trailers

- **Context.** The hook runs on every shell tool call in every repo where the plugin is
  enabled. Separately, the harness asks the agent to add a footer, which must not reach the
  message through the agent.
- **Decision.**
  - Use a hook `if` condition (`Bash(git *)`, `PowerShell(git *)`, plus `Bash(node
    *commit.cjs*)` and `PowerShell(node *commit.cjs*)` for the heartbeat, Q23; these only decide
    when the hook runs and grant nothing, unlike the anchored allow rules, Q16) if it reliably
    catches compound commands; otherwise match without `if` and exit early in the script when
    the command does not contain `commit`. Reliable detection beats saved milliseconds.
  - Footers use the Conventional Commits footer grammar, implemented by the script's own
    parser ([contracts](../contracts/message-grammar.md)): the last paragraph, every line either
    `Token: value` or `Token #value`, where the token is `BREAKING CHANGE` or a word of
    ASCII letters, digits and hyphens starting with a letter;
    indented lines continue the previous footer. A `Note: …` line in an earlier paragraph,
    or next to non-footer lines, is body text.
  - The agent may write only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes` and
    `Fixes` footers. Any other token (`Co-Authored-By`, `Signed-off-by`, …) fails lint; only
    the script adds those (Q5, Q20). `!` in the header is allowed. A last paragraph such as
    `Note: see #12` parses as a footer with a disallowed token, so the lint error says what to
    do: "`Note` is not an allowed footer token. If this is body text, rephrase it or add a
    non-footer line to the paragraph." The worker's lint retry can fix it on its own.
  - A footer-only final paragraph is not a body, so it is allowed under `body: forbidden`.
- **Amended.** By spec pass 3 (2026-09-27): the guard's cold-start time is
  an open verification item: it is measured for the exec-form hook on all three OSes, and
  the target is set, before the guard slice claims one. `module.enableCompileCache` for
  the cold start is deferred past 0.1.0 (see [Non-goals](non-goals.md)).
- **Rejected.**
  - Rejecting every trailer: makes `BREAKING CHANGE:`, `Refs:` and `Closes #n` impossible.
  - `git interpret-trailers`. Spike on git 2.54 (2026-09-26): `--parse` ignores
    `BREAKING CHANGE: …` and `Closes #12`; a paragraph mixing `Refs:` with `BREAKING CHANGE:`
    is not parsed at all; `trailer.separators=':#'` rewrites `Closes #12` to `Closes: 12`;
    `--trailer` after a `BREAKING CHANGE` paragraph starts a new paragraph.
- **Consequences.** A harness instruction to add a footer has no path into the message. Lint,
  append (Q5) and `infer` (Q7) share one footer parser.
