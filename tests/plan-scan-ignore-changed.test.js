'use strict';

// SCN-14 (docs/roadmap/05-scanner.md): Seam 1 proof that `plan` wires M4's pure
// `scanIgnoreChanged` and M10's `snapshotBlob` together end to end: the repo config's units
// are flagged in `state.json`'s `scanIgnoreUnits` and the comparison's result is reported in
// `plan.json`'s `scan.scanIgnoreChanged`, whenever the repo config's `scanIgnore` differs
// between HEAD and the uncommitted snapshot side (CFG-01 items 2-5). Unit-level coverage of
// the pure comparison itself (invalid JSON, non-array `scanIgnore`, missing blob) lives in
// tests/config.test.js; "a `scanIgnore` pattern committed at HEAD exempts a matching hit"
// is already covered end to end by tests/plan-scan.test.js's own scanIgnore case.
//
// The roadmap AC "snapshot content that is not valid JSON, or a non-array `scanIgnore`,
// counts as changed" cannot be reached in `split` mode: there `snapshotBlob` reads the same
// on-disk file `loadConfig`'s repo layer validates, which refuses with a `config` error
// first. In `staged` mode `snapshotBlob` reads the index entry, so a staged invalid copy next
// to a valid worktree copy reaches `scanIgnoreChanged`: tests/plan-staged.test.js covers it
// end to end (CHG-14, KD-R82), and tests/config.test.js covers the pure comparison.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function writeRepoConfig(c, text) {
  c.writeFile('.claude/commit.json', text);
}

function commitAll(c, message) {
  c.git(['add', '-A']);
  c.git(['commit', '-q', '-m', message]);
}

async function plan(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    hunks: result.json.hunks.hunks,
    state: JSON.parse(read('state.json')),
    planJson: JSON.parse(read('plan.json')),
  };
}

function configUnitIds(hunks) {
  return hunks
    .filter((h) => h.path === '.claude/commit.json' || h.oldPath === '.claude/commit.json')
    .map((h) => h.id)
    .sort();
}

test('editing only maxSubjectLength leaves scanIgnoreChanged false and scanIgnoreUnits empty', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, JSON.stringify({ maxSubjectLength: 72, scanIgnore: ['dist/**'] }));
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  writeRepoConfig(c, JSON.stringify({ maxSubjectLength: 50, scanIgnore: ['dist/**'] }));

  const { state, planJson } = await plan(c);

  assert.equal(planJson.scan.scanIgnoreChanged, false, detail(planJson));
  assert.deepEqual(state.scanIgnoreUnits, []);
});

test('adding a scanIgnore pattern flags every repo-config unit, including a hunk that edits only another key', async (t) => {
  const c = createCase(t);
  const pad = Array.from({ length: 7 }, (_, i) => `  "pad${i + 1}": ${i + 1}`).join(',\n');
  const head = `{\n  "maxSubjectLength": 72,\n${pad},\n  "scanIgnore": []\n}\n`;
  writeRepoConfig(c, head);
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  const worktree = head
    .replace('"maxSubjectLength": 72', '"maxSubjectLength": 50')
    .replace('"scanIgnore": []', '"scanIgnore": ["dist/**"]');
  writeRepoConfig(c, worktree);

  const { hunks, state, planJson } = await plan(c);

  const configHunks = hunks.filter((h) => h.path === '.claude/commit.json');
  assert.equal(configHunks.length, 2, `expected 2 separate hunks in the repo config, got ${configHunks.length}`);
  assert.equal(planJson.scan.scanIgnoreChanged, true, detail(planJson));
  assert.deepEqual([...state.scanIgnoreUnits].sort(), configUnitIds(hunks));
});

test('a missing repo config file, with HEAD holding patterns, counts as changed', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }));
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  fs.rmSync(path.join(c.repoDir, '.claude', 'commit.json'));
  c.writeFile('a.txt', 'one\nmore\n');

  const { hunks, state, planJson } = await plan(c);

  assert.equal(planJson.scan.scanIgnoreChanged, true, detail(planJson));
  assert.deepEqual([...state.scanIgnoreUnits].sort(), configUnitIds(hunks));
});

