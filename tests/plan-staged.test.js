'use strict';

// CHG-14 (docs/roadmap/07-change-set.md): the mode-aware inventory, Seam 1. In `staged` the
// snapshot diffs the index only (units come from `git diff --cached`), `plan.json`'s
// `tracked` lists only the unstaged changes and `unstagedLeft` counts them (`null` in
// `split`); `state.json` stores `indexOnly` (paths whose staged content differs from both
// HEAD and the worktree) with their index blob IDs; a hidden staged-new path, or a scan hit
// in the index diff, or a staged non-UTF-8 path that is not hidden (user decision: the
// staged set is committed as-is and no unit can hold such a path), refuses `plan --staged`
// with `staged-hit` (exit 6, Q10, Q11); M10 `snapshotBlob` reads the repo config's index
// entry in `staged` (KD-R82).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function runFolders(c) {
  const runs = path.join(c.repoDir, '.commit-plan');
  return fs.existsSync(runs) ? fs.readdirSync(runs) : [];
}

function numbered(count, prefix = 'line') {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`);
}

// Runs git with raw stdin bytes (a path that is not UTF-8 cannot travel on argv).
function gitInput(c, args, input) {
  const result = spawnSync('git', args, { cwd: c.repoDir, env: { ...process.env, ...c.env }, input });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString('utf8').trim();
}

// Stages `content` under the raw path `bytes` with no worktree file (`git update-index
// --index-info` reads the path from stdin), so the entry is staged-new and gone from the
// worktree (`AD`) on every filesystem, non-UTF-8 names included.
function stageRaw(c, bytes, content) {
  const blob = gitInput(c, ['hash-object', '-w', '--stdin'], Buffer.from(content));
  gitInput(c, ['update-index', '--index-info'], Buffer.concat([
    Buffer.from(`100644 ${blob}\t`), bytes, Buffer.from('\n'),
  ]));
  return blob;
}

async function plan(c, flags) {
  const result = await runCommit(c, ['plan', ...flags]);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    result,
    state: JSON.parse(read('state.json')),
    planJson: JSON.parse(read('plan.json')),
    hunksTxt: read('hunks.txt'),
  };
}

async function refused(c, flags) {
  const result = await runCommit(c, ['plan', ...flags]);
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'staged-hit', detail(result));
  assert.deepEqual(runFolders(c), []);
  return result;
}

// --- AC1: units from the index only, `unstagedLeft` --------------------------------------

test('plan --staged on a git add -p style file: units from the index only, unstagedLeft counts the unstaged changes', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'a.txt': lines.join(''), 'b.txt': 'b\n' });
  const staged = ['STAGED 1\n', ...lines.slice(1)];
  c.writeFile('a.txt', staged.join(''));
  c.git(['add', '--', 'a.txt']);
  c.writeFile('a.txt', [...staged.slice(0, 19), 'UNSTAGED 20\n'].join(''));
  c.writeFile('b.txt', 'b2\n');

  const { state, planJson, hunksTxt } = await plan(c, ['--staged']);

  assert.equal(planJson.mode, 'staged');
  assert.deepEqual(state.units.map((unit) => unit.path), ['a.txt']);
  assert.match(hunksTxt, /\+STAGED 1/);
  assert.doesNotMatch(hunksTxt, /UNSTAGED 20|b2/);
  assert.deepEqual(planJson.preStaged, ['a.txt']);
  assert.deepEqual(planJson.tracked.map((entry) => entry.path), ['a.txt', 'b.txt']);
  assert.deepEqual(planJson.tracked.map(({ added, deleted }) => [added, deleted]), [[1, 1], [1, 1]]);
  assert.equal(planJson.unstagedLeft, 2);
  assert.deepEqual(state.indexOnly, [{ path: 'a.txt', blob: c.git(['rev-parse', ':a.txt']).trim(), ignored: false }]);
});

test('plan --staged reports an unstaged attribute-hidden text file in tracked with real counts, not binary 0/0', async (t) => {
  const c = createCase(t);
  seed(c, { '.gitattributes': '*.dat -diff\n', 'x.dat': 'line 1\n', 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('x.dat', 'line 1\nline 2\n');

  const { planJson } = await plan(c, ['--staged']);

  const entry = planJson.tracked.find((e) => e.path === 'x.dat');
  assert.deepEqual(entry && [entry.added, entry.deleted], [1, 0]);
});

test('plan --split keeps unstagedLeft null', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');

  const { planJson } = await plan(c, ['--split']);

  assert.equal(planJson.unstagedLeft, null);
});

// --- AC2: `indexOnly` under `--split` ------------------------------------------------------

test('plan --split stores indexOnly with blob IDs: no unit for a staged-then-deleted or reverted file, and plan --hunks matches', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { '.gitignore': 'ign.txt\n', 'y.txt': 'y\n', 'z.txt': lines.join('') });
  c.writeFile('x.txt', 'x\n');
  c.git(['add', '--', 'x.txt']);
  fs.rmSync(path.join(c.repoDir, 'x.txt'));
  c.writeFile('y.txt', 'y2\n');
  c.git(['add', '--', 'y.txt']);
  c.writeFile('y.txt', 'y\n');
  const zStaged = ['Z 1\n', ...lines.slice(1)];
  c.writeFile('z.txt', zStaged.join(''));
  c.git(['add', '--', 'z.txt']);
  c.writeFile('z.txt', [...zStaged.slice(0, 19), 'Z 20\n'].join(''));
  c.writeFile('ign.txt', 'i\n');
  c.git(['add', '-f', '--', 'ign.txt']);
  c.writeFile('ign.txt', 'i2\n');
  const blob = (p) => c.git(['rev-parse', `:${p}`]).trim();
  const expected = [
    { path: 'ign.txt', blob: blob('ign.txt'), ignored: true },
    { path: 'x.txt', blob: blob('x.txt'), ignored: false },
    { path: 'y.txt', blob: blob('y.txt'), ignored: false },
    { path: 'z.txt', blob: blob('z.txt'), ignored: false },
  ];

  const { result, state, planJson } = await plan(c, ['--split']);

  assert.deepEqual(state.indexOnly, expected);
  assert.deepEqual([...new Set(state.units.map((unit) => unit.path))], ['ign.txt', 'z.txt']);
  assert.equal(planJson.unstagedLeft, null);
  const again = await runCommit(c, ['plan', '--hunks', '--plan', result.json.planId]);
  assert.equal(again.exitCode, 0, detail(again));
});

