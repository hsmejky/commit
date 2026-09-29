'use strict';

// Shared purity check for the pure modules in `plugin/scripts/lib/` (module map:
// docs/spec/modules*.md marks each module pure or effectful). A pure module may still
// import specific pure exports named in `allowImports` (e.g. M8 imports M7, M14 imports M6
// and M8, M19 imports M6 and M4's pure `validateLayer` even though M4 itself is effectful);
// every other import, `require`, or ambient-state access fails. Comments are blanked, and
// string, regex and template-literal-text content is blanked, before matching, so a comment
// or a literal value that merely mentions a banned word (e.g. documenting why `process` is
// not used, or a regex that matches the word `process` in scanned text) does not fail the
// check; a template literal's `${…}` substitutions are real code and are still checked.
//
// The lexer fails closed: whenever it cannot be sure a span is a comment or a literal, it
// leaves the span as it is, so the banned-word check still sees it. Blanking real code would
// let an impure module pass; leaving a literal unblanked at worst fails a pure one, which
// the author then notices and fixes.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath } = require('./load-lib');

// Keywords after which a `/` starts a value (a regex literal), not division, even though
// the keyword itself ends in a word character just like an identifier would. Only counts
// when the word is not a property name (i.e. not right after `.` or `?.`, as in `a.in / b`).
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'throw', 'in', 'of', 'await', 'yield', 'void', 'delete',
  'else', 'instanceof', 'new',
]);

// A `/` guessed as the start of a regex literal is blanked only if what follows its closing
// `/` (after any flags and spaces) is something that can follow a regex: end of line,
// `.`, `)`, `,`, `;`, `]`, `}`, `:`, `?`, `==`/`!=`, `&&`, `||`. Division instead continues
// with an operand (`2`, `n`, `(`...), so e.g. `{} / 2 + process.x / 2` is kept as code.
const REGEX_FLAGS = /[dgimsuyv]/;
const REGEX_FOLLOW = /^(?:$|[\r\n.),;\]}:?]|[=!]=|&&|\|\|)/;

const isWordChar = (ch) => /[\w$]/.test(ch);
const isLineEnd = (ch) => ch === '\n' || ch === '\r';
// Line terminators stay as they are (keeps line structure), anything else blanks to ' '.
const blankText = (text) => text.replace(/[^\r\n]/g, ' ');

/**
 * Lex `source` into two same-length texts (line terminators kept in place):
 * `stripped` has comments blanked and literals intact (for reading import specifiers);
 * `blanked` also has the contents of strings, regex literals and template-literal text
 * blanked, keeping `${…}` substitutions (real code, lexed recursively).
 *
 * @param {string} source
 * @returns {{ stripped: string, blanked: string }}
 */
