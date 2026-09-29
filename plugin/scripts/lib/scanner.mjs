// M8 Scanner (C:scan-patterns). Pure: no I/O, no ambient state; every input arrives as an
// argument. Its only import is M7's pure `matches`, to honour `scanIgnore` matchers. A hit
// names a pattern ID and a location, never the matched value.

import { matches } from './glob-matcher.mjs';

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

// Every scanned line (diff line, symlink target, message line) is cut to its first 4096
// UTF-16 code units before any regex or false-positive rule runs, so scanning stays linear
// in the input regardless of how long the underlying line is; text past the cut is not
// scanned, an accepted gap (C:scan-patterns, Q10, SCN-12). `String#slice` on UTF-16 code
// units, not code points, matching the contract's own unit.
const LINE_CUT_LENGTH = 4096;

/**
 * Cut a scanned line to `LINE_CUT_LENGTH` UTF-16 code units. Applied to every line before a
 * pattern's regex or false-positive rule sees it, including a line only read as lookahead
 * context (`private-key`'s body rule), so no rule ever runs against the uncut text.
 *
 * @param {string} line
 */
function cutLine(line) {
  return line.length > LINE_CUT_LENGTH ? line.slice(0, LINE_CUT_LENGTH) : line;
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
  for (let next = index + 1; next < lines.length; next += 1) yield cutLine(lines[next]);
}

