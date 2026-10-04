'use strict';

// INF-07 (docs/roadmap/14-infer-and-commit-config.md): `configJson` per layer. M19
// `configFor(proposal, layers)` takes the raw current layer (M4 `readLayers`), replaces the
// proposal's five keys and keeps every other key, checked by M4 `validateLayer`, as
// `{ text } | { errors }` (C:infer, Q7). Seam 1 through the shipped `infer` entry point,
// plus a static import check.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');
const { libPath } = require('./helpers/load-lib.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function assertProposal(result) {
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.equal(result.json.outcome, 'proposal', detail(result));
  assert.notEqual(result.json.proposal, null, detail(result));
}

function writeUserConfig(c, value) {
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), JSON.stringify(value));
}

function writeRepoConfig(c, value) {
  c.writeFile('.claude/commit.json', JSON.stringify(value));
}

// 30 plain "feat" commits: every proposal field settles on a default-shaped value (no scope,
// no body, lower case, 72, the 11 standard types), so each test only has to reason about the
// one config key it is exercising.
function seedProposal(c) {
  fastImportLinear(c, 30, (i) => `feat: change ${i}\n`);
}

test('Seam 1: a repo layer with scanIgnore and scope keeps scanIgnore, gets the proposed scope, and passes validateLayer', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeRepoConfig(c, { scanIgnore: ['*.log'], scope: 'required' });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const repo = result.json.configJson.repo;
  assert.ok(repo.text, detail(result));
  const parsed = JSON.parse(repo.text);
  assert.deepEqual(parsed.scanIgnore, ['*.log'], detail(result));
  assert.equal(parsed.scope, result.json.proposal.scope.value, detail(result));
});

test('Seam 1: no user layer gives user.text holding only the proposal\'s keys', async (t) => {
  const c = createCase(t);
  seedProposal(c);

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const user = result.json.configJson.user;
  assert.ok(user.text, detail(result));
  const parsed = JSON.parse(user.text);
  assert.deepEqual(Object.keys(parsed).sort(), ['body', 'maxSubjectLength', 'scope', 'subjectCase', 'types']);
  assert.equal(parsed.scope, result.json.proposal.scope.value, detail(result));
  assert.equal(parsed.maxSubjectLength, result.json.proposal.maxSubjectLength.value, detail(result));
});

test('Seam 1: a user layer with maxSubjectLength 300 gives user.errors naming it; infer still exits 0', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeUserConfig(c, { maxSubjectLength: 300 });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const user = result.json.configJson.user;
  assert.equal(user.text, undefined, detail(result));
  assert.ok(Array.isArray(user.errors), detail(result));
  assert.ok(user.errors.some((m) => m.includes('300')), detail(result));
});

test('Seam 1: a repo layer with scanIgnore ["**"] gives repo.errors naming the pattern, not repo.text', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeRepoConfig(c, { scanIgnore: ['**'] });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const repo = result.json.configJson.repo;
  assert.equal(repo.text, undefined, detail(result));
  assert.ok(Array.isArray(repo.errors), detail(result));
  assert.ok(repo.errors.some((m) => m.includes('**')), detail(result));
});

test('configJson is null when there is no proposal', async (t) => {
  const c = createCase(t);
  fastImportLinear(c, 5, (i) => `feat: change ${i}\n`);

  const result = await runCommit(c, ['infer']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.outcome, 'too-few-commits', detail(result));
  assert.equal(result.json.configJson, null, detail(result));
});

test('M19 history-inference imports validateLayer from M4 (no duplicate layer-validation logic)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/config\.mjs['"];?\s*$/m);
  assert.notEqual(importMatch, null, 'history-inference.mjs must import from ./config.mjs');
  assert.match(
    importMatch[1],
    /\bvalidateLayer\b/,
    'the config.mjs import must include validateLayer, not reimplement layer validation',
  );
});