function lexSource(source) {
  const n = source.length;

  // A span kept exactly as written in both outputs (code, or text the lexer is unsure of).
  const raw = (from, to) => {
    const text = source.slice(from, to);
    return { stripped: text, blanked: text };
  };

  // Lexes a `'…'`/`"…"` string starting at `i`. An unterminated string (a raw line break
  // or end of input before the closing quote) is not a string: kept as is to end of line.
  function lexString(i) {
    const quote = source[i];
    let j = i + 1;
    while (j < n && source[j] !== quote && !isLineEnd(source[j])) {
      j += source[j] === '\\' && j + 1 < n ? 2 : 1;
    }
    if (j >= n || source[j] !== quote) return { ...raw(i, j), end: j };
    const text = source.slice(i, j + 1);
    return { stripped: text, blanked: quote + blankText(source.slice(i + 1, j)) + quote, end: j + 1 };
  }

  // Lexes a template literal starting at `i`, recursing into each `${…}`. Returns null if
  // the template or one of its substitutions runs off the end of the input.
  function lexTemplate(i) {
    let stripped = '`';
    let blanked = '`';
    let j = i + 1;
    while (j < n) {
      const c = source[j];
      if (c === '`') {
        return { stripped: stripped + c, blanked: blanked + c, end: j + 1 };
      }
      if (c === '\\' && j + 1 < n) {
        stripped += source.slice(j, j + 2);
        blanked += blankText(source.slice(j, j + 2));
        j += 2;
        continue;
      }
      if (c === '$' && source[j + 1] === '{') {
        const inner = lexCode(j + 2, true);
        if (inner === null) return null;
        stripped += '${' + inner.stripped + '}';
        blanked += '${' + inner.blanked + '}';
        j = inner.end + 1;
        continue;
      }
      stripped += c;
      blanked += blankText(c);
      j += 1;
    }
    return null;
  }

  // Scans a regex literal body from the `/` at `i`: returns the index of its closing `/`,
  // or -1 if none on this line (then the `/` is division).
  function findRegexEnd(i) {
    let j = i + 1;
    let inClass = false;
    while (j < n && !isLineEnd(source[j])) {
      const c = source[j];
      if (c === '\\') {
        if (j + 1 >= n || isLineEnd(source[j + 1])) return -1;
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return j;
      j += 1;
    }
    return -1;
  }

  // Lexes code from `i`. At top level runs to end of input; inside a `${…}` substitution
  // (`inSubstitution`) stops at the `}` that closes it (not consumed; `end` is its index)
  // and returns null if there is none.
  function lexCode(i, inSubstitution) {
    let stripped = '';
    let blanked = '';
    const emit = (part) => {
      stripped += part.stripped;
      blanked += part.blanked;
    };

    // State for telling a regex literal (where a value is expected) from division (after a
    // value): 'start' or 'punct' expect a value, 'value' does not, 'word' depends on
    // whether the word is a keyword in REGEX_PRECEDING_KEYWORDS used as a keyword.
    let lastKind = 'start';
    let lastWord = '';
    let lastWordIsProperty = false;
    let lastPunct = '';
    let depth = 0;

    while (i < n) {
      const c = source[i];
      const next = source[i + 1];

      if (/\s/.test(c)) {
        emit(raw(i, i + 1));
        i += 1;
        continue;
      }

      if (c === '/' && next === '/') {
        let j = i;
        while (j < n && !isLineEnd(source[j])) j += 1;
        const text = blankText(source.slice(i, j));
        emit({ stripped: text, blanked: text });
        i = j;
        continue;
      }

      if (c === '/' && next === '*') {
        const close = source.indexOf('*/', i + 2);
        // An unterminated block comment is not a comment: keep the rest as is.
        const j = close === -1 ? n : close + 2;
        const text = close === -1 ? source.slice(i, j) : blankText(source.slice(i, j));
        emit({ stripped: text, blanked: text });
        i = j;
        continue;
      }

      if (c === '"' || c === "'") {
        const part = lexString(i);
        emit(part);
        i = part.end;
        lastKind = 'value';
        continue;
      }

      if (c === '`') {
        const part = lexTemplate(i);
        if (part === null) {
          // Unterminated template or substitution: keep the rest of the input as is.
          if (inSubstitution) return null;
          emit(raw(i, n));
          i = n;
          continue;
        }
        emit(part);
        i = part.end;
        lastKind = 'value';
        continue;
      }

      if (isWordChar(c)) {
        let j = i;
        while (j < n && isWordChar(source[j])) j += 1;
        lastWordIsProperty = lastKind === 'punct' && lastPunct === '.';
        lastWord = source.slice(i, j);
        lastKind = 'word';
        emit(raw(i, j));
        i = j;
        continue;
      }

      const regexExpected =
        lastKind === 'start' ||
        lastKind === 'punct' ||
        (lastKind === 'word' && !lastWordIsProperty && REGEX_PRECEDING_KEYWORDS.has(lastWord));
      if (c === '/' && regexExpected) {
        const close = findRegexEnd(i);
        if (close !== -1) {
          let after = close + 1;
          while (after < n && REGEX_FLAGS.test(source[after])) after += 1;
          const flagsEnd = after;
          while (after < n && (source[after] === ' ' || source[after] === '\t')) after += 1;
          const followsLikeRegex =
            (flagsEnd >= n || !isWordChar(source[flagsEnd])) &&
            REGEX_FOLLOW.test(source.slice(after, after + 2));
          const text = source.slice(i, flagsEnd);
          emit({
            stripped: text,
            // Unsure it is a regex (it may be division): keep it as code, but still skip it
            // whole so its quotes or `//` are not lexed as strings or comments.
            blanked: followsLikeRegex
              ? '/' + blankText(source.slice(i + 1, close)) + source.slice(close, flagsEnd)
              : text,
          });
          i = flagsEnd;
          lastKind = 'value';
          continue;
        }
        // No closing `/` on this line: not a regex literal, treat `/` as division.
      }

      if (inSubstitution && c === '}' && depth === 0) {
        return { stripped, blanked, end: i };
      }
      if (c === '{') depth += 1;
      else if (c === '}' && depth > 0) depth -= 1;

      emit(raw(i, i + 1));
      if (c === ')' || c === ']') {
        lastKind = 'value';
      } else if ((c === '+' || c === '-') && source[i - 1] === c && lastPunct === c) {
        // Postfix `++`/`--` ends an operand, so a following `/` is division.
        lastKind = 'value';
        lastPunct = '';
      } else {
        lastKind = 'punct';
        lastPunct = c;
      }
      i += 1;
    }

    return inSubstitution ? null : { stripped, blanked, end: n };
  }

  const { stripped, blanked } = lexCode(0, false);
  return { stripped, blanked };
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
  const { stripped, blanked } = lexSource(source);

  for (const [pattern, what] of AMBIENT_STATE) {
    assert.doesNotMatch(blanked, pattern, `${label} must not use ${what}`);
  }

  // Import specifiers are read from `stripped`, since their own string content must stay
  // readable.
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

module.exports = { assertPureSource, assertPureSourceText, lexSource };
