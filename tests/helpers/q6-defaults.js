'use strict';

// Q6's defaults (docs/decisions/q06-config-layers-and-keys.md), as a literal object: the
// commitlint `config-conventional` types, no scope, no body, 72 code points, lowercase, no
// `scanIgnore` patterns. Mirrors M4 `config.mjs`'s `DEFAULT_VALUES`, but spelled out here
// rather than imported from it, so a test asserting against this literal still catches a
// regression that changes `DEFAULT_VALUES` itself (review-CFG-05 finding 4). Shared so the
// several direct-`validatePlan` test fixtures that need the same object (CFG-05) cannot
// drift from each other or from the literal assertion.

const Q6_DEFAULT_VALUES = Object.freeze({
  types: Object.freeze([
    'build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test',
  ]),
  scope: 'forbidden',
  body: 'forbidden',
  maxSubjectLength: 72,
  subjectCase: 'lower',
  scanIgnore: Object.freeze([]),
});

/** `Q6_DEFAULT_VALUES`'s sources when neither layer is present: every key `default`. */
const ALL_DEFAULT_SOURCES = Object.freeze({
  types: 'default',
  scope: 'default',
  body: 'default',
  maxSubjectLength: 'default',
  subjectCase: 'default',
  scanIgnore: 'default',
});

module.exports = { Q6_DEFAULT_VALUES, ALL_DEFAULT_SOURCES };
