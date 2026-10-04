'use strict';

// CHG-19 (docs/roadmap/07-change-set.md): a separate `plan --hunks --plan <planId>` call
// rebuilds the temporary index from the lists `plan` stored, re-diffs and matches the stored
// `id → hash` map with M10 `matchIds` (C:plan-hunks, Q9, Q11, M10, M18 "`plan --hunks`"). The
// same hash set → `plan`'s IDs; any difference → exit 6 `diff-changed`; a moved HEAD → exit 6
// `head-moved`; past its own 540 s deadline → exit 5 `timeout`. Each of them ends the run
// (C:cli-and-exit-codes: the lock and the run folder go). Seam 1, plus M10 `matchIds` in
// process.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

let changeSet;
beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`).join('');
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function readState(c, planId) {
  return JSON.parse(fs.readFileSync(path.join(runDirOf(c), planId, 'state.json'), 'utf8'));
}

// `plan` (exit 0, the lock held), then the IDs and paths of its in-process hunk index.
async function mint(c, argv = ['plan']) {
  const result = await runCommit(c, argv);
  assert.equal(result.exitCode, 0, detail(result));
  assert.notEqual(result.json.hunks, null, detail(result));
  return { planId: result.json.planId, hunks: result.json.hunks };
}

function hunks(c, planId, options) {
  return runCommit(c, ['plan', '--hunks', '--plan', planId], options);
}

function idsAndPaths(index) {
  return index.hunks.map(({ id, path: file, status, kind, range }) => ({ id, path: file, status, kind, range }));
}

// The run ended (C:cli-and-exit-codes): neither the lock nor the run folder is left.
function assertRunEnded(c) {
  const left = fs.existsSync(runDirOf(c)) ? fs.readdirSync(runDirOf(c)) : [];
  assert.deepEqual(left, [], `left in .commit-plan: ${left.join(', ')}`);
}

function assertRefused(result, exitCode, kind) {
  assert.equal(result.exitCode, exitCode, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, kind, detail(result));
  assert.equal(result.json.reply.status, 'failed', detail(result));
}

// Two separated edits in one file (two hunk units) plus one untracked candidate.
function dirtyCase(t) {
  const c = createCase(t);
  seed(c, { 'a.txt': numbered(30) });
  c.writeFile('a.txt', numbered(30).replace('2\n', 'two\n').replace('28\n', 'twenty-eight\n'));
  c.writeFile('new.txt', 'fresh\n');
  return c;
}

test('an unchanged tree: the separate call emits plan\'s own IDs and marks the run resumed', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  const before = readState(c, minted.planId);

  const result = await hunks(c, minted.planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  assert.deepEqual(idsAndPaths(result.json), idsAndPaths(minted.hunks));
  assert.deepEqual(result.json.hunks.map(({ id }) => id), ['h1', 'h2', 'h3']);
  for (const key of ['runDir', 'mode', 'config', 'recentSubjects', 'counts', 'hunksFile']) {
    assert.deepEqual(result.json[key], minted.hunks[key], key);
  }
  assert.equal(fs.readFileSync(result.json.hunksFile, 'utf8').length > 0, true);
  const after = readState(c, minted.planId);
  assert.equal(after.resumed, true);
  assert.equal(after.lintFailures, 0);
  // Only its own fields change: the map, the unit table and the notices survive.
  const { resumed, lintFailures, ...rest } = after;
  const { lintFailures: _old, ...restBefore } = before;
  assert.deepEqual(rest, restBefore);
  // The lock is still held and this call's `call.lock` is gone.
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), true);
  assert.equal(fs.existsSync(path.join(runDirOf(c), minted.planId, 'call.lock')), false);
});

test('AC1: a file edited between plan and a separate plan --hunks → exit 6 diff-changed, run ended, nothing committed', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  const head = c.git(['rev-parse', 'HEAD']);
  c.writeFile('a.txt', numbered(30).replace('2\n', 'TWO\n').replace('28\n', 'twenty-eight\n'));

  const result = await hunks(c, minted.planId);

  assertRefused(result, 6, 'diff-changed');
  assert.equal(result.json.error.message, 'files changed since plan, run /commit again');
  assertRunEnded(c);
  assert.equal(c.git(['rev-parse', 'HEAD']), head, 'nothing committed');
});

test('a new hunk in a planned file, every stored hunk intact → diff-changed (the same hash set, not a subset)', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  c.writeFile('a.txt', numbered(30).replace('2\n', 'two\n').replace('15\n', 'fifteen\n').replace('28\n', 'twenty-eight\n'));

  const result = await hunks(c, minted.planId);

  assertRefused(result, 6, 'diff-changed');
  assertRunEnded(c);
});

test('AC2: a manual commit between plan and a separate plan --hunks → exit 6 head-moved, run ended', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  c.git(['commit', '-q', '-a', '-m', 'by hand']);

  const result = await hunks(c, minted.planId);

  assertRefused(result, 6, 'head-moved');
  assert.equal(result.json.error.message, 'HEAD moved since plan (commit made elsewhere?), run /commit again');
  assertRunEnded(c);
});

test('AC3: a stored untracked path deleted after plan → diff-changed', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  fs.rmSync(path.join(c.repoDir, 'new.txt'));

  const result = await hunks(c, minted.planId);

  assertRefused(result, 6, 'diff-changed');
  assertRunEnded(c);
});

test('AC3: a new untracked file created after plan is ignored (same IDs)', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  c.writeFile('later.txt', 'created after plan\n');

  const result = await hunks(c, minted.planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(idsAndPaths(result.json), idsAndPaths(minted.hunks));
  assert.equal(result.json.hunks.some(({ path: file }) => file === 'later.txt'), false);
});

test('AC4: a force-added gitignored file is still a unit on the re-snapshot (stored lists, not recomputed)', async (t) => {
  const c = createCase(t);
  seed(c, { '.gitignore': '*.log\n', 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\ntwo\n');
  c.writeFile('forced.log', 'kept on purpose\n');
  c.git(['add', '-f', '--', 'forced.log']);
  const minted = await mint(c, ['plan', '--split']);
  assert.ok(minted.hunks.hunks.some(({ path: file }) => file === 'forced.log'), JSON.stringify(minted.hunks));
  // Unstaged again after `plan`: a recomputed inventory would no longer see it at all.
  c.git(['rm', '-q', '--cached', '--', 'forced.log']);

  const result = await hunks(c, minted.planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(idsAndPaths(result.json), idsAndPaths(minted.hunks));
});

test('AC5: a separate plan --hunks call whose own clock crosses its own 540 s deadline → exit 5 timeout, run ended', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  // The step holds once this call's own `call.lock` exists (M12 `open`), so the clock is
  // this call's own: the minting `plan` ran in another process with the real clock.
  const schedulePath = path.join(c.root, 'schedule.json');
  const callLock = path.join(runDirOf(c), minted.planId, 'call.lock');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: callLock }, elapsedMs: 541_000 }]));

  const result = await hunks(c, minted.planId, {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assertRefused(result, 5, 'timeout');
  assert.match(result.json.error.message, /540-second deadline/);
  assertRunEnded(c);
});

test('a planId whose run has ended → lock refusal, nothing created', async (t) => {
  const c = dirtyCase(t);
  const minted = await mint(c);
  await runCommit(c, ['release', '--plan', minted.planId]);

  const result = await hunks(c, minted.planId);

  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assertRunEnded(c);
});

test('M10 matchIds exact: the same hash set → the current units under the stored IDs, in ID order', () => {
  const units = [{ hash: 'b', path: 'y' }, { hash: 'a', path: 'x' }];

  assert.deepEqual(changeSet.matchIds({ h1: 'a', h2: 'b' }, units, { exact: true }), {
    ok: true,
    units: [{ id: 'h1', hash: 'a', path: 'x' }, { id: 'h2', hash: 'b', path: 'y' }],
  });
});

test('M10 matchIds exact: a current hash no stored ID names → unmatched, listed as extra', () => {
  const units = [{ hash: 'a', path: 'x' }, { hash: 'c', path: 'z' }];

  assert.deepEqual(changeSet.matchIds({ h1: 'a' }, units, { exact: true }), {
    ok: false, code: 'unmatched', unmatched: [], extra: ['z'],
  });
  assert.deepEqual(changeSet.matchIds({ h1: 'a', h2: 'b' }, units, { exact: true }), {
    ok: false, code: 'unmatched', unmatched: ['h2'], extra: ['z'],
  });
});
