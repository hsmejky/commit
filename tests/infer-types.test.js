'use strict';

// INF-05 (docs/roadmap/14-infer-and-commit-config.md): the proposal's `types` field and the
// top-level `droppedTypes` (C:infer). `types.value` always carries all 11 standard types
// (config.mjs `DEFAULT_VALUES.types`), plus each non-standard type at 5% or more of the
// Conventional Commits messages read, with its share in `types.evidence`; a non-standard
// type under 5% is dropped and listed in `droppedTypes` with its raw count instead. The
// share's denominator is the Conventional Commits messages read only, same as scope/body/
// subjectCase (INF-03, INF-04). Seam 1 through the shipped entry point, with
// `fastImportLinear` building the history fixtures, plus a static import check.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');
const { libPath } = require('./helpers/load-lib.js');

const STANDARD_TYPES = [
  'build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test',
];

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

test('Seam 1: a history without revert still proposes it; deps at 7% is kept, wip at 3 commits is dropped', async (t) => {
  const c = createCase(t);
  // 100 Conventional Commits: 7 "deps" (7%, kept), 3 "wip" (3%, dropped), and 90 spread
  // evenly (9 each) across the 10 standard types other than "revert", so "revert" never
  // appears in the history at all.
  const otherStandard = STANDARD_TYPES.filter((type) => type !== 'revert');
  const messages = [];
  for (let i = 1; i <= 7; i += 1) messages.push(`deps: bump dep ${i}\n`);
  for (let i = 1; i <= 3; i += 1) messages.push(`wip: half-done thing ${i}\n`);
  for (let i = 0; i < 90; i += 1) {
    const type = otherStandard[i % otherStandard.length];
    messages.push(`${type}: change ${i}\n`);
  }
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 1, detail(result));
  assert.deepEqual(
    result.json.proposal.types,
    { value: [...STANDARD_TYPES, 'deps'], evidence: { deps: 0.07 } },
    detail(result),
  );
  assert.ok(result.json.proposal.types.value.includes('revert'), detail(result));
  assert.deepEqual(result.json.droppedTypes, [{ type: 'wip', count: 3 }], detail(result));
});

// Exact boundary around the 5% threshold: a mutation from `>=` to `>` must flip "bar" (kept)
// without touching "baz" (dropped), and vice versa for a `<` to `<=` mutation on the drop
// side.
test('Seam 1: an exactly-5% non-standard type is kept; a 4% one is dropped', async (t) => {
  const c = createCase(t);
  // 100 Conventional Commits: 5 "bar" (exactly 5%, kept), 4 "baz" (4%, dropped), 91 "feat".
  const messages = [];
  for (let i = 1; i <= 5; i += 1) messages.push(`bar: change ${i}\n`);
  for (let i = 1; i <= 4; i += 1) messages.push(`baz: change ${i}\n`);
  for (let i = 1; i <= 91; i += 1) messages.push(`feat: change ${i}\n`);
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.types,
    { value: [...STANDARD_TYPES, 'bar'], evidence: { bar: 0.05 } },
    detail(result),
  );
  assert.deepEqual(result.json.droppedTypes, [{ type: 'baz', count: 4 }], detail(result));
});

test('Seam 1: a non-standard type share is computed over the Conventional Commits ones only', async (t) => {
  const c = createCase(t);
  // 50 Conventional Commits (4 "foo", 46 "feat") and 50 non-conventional commits: 100 read,
  // ccShare 0.5 (still a proposal). Over the 50 Conventional Commits only, foo's share is
  // 0.08 (kept, >= 5%); computed over all 100 instead it would be 0.04 (dropped).
  const conventional = [];
  for (let i = 1; i <= 4; i += 1) conventional.push(`foo: change ${i}\n`);
  for (let i = 5; i <= 50; i += 1) conventional.push(`feat: change ${i}\n`);
  const nonConventional = Array.from({ length: 50 }, (_, i) => `WIP: change ${i}\n`);
  const messages = [...conventional, ...nonConventional];
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 0.5, detail(result));
  assert.deepEqual(
    result.json.proposal.types,
    { value: [...STANDARD_TYPES, 'foo'], evidence: { foo: 0.08 } },
    detail(result),
  );
  assert.deepEqual(result.json.droppedTypes, [], detail(result));
});

test('Seam 1: a history using only standard types proposes the 11 types with no evidence and no dropped types', async (t) => {
  const c = createCase(t);
  fastImportLinear(c, 100, (i) => `${STANDARD_TYPES[i % STANDARD_TYPES.length]}: change ${i}\n`);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.deepEqual(
    result.json.proposal.types,
    { value: STANDARD_TYPES, evidence: {} },
    detail(result),
  );
  assert.deepEqual(result.json.droppedTypes, [], detail(result));
});

test('Seam 1: multiple kept and dropped non-standard types are each sorted alphabetically', async (t) => {
  const c = createCase(t);
  // 100 Conventional Commits, committed oldest first as: 86 "feat", then "bravo" (1, the
  // least-recent non-standard type), "alpha" (5), "yankee" (2), "zeta" (6, the most recent).
  // `infer` reads history newest first, so the order fed to `proposeTypes` is zeta, yankee,
  // alpha, bravo, feat...: first-seen (insertion) order among the kept types is [zeta,
  // alpha] and among the dropped ones [yankee, bravo] -- both the reverse of the alphabetical
  // order asserted below, so a mutation that drops the sort (keeping encounter order instead)
  // is caught on both lists.
  const messages = [];
  for (let i = 1; i <= 86; i += 1) messages.push(`feat: change ${i}\n`);
  for (let i = 1; i <= 1; i += 1) messages.push(`bravo: change ${i}\n`);
  for (let i = 1; i <= 5; i += 1) messages.push(`alpha: change ${i}\n`);
  for (let i = 1; i <= 2; i += 1) messages.push(`yankee: change ${i}\n`);
  for (let i = 1; i <= 6; i += 1) messages.push(`zeta: change ${i}\n`);
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(
    result.json.proposal.types,
    { value: [...STANDARD_TYPES, 'alpha', 'zeta'], evidence: { alpha: 0.05, zeta: 0.06 } },
    detail(result),
  );
  assert.deepEqual(
    result.json.droppedTypes,
    [{ type: 'bravo', count: 1 }, { type: 'yankee', count: 2 }],
    detail(result),
  );
});

test('M19 history-inference imports DEFAULT_VALUES from config.mjs (no duplicate standard-types list)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.mjs['"];?\s*$/m);
  assert.notEqual(
    importMatch,
    null,
    'history-inference.mjs must import from ./config.mjs',
  );
  assert.match(
    importMatch[1],
    /\bDEFAULT_VALUES\b/,
    'the config.mjs import must include DEFAULT_VALUES, not redefine the standard-types list',
  );
  // No local hardcoded standard-types array: a regression that redefines the list instead of
  // importing it would reach for this literal.
  assert.doesNotMatch(source, /'build',\s*'chore'/);
});
