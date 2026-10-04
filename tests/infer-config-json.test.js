'use strict';

// INF-07 (docs/roadmap/14-infer-and-commit-config.md): `configJson` per layer. M19
// `configFor(proposal, layers)` takes the raw current layer (M4 `readLayers`), replaces the
// proposal's five keys and keeps every other key, checked by M4 `validateLayer`, as
// `{ text } | { errors }` (C:infer, Q7). Seam 1 through the shipped `infer` entry point,
// plus a static import check.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');
const { libPath, loadLib } = require('./helpers/load-lib.js');

let config;
beforeEach(async () => {
  config = await loadLib('config');
});

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

test('Seam 1: a repo layer with scanIgnore, scope and an unknown key keeps them, gets the proposed scope, and passes validateLayer', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeRepoConfig(c, { scanIgnore: ['*.log'], scope: 'required', x: 1 });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const repo = result.json.configJson.repo;
  assert.ok(repo.text, detail(result));
  const parsed = JSON.parse(repo.text);
  assert.deepEqual(parsed.scanIgnore, ['*.log'], detail(result));
  assert.equal(parsed.scope, result.json.proposal.scope.value, detail(result));
  // An unknown key is not a `validateLayer` concern (CFG-06's warning is `readLayer`'s own,
  // never run here): it survives the merge untouched (review-INF-07 finding 4).
  assert.equal(parsed.x, 1, detail(result));
  assert.equal(config.validateLayer(parsed, config.REPO_LAYER), null, detail(result));
});

test('Seam 1: a user layer with a malformed scanIgnore keeps it in user.text, not user.errors (CFG-07 forward note)', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeUserConfig(c, { scanIgnore: 'x' });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const user = result.json.configJson.user;
  assert.equal(user.errors, undefined, detail(result));
  assert.ok(user.text, detail(result));
  assert.equal(JSON.parse(user.text).scanIgnore, 'x', detail(result));
});

test('Seam 1: a user layer with an invalid scanIgnore glob keeps it in user.text, not user.errors', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeUserConfig(c, { scanIgnore: ['**'] });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const user = result.json.configJson.user;
  assert.equal(user.errors, undefined, detail(result));
  assert.ok(user.text, detail(result));
  assert.deepEqual(JSON.parse(user.text).scanIgnore, ['**'], detail(result));
});

test('Seam 1: an unreadable repo config (a directory in its place) gives repo.errors, not repo.text', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  fs.mkdirSync(path.join(c.repoDir, '.claude', 'commit.json'), { recursive: true });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const repo = result.json.configJson.repo;
  assert.equal(repo.text, undefined, detail(result));
  assert.ok(Array.isArray(repo.errors), detail(result));
  assert.ok(repo.errors.some((m) => m.includes('not a regular file')), detail(result));
});

test('Seam 1: a malformed (non-JSON) user config gives user.errors, not user.text', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  fs.mkdirSync(c.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), '{ not json');

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const user = result.json.configJson.user;
  assert.equal(user.text, undefined, detail(result));
  assert.ok(Array.isArray(user.errors), detail(result));
  assert.ok(user.errors.some((m) => m.includes('not valid JSON')), detail(result));
});

test('Seam 1: text formatting is pinned (2-space indent, trailing newline, existing keys keep position, new keys appended in types/scope/body/subjectCase/maxSubjectLength order)', async (t) => {
  const c = createCase(t);
  seedProposal(c);
  writeRepoConfig(c, { scope: 'optional', unknownKey: 5 });

  const result = await runCommit(c, ['infer']);

  assertProposal(result);
  const repo = result.json.configJson.repo;
  const p = result.json.proposal;
  const expected = {
    scope: p.scope.value,
    unknownKey: 5,
    types: p.types.value,
    body: p.body.value,
    subjectCase: p.subjectCase.value,
    maxSubjectLength: p.maxSubjectLength.value,
  };
  assert.equal(repo.text, `${JSON.stringify(expected, null, 2)}\n`, detail(result));
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