test('plan --split stores a non-UTF-8 indexOnly path in its \\xNN form with its blob ID', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  const blob = stageRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'b\n');

  const { state } = await plan(c, ['--split']);

  assert.deepEqual(state.indexOnly, [{ path: 't\\xe9.txt', blob, ignored: false }]);
});

test('plan --split: a hidden staged-new non-UTF-8 path is stagedExcluded as hidden, not notUtf8', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  stageRaw(c, Buffer.from('.env\xe9', 'latin1'), 'SECRET=1\n');

  const { state, planJson } = await plan(c, ['--split']);

  assert.deepEqual(planJson.stagedExcluded, [{ path: '.env\\xe9', reason: 'hidden' }]);
  assert.deepEqual(state.notUtf8, []);
});

// --- AC3: `staged-hit`, no collapse ------------------------------------------------------

test('plan --staged refuses a force-added hidden file with staged-hit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('.env', 'SECRET=1\n');
  c.git(['add', '-f', '--', '.env']);
  c.writeFile('a.txt', 'a2\n');

  const result = await refused(c, ['--staged']);

  assert.equal(result.json.error.message, '`.env` is staged but hidden — unstage it or commit by hand');
});

test('plan --staged refuses a hidden staged-new non-UTF-8 path with staged-hit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  stageRaw(c, Buffer.from('.env\xe9', 'latin1'), 'SECRET=1\n');
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);

  const result = await refused(c, ['--staged']);

  assert.equal(result.json.error.message, '`.env\\xe9` is staged but hidden — unstage it or commit by hand');
});

test('plan --staged refuses a staged non-UTF-8 path that is not hidden with staged-hit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  stageRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'b\n');
  c.writeFile('a.txt', 'a2\n');

  const result = await refused(c, ['--staged']);

  assert.equal(result.json.error.message, '`t\\xe9.txt`: path is not UTF-8 — unstage it or commit by hand');
});

test('plan --staged refuses a scan hit in the index diff with staged-hit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  c.writeFile('t.js', `const token = "${'gh' + 'p_' + 'a'.repeat(36)}";\n`);
  c.git(['add', '--', 't.js']);
  c.writeFile('b.txt', 'b2\n');

  const result = await refused(c, ['--staged']);

  assert.equal(result.json.error.message, 'unstage `t.js` and run `/commit` again, or commit by hand');
});

test('plan --staged: a scan hit only in unstaged content does not refuse --staged', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 't.js': 'clean\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('t.js', `const token = "${'gh' + 'p_' + 'a'.repeat(36)}";\n`);

  const { planJson } = await plan(c, ['--staged']);

  assert.equal(planJson.mode, 'staged');
});

test('plan --staged on a staged 60-file new directory scans 60 units, no collapse', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  for (let i = 1; i <= 60; i += 1) c.writeFile(`gen/f${String(i).padStart(2, '0')}.txt`, `f${i}\n`);
  c.git(['add', '--', 'gen']);
  c.writeFile('a.txt', 'a2\n');

  const { state, planJson } = await plan(c, ['--staged']);

  assert.equal(state.units.length, 60);
  assert.deepEqual(planJson.untracked.collapsed, []);
  assert.deepEqual(planJson.stagedExcluded, []);
  assert.equal(planJson.unstagedLeft, 1);
});

// --- AC4: `case-rename` is `split`-only ---------------------------------------------------

test('core.ignorecase=true: plan --staged on a staged case-only git mv is not refused', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.ignorecase', 'true']);
  seed(c, { 'readme.txt': 'r\n', 'b.txt': 'b\n' });
  c.git(['mv', 'readme.txt', 'README.txt']);
  c.writeFile('b.txt', 'b2\n');

  const { planJson } = await plan(c, ['--staged']);

  assert.equal(planJson.mode, 'staged');
  assert.equal(planJson.unstagedLeft, 1);
});

// --- AC5: `snapshotBlob` reads the index entry (KD-R82) -----------------------------------

for (const [label, stagedText] of [['unparseable JSON', '{'], ['a non-array scanIgnore', '{"scanIgnore": "dist/**"}']]) {
  test(`plan --staged: a staged repo config with ${label} and a valid worktree copy flags scanIgnoreChanged`, async (t) => {
    const c = createCase(t);
    seed(c, { '.claude/commit.json': '{"scanIgnore": []}\n', 'a.txt': 'a\n' });
    c.writeFile('.claude/commit.json', stagedText);
    c.git(['add', '--', '.claude/commit.json']);
    c.writeFile('.claude/commit.json', '{"scanIgnore": []}\n');

    const { state, planJson } = await plan(c, ['--staged']);

    assert.equal(planJson.scan.scanIgnoreChanged, true);
    const configUnits = state.units.filter((unit) => unit.path === '.claude/commit.json').map((unit) => unit.id);
    assert.equal(configUnits.length > 0, true);
    assert.deepEqual(state.scanIgnoreUnits, configUnits);
  });
}
