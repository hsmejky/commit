'use strict';

// M18 domain code -> CLI kind table (RPL-03; docs/spec/domain-code-cli-kind.md,
// C:cli-and-exit-codes). Table-driven against both docs as the oracle: every domain code a
// module below M18 can report resolves, through `lib/domain-codes.mjs` and then
// `lib/cli.mjs`'s kind -> exit map, to the same kind and exit code the docs list.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

let kindForDomainCode;
let DOMAIN_CODE_TO_KIND;
let EXIT_CODES_BY_KIND;

beforeEach(async () => {
  ({ kindForDomainCode, DOMAIN_CODE_TO_KIND } = await loadLib('domain-codes'));
  // `failure()` is the only exported way to read `lib/cli.mjs`'s private kind -> exit map;
  // it is used here only as an oracle-comparison helper, never to build a real failure.
  const { failure } = await loadLib('cli');
  EXIT_CODES_BY_KIND = (kind) => failure(kind, 'x').exitCode;
});

test('domain-codes.mjs is pure', () => {
  assertPureSource('domain-codes');
});

// Every row of docs/spec/domain-code-cli-kind.md that a module below M18 reports as a domain
// code, with the kind and exit code the doc lists. The rows that table leaves to M1 itself
// (the generic "bad argv" usage) or to a catch-all (`internal`, on any unexpected throw), and
// the non-failure "clean tree" row, are not domain codes reported through this table and are
// asserted absent below instead.
const rows = [
  ['unconfirmed', 'usage', 1],
  ['staged-empty', 'usage', 1],
  ['already-committed', 'usage', 1],
  ['no-groups', 'usage', 1],
  ['config', 'config', 1],
  ['env', 'env', 1],
  ['not-a-repo', 'state', 6],
  ['bare', 'state', 6],
  ['in-progress', 'state', 6],
  ['unmerged', 'state', 6],
  ['unborn', 'state', 6],
  ['merge', 'state', 6],
  ['encoding', 'state', 6],
  ['run-folder', 'state', 6],
  ['killed-leftover', 'state', 6],
  ['signing-locked', 'signing', 6],
  ['pushed', 'pushed', 6],
  ['staged-hit', 'staged-hit', 6],
  ['held', 'lock', 6],
  ['taken-over', 'lock', 6],
  ['ended', 'lock', 6],
  ['busy', 'lock', 6],
  ['index-locked', 'index-lock', 6],
  ['unmatched', 'diff-changed', 6],
  ['mismatch', 'diff-changed', 6],
  ['index-changed', 'diff-changed', 6],
  ['head-moved', 'head-moved', 6],
  ['lint', 'lint', 2],
  ['backstop-hit', 'scan', 3],
  ['git-failed', 'git', 4],
  ['stage-failed', 'git', 4],
  ['timed-out', 'timeout', 5],
];

for (const [domainCode, kind, exitCode] of rows) {
  test(`${domainCode} -> ${kind}, exit ${exitCode}`, () => {
    assert.equal(kindForDomainCode(domainCode), kind);
    assert.equal(EXIT_CODES_BY_KIND(kind), exitCode);
  });
}

test('the table has exactly these rows, no more, no fewer', () => {
  assert.deepEqual(Object.keys(DOMAIN_CODE_TO_KIND).sort(), rows.map((r) => r[0]).sort());
});

test('kindForDomainCode throws on an unmapped domain code, instead of returning undefined', () => {
  assert.throws(() => kindForDomainCode('not-a-real-code'), /not-a-real-code/);
});

test('kindForDomainCode throws on an inherited property name instead of resolving it', () => {
  // A plain-object lookup (`DOMAIN_CODE_TO_KIND[domainCode]`) resolves 'constructor' to
  // Object's constructor function rather than reporting it unmapped; the lookup must check
  // ownership (Object.hasOwn or a null-prototype map), not just presence.
  assert.throws(() => kindForDomainCode('constructor'), /constructor/);
});

// The rows this table deliberately leaves out (comment at the top of domain-codes.mjs):
// M1's own generic "bad argv" usage and the "unexpected throw" catch-all are not domain
// codes a module reports through it, so they must not appear as keys either.
test('the generic usage and internal catch-all rows are not in this table', () => {
  assert.equal('usage' in DOMAIN_CODE_TO_KIND, false);
  assert.equal('internal' in DOMAIN_CODE_TO_KIND, false);
});
