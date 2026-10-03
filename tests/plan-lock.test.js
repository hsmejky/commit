'use strict';

// CHG-03b (docs/roadmap/07-change-set.md): `plan` on a tree with changes reaches step 7,
// writes `state.json`, takes the run lock (M12 `acquire`, no takeover: a temporary file in
// `.commit-plan/` hard-linked into place as `.commit-plan/lock`) and writes `plan.json`, in
// that contract order (C:run-folder, C:plan step 7); step 8 renders the hunk index (M13
// `renderHunks`) into `hunks.txt` and the stdout `hunks` block. A throw before `acquire`
// deletes the provisional run folder; a throw after it also releases the lock (C:run-folder,
// C:cli-and-exit-codes `internal` row). Seam 1 only (docs/spec/testing-seams.md); the write
// order and the fault cases use the FND-10 fault preload.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

// Two modified tracked files: the common case every success test starts from.
async function planTwoModified(t, options) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'changed\n');
  const result = await runCommit(c, ['plan'], options);
  return { c, result };
}

test('plan reaching step 7 leaves .commit-plan/lock beside the run folder holding { planId, created }', async (t) => {
  const { c, result } = await planTwoModified(t);

  assert.equal(result.exitCode, 0, detail(result));
  const { planId } = result.json;
  assert.match(planId, PLAN_ID);
  const lock = readJson(path.join(runDirOf(c), 'lock'));
  assert.deepEqual(Object.keys(lock), ['planId', 'created']);
  assert.equal(lock.planId, planId);
  assert.equal(new Date(lock.created).toISOString(), lock.created);
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId, 'lock')), false, 'the lock is not inside <planId>/');
  assert.deepEqual(fs.readdirSync(runDirOf(c)).sort(), ['lock', planId].sort(), 'no lock temporary file is left');
});

test('plan prints runDir absolute, path.resolved and forward-slashed for a tree with changes (KD-R63)', async (t) => {
  const { c, result } = await planTwoModified(t);

  assert.equal(result.exitCode, 0, detail(result));
  const { planId, runDir } = result.json;
  assert.equal(runDir, path.resolve(c.repoDir, '.commit-plan', planId).split(path.sep).join('/'));
  assert.ok(path.isAbsolute(runDir), runDir);
  assert.equal(runDir.includes('\\'), false, runDir);
  assert.equal(result.json.reply, null);
  assert.equal(result.json.mode, 'split');
});

test('two modified files: stdout hunks lists h1 and h2, each pointing at its ### block in hunks.txt', async (t) => {
  const { c, result } = await planTwoModified(t);

  assert.equal(result.exitCode, 0, detail(result));
  const { hunks } = result.json;
  assert.equal(hunks.runDir, result.json.runDir);
  assert.equal(hunks.hunksFile, `${result.json.runDir}/hunks.txt`);
  assert.deepEqual(
    hunks.hunks.map(({ id, path: file, status, kind }) => ({ id, path: file, status, kind })),
    [
      { id: 'h1', path: 'a.txt', status: 'M', kind: 'text' },
      { id: 'h2', path: 'b.txt', status: 'M', kind: 'text' },
    ],
  );
  const lines = fs.readFileSync(path.join(runDirOf(c), result.json.planId, 'hunks.txt'), 'utf8').split('\n');
  for (const entry of hunks.hunks) {
    assert.equal(lines[entry.offset - 1], `### ${entry.id} M text ${entry.range} ${entry.path}`);
    const next = lines[entry.offset - 1 + entry.lines];
    assert.ok(next === undefined || next === '' || next.startsWith('### '), `block ${entry.id} ends before ${next}`);
  }
});

test('state.json stores the unit table and id map; plan.json tracked carries bucket, added, deleted', async (t) => {
  const { c, result } = await planTwoModified(t);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const state = readJson(path.join(folder, 'state.json'));
  assert.equal(state.version, 1);
  assert.deepEqual(state.units.map(({ id, path: file, status, kind }) => ({ id, path: file, status, kind })), [
    { id: 'h1', path: 'a.txt', status: 'M', kind: 'text' },
    { id: 'h2', path: 'b.txt', status: 'M', kind: 'text' },
  ]);
  for (const unit of state.units) {
    assert.match(unit.hash, /^[0-9a-f]{64}$/);
    assert.equal(state.idMap[unit.id], unit.hash);
  }
  const plan = readJson(path.join(folder, 'plan.json'));
  assert.equal(plan.planId, result.json.planId);
  assert.equal(plan.runDir, result.json.runDir);
  assert.deepEqual(plan.tracked, [
    { path: 'a.txt', oldPath: null, status: 'M', bucket: 'code', added: 1, deleted: 0 },
    { path: 'b.txt', oldPath: null, status: 'M', bucket: 'code', added: 1, deleted: 1 },
  ]);
});

