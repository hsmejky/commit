# 03 Message grammar

M6, the message grammar: byte normalisation, the one parser for header, body and footers,
lint against the config, the allowed agent footer tokens, reword carry-over and trailer
append. `parse` and `lint` are tested in-process at Seam 3 from C:message-grammar; the byte
normalisation, the append and the carry-over are tested through `check`, `commit` and
reword at Seam 1, so those slices widen the paths other groups open. Main sources: M6,
C:message-grammar, Q5, Q7, Q13, Q20, stories 106, 118-121, 123-125.

## MSG-01: Header parse and type lint (tracer)

**What to build:** the thinnest M6: `parse` splits a header-only message into type, scope,
breaking flag and description with the header regex of C:message-grammar (`u` flag), and
`lint` checks the type against the config's `types`, returning a list of reasons. A
header-only `feat: add x` passes under the default types; `Feat: add x` fails.

**Blocked by:** FND-01.

**Status:** ready-for-agent

**Sources:** C:message-grammar (header regex, `type`), Q6 (default types), story 106,
spec Seam 3.

- [ ] Seam 3 table: `feat: add x` parses to type `feat`, no scope, no breaking flag,
      description `add x`, and lints clean under the 11 default types.
- [ ] Seam 3 table: a type outside `types` (`wip: x`) and an uppercase type (`Feat: x`)
      each give one reason naming the type (the reason text C:check shows, e.g.
      "type 'Feat' not in types").
- [ ] A header that does not match the regex (no `: ` separator, empty description) gives
      a header-shape reason, not a throw.
- [ ] `parse` and `lint` are pure and exported for M14, M19 and M5; `lint` takes the config
      values as an argument and reads nothing else.


## MSG-02: Scope rule and breaking flag

**What to build:** `lint` enforces `scope: forbidden | optional | required` and accepts the
`!` breaking flag, with the header regex's scope rules (no whitespace or parentheses inside
the scope).

**Blocked by:** MSG-01.

**Status:** ready-for-agent

**Sources:** C:message-grammar, Q6 (`scope`), Q13 (`!` allowed), story 106.

- [ ] Seam 3 table: `feat(api): x` fails under `forbidden`, passes under `optional` and
      `required`; `feat: x` fails under `required` only.
- [ ] Seam 3 table: `feat!: x` and `feat(api)!: x` parse with the breaking flag set and
      lint clean where the scope rule allows.
- [ ] Seam 3 table: `feat(a b): x`, `feat(): x` and `feat((a)): x` are header-shape
      failures.


## MSG-03: Subject length in code points and the lowercase rule

**What to build:** `lint` enforces `maxSubjectLength` over the code points of the whole
header line and `subjectCase: lower | any`, with the acronym exception; the case check is a
separately exported function that M19 reuses.

**Blocked by:** MSG-01.

**Status:** ready-for-agent

**Sources:** C:message-grammar (`maxSubjectLength`, `subjectCase`), Q6, Q7 (shared
function), stories 106, 123.

- [ ] Seam 3 table: a header of exactly `maxSubjectLength` code points passes, one more
      fails; a header with astral characters (emoji) is counted in code points, not UTF-16
      units, so it passes where a `.length` count would fail.
- [ ] Seam 3 table under `lower`: `feat: Add x` fails; `feat: API change`, `feat: CI
      matrix`, `feat: 2fa`, a description starting with a backtick, a quote or a symbol
      all pass; `feat: A thing` fails (a one-letter uppercase word is not an acronym).
- [ ] Seam 3 table under `any`: `feat: Add x` passes.
- [ ] The lowercase check is exported on its own and is the one M19 calls (no second
      implementation).


## MSG-04: Paragraphs, footer grammar and the body rule

**What to build:** `parse` splits the message into header, body paragraphs and an optional
footer paragraph by the Conventional Commits footer grammar of C:message-grammar
(`Token: value`, `Token #value`, `BREAKING CHANGE`, indented continuation lines; one failing
line makes the whole paragraph body), and `lint` enforces `body: forbidden | optional`,
where a footer-only last paragraph is not a body.

**Blocked by:** MSG-01.

**Status:** ready-for-agent

**Sources:** C:message-grammar (footer paragraph, `body: forbidden`), Q13, stories 106, 121.

- [ ] Seam 3 table: `Closes #12`, `Refs: abc`, `BREAKING CHANGE: x` with an indented
      continuation line each parse as a footer paragraph with the right tokens and values.
- [ ] Seam 3 table: a last paragraph mixing `Refs: x` with a plain sentence parses as body;
      a `Note: x` line in an earlier paragraph is body.
- [ ] Seam 3 table under `body: forbidden`: header plus `Closes #12` passes (story 121);
      header plus a prose paragraph fails; header plus prose plus footers fails.
- [ ] `parse` exposes the footer paragraph's entries in order, for M5 (trailer-shaped
      lines), M19 (footer is not a body) and the append (MSG-07).


## MSG-05: Allowed agent footer tokens and the `Note:` hint

