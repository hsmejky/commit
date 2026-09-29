// M8 Scanner (C:scan-patterns). Pure: no I/O, no imports, no ambient state; every input
// arrives as an argument. A hit names a pattern ID and a location, never the matched value.

/**
 * @typedef {object} PatternRow One row of C:scan-patterns, as data.
 * @property {string} id the public pattern ID
 * @property {RegExp} regex the row's regex, with whole-regex flags only (no inline flags);
 *   the scanner adds `g` itself. It may add (named) capture groups to the contract's regex
 *   for its rule to read; they do not change what matches
 * @property {null | ((match: RegExpExecArray, context: RuleContext) => boolean)} notHit
 *   the row's false-positive rule ("Not a hit when"): true drops the match; `null` for none.
 *   Takes the full match array (`match[0]` the whole match, `match[1]…` its capture groups),
 *   so a row whose rule reads a captured value (the `generic-secret` value, the `local-path`
 *   user segment) can pick its own group instead of the whole match
 * @property {string} source where the row's shape and sample cases were checked against
 */

/**
 * @typedef {object} RuleContext What a false-positive rule sees besides its match.
 * @property {string | null} osUser the current OS user name, `null` when unknown
 * @property {string | null} osUserSegment `osUser`, lower-cased, when it is usable for
 *   `local-path`'s OS-user segment check (4 or more characters, not a placeholder or
 *   service user, per `isPlaceholderUser` — the illegal-character rule runs against
 *   `osUser` itself here, not only a matched segment); `null` otherwise. Computed once per
 *   scan (`scanText`/`scanUnits`), not once per matched segment (SCN-11)
 * @property {readonly string[]} lines the scanned lines around the match, in order: the
 *   added lines of the match's unit, or the lines of the message
 * @property {number} index the position of the match's line in `lines`, so a rule that
 *   spans lines (`private-key`'s body rule) reads `lines[index + 1]…`
 */

// `connection-string` placeholder passwords (C:scan-patterns): each shape matches the whole
// password, the words case-insensitively.
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{[^}]*\}|<[^>]*>|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\*{3,}|password|pass|secret)$/i;

// `local-path` placeholders and service users (C:scan-patterns), compared case-insensitively
// against the whole user segment. The bracketed and variable placeholders (`<…>`, `{…}`,
// `$USER`, `%USERNAME%`) never reach this list: the regexes stop at `<`, and `{`, `$`, `%`
// fall to the illegal-character rule.
const PATH_PLACEHOLDER_USERS = new Set([
  'user', 'username', 'you', 'me', 'name', 'example', 'node', 'root', 'ubuntu', 'admin',
  'runner', 'app', 'build', 'dev', 'src', 'docker', 'jenkins', 'vagrant', 'ec2-user',
  'www-data', 'git', 'circleci', 'gitpod', 'vscode', 'codespace', 'public', 'default',
]);

// A character no OS allows in a user name (C:scan-patterns).
const ILLEGAL_USER_CHARACTER = /[[\]()*+?|^${}<>%]/;

/**
 * Whether a `local-path` user segment is not a real user: a placeholder, a service user, or
 * a name holding a character no OS allows.
 *
 * @param {string} segment
 */
function isPlaceholderUser(segment) {
  return PATH_PLACEHOLDER_USERS.has(segment.toLowerCase()) || ILLEGAL_USER_CHARACTER.test(segment);
}

// `private-key` body rule (C:scan-patterns): a key body line starts, after trimming, with 40
// or more base64 characters; the RFC 1421 header lines of an encrypted PEM are not counted.
const KEY_BODY_LINE = /^[A-Za-z0-9+/=]{40,}/;
const RFC1421_HEADER_LINE = /^(?:Proc-Type|DEK-Info):/;
const KEY_BODY_LOOKAHEAD = 3;

