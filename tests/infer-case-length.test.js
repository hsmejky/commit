'use strict';

// INF-04 (docs/roadmap/14-infer-and-commit-config.md): the proposal's `subjectCase` and
// `maxSubjectLength` fields (C:infer). `subjectCase` is `lower` at 90% or more of the
// Conventional Commits descriptions passing M6's `passesLowerCase` (which exempts a leading
// acronym such as `API change`), else `any`. `maxSubjectLength` is the p95 header length in
// code points, rounded up to 72 or 100; above 100 it is rounded up to the next multiple of
// 10 and flagged; above 200 it is clamped to 200 and flagged. Both shares/percentiles are
// taken over the Conventional Commits messages read only. Seam 1 through the shipped entry
// point, with `fastImportLinear` building the history fixtures, plus a static import check.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');
const { libPath } = require('./helpers/load-lib.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.version, 1, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.equal(result.json.outcome, 'proposal', detail(result));
  assert.notEqual(result.json.proposal, null, detail(result));
}

// Builds a history of 100 Conventional Commits: `passCount` whose header is produced by
// `passMessageFor` (expected to pass `passesLowerCase`), then `100 - passCount` with a
// plain uppercase, non-acronym description (`Change <i>`, which fails it), so the lower
// share is exactly `passCount / 100`.
function subjectCaseHistory(c, passCount, passMessageFor) {
  fastImportLinear(c, 100, (i) => (i <= passCount
    ? passMessageFor(i)
    : `feat: Change ${i}\n`));
}

// Builds a history of 100 Conventional Commits headers: 95 at exactly `p95Length` code
// points, 5 longer, so the 95th percentile (nearest-rank over 100) is exactly `p95Length`.
function lengthHistory(c, p95Length) {
  const prefix = 'feat: '.length;
  const tailLength = p95Length + 50;
  fastImportLinear(c, 100, (i) => {
    const length = i <= 95 ? p95Length : tailLength;
    return `feat: ${'a'.repeat(length - prefix)}\n`;
  });
}

test('Seam 1: a leading-acronym description (API change) counts as lower', async (t) => {
  const c = createCase(t);
  // All 100 headers use the acronym-exempt form; if the exemption did not apply, the lower
  // share would be 0 (subjectCase: any) instead of 1 (subjectCase: lower).
  fastImportLinear(c, 100, () => 'feat: API change\n');

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.subjectCase, { value: 'lower', evidence: { lower: 1 } }, detail(result));
});

test('Seam 1: an exactly 90% lowercase-header share gives subjectCase: lower', async (t) => {
  const c = createCase(t);
  subjectCaseHistory(c, 90, (i) => `feat: change ${i}\n`);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.subjectCase, { value: 'lower', evidence: { lower: 0.9 } }, detail(result));
});

test('Seam 1: an 89% lowercase-header share gives subjectCase: any', async (t) => {
  const c = createCase(t);
  subjectCaseHistory(c, 89, (i) => `feat: change ${i}\n`);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.subjectCase, { value: 'any', evidence: { lower: 0.89 } }, detail(result));
});

test('Seam 1: a p95 header length of 64 gives maxSubjectLength 72, not flagged', async (t) => {
  const c = createCase(t);
  lengthHistory(c, 64);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 72, evidence: { p95: 64, flagged: false } },
    detail(result),
  );
});

test('Seam 1: a p95 header length of 90 gives maxSubjectLength 100, not flagged', async (t) => {
  const c = createCase(t);
  lengthHistory(c, 90);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 100, evidence: { p95: 90, flagged: false } },
    detail(result),
  );
});

test('Seam 1: a p95 header length of 113 gives maxSubjectLength 120, flagged', async (t) => {
  const c = createCase(t);
  lengthHistory(c, 113);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 120, evidence: { p95: 113, flagged: true } },
    detail(result),
  );
});

test('Seam 1: a p95 header length of 230 gives maxSubjectLength 200 (clamped), flagged', async (t) => {
  const c = createCase(t);
  lengthHistory(c, 230);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 200, evidence: { p95: 230, flagged: true } },
    detail(result),
  );
});

test('M19 history-inference imports passesLowerCase from M6, separately from lint (no duplicate case check)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  assert.match(
    source,
    /^import\s*\{\s*passesLowerCase\s*\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m,
    'history-inference.mjs must import passesLowerCase from ./message-grammar.mjs, not redefine the lowercase check',
  );
  // Not vacuous: a module that only mentions "passesLowerCase" without importing it fails.
  assert.doesNotMatch(
    'function passesLowerCase(d) { return !/^[A-Z]/.test(d); }',
    /^import\s*\{\s*passesLowerCase\s*\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m,
  );
});