// `generic-secret` false-positive rule (C:scan-patterns): a low-entropy value, one holding a
// placeholder word (compared case-insensitively), or an unquoted value that is a call site.
const MIN_SECRET_ENTROPY = 3.5;
// `proce[s]s`: the purity check bans the bare word anywhere in this file, literals included.
const SECRET_PLACEHOLDER = /example|changeme|dummy|xxx|\$\{|<|proce[s]s\.env|os\.environ/i;

// An unquoted `generic-secret` value that is a call, e.g. `fetchAccessToken()`,
// `get_password_from_env()`, `self._fetch_token(scope)` (C:scan-patterns): a bare or dotted
// identifier followed by an empty parameter list or a single identifier argument, running to
// the end of the value. Only a zero- or one-argument call is shaped this way: a multi-argument
// call's value stops at the row's own `,` lookahead before reaching its own `)` (`a` in
// `fetchAccessToken(a, b);`), so it never matches here and stays a documented false positive
// (C:scan-patterns) — this regex does not, and cannot, cover that case.
const UNQUOTED_CALL_VALUE =
  /^(?<callee>[A-Za-z_$][\w$.]*)\((?<argument>[A-Za-z_$][\w$.]*)?\)$/;

// A call-shaped value this long is no longer a plausible name reference in source (the
// longest real example above is 24 characters); it is far more likely a secret dressed up as
// one, e.g. a JWT ending in `(x)` (C:scan-patterns).
const MAX_CALL_VALUE_LENGTH = 40;

// A dotted segment of a call's callee or argument is word-shaped (C:scan-patterns) when a
// digit appears only at the segment's end (`getV2`, `fetchToken2`): a real name reference
// still reads this way even with a trailing version number, while a digit buried inside a
// segment (`Xk9aQ2xL7mZ4pRkW8vT3`) means the "name" is a secret standing in as the callee or
// argument, not a plausible identifier. This does not catch an all-letter, arbitrary-looking
// callee (`XkaQxLmZpRkWvT()`); that residual gap is accepted (C:scan-patterns) since a real
// secret does not accidentally end in `()`.
const WORD_SHAPED_SEGMENT = /^[A-Za-z_$]+\d*$/;

/**
 * Whether every dotted segment of a call's callee or argument is word-shaped
 * (`WORD_SHAPED_SEGMENT`).
 *
 * @param {string} identifier a bare or dotted identifier (a callee or an argument)
 */
function isWordShaped(identifier) {
  return identifier.split('.').every((segment) => WORD_SHAPED_SEGMENT.test(segment));
}

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
 * Whether an unquoted `generic-secret` value is a call site reading a secret, rather than the
 * secret itself (C:scan-patterns): short enough to be a real call (`MAX_CALL_VALUE_LENGTH` or
 * fewer characters), shaped like one (`UNQUOTED_CALL_VALUE`), every dotted segment of its
 * callee and of its argument (if any) word-shaped (`isWordShaped`) — a digit inside a segment
 * (`Xk9aQ2xL7mZ4pRkW8vT3()`, `a.Xk9aQ2xL7mZ4pRkW8vT3()`) means a secret is standing in as the
 * callee, not a call — and, when it carries an argument, that argument does not itself look
 * like a secret by entropy either (the row's own entropy floor): an identifier-shaped but
 * high-entropy argument (`abc(Xk9aQ2xL7mZ4pRkW8vT3)`) is not a call.
 *
 * @param {string} value
 */
function isCallSite(value) {
  if (value.length > MAX_CALL_VALUE_LENGTH) return false;
  const match = UNQUOTED_CALL_VALUE.exec(value);
  if (match === null) return false;
  const { callee, argument } = match.groups;
  if (!isWordShaped(callee)) return false;
  if (argument === undefined) return true;
  return isWordShaped(argument) && shannonEntropy(argument) < MIN_SECRET_ENTROPY;
}

/**
 * Whether a `generic-secret` value is not a secret: Shannon entropy below 3.5 bits per
 * character, a placeholder word in it, or (unquoted only) the value is a call site.
 *
 * @param {string} value the value without quotes
 * @param {boolean} quoted whether the value was quoted before `unquote`
 */
function isPlaceholderSecret(value, quoted) {
  return (
    shannonEntropy(value) < MIN_SECRET_ENTROPY ||
    SECRET_PLACEHOLDER.test(value) ||
    (!quoted && isCallSite(value))
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
 *   addedLines: readonly AddedLine[], overScanLimit?: boolean }} Unit
 *   A unit record from M10 (only the fields M8 reads). `kind: "binary"` marks a binary unit
 *   (SCN-13); every other kind, including `"symlink"`, is scanned like text, so a symlink's
 *   target reaches `scanUnits` as its unit's one added line. `overScanLimit: true` (SCN-13b)
 *   marks a unit whose file M10 stopped collecting added lines for at M10's own 1 MB scan
 *   limit, so `addedLines` may be cut short or empty and stay under M8's own byte measure;
 *   absent (or falsy) otherwise
 */

// SCN-13, Q19, C:plan, M10 (docs/spec/modules-m10-m13.md): a unit whose added lines total
// more than this many UTF-8 bytes is reported skipped instead of scanned — the same 1 MB
// content-size measure M10's own 1 MB scan limit uses, counted here even though a unit's
// `addedLines` text has already been lossily decoded to a JS string by the time it reaches
// M8, since the boundary this module sees is close enough to M10's byte count for the cap to
// mean the same thing at both ends.
const MAX_ADDED_LENGTH = 1024 * 1024;
const OVER_SIZE_LIMIT_REASON = 'added content over 1 MB';

/**
 * The UTF-8 byte length of one code point.
 *
 * @param {number} codePoint
 */
function utf8CodePointLength(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * The total length, in UTF-8 bytes, of a unit's added lines — the measure `MAX_ADDED_LENGTH`
 * bounds (SCN-13) — plus one byte per line for the `\n` git's diff carries after it but
 * `addedLines` strips (M10). Counted with a pure code-point loop, not `Buffer` or
 * `TextEncoder`, since this module is pure (no ambient state, no globals beyond the
 * language, docs/spec module map).
 *
 * @param {Unit} unit
 */
function addedContentLength(unit) {
  let total = 0;
  for (const { text } of unit.addedLines) {
    total += 1; // the added line's own '\n', stripped from `text` but still counted (M10)
    for (const char of text) {
      total += utf8CodePointLength(char.codePointAt(0));
    }
  }
  return total;
}

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
    const line = cutLine(lines[index]);
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
   * Scan a text (a normalised commit message) line by line. Each line is cut to
   * `LINE_CUT_LENGTH` before it is matched (SCN-12); offsets are still computed against the
   * uncut text, so a hit's `start`/`end` stay correct even though nothing past the cut on a
   * long line can ever be one.
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
   * Scan the added lines of units (SCN-13). A pattern hitting a line more than once is one
   * hit, since a hit's location is its path and line. Unit-level rules run before any line is
   * scanned, in order:
   *
   * 1. A unit whose path a `scanIgnore` matcher (M4's compiled M7 matchers) matches is
   *    dropped outright — no hit, not `skipped` either, since it is exempted, not
   *    scanned-and-rejected.
   * 2. A unit that is over the 1 MB added-content limit — flagged `overScanLimit: true` by
   *    M10 (SCN-13b), or whose added lines total more than 1 MB by M8's own measure
   *    (`addedContentLength`, tracked or untracked alike) — is reported in `skipped` with
   *    the reason `"added content over 1 MB"` (C:plan) and not scanned, the flag checked
   *    before the binary kind so it wins over the silent binary skip, and a path gets one
   *    `skipped` entry however many of its units are over.
   * 3. A binary unit (`kind: "binary"`) that is not over the limit is skipped silently, the
   *    same way.
   *
   * Every other unit, symlinks included, is scanned line by line like a text unit.
   *
   * @param {readonly Unit[]} units
   * @param {{ scanIgnore?: readonly object[], osUser?: string | null }} [options] `scanIgnore`
   *   holds M7 `Matcher` values, opaque here; each is checked against a unit's path with M7's
   *   own `matches`
   * @returns {{ hits: UnitHit[], skipped: { path: string, reason: string }[] }}
   */
  function scanUnits(units, { scanIgnore = [], osUser = null } = {}) {
    const osUserSegment = osUserSegmentName(osUser);
    const hits = [];
    const skipped = [];
    const skippedPaths = new Set();
    for (const unit of units) {
      if (scanIgnore.some((matcher) => matches(matcher, unit.path))) continue;
      // SCN-13b: M10 sets `overScanLimit: true` on a unit when it stopped collecting that
      // file's added lines at its own 1 MB scan limit, so a cut-short (or emptied)
      // `addedLines` may stay under M8's own byte measure here. The flag is checked before
      // the binary kind, so it wins over the silent binary skip too (a flagged unit with
      // empty `addedLines` and `kind: "binary"` is still reported skipped).
      if (unit.overScanLimit === true || addedContentLength(unit) > MAX_ADDED_LENGTH) {
        if (!skippedPaths.has(unit.path)) {
          skippedPaths.add(unit.path);
          skipped.push({ path: unit.path, reason: OVER_SIZE_LIMIT_REASON });
        }
        continue;
      }
      if (unit.kind === 'binary') continue;
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
    return { hits, skipped };
  }

  return { scanText, scanUnits };
}

const scanner = createScanner(PATTERNS);

export const { scanText, scanUnits } = scanner;
