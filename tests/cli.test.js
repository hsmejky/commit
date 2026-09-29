'use strict';

// M1 CLI and envelope, in-process unit coverage for `failure()` (RPL-01 review finding: an
// unmapped kind must not silently exit 0). The subcommand-routing behavior itself is covered
// through Seam 1 (tests/commit-entry.test.js); this file only exercises the helper that maps
// a kind to its exit code, which Seam 1 cannot reach directly.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { parseDocumentedKinds } = require('./helpers/cli-exit-codes-doc.js');

let failure;
let EXIT_CODES;

beforeEach(async () => {
  ({ failure, EXIT_CODES } = await loadLib('cli'));
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

test('failure() throws on an inherited property name instead of resolving it', () => {
  // A plain-object lookup (`EXIT_CODES[kind]`) resolves 'toString' to Object.prototype's
  // toString function rather than reporting it unmapped; the lookup must check ownership
  // (Object.hasOwn or a null-prototype map), not just presence.
  assert.throws(() => failure('toString', 'x'), /toString/);
});

// RPL-03: the full kind -> exit code map, 0-6, from the exit table of C:cli-and-exit-codes.
// Table-driven against that doc as the oracle, independent of the module's own EXIT_CODES.
const EXIT_TABLE = [
  ['usage', 1], ['config', 1], ['env', 1], ['internal', 1],
  ['lint', 2],
  ['scan', 3],
  ['git', 4],
  ['timeout', 5],
  ['state', 6], ['signing', 6], ['pushed', 6], ['staged-hit', 6],
  ['lock', 6], ['index-lock', 6], ['diff-changed', 6], ['head-moved', 6],
];

for (const [kind, exitCode] of EXIT_TABLE) {
  test(`failure() maps kind ${kind} to exit ${exitCode}`, () => {
    assert.equal(failure(kind, 'x').exitCode, exitCode);
  });
}

// The exact set, not just each entry checked above one at a time: EXIT_CODES is exported
// (read-only) so this can assert its key set equals the documented one, catching a kind the
// doc lists but the module is missing (or vice versa) instead of only spot checks.
test('EXIT_CODES has exactly the kinds documented in C:cli-and-exit-codes, no more, no fewer', () => {
  const documented = Array.from(parseDocumentedKinds()).sort();
  assert.deepEqual(Object.keys(EXIT_CODES).sort(), documented);
});