// First write of `state.json`'s `interactive` field (workflows.mjs:186): `false` under
// `--no-user`, `true` otherwise. Not a CHG-03b criterion, but worth pinning (review finding 7).
test('state.json interactive is false under --no-user, true otherwise', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const plain = await runCommit(c, ['plan']);
  assert.equal(plain.exitCode, 0, detail(plain));
  const plainState = readJson(path.join(runDirOf(c), plain.json.planId, 'state.json'));
  assert.equal(plainState.interactive, true);

  const c2 = createCase(t);
  seed(c2, { 'a.txt': 'one\n' });
  c2.writeFile('a.txt', 'one\nmore\n');
  const noUser = await runCommit(c2, ['plan', '--split', '--no-user']);
  assert.equal(noUser.exitCode, 0, detail(noUser));
  const noUserState = readJson(path.join(runDirOf(c2), noUser.json.planId, 'state.json'));
  assert.equal(noUserState.interactive, false);
});

// `git diff --numstat -z HEAD`, the parser oracle: `added\tdeleted\tpath\0` per file.
function numstat(c) {
  const result = spawnSync('git', ['diff', '--numstat', '-z', 'HEAD'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  const counts = {};
  for (const record of result.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const [added, deleted, file] = record.split('\t');
    counts[file] = { added: Number(added), deleted: Number(deleted) };
  }
  return counts;
}

test('parser oracle: plan.json tracked added/deleted equal git diff --numstat -z', async (t) => {
  const c = createCase(t);
  seed(c, {
    'src/app.js': 'a\nb\nc\nd\n',
    'a b/c': 'x\n',
    'notes.md': 'keep\n',
  });
  c.writeFile('src/app.js', 'a\nB\nc\nd\ne\nf\n');
  c.writeFile('a b/c', '');
  c.writeFile('notes.md', 'keep\nadd one\nadd two\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const plan = readJson(path.join(runDirOf(c), result.json.planId, 'plan.json'));
  const counts = Object.fromEntries(plan.tracked.map(({ path: file, added, deleted }) => [file, { added, deleted }]));
  assert.deepEqual(counts, numstat(c));
  // KD-R1: the path whose patch headers render differently comes out raw.
  assert.ok(result.json.hunks.hunks.some((entry) => entry.path === 'a b/c'), JSON.stringify(result.json.hunks.hunks));
});

// The FND-10 preload, with its call-order log: every intercepted link/rename target, in order.
async function planWithFault(t, faultEnv) {
  const c = createCase(t);
  const log = path.join(c.root, 'fs-calls.log');
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'changed\n');
  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_LOG: log, ...faultEnv },
  });
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => path.basename(line))
    : [];
  return { c: c, result, calls };
}

function assertInternalNothingLeft(c, result) {
  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  assert.deepEqual(fs.readdirSync(runDirOf(c)), [], 'no lock, no lock temporary file and no run folder left');
}

test('a state.json rename failing with EIO: internal, nothing left, and no lock link was ever made', async (t) => {
  const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' });

  assertInternalNothingLeft(c, result);
  assert.deepEqual(calls, ['state.json']);
});

test('the lock link failing with EIO: internal (not held or busy), nothing left', async (t) => {
  const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_LINK_BASENAME: 'lock' });

  assertInternalNothingLeft(c, result);
  assert.deepEqual(calls, ['state.json', 'lock']);
});

test('a plan.json rename failing with EIO: internal, the lock released, nothing left', async (t) => {
  const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_RENAME_BASENAME: 'plan.json' });

  assertInternalNothingLeft(c, result);
  assert.deepEqual(calls.slice(0, 3), ['state.json', 'lock', 'plan.json']);
});

test('no fault: the state.json rename precedes the lock link, which precedes the plan.json rename', async (t) => {
  const { result, calls } = await planWithFault(t, {});

  assert.equal(result.exitCode, 0, detail(result));
  const firstState = calls.indexOf('state.json');
  const lockLink = calls.indexOf('lock');
  const planRename = calls.indexOf('plan.json');
  assert.ok(firstState !== -1 && lockLink !== -1 && planRename !== -1, calls.join(' '));
  assert.ok(firstState < lockLink, calls.join(' '));
  assert.ok(lockLink < planRename, calls.join(' '));
});
