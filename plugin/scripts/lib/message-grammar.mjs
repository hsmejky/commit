// M6 Message grammar (C:message-grammar). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument.

// type, optional (scope), optional breaking `!`, `: `, description starting with a
// non-space character. The `u` flag, as every grammar regex.
const HEADER = /^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$/u;

const HEADER_REASON = "header is not 'type(scope)!: description'";

/**
 * Split a message into its parts. The header is the first line; `header` is `null` when
 * that line does not match the header regex.
 *
 * @param {string} message
 * @returns {{ header: { type: string, scope: string | null, breaking: boolean,
 *   description: string } | null }}
 */
export function parse(message) {
  const headerLine = message.split('\n', 1)[0];
  const match = HEADER.exec(headerLine);
  if (match === null) {
    return { header: null };
  }
  const [, type, , scope, bang, description] = match;
  return {
    header: { type, scope: scope ?? null, breaking: bang === '!', description },
  };
}

/**
 * Lint a message against the effective config values. Returns the failure reasons, in
 * rule order; an empty list means the message passes. A header that does not match the
 * regex gives only the header reason: no further rule runs on it.
 *
 * @param {string} message
 * @param {{ types: readonly string[], scope?: 'forbidden' | 'optional' | 'required' }} values
 * @returns {string[]}
 */
export function lint(message, values) {
  const { header } = parse(message);
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
  return reasons;
}
