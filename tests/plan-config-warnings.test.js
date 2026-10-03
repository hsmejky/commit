'use strict';

// CFG-06 (docs/roadmap/04-config-and-attribution.md): unknown keys, unknown values of a
// known key, and a key in the wrong layer warn and fall back instead of refusing `plan`
// (Q6). Unit-level coverage of `loadConfig`'s warnings lives in tests/config.test.js; this
// file is Seam 1 only, through the shipped `plan` entry point: `plan.warnings`, the effective
// fallback, and the real process's stderr.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

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

function seed(c) {
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
}

test('an unknown value for a known key in the repo layer warns, naming the value, and falls back to the user layer', async (t) => {
  const c = createCase(t);
  seed(c);
  writeUserConfig(c, { body: 'optional' });
  writeRepoConfig(c, { body: 'required' });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.equal(planJson.config.values.body, 'optional');
  assert.equal(planJson.config.sources.body, 'user');
  // review-CFG-06 finding 3 (Low): pins that the stored `config` has exactly these two keys,
  // so a leak of `warnings` into `plan.json`/`state.json`'s `config` (CFG-05's shape,
  // `workflows.mjs` `loadConfigLayers`) would be caught here.
  assert.deepEqual(Object.keys(planJson.config), ['values', 'sources']);
  assert.equal(planJson.warnings.length, 1);
  assert.match(planJson.warnings[0], /required/);
  assert.ok(result.stderr.includes(planJson.warnings[0]), detail(result));
});

test('an unknown key in the repo layer warns and has no effect (story 113)', async (t) => {
  const c = createCase(t);
  seed(c);
  writeRepoConfig(c, { workerModel: 'haiku', types: ['feat'] });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.deepEqual(planJson.config.values.types, ['feat']);
  assert.equal(planJson.warnings.length, 1);
  assert.match(planJson.warnings[0], /workerModel/);
  assert.ok(result.stderr.includes(planJson.warnings[0]), detail(result));
});

test('scanIgnore in the user layer warns as the wrong layer and leaves the effective scanIgnore unaffected', async (t) => {
  const c = createCase(t);
  seed(c);
  writeUserConfig(c, { scanIgnore: ['*.log'] });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.deepEqual(planJson.config.values.scanIgnore, []);
  assert.equal(planJson.config.sources.scanIgnore, 'default');
  assert.equal(planJson.warnings.length, 1);
  assert.match(planJson.warnings[0], /scanIgnore/);
  assert.ok(result.stderr.includes(planJson.warnings[0]), detail(result));
});

test('no config-warning case fails plan: a clean exit 0 with warnings present', async (t) => {
  const c = createCase(t);
  seed(c);
  writeRepoConfig(c, { unknownThing: true });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.equal(planJson.ok, true);
  assert.equal(planJson.warnings.length, 1);
});
