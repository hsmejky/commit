'use strict';

// RUN-17 (docs/roadmap/09-runs.md, C:confirmation-triggers, Q16): M15 `computeConfirm`'s pure
// decision — `check`'s `confirm` field from the per-group facts M18 resolves. Pure unit tests
// (same pattern as tests/check-lint-failures.test.js's `onLintFailure` and
// tests/run-policy-clean-tree.test.js's `planRefusal`): no git process, so they run on every
// host. Seam-1 table tests for the wired-in behavior (via `check`'s real output) follow below.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib.js');

let computeConfirm;
beforeEach(async () => {
  ({ computeConfirm } = await loadLib('run-policy'));
});

const NOT_RESUMED = { resumed: false, interactive: true };

function group(fields = {}) {
  return { newFiles: [], skippedFiles: [], scanIgnoreFiles: [], ...fields };
}

test('computeConfirm: one group, no trigger → null', () => {
  assert.equal(computeConfirm('split', [group()], NOT_RESUMED), null);
  assert.equal(computeConfirm('staged', [group()], NOT_RESUMED), null);
  assert.equal(computeConfirm('reword', [group()], NOT_RESUMED), null);
});

test('computeConfirm: more than one group → "n groups", humanOnly false', () => {
  assert.deepEqual(
    computeConfirm('split', [group(), group()], NOT_RESUMED),
    { reasons: ['2 groups'], humanOnly: false },
  );
  assert.deepEqual(
    computeConfirm('split', [group(), group(), group()], NOT_RESUMED),
    { reasons: ['3 groups'], humanOnly: false },
  );
});

test('computeConfirm: a new file in split → "new file <path>", humanOnly false', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED),
    { reasons: ['new file docs/new.md'], humanOnly: false },
  );
});

test('computeConfirm: a new file is never a trigger outside split', () => {
  assert.equal(computeConfirm('staged', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED), null);
  assert.equal(computeConfirm('reword', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED), null);
});

test('computeConfirm: a skipped file → "skipped file <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ skippedFiles: ['big.bin'] })], NOT_RESUMED),
    { reasons: ['skipped file big.bin'], humanOnly: true },
  );
  assert.deepEqual(
    computeConfirm('staged', [group({ skippedFiles: ['big.bin'] })], NOT_RESUMED),
    { reasons: ['skipped file big.bin'], humanOnly: true },
  );
});

test('computeConfirm: a scanIgnore change → "scanIgnore change <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ scanIgnoreFiles: ['.claude/commit.json'] })], NOT_RESUMED),
    { reasons: ['scanIgnore change .claude/commit.json'], humanOnly: true },
  );
});

test('computeConfirm: resumed + interactive → "edited plan"', () => {
  assert.deepEqual(
    computeConfirm('split', [group()], { resumed: true, interactive: true }),
    { reasons: ['edited plan'], humanOnly: false },
  );
});

test('computeConfirm: resumed but not interactive → no "edited plan"', () => {
  assert.equal(computeConfirm('split', [group()], { resumed: true, interactive: false }), null);
});

test('computeConfirm: not resumed → no "edited plan" regardless of interactive', () => {
  assert.equal(computeConfirm('split', [group()], { resumed: false, interactive: true }), null);
  assert.equal(computeConfirm('split', [group()], { resumed: false, interactive: false }), null);
});

test('computeConfirm: combination ordering — groups, then new files, then skipped/scanIgnore, then edited plan', () => {
  const groups = [
    group({ newFiles: ['a.txt'], skippedFiles: ['big.bin'] }),
    group({ newFiles: ['b.txt'], scanIgnoreFiles: ['.claude/commit.json'] }),
  ];
  assert.deepEqual(
    computeConfirm('split', groups, { resumed: true, interactive: true }),
    {
      reasons: [
        '2 groups',
        'new file a.txt',
        'new file b.txt',
        'skipped file big.bin',
        'scanIgnore change .claude/commit.json',
        'edited plan',
      ],
      humanOnly: true,
    },
  );
});
