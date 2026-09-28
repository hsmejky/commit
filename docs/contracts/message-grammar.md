# Message grammar

`check` reads the message as bytes (`plan.groups.json`), normalised first:

1. UTF-8 BOM stripped; a UTF-16 LE or BE BOM → decoded as UTF-16.
2. Invalid UTF-8 (U+FFFD after decoding) → lint error `message not UTF-8`.
3. CRLF and lone CR → LF.
4. Trailing blank lines trimmed; exactly one trailing LF.

Structure: header line, blank line, optional body, optional footer paragraph. All regexes use
the `u` flag.

- Header regex: `^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$` → type, scope, breaking
  flag, description. A header that does not match this regex fails lint with the reason
  `header is not 'type(scope)!: description'`, and no type check runs (so `Feat: x` fails
  here, on the uppercase first character, never on its type).
- `type` must be in `types` (reason `type '<type>' not in types`); `scope` must obey `scope`.
- `maxSubjectLength` counts the **code points** of the whole header line.
- `subjectCase: lower`: fails only when the first character of the description is an
  uppercase letter (`\p{Lu}`), unless the first word is all uppercase with at least two
  letters (`API`, `CI`). Digits, backticks, quotes and symbols pass. `infer` uses the same
  function.
- Footer paragraph: the last paragraph (not the header), where every line matches
  `^(BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)(.+)$`, or starts with whitespace and
  continues the previous footer. If any line fails, the whole paragraph is body.
- Allowed footer tokens (case-sensitive): `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`,
  `Closes`, `Fixes`. Any other token fails lint with: "`<token>` is not an allowed footer
  token. If this is body text, rephrase it or add a non-footer line to the paragraph."
- `body: forbidden`: no paragraph besides the header and a footer paragraph.
- Trailers, added by `commit` after lint, in this order after the message's own footers:
  1. `reword` only: trailers carried over from the **old** message's footer paragraph. Not
     carried: allowed tokens (the new message owns them) and any
     `Co-Authored-By: … <noreply@anthropic.com>`. Everything else (`Signed-off-by`, a human
     `Co-Authored-By`, `Change-Id`, …) is carried verbatim, in its original order.
  2. The attribution's trailer-shaped lines, when the group's `attribution` is `true`:
     always in `split` and `staged`; in `reword` when `source` is `worker` or the old
     message had a `Co-Authored-By: … <noreply@anthropic.com>` trailer (Q20).

  They go into the footer paragraph when the message ends in one, otherwise into a new
  paragraph. `git commit` runs with `--cleanup=verbatim`, so the committed message is
  exactly the one lint approved plus these trailers.
