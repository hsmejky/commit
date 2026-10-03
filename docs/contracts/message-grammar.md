# Message grammar

`check` reads the message as bytes (`plan.groups.json`), normalised first:

1. UTF-8 BOM stripped; a UTF-16 LE or BE BOM → decoded as UTF-16.
2. Invalid UTF-8 or UTF-16 (`TextDecoder`'s own `fatal` mode), or — for a message already
   decoded from JSON, with no bytes to decode — a lone surrogate (not well-formed Unicode) →
   lint error `message not UTF-8`.
3. CRLF and lone CR → LF.
4. Trailing blank lines (empty, or made of only spaces/tabs) trimmed; exactly one trailing LF.

Structure: header line, blank line, optional body, optional footer paragraph. All regexes use
the `u` flag.

- Header regex: `^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$` → type, scope, breaking
  flag, description. A header that does not match this regex fails lint with the reason
  `header is not 'type(scope)!: description'`, and no type check runs (so `Feat: x` fails
  here, on the uppercase first character, never on its type).
- `type` must be in `types` (reason `type '<type>' not in types`); `scope` must obey `scope`:
  `forbidden` with a scope present fails with `scope '<scope>' not allowed (scope:
  forbidden)`; `required` with no scope fails with `scope required (scope: required)`.
- `maxSubjectLength` counts the **code points** of the whole header line; over the limit
  fails with `header exceeds maxSubjectLength (<n> > <max>)`.
- `subjectCase: lower`: fails only when the first character of the description is an
  uppercase letter (`\p{Lu}`), unless the first word is all uppercase with at least two
  letters (`API`, `CI`). Digits, backticks, quotes and symbols pass. `infer` uses the same
  function, exported separately from `lint` as `passesLowerCase(description)`. A failure's
  reason is `description not lowercase (subjectCase: lower)`.
- A paragraph is a maximal run of consecutive non-blank lines after the header; any number
  of blank lines separates two paragraphs. Only the last paragraph is ever a footer; an
  earlier paragraph that happens to look like one (a `Note: x` line, say) is still body.
- Footer paragraph: the last paragraph (not the header), where every line matches
  `^(BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)(.+)$`, or starts with whitespace and
  continues the previous footer. If any line fails, the whole paragraph is body. A
  continuation line's leading whitespace is stripped and the remainder is appended to the
  entry's value, joined by `\n`; `parse` exposes each entry as `{ token, separator, value,
  raw }`, in order — `separator` is the captured `: ` or ` #`, and `raw` is the entry's
  original lines, verbatim, for reword carry-over (Q20).
- Allowed footer tokens (case-sensitive): `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`,
  `Closes`, `Fixes`. Any other token fails lint with: "`<token>` is not an allowed footer
  token. If this is body text, rephrase it or add a non-footer line to the paragraph."
- `body: forbidden`: no paragraph besides the header and a footer paragraph; a violation
  fails with `body not allowed (body: forbidden)`.
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
