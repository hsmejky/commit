'use strict';

// Parses a plugin agent's Markdown file into its YAML frontmatter block and body.
//
// This repo has no YAML dependency (Q1: zero npm dependencies), so this is a minimal
// hand-written parser for the one shape the plugin's agent frontmatter actually uses:
// flat `key: value` lines, no lists, no nested maps, no multi-line scalars. A value is
// either a bare scalar (trimmed as-is: `sonnet`, `true`, `25`, `Bash, PowerShell, Read,
// Write`) or a double-quoted string with `\"` escapes for a literal `"` (used by
// `description`, which quotes "commit this" inline). It throws on anything else, so an
// agent file that outgrows this shape fails loudly instead of parsing wrong.

const fs = require('node:fs');

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith("'")) {
    throw new Error(`single-quoted scalars are not supported: ${rawValue}`);
  }
  if (/\s#/.test(value)) {
    throw new Error(`comments are not supported in a scalar: ${rawValue}`);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new Error(`unterminated quoted scalar: ${rawValue}`);
    }
    const inner = value.slice(1, -1);
    if (/\\(?!")/.test(inner)) {
      throw new Error(`unsupported backslash escape in quoted scalar: ${rawValue}`);
    }
    return inner.replace(/\\"/g, '"');
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

// Reads `filePath` and returns { source, attrs, body }: `attrs` is the parsed frontmatter
// as a plain object, `body` is everything after the closing `---` line (leading blank
// lines trimmed), `source` is the raw file text.
function parseAgentFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) {
    throw new Error(`no YAML frontmatter block (--- ... ---) found in ${filePath}`);
  }
  const [, frontmatterText, rest] = match;
  const attrs = {};
  for (const line of frontmatterText.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      throw new Error(`unparseable frontmatter line in ${filePath}: ${JSON.stringify(line)}`);
    }
    const [, key, rawValue] = keyMatch;
    attrs[key] = parseScalar(rawValue);
  }
  return { source, attrs, body: rest.replace(/^\r?\n+/, '') };
}

module.exports = { parseAgentFile };
