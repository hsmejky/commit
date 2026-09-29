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
