'use strict';

// Reads the fixed `callerRule` texts out of docs/contracts/reply-and-handback.md, the oracle
// for M17's rule constants (INT-01: "callerRule equal to the base rule text byte for byte").
// The doc wraps the quoted rule over several indented lines; a wrap is one space in the
// rule itself, so every line break with its indentation collapses to a single space.

const fs = require('node:fs');
const path = require('node:path');

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'contracts', 'reply-and-handback.md');

// The rule is the double-quoted text after the bullet's label; it holds no `"` of its own.
const BASE_RULE_RE = /^\s*- Base rule, always: "([^"]*)"/m;

// INT-05: the sibling bullet, nested under the same `callerRule` bullet as the base rule
// (one extra indent level, irrelevant to `\s*`), added to the base rule only for a
// `handback` reply.
const HANDBACK_RULE_RE = /^\s*- Handback rule, added when `handback` is set: "([^"]*)"/m;

/**
 * @param {string} [content] defaults to reading DOC_PATH; a caller can pass fixed text.
 * @returns {string} the base rule, with the doc's line wraps joined by single spaces.
 */
function parseBaseCallerRule(content = fs.readFileSync(DOC_PATH, 'utf8')) {
  const match = BASE_RULE_RE.exec(content);
  if (!match) throw new Error(`no "Base rule, always:" bullet found in ${DOC_PATH}`);
  return match[1].replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * @param {string} [content] defaults to reading DOC_PATH; a caller can pass fixed text.
 * @returns {string} the handback rule, with the doc's line wraps joined by single spaces.
 */
function parseHandbackRule(content = fs.readFileSync(DOC_PATH, 'utf8')) {
  const match = HANDBACK_RULE_RE.exec(content);
  if (!match) throw new Error(`no "Handback rule, added when \`handback\` is set:" bullet found in ${DOC_PATH}`);
  return match[1].replace(/\s*\r?\n\s*/g, ' ');
}

module.exports = { parseBaseCallerRule, parseHandbackRule };
