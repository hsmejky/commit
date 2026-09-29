'use strict';

// Self-test for the shared purity-check helper (tests/helpers/assert-pure-source.js), used
// by MSG-01 and later pure-module tests (M8, M14, M19; see docs/spec/modules.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPureSourceText } = require('./helpers/assert-pure-source');

test('a comment that merely mentions a banned word passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "// this module deliberately avoids process and console\nexport const x = 1;\n",
      'fixture.mjs',
    );
  });
});

test('an import outside allowImports fails', () => {
  assert.throws(() => {
    assertPureSourceText(
      "import { helper } from './not-allowed.mjs';\nexport const x = 1;\n",
      'fixture.mjs',
      { allowImports: [] },
    );
  }, assert.AssertionError);
});

test('an import listed in allowImports passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "import { helper } from './allowed.mjs';\nexport const x = 1;\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  });
});

test('a banned ambient-state access still fails even with matching allowImports', () => {
  assert.throws(() => {
    assertPureSourceText(
      "import { helper } from './allowed.mjs';\nexport const x = process.cwd();\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  }, assert.AssertionError);
});

test('a dynamic import is always banned, even when the specifier is in allowImports', () => {
  assert.throws(() => {
    assertPureSourceText(
      "export const x = import('./allowed.mjs');\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  }, assert.AssertionError);
});

test('a "//" inside a string literal does not hide a banned use later on the line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const u = 'http://x'; const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a "//" inside a regex literal does not hide a banned use later on the line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const r = /\\//; const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('`export ... from` is checked against allowImports like a static import', () => {
  assert.throws(() => {
    assertPureSourceText(
      "export * from 'node:fs';\n",
      'fixture.mjs',
      { allowImports: [] },
    );
  }, assert.AssertionError);
});

test('`export ... from` listed in allowImports passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "export { helper } from './allowed.mjs';\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  });
});

test('`import.meta` is banned', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const url = import.meta.url;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return /\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('typeof followed by a regex literal is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "typeof /\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword with no space is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return/\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword does not derail quote tracking on the next line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return /'/.test(s);\nconst u = 'http://x'; process.exit();\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('division after a plain identifier is still division and does not break stripping', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const c = a / b;\nconst y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('division followed by a comment naming a banned word on the same line passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('const c = a / b; // no process here\n', 'fixture.mjs');
  });
});
