'use strict';

// CFG-08 (docs/roadmap/04-config-and-attribution.md): wires M5's `resolveAttribution` into
// `plan` step 1 (`loadConfigLayers`, workflows.mjs) and stores the result on `ctx.attribution`
// for step 7 (`storeAndLock`) to write into both `state.json` and `plan.json` (C:run-folder,
// C:plan `attribution`). AC3 only: the resolved trailer and source are in the state file, in
// the contract's shape `{ trailer, source }`, read from there instead of re-resolved. The
// resolver itself (tests/attribution.test.js) is pure and already pinned; this file covers
// Seam 1 only, through the shipped entry point.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('plan on a tree with changes stores the default attribution trailer and source in state.json and plan.json', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const expected = { trailer: DEFAULT_TRAILER, source: 'default' };
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, expected);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution, expected);
});

test('plan --reword on a clean tree also stores the default attribution in state.json and plan.json', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const expected = { trailer: DEFAULT_TRAILER, source: 'default' };
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, expected);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution, expected);
});

test('attribution carries no model name and no agent-controlled flag changes it', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan', '--split', '--no-user']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const state = readJson(path.join(folder, 'state.json'));
  assert.equal(state.attribution.trailer, DEFAULT_TRAILER);
  assert.equal(state.attribution.source, 'default');
});

// An agent can write .claude/commit.json itself (it is tracked, repo-layer config); the
// tracer must not read it, so an `attribution` key there changes nothing (Q5, AC2).
test('an agent-writable .claude/commit.json attribution key does not change the resolved trailer', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('.claude/commit.json', JSON.stringify({ attribution: { commit: false } }));
  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'add repo config']);
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const expected = { trailer: DEFAULT_TRAILER, source: 'default' };
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, expected);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution, expected);
});
