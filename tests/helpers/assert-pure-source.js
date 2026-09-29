'use strict';

// Shared purity check for the pure modules in `plugin/scripts/lib/` (module map:
// docs/spec/modules*.md marks each module pure or effectful). A pure module may still
// import specific pure exports named in `allowImports` (e.g. M8 imports M7, M14 imports M6
// and M8, M19 imports M6 and M4's pure `validateLayer` even though M4 itself is effectful);
// every other import, `require`, or ambient-state access fails. Comments are stripped
// before matching, so a comment that merely mentions a banned word (e.g. documenting why
// `process` is not used) does not fail the check.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath } = require('./load-lib');

// Keywords after which a `/` starts a value (a regex literal), not division, even though
// the keyword itself ends in a word character just like an identifier would.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'throw', 'in', 'of', 'await', 'yield', 'void', 'delete',
  'else', 'instanceof', 'new',
]);

// Strips `//` and `/* */` comments in a single pass, leaving string and regex literals
// (which may themselves contain `//`, e.g. `'http://x'` or `/\//`) untouched, so a comment
// stripped from inside one of those doesn't swallow the rest of the line with it.
// Known limitation: a template literal nested inside `${}` is not tracked (rare).
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // The last non-whitespace character copied to `out`, used to tell a regex literal
  // (starts where a value is expected) from division (follows an identifier, number, `)`,
  // or `]`).
  let lastChar = '';
  // The identifier word just completed (e.g. `return`), tracked separately from `lastChar`
  // so it survives intervening whitespace; used to tell a regex literal after a keyword
  // (e.g. `return /re/`) from division after a plain identifier (e.g. `a / b`).
  let lastWord = '';
  let currentWord = '';

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (!/[\w$]/.test(c) && currentWord) {
      lastWord = currentWord;
      currentWord = '';
    }

    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      lastChar = quote;
      continue;
    }

    // A `/` normally starts a regex literal only where a value is expected (not right after
    // an identifier, number, `)`, or `]`); but a keyword like `return` or `typeof` also ends
    // in a word character, so check whether the just-completed word is one of those keywords.
    const afterRegexKeyword = /[a-zA-Z_$]/.test(lastChar) && REGEX_PRECEDING_KEYWORDS.has(lastWord);
    if (c === '/' && (!/[\w$)\]]/.test(lastChar) || afterRegexKeyword)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') {
          inClass = true;
        } else if (source[j] === ']') {
          inClass = false;
        } else if (source[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        out += source.slice(i, j + 1);
        i = j + 1;
        lastChar = '/';
        continue;
      }
      // No closing `/` before end of line: not a regex literal, treat `/` as division.
    }

    out += c;
    if (!/\s/.test(c)) lastChar = c;
    if (/[\w$]/.test(c)) currentWord += c;
    i += 1;
  }

  return out;
}

// Matches a static import's specifier, with or without a `from` clause (side-effect-only
// imports), and an `export ... from` re-export, which reaches into another module just
// like an import does. Does not match dynamic `import(...)`, which is banned
// unconditionally below.
const STATIC_IMPORT =
  /^[ \t]*(?:import\s+(?:[^'";]*?from\s*)?|export\s+[^'";]*?from\s*)['"]([^'"]+)['"]/gm;

const AMBIENT_STATE = [
  [/\bimport\s*\(/, 'a dynamic import'],
  [/\bimport\.meta\b/, 'import.meta'],
  [/\brequire\s*\(/, 'require'],
  [/\bprocess\b/, 'process'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bDate\b/, 'the clock'],
  [/\bMath\.random\b/, 'randomness'],
  [/\bconsole\b/, 'console'],
];

/**
 * Assert that `source` (a pure module's text; `label` names it in failure messages) does no
 * I/O, reads no ambient state, and imports only the pure modules listed in `allowImports`
 * (exact specifiers, e.g. `./glob-matcher.mjs`).
 *
 * @param {string} source
 * @param {string} label
 * @param {{ allowImports?: string[] }} [options]
 */
function assertPureSourceText(source, label, { allowImports = [] } = {}) {
  const stripped = stripComments(source);

  for (const [pattern, what] of AMBIENT_STATE) {
    assert.doesNotMatch(stripped, pattern, `${label} must not use ${what}`);
  }

  STATIC_IMPORT.lastIndex = 0;
  let match;
  while ((match = STATIC_IMPORT.exec(stripped)) !== null) {
    const specifier = match[1];
    assert.ok(
      allowImports.includes(specifier),
      `${label} imports '${specifier}', which is not in allowImports (${allowImports.join(', ') || 'none'})`,
    );
  }
}

/**
 * Assert purity of `plugin/scripts/lib/<name>.mjs`. See `assertPureSourceText`.
 *
 * @param {string} name
 * @param {{ allowImports?: string[] }} [options]
 */
function assertPureSource(name, options = {}) {
  const source = readFileSync(libPath(name), 'utf8');
  assertPureSourceText(source, `${name}.mjs`, options);
}

module.exports = { assertPureSource, assertPureSourceText };
