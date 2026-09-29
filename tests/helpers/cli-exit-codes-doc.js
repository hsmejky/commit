'use strict';

// Parses the exit-code table ("| Code | Kinds | Meaning |") of docs/contracts/cli-and-exit-
// codes.md (RPL-03), the doc that is the oracle for `lib/cli.mjs`'s EXIT_CODES map. Modeled
// on tests/helpers/roadmap-graph.js: read the raw text, find the table by its header, stop at
// the first line after it that is not a `| ... |` row.

const fs = require('node:fs');
const path = require('node:path');

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'contracts', 'cli-and-exit-codes.md');
const TABLE_ROW_RE = /^\|(.+)\|$/;
const HEADER_FIRST_CELL = 'Code';
const SEPARATOR_CELL_RE = /^:?-+:?$/;

/**
 * @param {string} [content] defaults to reading DOC_PATH; a caller can pass fixed text for a
 *   parser test.
 * @returns {Set<string>} every kind named in the table's "Kinds" column, across every code
 *   row (the "—" of the `0` row names none).
 */
function parseDocumentedKinds(content = fs.readFileSync(DOC_PATH, 'utf8')) {
  const lines = content.split(/\r?\n/);
  const kinds = new Set();
  let inTable = false;
  let sawHeader = false;
  for (const line of lines) {
    const match = TABLE_ROW_RE.exec(line.trim());
    if (!match) {
      if (inTable) break; // the table is one contiguous block; prose after it ends the scan
      continue;
    }
    const cells = match[1].split('|').map((c) => c.trim());
    if (!sawHeader) {
      if (cells[0] !== HEADER_FIRST_CELL) continue; // a `| ... |` line before this table
      sawHeader = true;
      inTable = true;
      continue;
    }
    inTable = true;
    if (SEPARATOR_CELL_RE.test(cells[0])) continue; // the `--- | --- | ---` rule row
    for (const token of cells[1].split(',')) {
      const kind = token.replace(/`/g, '').trim();
      if (kind && kind !== '—') kinds.add(kind); // '—' is the '0' row's '—' (none)
    }
  }
  return kinds;
}

module.exports = { parseDocumentedKinds, DOC_PATH };