**What to build:** `lint` allows only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes`
and `Fixes` (case-sensitive) in the message's own footer paragraph; any other token fails
with the fixed hint text, so an agent cannot write `Co-Authored-By` or `Signed-off-by` and
the worker's retry can fix a `Note:` paragraph on its own.

**Blocked by:** MSG-04.

**Status:** ready-for-agent

**Sources:** C:message-grammar (allowed footer tokens), Q13, stories 119, 120.

- [ ] Seam 3 table: each allowed token passes; `refs: x` (wrong case) fails.
- [ ] Seam 3 table: `Co-Authored-By: Claude <noreply@anthropic.com>` and `Signed-off-by: A
      <a@b>` in the message fail lint (story 119).
- [ ] Seam 3 table: a last paragraph `Note: see #12` fails with exactly "`Note` is not an
      allowed footer token. If this is body text, rephrase it or add a non-footer line to
      the paragraph."


## MSG-06: Byte normalisation of messages read by `check`

**What to build:** M6 `normalise` turns the message bytes `check` reads from the worker plan
into the text lint sees: UTF-8 BOM stripped, UTF-16 LE or BE (by BOM) decoded, invalid UTF-8
a lint error (`TextDecoder` `fatal`), CRLF and lone CR to LF, trailing blank lines trimmed to
one trailing LF. Tested where the spec puts it: lint through `check` at Seam 1.

**Blocked by:** MSG-04, PLN-06.

**Status:** ready-for-agent

**Sources:** C:message-grammar (normalisation steps 1-4), M6, Q9, story 124,
spec testing-modules (M6 lint through `check`).

- [ ] Seam 1: a worker plan whose message has a UTF-8 BOM, CRLF line ends and trailing
      blank lines passes `check` (a header with a trailing CR would fail the header regex
      without normalisation).
- [ ] Seam 1: a message encoded as UTF-16 LE with BOM and one as UTF-16 BE with BOM pass
      `check` like their UTF-8 form.
- [ ] Seam 1: a message with an invalid UTF-8 byte fails `check` with exit 2 and the error
      `message not UTF-8`, and nothing is committed.
- [ ] Seam 1, once `check` commits (needs EXE: one group committed): the committed message
      has LF line ends and exactly one trailing LF.


## MSG-07: Trailers appended to committed messages

**What to build:** M6 `appendTrailers` adds the stored attribution trailer after lint: into
the message's footer paragraph when it ends in one, otherwise as a new last paragraph, in
the order new footers, (carried trailers,) attribution. The committed message is exactly
the lint-approved message plus these trailers.

**Blocked by:** MSG-04, CFG-08, EXE-03, INT-02.

**Status:** ready-for-agent

**Sources:** C:message-grammar (trailers), Q5, Q13, M6, M16, stories 118, 119, 125.

- [ ] Seam 1: a header-only message commits as header, blank line, `Co-Authored-By:
      Claude <noreply@anthropic.com>` (the default trailer) when no settings layer defines
      attribution.
- [ ] Seam 1: a message ending in `Closes #12` commits with the trailer appended to that
      same paragraph (no blank line between them).
- [ ] Seam 1: a message ending in a body paragraph gets the trailer as a new paragraph.
- [ ] Seam 1: with attribution resolved to `null` (`includeCoAuthoredBy: false`), the
      committed message equals the lint-approved message byte for byte.
- [ ] Seam 1: a trailer instruction inside the worker plan's message text cannot add a
      trailer (it fails lint per MSG-05); the only trailer is the resolved one (story 119).
- [ ] Seam 1: the INT-02 First-slice run (`plan` → `check`) now commits the planned header
      plus the default trailer, and the `committed` reply's `text` holds the trailer line.


## MSG-08: Reword carry-over of foreign trailers

**What to build:** M6 `carryOver` takes the old message's footer paragraph on a reword and
keeps every foreign trailer (`Signed-off-by`, a human `Co-Authored-By`, `Change-Id`, …)
verbatim and in order, drops the allowed tokens (the new message owns them) and every
`Co-Authored-By: … <noreply@anthropic.com>`; `appendTrailers` then writes new footers,
carried trailers, attribution.

**Blocked by:** MSG-07, EXE-20, PLN-07.

**Status:** ready-for-agent

**Sources:** C:message-grammar (trailer order, reword carry-over), Q20, M6, M14.

- [ ] Seam 1: rewording a commit whose footer holds `Signed-off-by: A <a@b>`, `Change-Id:
      I1` and a human `Co-Authored-By` keeps all three verbatim, in their original order,
      after the new message's own footers.
- [ ] Seam 1: an old `Refs: x` is not carried; the old
      `Co-Authored-By: Claude <noreply@anthropic.com>` is dropped and, since it was present,
      the resolved attribution is appended once after the carried trailers.
- [ ] Seam 1: a dictated reword (`source: user`) of an old message with no noreply trailer
      gets no attribution trailer; the same with `source: worker` gets one.
- [ ] Seam 1: an old message whose last paragraph is body (not a footer paragraph) carries
      nothing.