/**
 * Whether a `private-key` header has a key body: on its own line right after it (a one-line
 * key), or within the next 3 non-blank lines, not counting RFC 1421 header lines. Literal
 * `\n` escapes after the header split its line into lines first (a flattened key).
 *
 * @param {RegExpExecArray} match
 * @param {RuleContext} context
 */
function hasKeyBody(match, { lines, index }) {
  const [rest, ...split] = match.input.slice(match.index + match[0].length).split('\\n');
  if (KEY_BODY_LINE.test(rest.trim())) return true;
  let counted = 0;
  for (const line of followingLines(split, lines, index)) {
    const text = line.trim();
    if (text === '' || RFC1421_HEADER_LINE.test(text)) continue;
    if (KEY_BODY_LINE.test(text)) return true;
    counted += 1;
    if (counted === KEY_BODY_LOOKAHEAD) return false;
  }
  return false;
}

/**
 * The lines after a header: the pieces its own line split into, then the following lines.
 *
 * @param {readonly string[]} split
 * @param {readonly string[]} lines
 * @param {number} index
 */
function* followingLines(split, lines, index) {
  yield* split;
  for (let next = index + 1; next < lines.length; next += 1) yield lines[next];
}

// `generic-secret` false-positive rule (C:scan-patterns): a low-entropy value, one holding a
// placeholder word (compared case-insensitively), or an unquoted value that is a call.
const MIN_SECRET_ENTROPY = 3.5;
const SECRET_PLACEHOLDER = /example|changeme|dummy|xxx|\$\{|<|process\.env|os\.environ/i;

// An unquoted `generic-secret` value that is a call, e.g. `fetchAccessToken()`,
// `get_password_from_env()`, `self._fetch_token(scope)` (C:scan-patterns): a bare identifier
// (optionally dotted, as a method call) followed by a parenthesised argument list running to
// the end of the value. The value never carries a trailing `;`, `,`, `#` or its own quotes
// (the row's regex lookahead stops there), so the call's closing `)` is always the value's
// last character.
const UNQUOTED_CALL_VALUE = /^[A-Za-z_$][\w$.]*\(.*\)$/;

/**
 * A `generic-secret` value without its quotes, alongside whether it was quoted: the call rule
 * only applies to an unquoted value.
 *
 * @param {string} value
 */
function unquote(value) {
  const quoted = value.startsWith('"') || value.startsWith("'");
  return { value: quoted ? value.slice(1, -1) : value, quoted };
}

/**
 * Whether a `generic-secret` value is not a secret: Shannon entropy below 3.5 bits per
 * character, a placeholder word in it, or (unquoted only) the value is a call.
 *
 * @param {string} value the value without quotes
 * @param {boolean} quoted whether the value was quoted before `unquote`
 */
function isPlaceholderSecret(value, quoted) {
  return (
    shannonEntropy(value) < MIN_SECRET_ENTROPY ||
    SECRET_PLACEHOLDER.test(value) ||
    (!quoted && UNQUOTED_CALL_VALUE.test(value))
  );
}

/**
 * Shannon entropy of a string in bits per character (code point).
 *
 * @param {string} text
 */
function shannonEntropy(text) {
  const chars = [...text];
  const counts = new Map();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / chars.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The pattern table of C:scan-patterns. A later row is one more entry here.
 *
 * `local-path`'s three fixed shapes are one regex: its `C:\Users\<name>` shape is
 * case-insensitive (flags `iu` in the contract) while the `/Users/<name>` and `/home/<name>`
 * shapes are not, so that alternative spells its letters as `[Uu]…` classes; one regex keeps
 * `C:/Users/<name>` one hit instead of a drive hit plus an overlapping `/Users/<name>` hit.
 * Its OS-user segment is a
 * second entry with the same ID: it matches every whole path segment and keeps only the
 * `osUser` name, independently of the fixed shapes, so neither can consume the other's text.
 * `scanUnits` reports one hit per ID and line either way.
 *
 * @type {readonly PatternRow[]}
 */
export const PATTERNS = Object.freeze([
  Object.freeze({
    id: 'aws-access-key',
    regex: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/,
    notHit: (match) => match[0].includes('EXAMPLE'),
    source: 'gitleaks, secretlint',
  }),
  Object.freeze({
    id: 'github-token',
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    notHit: null,
    source: 'GitHub token prefixes',
  }),
  Object.freeze({
    id: 'slack-token',
    regex: /\b(xox[abeoprs]-|xoxe\.xox[bp]-|xapp-\d-)[A-Za-z0-9-]{10,}/,
    notHit: null,
    source: 'gitleaks, secretlint',
  }),
  Object.freeze({
    id: 'anthropic-key',
    regex: /\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{93}AA(?![A-Za-z0-9_-])/,
    notHit: null,
    source: 'gitleaks, secretlint',
  }),
  Object.freeze({
    id: 'private-key',
    regex: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----/i,
    notHit: (match, context) => !hasKeyBody(match, context),
    source: 'gitleaks, secretlint',
  }),
  Object.freeze({
    id: 'connection-string',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?<password>[^\s/@]+)@/,
    notHit: (match) => PLACEHOLDER_PASSWORD.test(match.groups.password),
    source: 'secretlint',
  }),
  Object.freeze({
    id: 'generic-secret',
    regex:
      /(?<![A-Za-z0-9])[A-Za-z0-9_]*?(secret|token|passw(or)?d|api[_-]?key|client[_-]?secret)(?![A-Za-z0-9])(_[A-Za-z0-9_]*)?["']?\s*[:=]\s*(?<value>["'][^"'\s]{12,}["']|[^"'\s,;#]{12,}(?=[\s,;#]|$))/iu,
    notHit: (match) => {
      const { value, quoted } = unquote(match.groups.value);
      return isPlaceholderSecret(value, quoted);
    },
    source: 'gitleaks',
  }),
  Object.freeze({
    id: 'local-path',
    regex:
      /\b[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+(?<drive>[^\\/\s"'`<>]+)|\/(?:Users|home)\/(?<home>[^/\s"'`<>]+)/u,
    notHit: (match) => isPlaceholderUser(match.groups.drive ?? match.groups.home),
    source: 'this plugin (Q10)',
  }),
  Object.freeze({
    id: 'local-path',
    regex: /[\\/](?<segment>[^\\/]+)(?=[\\/])/,
    notHit: (match, { osUserSegment }) => !isOsUserSegment(match.groups.segment, osUserSegment),
    source: 'this plugin (Q10)',
  }),
]);

/**
 * The lower-cased OS user name usable for `local-path`'s OS-user segment check, or `null`
 * when there is no OS user, it is under 4 characters, or it is itself a placeholder or
 * service user (the illegal-character rule then applies to `osUser` itself, not only a
 * matched segment). Computed once per scan (`scanText`/`scanUnits`), not once per matched
 * segment (SCN-11).
 *
 * @param {string | null} osUser
 * @returns {string | null}
 */
function osUserSegmentName(osUser) {
  if (osUser === null || [...osUser].length < 4 || isPlaceholderUser(osUser)) return null;
  return osUser.toLowerCase();
}

/**
 * Whether a whole path segment is the current OS user's name, for `local-path`.
 *
 * @param {string} segment
 * @param {string | null} osUserSegment the precomputed usable OS user name, see
 *   `osUserSegmentName`
 */
function isOsUserSegment(segment, osUserSegment) {
  return osUserSegment !== null && segment.toLowerCase() === osUserSegment;
}

/**
 * @typedef {{ patternId: string, start: number, end: number }} TextHit
 *   UTF-16 offsets into the scanned text, `end` exclusive
 * @typedef {{ patternId: string, path: string, line: number }} UnitHit
 *   `line` is the added line's number in the new file, as the unit gives it
 * @typedef {{ line: number, text: string }} AddedLine
 * @typedef {{ path: string, oldPath: string | null, status: string, kind: string,
 *   addedLines: readonly AddedLine[] }} Unit
 *   A unit record from M10 (only the fields M8 reads)
 */

/**
 * Build a scanner over a pattern table. The module's own `scanText` and `scanUnits` are
 * this over `PATTERNS`; the factory exists so the engine's rules (offsets, overlapping
 * hits) can be checked independently of which rows the table holds.
 *
 * @param {readonly PatternRow[]} patterns
 */
export function createScanner(patterns) {
  const compiled = patterns.map((row) => ({
    row,
    regex: new RegExp(row.regex.source, `${row.regex.flags.replace(/[gy]/g, '')}g`),
  }));

  /**
   * Every hit on one line of `lines`, offsets relative to the line, sorted by start (table
   * order on a tie). Overlapping hits stay separate entries. The other lines are only
   * context for the rules.
   *
   * @param {readonly string[]} lines
   * @param {number} index
   * @param {string | null} osUser
   * @param {string | null} osUserSegment the precomputed `osUserSegmentName(osUser)`, passed
   *   in rather than recomputed per line or per matched segment (SCN-11)
   * @returns {{ patternId: string, start: number, end: number }[]}
   */
  function scanLine(lines, index, osUser, osUserSegment) {
    const line = lines[index];
    const context = { osUser, osUserSegment, lines, index };
    const hits = [];
    for (const { row, regex } of compiled) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(line)) !== null) {
        // A zero-length match (e.g. a table row whose regex can match empty) would leave
        // `lastIndex` unchanged and loop forever; step past it by one instead. This guards
        // any table passed to `createScanner`, not just the built-in `PATTERNS`.
        if (match[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        if (row.notHit === null || !row.notHit(match, context)) {
          hits.push({ patternId: row.id, start: match.index, end: match.index + match[0].length });
        }
      }
    }
    return hits.sort((a, b) => a.start - b.start);
  }

  /**
   * Scan a text (a normalised commit message) line by line.
   *
   * @param {string} text
   * @param {{ osUser?: string | null }} [options]
   * @returns {TextHit[]}
   */
  function scanText(text, { osUser = null } = {}) {
    const lines = text.split('\n');
    const osUserSegment = osUserSegmentName(osUser);
    const hits = [];
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      for (const hit of scanLine(lines, index, osUser, osUserSegment)) {
        hits.push({ patternId: hit.patternId, start: offset + hit.start, end: offset + hit.end });
      }
      offset += lines[index].length + 1;
    }
    return hits;
  }

  /**
   * Scan the added lines of units. A pattern hitting a line more than once is one hit,
   * since a hit's location is its path and line. `scanIgnore` (M4's compiled M7 matchers)
   * is part of the interface but not read yet: the unit-level rules (binaries, the 1 MB
   * skip, symlink targets, `scanIgnore`) are not implemented here yet, so `skipped` is
   * always empty.
   *
   * @param {readonly Unit[]} units
   * @param {{ scanIgnore?: readonly unknown[], osUser?: string | null }} [options]
   * @returns {{ hits: UnitHit[], skipped: { path: string, reason: string }[] }}
   */
  function scanUnits(units, { osUser = null } = {}) {
    const osUserSegment = osUserSegmentName(osUser);
    const hits = [];
    for (const unit of units) {
      const lines = unit.addedLines.map(({ text }) => text);
      unit.addedLines.forEach(({ line }, index) => {
        const seen = new Set();
        for (const { patternId } of scanLine(lines, index, osUser, osUserSegment)) {
          if (!seen.has(patternId)) {
            seen.add(patternId);
            hits.push({ patternId, path: unit.path, line });
          }
        }
      });
    }
    return { hits, skipped: [] };
  }

  return { scanText, scanUnits };
}

const scanner = createScanner(PATTERNS);

export const { scanText, scanUnits } = scanner;
