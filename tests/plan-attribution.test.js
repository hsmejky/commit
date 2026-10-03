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

// CFG-10 (docs/roadmap/04-config-and-attribution.md): project-local and project settings
// layers under the injected `projectDir`, ahead of the user layer, through the shipped
// entry point (workflows.mjs `loadConfigLayers` now passes `ctx.injected.projectDir`).
// These cover the slice's four Seam 1 ACs end to end; the resolver's own unit coverage
// (precedence, two passes, warnings) lives in tests/attribution.test.js.
function writeProjectSettings(c, filename, value) {
  c.writeFile(path.join('.claude', filename), JSON.stringify(value));
}

test('settings.local.json beats settings.json beats user settings at Seam 1, source names the layer', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: User <u@x>' } });
  writeProjectSettings(c, 'settings.json', { attribution: { commit: 'Co-Authored-By: Project <p@x>' } });
  writeProjectSettings(c, 'settings.local.json', { attribution: { commit: 'Co-Authored-By: Local <l@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: Local <l@x>', source: 'project-local' });
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution,
    { trailer: 'Co-Authored-By: Local <l@x>', source: 'project-local' });
});

test('dropping settings.local.json falls through to settings.json at Seam 1, source project', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: User <u@x>' } });
  writeProjectSettings(c, 'settings.json', { attribution: { commit: 'Co-Authored-By: Project <p@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: Project <p@x>', source: 'project' });
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution,
    { trailer: 'Co-Authored-By: Project <p@x>', source: 'project' });
});

test('dropping both project layers falls through to user settings at Seam 1, source user', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: User <u@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: User <u@x>', source: 'user' });
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution,
    { trailer: 'Co-Authored-By: User <u@x>', source: 'user' });
});

// Q5 "two passes": attribution.commit is checked across every layer before
// includeCoAuthoredBy is checked in any, so a project-local includeCoAuthoredBy: false does
// not shadow a user attribution.commit.
test('includeCoAuthoredBy: false in project-local with attribution.commit in user: the user trailer applies at Seam 1', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: User <u@x>' } });
  writeProjectSettings(c, 'settings.local.json', { includeCoAuthoredBy: false });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: User <u@x>', source: 'user' });
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution,
    { trailer: 'Co-Authored-By: User <u@x>', source: 'user' });
});

test('CLAUDE_PROJECT_DIR pointed at a separate directory: its settings apply, the repo\'s own .claude/ is ignored', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  const otherProject = path.join(c.root, 'other-project');
  fs.mkdirSync(path.join(otherProject, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(otherProject, '.claude', 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: Other <o@x>' } }),
  );
  writeProjectSettings(c, 'settings.json', { attribution: { commit: 'Co-Authored-By: Repo <r@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan'], { env: { CLAUDE_PROJECT_DIR: otherProject } });

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: Other <o@x>', source: 'project' });
});

// No walk-up (PRE-11): without CLAUDE_PROJECT_DIR, the project directory is the process cwd
// the entry point sees, never a parent of it.
test('without CLAUDE_PROJECT_DIR, a subfolder\'s own .claude/ beats the repo toplevel\'s', async (t) => {
  const c = createCase(t, { projectDir: null });
  seed(c, { 'a.txt': 'one\n' });
  writeProjectSettings(c, 'settings.json', { attribution: { commit: 'Co-Authored-By: Toplevel <t@x>' } });
  const sub = c.writeFile('sub/.claude/settings.json',
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: Sub <s@x>' } }));
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan'], { cwd: path.dirname(path.dirname(sub)) });

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: Sub <s@x>', source: 'project' });
});

test('without CLAUDE_PROJECT_DIR, a subfolder with no .claude/ of its own gets the user layer, the toplevel\'s not read', async (t) => {
  const c = createCase(t, { projectDir: null });
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: User <u@x>' } });
  writeProjectSettings(c, 'settings.json', { attribution: { commit: 'Co-Authored-By: Toplevel <t@x>' } });
  const bareMarker = c.writeFile('bare/.gitkeep', '');
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan'], { cwd: path.dirname(bareMarker) });

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: User <u@x>', source: 'user' });
});

// AC4 (story 112): with CLAUDE_CONFIG_DIR set (createCase's default), the user layer comes
// from $CLAUDE_CONFIG_DIR/settings.json, not <osHome>/.claude/settings.json, even when the
// latter also exists.
test('with CLAUDE_CONFIG_DIR set, the user layer is read from it, not the OS-home default', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  fs.mkdirSync(path.join(c.osHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(c.osHome, '.claude', 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: OsHome <h@x>' } }),
  );
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: ConfigDir <c@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: ConfigDir <c@x>', source: 'user' });
});

// Mirror of the above without CLAUDE_CONFIG_DIR: the OS-home default applies, and a file at
// the path CLAUDE_CONFIG_DIR would have pointed to (had it been set) has no effect.
test('without CLAUDE_CONFIG_DIR, the user layer is the OS-home default, not an unset config dir\'s path', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  seed(c, { 'a.txt': 'one\n' });
  const unsetConfigDir = path.join(c.root, 'claude');
  fs.mkdirSync(unsetConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(unsetConfigDir, 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: Unset <u2@x>' } }),
  );
  fs.mkdirSync(c.claudeHome, { recursive: true });
  fs.writeFileSync(
    path.join(c.claudeHome, 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: OsHomeDefault <h2@x>' } }),
  );
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: OsHomeDefault <h2@x>', source: 'user' });
});
