// M6 Message grammar (C:message-grammar). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument.

// type, optional (scope), optional breaking `!`, `: `, description starting with a
// non-space character. The `u` flag, as every grammar regex.
const HEADER = /^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$/u;

const HEADER_REASON = "header is not 'type(scope)!: description'";

// Footer tokens (case-sensitive) an agent may write; the script appends every other
// trailer-shaped token itself (Q13, C:message-grammar).
const ALLOWED_FOOTER_TOKENS = new Set(['BREAKING CHANGE', 'BREAKING-CHANGE', 'Refs', 'Closes', 'Fixes']);

// A footer entry's own line: a token (`BREAKING CHANGE` or a word of ASCII letters, digits
// and hyphens starting with a letter), then `: ` or ` #` (captured as the separator, for
// verbatim carry-over, Q20/MSG-08), then the value.
const FOOTER_LINE = /^(BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)(.+)$/u;

// An indented continuation of the previous footer entry's value.
const CONTINUATION = /^[ \t]+(\S.*)$/u;

/**
 * The message's header line: everything up to (not including) the first `\n`, or the whole
 * message when it has none. Shared by `parse` and `lint` so the header line is split once.
 *
 * @param {string} message
 * @returns {string}
 */
function headerLineOf(message) {
  return message.split('\n', 1)[0];
}

/**
 * Group `lines` (the message after the header) into paragraphs: a paragraph is a maximal run
 * of consecutive non-blank lines, and any number of blank lines separates two paragraphs.
 *
 * @param {string[]} lines
 * @returns {string[][]}
 */
function paragraphsOf(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current);
  }
  return paragraphs;
}

/**
 * Parse `lines` as a footer paragraph: every line must either start a footer entry
 * (`FOOTER_LINE`) or continue the previous one (`CONTINUATION`, indented). A continuation
 * line's leading whitespace is stripped and the remainder appended to the entry's value,
 * joined by a newline; the continuation's original line (whitespace included) is appended to
 * the entry's `raw`, also joined by a newline. Returns `null` (the paragraph is body, not a
 * footer) when any line matches neither, including when the first line is itself a
 * continuation with nothing to continue.
 *
 * @param {string[]} lines
 * @returns {{ token: string, separator: string, value: string, raw: string }[] | null}
 */
function parseFooterParagraph(lines) {
  const entries = [];
  for (const line of lines) {
    const start = FOOTER_LINE.exec(line);
    if (start !== null) {
      entries.push({ token: start[1], separator: start[2], value: start[3], raw: line });
      continue;
    }
    const continuation = entries.length > 0 ? CONTINUATION.exec(line) : null;
    if (continuation !== null) {
      const last = entries[entries.length - 1];
      last.value = `${last.value}\n${continuation[1]}`;
      last.raw = `${last.raw}\n${line}`;
      continue;
    }
    return null;
  }
  return entries;
}

/**
 * Whether `line`, taken on its own, is a footer entry's own line (`FOOTER_LINE`): a token,
 * then `: ` or ` #`, then a non-empty value. An indented continuation line (`CONTINUATION`)
 * does not match: it only continues an entry already open in a paragraph. Shared by `parse`
 * (whole-paragraph footer parsing, via the same regex) and the attribution resolver (M5),
 * which tests a config value's lines independently rather than as a paragraph (Q5): the
 * value is not message prose, so M6's paragraph/continuation rules do not apply to it.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isFooterLine(line) {
  return FOOTER_LINE.test(line);
}

/**
 * Whether `description` (the header's description) satisfies the `subjectCase: lower` rule:
 * its first character is not an uppercase letter, unless the first word is an acronym (every
 * letter uppercase, at least two letters), which is exempt. Shared with `infer` (M19), which
 * uses it to measure the share of history that would pass this rule.
 *
 * @param {string} description
 * @returns {boolean}
 */
