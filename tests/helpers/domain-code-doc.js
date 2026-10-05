'use strict';

// Parses the data rows of docs/spec/domain-code-cli-kind.md's table (RPL-03), the doc that
// is the oracle for both `lib/domain-codes.mjs` (tests/domain-codes.test.js) and the
// reachability manifest (tests/domain-code-reachability.test.js). Only the first column (the
// domain code or row description) is extracted by `parseDomainCodeDocRows`; INT-31's manifest
// also reads the Producer, CLI kind and Exit cells (`parseDomainCodeDocTable`).
// Modeled on tests/helpers/roadmap-graph.js: read the raw text, find the table by its header,
// stop at the first line after it that is not a `| ... |` row (the doc's prose resumes there).

const fs = require('node:fs');
const path = require('node:path');

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'spec', 'domain-code-cli-kind.md');
const TABLE_ROW_RE = /^\|(.+)\|$/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const EXPECTED_HEADER = 'Domain code | Producer | CLI kind | Exit';

/**
 * @param {string} [content] defaults to reading DOC_PATH; a caller can pass fixed text for a
 *   parser test.
 * @returns {{ code: string, producer: string, kind: string, exit: string }[]} each data row's
 *   four cells (Domain code, Producer, CLI kind, Exit), trimmed, in table order.
 * @throws if the table's header is not exactly "Domain code | Producer | CLI kind | Exit", or
 *   any row (including the header) does not split into exactly four cells: an escaped `\|` or
 *   a reordered header would otherwise misparse silently.
 */
function parseDomainCodeDocTable(content = fs.readFileSync(DOC_PATH, 'utf8')) {
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
    const cells = match[1].split('|').map((cell) => cell.trim());
    if (cells.length !== 4) {
      throw new Error(`domain-code-cli-kind.md row has ${cells.length} cells, not 4: ${line}`);
    }
    const [code, producer, kind, exit] = cells;
    if (!sawHeader) {
      const header = `${code} | ${producer} | ${kind} | ${exit}`;
      if (header !== EXPECTED_HEADER) {
        throw new Error(`domain-code-cli-kind.md header is ${JSON.stringify(header)}, not ${JSON.stringify(EXPECTED_HEADER)}`);
      }
      sawHeader = true; // the header row itself ("Domain code | Producer | ...")
      continue;
    }
    if (SEPARATOR_CELL_RE.test(code)) continue; // the `--- | --- | ...` rule row
    rows.push({ code, producer, kind, exit });
  }
  return rows;
}

/**
 * @param {string} [content] defaults to reading DOC_PATH.
 * @returns {string[]} the first-column cell text of each data row, in table order.
 */
function parseDomainCodeDocRows(content) {
  return parseDomainCodeDocTable(content).map((row) => row.code);
}

// The part of a row's first-column text that names what it is, ignoring an explanatory
// aside: everything up to (not including) the first `(`, backticks stripped, trimmed. A row
// with no aside is its whole text. Used to compare a doc row against a manifest label that
// may itself carry a different (shorter, or differently annotated) aside.
function firstColumnKey(text) {
  return text.replace(/`/g, '').split('(')[0].trim();
}

module.exports = { parseDomainCodeDocTable, parseDomainCodeDocRows, firstColumnKey, DOC_PATH };