test('an untracked, gitignored repo config with its own scanIgnore leaves scanIgnoreChanged false: no unit is the repo config', async (t) => {
  const c = createCase(t);
  c.writeFile('.gitignore', '.claude/\n');
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }));
  c.writeFile('a.txt', 'one\nmore\n');

  const { hunks, state, planJson } = await plan(c);

  assert.equal(configUnitIds(hunks).length, 0, 'the repo config has no unit here');
  assert.equal(planJson.scan.scanIgnoreChanged, false, detail(planJson));
  assert.deepEqual(state.scanIgnoreUnits, []);
});

test('no repo config file at all, on either side, is no patterns and no change', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  c.writeFile('a.txt', 'one\nmore\n');

  const { planJson, state } = await plan(c);

  assert.equal(planJson.scan.scanIgnoreChanged, false, detail(planJson));
  assert.deepEqual(state.scanIgnoreUnits, []);
});

// Moved to a destination outside `.claude/`: a rename whose new path lands back inside
// `.claude/` drops the add side from the unit list entirely (only the `D` of the old path
// survives; the new path goes to `plan.stagedExcluded` instead) — the M9 hidden rule
// (`.claude/` is a dot-segment; only `.claude/commit.json`, `settings.json`, `CLAUDE.md` and
// four dirs are excepted) applied to a staged-new path, documented in C:untracked-files
// (lines 9-10) and explicitly in C:plan ("a tracked file renamed ... to a hidden path in
// `stagedExcluded` still leaves the tree dirty"), independently of SCN-14 and of
// `commit.json` specifically — reproduced with two unrelated `.claude/`-to-`.claude/`
// filenames holding no `scanIgnore` key; out of scope here. Padded with filler lines so the
// single-line edit keeps enough byte similarity for git's default `-M` rename threshold.
const PAD = Array.from({ length: 8 }, (_, i) => `  "pad${i + 1}": ${i + 1},\n`).join('');

test('renaming the repo config while also editing scanIgnore flags the unit by its old path', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, `{\n${PAD}  "scanIgnore": ["old/**"]\n}\n`);
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  c.git(['mv', '.claude/commit.json', 'moved.json']);
  c.writeFile('moved.json', `{\n${PAD}  "scanIgnore": ["dist/**"]\n}\n`);
  c.git(['add', 'moved.json']);

  const { hunks, state, planJson } = await plan(c);

  const renamed = hunks.find((h) => h.oldPath === '.claude/commit.json');
  assert.ok(renamed, `no hunk found with oldPath .claude/commit.json, got ${JSON.stringify(hunks)}`);
  assert.equal(renamed.status, 'R');
  assert.equal(planJson.scan.scanIgnoreChanged, true, detail(planJson));
  assert.ok(state.scanIgnoreUnits.includes(renamed.id), JSON.stringify(state.scanIgnoreUnits));
});

test('renaming the repo config away with no scanIgnore edit still counts as changed when HEAD holds patterns', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }, null, 2) + '\n');
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  c.git(['mv', '.claude/commit.json', 'moved.json']);

  const { hunks, state, planJson } = await plan(c);

  const renamed = hunks.find((h) => h.oldPath === '.claude/commit.json');
  assert.ok(renamed, `no hunk found with oldPath .claude/commit.json, got ${JSON.stringify(hunks)}`);
  assert.equal(planJson.scan.scanIgnoreChanged, true, detail(planJson));
  assert.ok(state.scanIgnoreUnits.includes(renamed.id), JSON.stringify(state.scanIgnoreUnits));
});

test('an invalid scanIgnore at HEAD fixed in the worktree with a real pattern counts as changed and flags the unit', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, JSON.stringify({ scanIgnore: 'dist/**' }));
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }));

  const { hunks, state, planJson } = await plan(c);

  assert.equal(planJson.config.values.scanIgnore.length, 0, detail(planJson));
  assert.equal(planJson.warnings.length, 1, detail(planJson));
  assert.equal(planJson.scan.scanIgnoreChanged, true, detail(planJson));
  assert.deepEqual([...state.scanIgnoreUnits].sort(), configUnitIds(hunks));
});
