'use strict';

// RPL-03 (docs/roadmap/11-reply-and-cli.md): "a test lists, for each row already reachable
// through this slice's blockers (RPL-01's `usage` refusals), the Seam 1 case that reaches
// it; rows not yet built are left to INT-31."
//
// This slice's only blocker is RPL-01, which built M1's own argv-level `usage` refusals (no
// or an unknown subcommand). Every other row of docs/spec/domain-code-cli-kind.md is
// produced by a module (M2-M19) or workflow (M18) that does not exist yet, so it cannot be
// reached through the shipped CLI at all; INT-31 extends this manifest once the roadmap
// builds them. The manifest is data so a later slice adds a row (and, once reachable, a Seam
// 1 case) instead of writing a new test file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit } = require('./helpers/process-seam.js');

const ROWS = [
  {
    row: 'bad argv or flag combination, malformed planId',
    kind: 'usage',
    exitCode: 1,
    reachable: true,
    // The Seam 1 case that reaches it (also covered directly in tests/commit-entry.test.js):
    // no subcommand at all is the simplest illegal argv M1 already rejects.
    async seam1Case(t) {
      const c = createCase(t);
      return runCommit(c, []);
    },
  },
  { row: 'unconfirmed', reachable: false },
  { row: 'staged-empty', reachable: false },
  { row: 'already-committed', reachable: false },
  { row: 'no-groups', reachable: false },
  { row: 'config', reachable: false },
  { row: 'env (install path, M3)', reachable: false },
  { row: 'not-a-repo, bare, in-progress, unmerged, unborn, merge, encoding', reachable: false },
  { row: 'run-folder', reachable: false },
  { row: 'killed-leftover', reachable: false },
  { row: 'signing-locked', reachable: false },
  { row: 'pushed', reachable: false },
  { row: 'staged-hit', reachable: false },
  { row: 'held, taken-over, ended, busy', reachable: false },
  { row: 'index-locked', reachable: false },
  { row: 'unmatched, mismatch', reachable: false },
  { row: 'index-changed', reachable: false },
  { row: 'head-moved', reachable: false },
  { row: 'lint', reachable: false },
  { row: 'backstop-hit', reachable: false },
  { row: 'git-failed', reachable: false },
  { row: 'stage-failed', reachable: false },
  { row: 'timed-out', reachable: false },
  { row: 'unexpected throw -> internal', reachable: false },
  { row: 'clean tree (nothing)', reachable: false },
];

for (const entry of ROWS) {
  if (!entry.reachable) continue;
  test(`reachable row "${entry.row}": Seam 1 reaches exit ${entry.exitCode} ${entry.kind}`, async (t) => {
    const result = await entry.seam1Case(t);
    assert.equal(result.exitCode, entry.exitCode);
    assert.equal(result.json.error.kind, entry.kind);
  });
}

test('every row of docs/spec/domain-code-cli-kind.md is accounted for, reachable or not', () => {
  assert.equal(ROWS.length, 25);
  assert.equal(ROWS.filter((r) => r.reachable).length, 1);
});
