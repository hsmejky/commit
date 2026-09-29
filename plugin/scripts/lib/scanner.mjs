// M8 Scanner (C:scan-patterns). Pure: no I/O, no imports, no ambient state; every input
// arrives as an argument. A hit names a pattern ID and a location, never the matched value.

/**
 * @typedef {object} PatternRow One row of C:scan-patterns, as data.
 * @property {string} id the public pattern ID
 * @property {RegExp} regex the row's regex, with whole-regex flags only (no inline flags);
 *   the scanner adds `g` itself
 * @property {null | ((match: RegExpExecArray, context: { osUser: string | null }) => boolean)} notHit
 *   the row's false-positive rule ("Not a hit when"): true drops the match; `null` for none.
 *   Takes the full match array (`match[0]` the whole match, `match[1]…` its capture groups),
 *   so a row whose rule reads a captured value (the `generic-secret` value, the `local-path`
 *   user segment) can pick its own group instead of the whole match
 * @property {string} source where the row's shape and sample cases were checked against
 */

/**
 * The pattern table of C:scan-patterns. A later row is one more entry here.
 *
 * @type {readonly PatternRow[]}
 */
export const PATTERNS = Object.freeze([
  Object.freeze({
    id: 'github-token',
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    notHit: null,
    source: 'GitHub token prefixes',
  }),
]);

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
   * Every hit on one line, offsets relative to the line, sorted by start (table order on a
   * tie). Overlapping hits stay separate entries.
   *
   * @param {string} line
   * @param {{ osUser: string | null }} context
   * @returns {{ patternId: string, start: number, end: number }[]}
   */
  function scanLine(line, context) {
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
    const context = { osUser };
    const hits = [];
    let offset = 0;
    for (const line of text.split('\n')) {
      for (const hit of scanLine(line, context)) {
        hits.push({ patternId: hit.patternId, start: offset + hit.start, end: offset + hit.end });
      }
      offset += line.length + 1;
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
    const context = { osUser };
    const hits = [];
    for (const unit of units) {
      for (const { line, text } of unit.addedLines) {
        const seen = new Set();
        for (const { patternId } of scanLine(text, context)) {
          if (!seen.has(patternId)) {
            seen.add(patternId);
            hits.push({ patternId, path: unit.path, line });
          }
        }
      }
    }
    return { hits, skipped: [] };
  }

  return { scanText, scanUnits };
}

const scanner = createScanner(PATTERNS);

export const { scanText, scanUnits } = scanner;
