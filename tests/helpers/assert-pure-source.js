'use strict';

// Shared purity check for the pure modules in `plugin/scripts/lib/` (module map:
// docs/spec/modules*.md marks each module pure or effectful). A pure module may still
// import other pure modules (e.g. M8 imports M7, M14 imports M6, M19 imports M6 and M4's
// pure `validateLayer`); every other import, `require`, or ambient-state access fails.
// Comments are stripped before matching, so a comment that merely mentions a banned word
// (e.g. documenting why `process` is not used) does not fail the check.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { libPath } = require('./load-lib');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// Matches a static import's specifier, with or without a `from` clause (side-effect-only
// imports). Does not match dynamic `import(...)`, which is banned unconditionally below.
const STATIC_IMPORT = /^[ \t]*import\s+(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/gm;

const AMBIENT_STATE = [
  [/\bimport\s*\(/, 'a dynamic import'],
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
