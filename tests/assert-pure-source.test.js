'use strict';

// Self-test for the shared purity-check helper (tests/helpers/assert-pure-source.js), used
// by MSG-01 and later pure-module tests (M8, M14, M19; see docs/spec/modules.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPureSourceText } = require('./helpers/assert-pure-source');

const fails = (source, options) => {
  assert.throws(() => assertPureSourceText(source, 'fixture.mjs', options), assert.AssertionError);
};
const passes = (source, options) => {
  assert.doesNotThrow(() => assertPureSourceText(source, 'fixture.mjs', options));
};
const allowed = { allowImports: ['./allowed.mjs'] };

// Pure modules that must pass.

test('a pure module with comments, literals, regexes and division passes', () => {
  passes(
    [
      '// Pure: no I/O, no ambient state; every input arrives as an argument.',
      '/** @param {string} s text read from the diff */',
      "export const r = /proce[s]s\\.env|\\x2f\\x2f|['\"`]/i;",
      'export const half = (n) => n / 2 + n / .5;',
      "export const u = 'http://x'; const t = `a ${half(1)} b`;",
      'export const chars = Array.from(t);',
      '',
    ].join('\n'),
  );
});

test('allowed imports and re-exports pass in every spelling', () => {
  passes(
    [
      "import { a } from './allowed.mjs';",
      'import{b}from"./allowed.mjs";',
      "import * as c from './allowed.mjs'",
      "import d, { e as f } from\n  './allowed.mjs';",
      "import './allowed.mjs';",
      "export*from'./allowed.mjs';",
      "export { g } from './allowed.mjs';",
      "// import the helper from the allowed module, which names imports in its comments",
      '',
    ].join('\n'),
    allowed,
  );
});

// Banned words fail wherever they appear: the check never tries to tell code from comments
// or literals, so no mis-lexing can hide code.

for (const [what, source] of [
  ['process', 'const x = process.cwd();\n'],
  ['globalThis', 'const g = globalThis;\n'],
  ['require', "const fs = require('node:fs');\n"],
  ['require with a comment before the call', "const fs = require /* x */ ('node:fs');\n"],
  ['fetch', "fetch('https://x');\n"],
  ['the clock', 'const t = Date.now();\n'],
  ['randomness', 'const r = Math.random();\n'],
  ['randomness spaced out', 'const r = Math . random();\n'],
  ['randomness by bracket', "const r = Math['random']();\n"],
  ['console', "console.log('x');\n"],
  ['eval', "eval('1');\n"],
  ['the Function constructor', "const p = Function('return pro' + 'cess')();\n"],
  ['a banned word in a comment', '// avoids process\nexport const x = 1;\n'],
  ['a banned word in a string', "const s = 'the process module';\n"],
  ['a banned word in a regex', 'const r = /process\\.env/;\n'],
  ['a banned word in template text', 'const s = `no process here`;\n'],
]) {
  test(`${what} fails`, () => fails(source));
}

// Reviewer inputs that got impure code past the earlier lexer-based helper.

for (const [what, source] of [
  ['a regex after `if (…)` holding "//"', 'if (a) /[//]/.test(a) || process.exit(1);\n'],
  ['a regex after `if (…)` holding a quote', "if (a) /'/.test(a) || process.exit(1) || /'/.test(b);\n"],
  ['regexes after `if (…)` holding backticks', 'if (a) /`/.test(a);\nprocess.exit(1);\nif (b) /`/.test(b);\n'],
  ['regexes after `if (…)` holding "/*" and "*/"', 'if (a) /[/*]/.test(a);\nprocess.exit(1);\nif (b) /[*/]/.test(b);\n'],
  ['an identifier `of` then division', 'const of = 4; const x = of / 2; process.exit(); const y = x / .5;\n'],
  ['an identifier `of` then division across lines', 'const of = 4; const x = of / 2 + process.exitCode /\n 2;\n'],
  ['an object literal then division', 'const r = {} / process.exitCode / .5;\n'],
  ['a `#in` private field then division', 'class C { #in = 1; m() { return this.#in / 2 + process.exitCode / .5; } }\n'],
  ['a \\u escape spelling process', 'proc\\u0065ss.exitCode = 0;\n'],
  ['a \\u{…} escape spelling process', '\\u{70}rocess.exitCode = 0;\n'],
  ['division after postfix ++', 'const t = n++ / 2 + process.uptime() / 2;\n'],
  ['a "//" inside a string', "const u = 'http://x'; const y = process.env;\n"],
  ['an unterminated block comment', '/* open\nprocess.exit(0);\n'],
  ['a template substitution', 'const msg = `value: ${process.env.X}`;\n'],
]) {
  test(`impure code after ${what} fails`, () => fails(source));
}

// Imports: every specifier in the raw text is checked, however it is spaced.

for (const [what, source] of [
  ['a static import', "import { helper } from './not-allowed.mjs';\n"],
  ['an import with no spaces', "import{readFileSync}from'node:fs';\n"],
  ['an import after a statement on the same line', "const a = 1; import fs from 'node:fs';\n"],
  ['an import after a regex holding "//"', "if (a) /[//]/.test(a); import fs from 'node:fs';\n"],
  ['an import after a comment', "/* c */ import fs from 'node:fs';\n"],
  ['a side-effect import', "import 'node:fs';\n"],
  ['a side-effect import with no space', 'import"node:fs";\n'],
  ['a re-export with no spaces', "export*from'node:fs';\n"],
  ['a named re-export', "export { x } from 'node:fs';\n"],
]) {
  test(`${what} outside allowImports fails`, () => fails(source, allowed));
}

for (const [what, source] of [
  ['a comment between `from` and the specifier', "import fs from /* x */ './allowed.mjs';\n"],
  ['a line comment between `from` and the specifier', "export * from // x\n'./allowed.mjs';\n"],
  ['a comment between `import` and the specifier', "import /* x */ './allowed.mjs';\n"],
  ['an escape in the specifier', "import fs from './allowed\\x2emjs';\n"],
  ['a dynamic import', "export const x = import('./allowed.mjs');\n"],
  ['a dynamic import with a space', "export const x = import ('./allowed.mjs');\n"],
  ['import.meta', 'const url = import.meta.url;\n'],
]) {
  test(`${what} fails even when the specifier is allowed`, () => fails(source, allowed));
}

test('a failing import names the specifier', () => {
  assert.throws(
    () => assertPureSourceText("import { helper } from './not-allowed.mjs';\n", 'fixture.mjs'),
    /not-allowed\.mjs/,
  );
});