export function passesLowerCase(description) {
  if (!/^\p{Lu}/u.test(description)) {
    return true;
  }
  return /^\p{Lu}{2,}(?!\p{L})/u.test(description);
}

/**
 * Split a message into its parts. The header is the first line; `header` is `null` when
 * that line does not match the header regex. `body` lists the non-footer paragraphs after
 * the header, each paragraph's lines joined by `\n`, in order. `footer` is the last
 * paragraph's entries, in order, when that paragraph's every line is a footer entry or an
 * indented continuation of one; otherwise `null`, and that paragraph is the last element of
 * `body` instead (a footer-only last paragraph is not counted as body).
 *
 * @param {string} message
 * @returns {{ header: { type: string, scope: string | null, breaking: boolean,
 *   description: string } | null, body: string[],
 *   footer: { token: string, separator: string, value: string, raw: string }[] | null }}
 */
export function parse(message) {
  const lines = message.split('\n');
  const headerLine = headerLineOf(message);
  const match = HEADER.exec(headerLine);
  let header = null;
  if (match !== null) {
    const [, type, , scope, bang, description] = match;
    header = { type, scope: scope ?? null, breaking: bang === '!', description };
  }

  const paragraphs = paragraphsOf(lines.slice(1));
  let footer = null;
  let bodyParagraphs = paragraphs;
  if (paragraphs.length > 0) {
    const entries = parseFooterParagraph(paragraphs[paragraphs.length - 1]);
    if (entries !== null) {
      footer = entries;
      bodyParagraphs = paragraphs.slice(0, -1);
    }
  }

  return {
    header,
    body: bodyParagraphs.map((paragraphLines) => paragraphLines.join('\n')),
    footer,
  };
}

/**
 * Lint a message against the effective config values. Returns the failure reasons, in
 * rule order; an empty list means the message passes. A header that does not match the
 * regex gives only the header reason: no further rule runs on it. Every footer entry
 * (`parse`'s `footer`) whose token is not one of the allowed agent footer tokens
 * (`ALLOWED_FOOTER_TOKENS`) adds its own reason, case-sensitive, independent of `body`
 * (Q13, C:message-grammar) — this also catches a last paragraph such as `Note: see #12`.
 *
 * @param {string} message
 * @param {{ types: readonly string[], scope?: 'forbidden' | 'optional' | 'required',
 *   maxSubjectLength?: number, subjectCase?: 'lower' | 'any',
 *   body?: 'forbidden' | 'optional' }} values
 * @returns {string[]}
 */
export function lint(message, values) {
  const { header, body, footer } = parse(message);
  if (header === null) {
    return [HEADER_REASON];
  }
  const reasons = [];
  if (!values.types.includes(header.type)) {
    reasons.push(`type '${header.type}' not in types`);
  }
  if (values.scope === 'forbidden' && header.scope !== null) {
    reasons.push(`scope '${header.scope}' not allowed (scope: forbidden)`);
  } else if (values.scope === 'required' && header.scope === null) {
    reasons.push('scope required (scope: required)');
  }
  const headerLength = Array.from(headerLineOf(message)).length;
  if (headerLength > values.maxSubjectLength) {
    reasons.push(`header exceeds maxSubjectLength (${headerLength} > ${values.maxSubjectLength})`);
  }
  if (values.subjectCase === 'lower' && !passesLowerCase(header.description)) {
    reasons.push('description not lowercase (subjectCase: lower)');
  }
  if (footer !== null) {
    for (const entry of footer) {
      if (!ALLOWED_FOOTER_TOKENS.has(entry.token)) {
        reasons.push(
          `\`${entry.token}\` is not an allowed footer token. If this is body text, rephrase ` +
            'it or add a non-footer line to the paragraph.',
        );
      }
    }
  }
  if (values.body === 'forbidden' && body.length > 0) {
    reasons.push('body not allowed (body: forbidden)');
  }
  return reasons;
}
