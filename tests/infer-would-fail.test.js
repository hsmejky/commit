'use strict';

// INF-06 (docs/roadmap/14-infer-and-commit-config.md): the top-level `wouldFail` (C:infer).
// M19 lints the Conventional Commits messages it read with M6 `lint`, under the proposed
// config values (`proposal.types.value`, `.scope.value`, `.body.value`, `.subjectCase.value`,
// `.maxSubjectLength.value`); `wouldFail` is how many of them fail. Non-conventional commits
// are never linted (they would all fail anyway, counted separately in `nonConventional`), so
// they must not add to `wouldFail`. Seam 1 through the shipped entry point, with
// `fastImportLinear` building the history fixtures, plus a static import check.

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

test('Seam 1: wouldFail counts known over-length and dropped-type commits, not non-conventional ones', async (t) => {
  const c = createCase(t);
  // 90 Conventional Commits: 85 short "feat" headers, 2 long "feat" headers (over the
  // proposed maxSubjectLength of 72, so they fail lint on length only), 3 "wip" headers
  // (3/90 = 3.3%, below the 5% kept threshold, so "wip" is dropped from types.value and
  // these 3 fail lint on type only) -- plus 10 non-conventional commits, which would all
  // fail lint too but are never linted: they must stay out of wouldFail, only counted in
  // nonConventional. p95 of the 90 header lengths lands among the 88 short ones (at most 2
  // of 90 are long), so the proposed maxSubjectLength stays 72 regardless of how long the
  // long headers are.
  const messages = [];
  for (let i = 1; i <= 85; i += 1) messages.push(`feat: change ${i}\n`);
  for (let i = 1; i <= 2; i += 1) messages.push(`feat: ${'a'.repeat(100)}\n`);
  for (let i = 1; i <= 3; i += 1) messages.push(`wip: half-done thing ${i}\n`);
  for (let i = 1; i <= 10; i += 1) messages.push(`WIP: change ${i}\n`);
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 0.9, detail(result));
  assert.equal(result.json.nonConventional, 10, detail(result));
  assert.deepEqual(result.json.proposal.maxSubjectLength.value, 72, detail(result));
  assert.deepEqual(result.json.droppedTypes, [{ type: 'wip', count: 3 }], detail(result));
  assert.equal(result.json.wouldFail, 5, detail(result));
});

test('Seam 1: a history with no lint failures among the Conventional Commits gives wouldFail: 0', async (t) => {
  const c = createCase(t);
  fastImportLinear(c, 100, (i) => `feat: change ${i}\n`);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.wouldFail, 0, detail(result));
});

test('M19 history-inference imports lint from M6, separately from the step table (no duplicate lint logic)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m);
  assert.notEqual(
    importMatch,
    null,
    'history-inference.mjs must import from ./message-grammar.mjs',
  );
  assert.match(
    importMatch[1],
    /\blint\b/,
    'the message-grammar.mjs import must include lint, not reimplement header/scope/body/case checks',
  );
});
