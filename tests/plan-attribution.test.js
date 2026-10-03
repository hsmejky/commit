'use strict';

// CFG-08/CFG-09 (docs/roadmap/04-config-and-attribution.md): wires M5's `resolveAttribution`
// into `plan` step 1 (`loadConfigLayers`, workflows.mjs) and stores the result on
// `ctx.attribution` for step 7 (`storeAndLock`) to write into `state.json` (always
// `{ trailer, source }`) and `plan.json` (`null` when `trailer` is `null`, C:plan
// `attribution`), read from there instead of re-resolved. CFG-09 widens this to the user
// settings layer (`<claudeHome>/settings.json`) and `plan.json`'s `warnings` field. The
// resolver itself (tests/attribution.test.js) is pinned at the unit level; this file covers
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

// CFG-09: the user settings layer (`<claudeHome>/settings.json`, not the repo's own
// commit.json) now feeds resolveAttribution. These three cover the slice's ACs end to end,
// through the shipped `plan` entry point; resolveAttribution's own unit coverage (dropped
// lines, includeCoAuthoredBy precedence) lives in tests/attribution.test.js.
function writeUserSettings(c, value) {
  fs.writeFileSync(path.join(c.claudeHome, 'settings.json'), JSON.stringify(value));
}

test('attribution.commit: "" in the user settings layer resolves to no trailer in plan.json, source user in state.json', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: '' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.equal(readJson(path.join(folder, 'plan.json')).attribution, null);
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, { trailer: null, source: 'user' });
});

test('attribution.commit with a non-trailer line keeps only the trailer and warns in plan.json', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: '🤖 line\n\nCo-Authored-By: X <x@y>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const planJson = readJson(path.join(folder, 'plan.json'));
  assert.deepEqual(planJson.attribution, { trailer: 'Co-Authored-By: X <x@y>', source: 'user' });
  assert.equal(planJson.warnings.length, 1);
});

// A clean tree takes the reply branch instead of the hunks one (C:plan: `reply` is null only
// when the worker still has hunks to read), so this is the seam that reaches `reply.notices`.
test('attribution.commit with a non-trailer line also surfaces the warning in the reply notices on a clean tree', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: '🤖 line\n\nCo-Authored-By: X <x@y>' } });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.ok(
    result.json.reply.notices.some((n) => n.includes('attribution.commit')),
    JSON.stringify(result.json.reply.notices),
  );
});

test('includeCoAuthoredBy: false in the user settings layer resolves to no trailer, source user', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { includeCoAuthoredBy: false });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.equal(readJson(path.join(folder, 'plan.json')).attribution, null);
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, { trailer: null, source: 'user' });
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
