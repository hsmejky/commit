'use strict';

// Regression guard (see tests/helpers/load-lib.js, commit 3f9fb9d): on Node 22.0-22.1,
// node:test does not await a top-level async `before()` hook (fixed in 22.2.0), so every
// test that needs the shared library must load it from a top-level `beforeEach(async ...)`
// instead — a root-level `before(async ...)` would pass on Node 22.2+ and on a
// maintainer's own machine while silently leaving library bindings `undefined` on Node
// 22.0-22.1. This fails the suite if any tests/*.test.js file reintroduces one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TESTS_DIR = __dirname;

// Matches a root-level (column-0) `before(async ...)` call. `beforeEach(async ...)` does
// not match (the character after "before" is "E", not "("), and neither does a `before(...)`
// nested inside a describe block, since indentation puts it past column 0.
const TOP_LEVEL_ASYNC_BEFORE = /^before\(\s*async\b/m;

function hasTopLevelAsyncBefore(sourceText) {
  return TOP_LEVEL_ASYNC_BEFORE.test(sourceText);
}

function listTestFiles() {
  return fs.readdirSync(TESTS_DIR).filter((name) => name.endsWith('.test.js'));
}

test('no tests/*.test.js file defines a root-level before(async ...) hook', () => {
  const offenders = listTestFiles().filter((name) => {
    const sourceText = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
    return hasTopLevelAsyncBefore(sourceText);
  });
  assert.deepEqual(offenders, []);
});

test('the check catches a root-level before(async ...) hook', () => {
  assert.equal(hasTopLevelAsyncBefore('before(async () => {\n  x = await y();\n});\n'), true);
});

test('the check does not flag a beforeEach(async ...) hook', () => {
  assert.equal(hasTopLevelAsyncBefore('beforeEach(async () => {\n  x = await y();\n});\n'), false);
});

test('the check does not flag a synchronous root-level before(...) hook', () => {
  assert.equal(hasTopLevelAsyncBefore('before(() => {\n  x = 1;\n});\n'), false);
});
