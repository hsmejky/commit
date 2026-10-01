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
// banned, but code built from strings by other routes are beyond a text check — a function's
// `.constructor`, a bracket property access that spells a banned word with an escape
// (`Math['r\x61ndom']()`), or a reflective get of the same
// (`Reflect.get(Math, 'r\x61ndom')`). A regex for the banned word itself is written around
// this the same way a pure module's own comments are (a character class, e.g. `rando[m]`).
//
// `setTimeout`, `queueMicrotask`, `navigator` and `WeakRef` are banned outright rather than
// left out of scope: unlike `eval`/`Function`, nothing about them needs more than a text
// check, and none of the pure modules in `plugin/scripts/lib/` has a legitimate use for
// scheduling, environment identification or GC-sensitive references, so banning costs
// nothing. `Date` is banned as the clock; a pure module that needs to show a human-readable
// time formats it from the injected epoch-ms number (`now`, docs/spec/architectural-decisions.md
// "Injected environment") with arithmetic, or its effectful caller formats the string (with
// `Date`, which it is allowed to use) and passes that string down — never a `Date` inside the
// pure module itself.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath } = require('./load-lib');

// Matched as whole words anywhere in the raw text, so spacing or comments between tokens
// (`Math . random`, `require /* x */ (`) cannot slip past.
const AMBIENT_STATE = [
  [/\brequire\b/, 'require'],
  [/\bprocess\b/, 'process'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bglobal\b/, "global (Node's alias of globalThis)"],
  [/\bfetch\b/, 'fetch'],
  [/\bDate\b/, 'the clock'],
  [/\bperformance\b/, 'performance'],
  [/\brandom\b/, 'randomness'],
  [/\bcrypto\b/, 'crypto'],
  [/\bconsole\b/, 'console'],
  [/\bIntl\b/, 'Intl'],
  [/\btoLocale\w*/, 'a toLocale* call'],
  [/\beval\b|\bFunction\b/, 'code built from strings'],
  [/\bsetTimeout\b/, 'setTimeout'],
  [/\bqueueMicrotask\b/, 'queueMicrotask'],
  [/\bnavigator\b/, 'navigator'],
  [/\bWeakRef\b/, 'WeakRef'],
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

// 1-based line number of `index` in `source`, for failure messages.
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Assert that `source` (a pure module's text; `label` names it in failure messages) does no
 * I/O, reads no ambient state, and imports only the pure modules listed in `allowImports`
 * (exact specifiers, e.g. `./glob-matcher.mjs`).
 *
 * `extraBans` adds words to ban on top of `AMBIENT_STATE`, for a caller that checks a single
 * function's own text (`fn.toString()`) rather than a whole module file: a function body
 * reaches an effectful module-level import (`fs`, `path`, and the like) as a plain
 * identifier, with no `import` statement for `AMBIENT_STATE`'s own import check to see, so
 * such a caller must ban those identifiers itself (e.g. M4's `validateLayer`, which this
 * file cannot check with `assertPureSource` since `config.mjs` is itself effectful;
 * review-CFG-03 finding 1). Left empty (the default), nothing changes for
 * `assertPureSource`'s own whole-module callers, several of which use "path" and "fs" as
 * ordinary English words in their comments and would wrongly fail if those were banned
 * module-wide.
 *
 * @param {string} source
 * @param {string} label
 * @param {{ allowImports?: string[], extraBans?: [RegExp, string][] }} [options]
 */
function assertPureSourceText(source, label, { allowImports = [], extraBans = [] } = {}) {
  for (const [pattern, what] of [...AMBIENT_STATE, ...extraBans]) {
    const match = pattern.exec(source);
    assert.ok(
      match === null,
      match && `${label}:${lineAt(source, match.index)}: must not use ${what}, not even in a comment or literal`,
    );
  }
  {
    const match = UNICODE_ESCAPE.exec(source);
    assert.ok(match === null, match && `${label}:${lineAt(source, match.index)}: must not use a \\u escape`);
  }

  const allowed = allowImports.join(', ') || 'none';
  const checkSpecifier = (index, keyword) => {
    const line = lineAt(source, index);
    const match = SPECIFIER.exec(source.slice(index));
    assert.ok(
      match !== null,
      `${label}:${line}: cannot read the module specifier after '${keyword}', even in a comment`,
    );
    assert.ok(
      allowImports.includes(match[2]),
      `${label}:${line}: imports '${match[2]}', even in a comment, which is not in allowImports (${allowed})`,
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
