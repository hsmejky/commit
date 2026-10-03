'use strict';

// INF-03 (docs/roadmap/14-infer-and-commit-config.md): the proposal's `scope` and `body`
// fields (C:infer). `scope` is `required` at 90% or more of the Conventional Commits
// headers carrying a scope, `optional` at 10% or more, else `forbidden`; `body` is
// `optional` at 10% or more of the Conventional Commits messages carrying a body paragraph
// (a footer-only last paragraph, such as a lone `Closes #n`, is not a body), else
// `forbidden`. Both shares are taken over the Conventional Commits messages read only,
// excluding non-conventional ones from the denominator. Seam 1 through the shipped entry
// point, with `fastImportLinear` building the history fixtures.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');

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

// Builds a history of `scopedCount` scoped conventional commits, then `plainCount` unscoped
// conventional commits, so the scope share is exactly `scopedCount / (scopedCount +
// plainCount)`.
function scopeHistory(c, scopedCount, plainCount) {
  fastImportLinear(c, scopedCount + plainCount, (i) => (i <= scopedCount
    ? `feat(mod${i}): change ${i}\n`
    : `feat: change ${i}\n`));
}

test('Seam 1: a 90% scope share gives scope: required', async (t) => {
  const c = createCase(t);
  scopeHistory(c, 90, 10);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.scope, { value: 'required', evidence: { withScope: 0.9 } }, detail(result));
});

test('Seam 1: a 10% scope share gives scope: optional', async (t) => {
  const c = createCase(t);
  scopeHistory(c, 10, 90);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.scope, { value: 'optional', evidence: { withScope: 0.1 } }, detail(result));
});

test('Seam 1: an 89% scope share gives scope: optional', async (t) => {
  const c = createCase(t);
  scopeHistory(c, 89, 11);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.scope, { value: 'optional', evidence: { withScope: 0.89 } }, detail(result));
});

test('Seam 1: a 9% scope share gives scope: forbidden', async (t) => {
  const c = createCase(t);
  scopeHistory(c, 9, 91);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.scope, { value: 'forbidden', evidence: { withScope: 0.09 } }, detail(result));
});

test('Seam 1: a commit whose only extra paragraph is Closes #n does not count as a body', async (t) => {
  const c = createCase(t);
  // 20 conventional commits, 2 with a trailing "Closes #n" paragraph and nothing else: a
  // footer-only last paragraph, not a body (C:message-grammar). If it counted as a body,
  // withBody would be 0.1 (optional) instead of 0 (forbidden).
  fastImportLinear(c, 20, (i) => (i <= 2
    ? `feat: change ${i}\n\nCloses #${i}\n`
    : `feat: change ${i}\n`));

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 20, detail(result));
  assert.deepEqual(result.json.proposal.body, { value: 'forbidden', evidence: { withBody: 0 } }, detail(result));
});

test('Seam 1: scope and body shares are computed over the Conventional Commits ones only', async (t) => {
  const c = createCase(t);
  // 50 Conventional Commits (45 scoped, 5 with a body) and 50 non-conventional commits: 100
  // read, ccShare 0.5 (still a proposal). Over the 50 Conventional Commits only, scope share
  // is 0.9 (required) and body share is 0.1 (optional); computed over all 100 instead, they
  // would be 0.45 (optional) and 0.05 (forbidden).
  const conventional = [];
  for (let i = 1; i <= 45; i += 1) conventional.push(`feat(mod${i}): change ${i}\n`);
  for (let i = 46; i <= 50; i += 1) conventional.push(`feat: change ${i}\n\nbody line ${i}\n`);
  const nonConventional = Array.from({ length: 50 }, (_, i) => `WIP: change ${i}\n`);
  const messages = [...conventional, ...nonConventional];
  fastImportLinear(c, messages.length, (i) => messages[i - 1]);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 0.5, detail(result));
  assert.deepEqual(result.json.proposal.scope, { value: 'required', evidence: { withScope: 0.9 } }, detail(result));
  assert.deepEqual(result.json.proposal.body, { value: 'optional', evidence: { withBody: 0.1 } }, detail(result));
});

test('Seam 1: an exactly 10% with-body share gives body: optional', async (t) => {
  const c = createCase(t);
  // Of the 10 with-body commits, half also carry a trailing Closes #n footer after the body
  // paragraph: that footer must not strip the body (C:message-grammar). A regression that
  // treats any message with a footer as body-less would drop withBody to 0.05 (forbidden).
  fastImportLinear(c, 100, (i) => {
    if (i <= 5) return `feat: change ${i}\n\nbody line ${i}\n`;
    if (i <= 10) return `feat: change ${i}\n\nbody line ${i}\n\nCloses #${i}\n`;
    return `feat: change ${i}\n`;
  });

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.body, { value: 'optional', evidence: { withBody: 0.1 } }, detail(result));
});

test('Seam 1: a 9% with-body share gives body: forbidden', async (t) => {
  const c = createCase(t);
  fastImportLinear(c, 100, (i) => (i <= 9
    ? `feat: change ${i}\n\nbody line ${i}\n`
    : `feat: change ${i}\n`));

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.deepEqual(result.json.proposal.body, { value: 'forbidden', evidence: { withBody: 0.09 } }, detail(result));
});
