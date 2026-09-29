'use strict';

// M1 CLI and envelope, in-process unit coverage for `failure()` (RPL-01 review finding: an
// unmapped kind must not silently exit 0). The subcommand-routing behavior itself is covered
// through Seam 1 (tests/commit-entry.test.js); this file only exercises the helper that maps
// a kind to its exit code, which Seam 1 cannot reach directly.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');

let failure;

beforeEach(async () => {
  ({ failure } = await loadLib('cli'));
});

test('failure() returns the failure shape and exit code for a mapped kind', () => {
  const result = failure('usage', 'missing subcommand');
  assert.deepEqual(result, {
    stdoutJson: { version: 1, ok: false, error: { kind: 'usage', message: 'missing subcommand' } },
    exitCode: 1,
  });
});

test('failure() throws on a kind with no mapped exit code, instead of exiting 0', () => {
  assert.throws(() => failure('not-a-real-kind', 'x'), /not-a-real-kind/);
});
