// M6 Message grammar (C:message-grammar). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument.

// type, optional (scope), optional breaking `!`, `: `, description starting with a
// non-space character. The `u` flag, as every grammar regex.
const HEADER = /^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$/u;

const HEADER_REASON = "header is not 'type(scope)!: description'";

// A footer entry's own line: a token (`BREAKING CHANGE` or a word of ASCII letters, digits
// and hyphens starting with a letter), then `: ` or ` #`, then the value.
const FOOTER_LINE = /^(BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(?:: | #)(.+)$/u;

// An indented continuation of the previous footer entry's value.
const CONTINUATION = /^[ \t]+(\S.*)$/u;

/**
 * Group `lines` (already stripped of blank separator lines) into paragraphs: a paragraph is
 * a maximal run of consecutive non-blank lines, and any number of blank lines separates two
 * paragraphs.
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
 * joined by a newline. Returns `null` (the paragraph is body, not a footer) when any line
 * matches neither, including when the first line is itself a continuation with nothing to
 * continue.
 *
 * @param {string[]} lines
 * @returns {{ token: string, value: string }[] | null}
 */
function parseFooterParagraph(lines) {
  const entries = [];
  for (const line of lines) {
    const start = FOOTER_LINE.exec(line);
    if (start !== null) {
      entries.push({ token: start[1], value: start[2] });
      continue;
    }
    const continuation = entries.length > 0 ? CONTINUATION.exec(line) : null;
    if (continuation !== null) {
      const last = entries[entries.length - 1];
      last.value = `${last.value}\n${continuation[1]}`;
      continue;
    }
    return null;
  }
  return entries;
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
  const firstWord = /^\p{L}+/u.exec(description)?.[0] ?? '';
  const letters = Array.from(firstWord);
  return letters.length >= 2 && letters.every((ch) => /\p{Lu}/u.test(ch));
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
 *   footer: { token: string, value: string }[] | null }}
 */
export function parse(message) {
  const lines = message.split('\n');
  const headerLine = lines[0];
  const match = HEADER.exec(headerLine);
  const header =
    match === null
      ? null
      : (([, type, , scope, bang, description]) => ({
          type,
          scope: scope ?? null,
          breaking: bang === '!',
          description,
        }))(match);

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
 * regex gives only the header reason: no further rule runs on it.
 *
 * @param {string} message
 * @param {{ types: readonly string[], scope?: 'forbidden' | 'optional' | 'required',
 *   maxSubjectLength?: number, subjectCase?: 'lower' | 'any',
 *   body?: 'forbidden' | 'optional' }} values
 * @returns {string[]}
 */
export function lint(message, values) {
  const { header, body } = parse(message);
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
  const headerLine = message.split('\n', 1)[0];
  const headerLength = Array.from(headerLine).length;
  if (headerLength > values.maxSubjectLength) {
    reasons.push(`header exceeds maxSubjectLength (${headerLength} > ${values.maxSubjectLength})`);
  }
  if (values.subjectCase === 'lower' && !passesLowerCase(header.description)) {
    reasons.push('description not lowercase (subjectCase: lower)');
  }
  if (values.body === 'forbidden' && body.length > 0) {
    reasons.push('body not allowed (body: forbidden)');
  }
  return reasons;
}
