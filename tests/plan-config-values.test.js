'use strict';

// CFG-05 (docs/roadmap/04-config-and-attribution.md): `plan`'s per-key layered override
// (repo beats user beats default, arrays replaced whole) and the effective `config.values`
// / `config.sources` it stores in `state.json` and `plan.json` (C:plan). Unit-level coverage
// of `effectiveConfig`/`loadConfig` themselves lives in tests/config.test.js; this file is
// Seam 1 only, through the shipped `plan` and `check` entry points.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeUserConfig(c, value) {
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), JSON.stringify(value));
}

function writeRepoConfig(c, value) {
  c.writeFile('.claude/commit.json', JSON.stringify(value));
}

const ALL_DEFAULT_SOURCES = {
  types: 'default',
  scope: 'default',
  body: 'default',
  maxSubjectLength: 'default',
  subjectCase: 'default',
  scanIgnore: 'default',
};

test('plan with no config layers at all stores the Q6 defaults as config.values, every source default', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const config = await loadLib('config');
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  const stateJson = readJson(path.join(folder, 'state.json'));
  assert.deepEqual(planJson.config.values, config.DEFAULT_VALUES);
  assert.deepEqual(planJson.config.sources, ALL_DEFAULT_SOURCES);
  assert.deepEqual(stateJson.config.values, config.DEFAULT_VALUES);
  assert.deepEqual(stateJson.config.sources, ALL_DEFAULT_SOURCES);
});

test('a repo types layer beats a user types layer at Seam 1, source repo; a user-only key sources to user', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  writeUserConfig(c, { types: ['feat', 'fix', 'deps'], scope: 'optional' });
  writeRepoConfig(c, { types: ['feat'] });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.deepEqual(planJson.config.values.types, ['feat']);
  assert.equal(planJson.config.sources.types, 'repo');
  assert.equal(planJson.config.values.scope, 'optional');
  assert.equal(planJson.config.sources.scope, 'user');
  assert.equal(planJson.config.sources.body, 'default');
  const stateJson = readJson(path.join(folder, 'state.json'));
  assert.deepEqual(stateJson.config.values.types, ['feat']);
  assert.equal(stateJson.config.sources.types, 'repo');
});

// AC3: the effective values reach M14's lint (`validatePlan` reads `runState.config.values`,
// CFG-05's forward note). A repo layer that restricts `types` to `['feat']` makes a
// `chore:` header (a Q6-default type the repo layer removed) fail lint, while a `feat:`
// header still passes.
async function plannedRunWithRepoTypes(t, types) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  writeRepoConfig(c, { types });
  c.git(['add', '--', 'a.txt', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function writeWorkerPlan(runDir, header, body) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header, body, files: ['a.txt'], hunks: [] }],
    notIncluded: [],
  }));
}

test('a group header using a repo-only-allowed type passes lint at Seam 1', async (t) => {
  const { c, planId, runDir } = await plannedRunWithRepoTypes(t, ['feat']);
  writeWorkerPlan(runDir, 'feat: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
});

test('a group header using a Q6-default type the repo layer removed fails lint at Seam 1', async (t) => {
  const { c, planId, runDir } = await plannedRunWithRepoTypes(t, ['feat']);
  writeWorkerPlan(runDir, 'chore: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "type 'chore' not in types" },
  ]);
});
