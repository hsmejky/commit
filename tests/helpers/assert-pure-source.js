'use strict';

// Shared purity check for the pure modules in `plugin/scripts/lib/` (module map:
// docs/spec/modules*.md marks each module pure or effectful). A pure module may still
// import specific pure exports named in `allowImports` (e.g. M8 imports M7, M14 imports M6
// and M8, M19 imports M6 and M4's pure `validateLayer` even though M4 itself is effectful);
// every other import, `require`, or ambient-state access fails.
//
// Fail closed by construction: every check runs on the raw source text. Nothing is ever
// blanked or skipped, not comments, strings or regex literals, because telling those apart
// from code takes a JavaScript lexer, and every hand-written one tried here mis-lexed some
// valid input (a regex read as division, say) and so hid real code. The price is that a
// banned word fails the check even inside a comment or a literal: a pure module words its
// comments around it ("no ambient state") and spells a literal differently (a regex for the
// word itself uses a character class, e.g. `proce[s]s`). A false failure is noticed and
// fixed; a false pass is not.
//
// This catches accidental impurity, not deliberate evasion: `eval` and `Function` are
// banned, but code built from strings by other routes (e.g. a function's `.constructor`)
// is beyond a text check.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath } = require('./load-lib');

// Matched as whole words anywhere in the raw text, so spacing or comments between tokens
// (`Math . random`, `require /* x */ (`) cannot slip past.
const AMBIENT_STATE = [
  [/\brequire\b/, 'require'],
  [/\bprocess\b/, 'process'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bfetch\b/, 'fetch'],
  [/\bDate\b/, 'the clock'],
  [/\brandom\b/, 'randomness'],
  [/\bconsole\b/, 'console'],
  [/\beval\b|\bFunction\b/, 'code built from strings'],
];

// A `\u` escape can spell an identifier (`process` is `process`), which a word match
// cannot see, so it is banned outright; a literal can use `\x..` or the character itself.
const UNICODE_ESCAPE = /\\u/;

// Every `from` directly followed (after whitespace) by a quote or a `/` (a comment, or
// division when `from` is a variable). A module specifier always follows the `from` of a
// static import or re-export, possibly after comments, so any `from` not matched here
// (e.g. `from the diff`, `Array.from(x)`) cannot belong to one.
const FROM_CLAUSE = /\bfrom\s*(?=['"/])/g;
// Every `import` keyword. After it a static import has either its specifier (side-effect
// import) or its clause (a binding name, `{` or `*`), whose `from` FROM_CLAUSE checks.
// Anything else (`import(`, `import.meta`, `import /* x */ '…'`) fails.
const IMPORT_KEYWORD = /\bimport\b/g;
const IMPORT_CLAUSE_START = /^\s*[\w${*]/;
// A specifier as it must appear right after `from` or `import` and whitespace: one quoted
// string with no escapes.
const SPECIFIER = /^\s*(['"])([^'"\\\r\n]*)\1/;

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
  for (const [pattern, what] of AMBIENT_STATE) {
    assert.doesNotMatch(source, pattern, `${label} must not use ${what}, not even in a comment or literal`);
  }
  assert.doesNotMatch(source, UNICODE_ESCAPE, `${label} must not use a \\u escape`);

  const allowed = allowImports.join(', ') || 'none';
  const checkSpecifier = (index, keyword) => {
    const match = SPECIFIER.exec(source.slice(index));
    assert.ok(
      match !== null,
      `${label}: cannot read the module specifier after '${keyword}' at offset ${index}`,
    );
    assert.ok(
      allowImports.includes(match[2]),
      `${label} imports '${match[2]}', which is not in allowImports (${allowed})`,
    );
  };

  for (const match of source.matchAll(FROM_CLAUSE)) {
    checkSpecifier(match.index + 'from'.length, 'from');
  }
  for (const match of source.matchAll(IMPORT_KEYWORD)) {
    const after = match.index + 'import'.length;
    if (!IMPORT_CLAUSE_START.test(source.slice(after))) checkSpecifier(after, 'import');
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
