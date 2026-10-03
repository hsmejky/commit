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

// Exact boundaries around the two thresholds (72 and 100) and the cap (200): a mutation
// from `<=` to `<` at either threshold, or clamp-vs-natural-rounding at the cap, must flip
// at least one of these.
for (const [p95Length, value, flagged] of [
  [72, 72, false],
  [73, 100, false],
  [100, 100, false],
  [101, 110, true],
  [200, 200, true],
  [201, 200, true],
]) {
  test(`Seam 1: a p95 header length of ${p95Length} gives maxSubjectLength ${value}, ${flagged ? '' : 'not '}flagged`, async (t) => {
    const c = createCase(t);
    lengthHistory(c, p95Length);

    const result = await runCommit(c, ['infer']);

    assertOk(result);
    assert.equal(result.json.commitCount, 100, detail(result));
    assert.deepEqual(
      result.json.proposal.maxSubjectLength,
      { value, evidence: { p95: p95Length, flagged } },
      detail(result),
    );
  });
}

test('Seam 1: header length counts code points, not UTF-16 units (astral emoji headers)', async (t) => {
  const c = createCase(t);
  // 95 headers whose description is 64 emoji (code-point length 70: 6 for "feat: " + 64;
  // UTF-16 length 134, since each emoji is a surrogate pair), 5 headers of plain-ASCII code
  // -point length 120 (the usual longer tail). The correct p95 (code points) is 70 (<= 72,
  // not flagged). A UTF-16-`.length` mutant would see 134 for the first 95 and 120 for the
  // tail, so its p95 would be 134 (> 100, flagged) instead.
  const emoji = '\u{1F389}';
  fastImportLinear(c, 100, (i) => (i <= 95
    ? `feat: ${emoji.repeat(64)}\n`
    : `feat: ${'a'.repeat(114)}\n`));

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 72, evidence: { p95: 70, flagged: false } },
    detail(result),
  );
});

test('Seam 1: subjectCase and maxSubjectLength are computed over the Conventional Commits ones only', async (t) => {
  const c = createCase(t);
  // 50 Conventional Commits (45 lowercase, 5 uppercase; 47 short headers, 3 long) and 50
  // non-conventional commits with very short, lowercase-irrelevant headers: 100 read,
  // ccShare 0.5 (still a proposal). Over the 50 Conventional Commits only, lower is 0.9
  // (subjectCase: lower) and p95 is 130 (maxSubjectLength 130, flagged). Computed over all
  // 100 instead, lower would be 0.45 (any) and p95 would be 64 (maxSubjectLength 72, not
  // flagged).
  const conventional = [];
  for (let i = 1; i <= 50; i += 1) {
    const caseFail = i <= 5;
    const long = i > 47;
    const descLength = (long ? 130 : 64) - 'feat: '.length;
    const first = caseFail ? 'A' : 'a';
    conventional.push(`feat: ${first}${'a'.repeat(descLength - 1)}\n`);
  }
  const nonConventional = Array.from({ length: 50 }, (_, i) => `WIP: x${i}\n`);
  const messages = [...conventional, ...nonConventional];
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 0.5, detail(result));
  assert.deepEqual(result.json.proposal.subjectCase, { value: 'lower', evidence: { lower: 0.9 } }, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 130, evidence: { p95: 130, flagged: true } },
    detail(result),
  );
});

test('Seam 1: a 30-commit history distinguishes nearest-rank ceil from floor', async (t) => {
  const c = createCase(t);
  // 28 headers at length 50, then 2 at length 90. ceil(0.95 * 30) = 29, so the correct p95
  // is the 29th sorted value: 90 (one of the two tail commits). A floor-based mutant would
  // read rank 28 instead: 50 (still inside the 28-commit group) — a value this fixture
  // would not otherwise force, since 100-commit fixtures above have 0.95n already an
  // integer and do not distinguish floor from ceil.
  fastImportLinear(c, 30, (i) => {
    const length = i <= 28 ? 50 : 90;
    return `feat: ${'a'.repeat(length - 'feat: '.length)}\n`;
  });

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 30, detail(result));
  assert.deepEqual(
    result.json.proposal.maxSubjectLength,
    { value: 100, evidence: { p95: 90, flagged: false } },
    detail(result),
  );
});

test('M19 history-inference imports passesLowerCase and headerLineOf from M6, separately from lint (no duplicate case check or header split)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m);
  assert.notEqual(
    importMatch,
    null,
    'history-inference.mjs must import from ./message-grammar.mjs',
  );
  const [, names] = importMatch;
  assert.match(
    names,
    /\bpassesLowerCase\b/,
    'the message-grammar.mjs import must include passesLowerCase, not redefine the lowercase check',
  );
  assert.match(
    names,
    /\bheaderLineOf\b/,
    'the message-grammar.mjs import must include headerLineOf, not redefine the header split',
  );
  // No local case-check regex: a regression that redefines passesLowerCase instead of
  // importing it would reach for an uppercase-letter test like these.
  assert.doesNotMatch(source, /\[A-Z\]/);
  assert.doesNotMatch(source, /\\p\{Lu\}/);
});
