'use strict';

// Parses the data rows of docs/spec/domain-code-cli-kind.md's table (RPL-03), the doc that
// is the oracle for both `lib/domain-codes.mjs` (tests/domain-codes.test.js) and the
// reachability manifest (tests/domain-code-reachability.test.js). Only the first column (the
// domain code or row description) is extracted; callers compare it against their own data.
// Modeled on tests/helpers/roadmap-graph.js: read the raw text, find the table by its header,
// stop at the first line after it that is not a `| ... |` row (the doc's prose resumes there).

const fs = require('node:fs');
const path = require('node:path');

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'spec', 'domain-code-cli-kind.md');
const TABLE_ROW_RE = /^\|(.+)\|$/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;

/**
 * @param {string} [content] defaults to reading DOC_PATH; a caller can pass fixed text for a
 *   parser test.
 * @returns {string[]} the first-column cell text of each data row, in table order.
 */
function parseDomainCodeDocRows(content = fs.readFileSync(DOC_PATH, 'utf8')) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  let inTable = false;
  let sawHeader = false;
  for (const line of lines) {
    const match = TABLE_ROW_RE.exec(line.trim());
    if (!match) {
      if (inTable) break; // the table is one contiguous block; anything after it ends the scan
      continue;
    }
    inTable = true;
    const firstCell = match[1].split('|')[0].trim();
    if (!sawHeader) {
      sawHeader = true; // the header row itself ("Domain code | Producer | ...")
      continue;
    }
    if (SEPARATOR_CELL_RE.test(firstCell)) continue; // the `--- | --- | ...` rule row
    rows.push(firstCell);
  }
  return rows;
}

// The part of a row's first-column text that names what it is, ignoring an explanatory
// aside: everything up to (not including) the first `(`, backticks stripped, trimmed. A row
// with no aside is its whole text. Used to compare a doc row against a manifest label that
// may itself carry a different (shorter, or differently annotated) aside.
function firstColumnKey(text) {
  return text.replace(/`/g, '').split('(')[0].trim();
}

module.exports = { parseDomainCodeDocRows, firstColumnKey, DOC_PATH };
