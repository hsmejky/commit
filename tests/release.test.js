'use strict';

// RUN-01 (docs/roadmap/09-runs.md): `release --plan <planId>` ends a run. When the run lock
// holds that `planId` it removes the lock and deletes the run folder; otherwise it is a
// no-op that exits 0 (C:commit-release `release`, C:run-folder, Q22, stories 194 and 206).
// Seam 1 only: the shipped entry point as a subprocess through the FND-04 harness; each
// fixture writes the lock and folders in the C:run-folder shape, as `plan` would.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { parseBaseCallerRule } = require('./helpers/reply-contract-doc.js');

const NOTHING_TO_RELEASE = 'nothing to release: the run has already ended or was taken over';
const CREATED = '2026-01-01T00:00:00.000Z';

function seedCommit(c) {
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
}

// A repo with one commit and the `/.commit-plan/` exclude line `plan` adds before it first
// creates the run-folder directory (C:run-folder), so the fixture's run files leave the
// working tree clean.
function createRepo(t) {
  const c = createCase(t);
  seedCommit(c);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '/.commit-plan/\n');
  return c;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

// Writes `<runDir>/lock` with the given content (an object is written as JSON).
function writeLock(runDir, content) {
  fs.mkdirSync(runDir, { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(runDir, 'lock'), text);
}

// Creates `<runDir>/<planId>/` with a state file and the temporary index inside.
function writeRunFolder(runDir, planId) {
  const folder = path.join(runDir, planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(folder, 'git-index'), 'index bytes');
  return folder;
}

// A snapshot of every file under `dir` (relative path → content), for "unchanged" checks.
function snapshot(dir) {
  const files = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

function assertNothingReply(result, firstLine) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  const { json } = result;
  assert.equal(json.version, 1);
  assert.equal(json.ok, true);
  const { reply } = json;
  assert.equal(reply.version, 1);
  assert.equal(reply.status, 'nothing');
  // No run folder is kept after a release, so the reply names no run (C:reply-and-handback).
  assert.equal(reply.planId, null);
  assert.deepEqual(reply.commits, []);
  assert.equal(reply.handback, null);
  assert.equal(reply.callerRule, parseBaseCallerRule());
  // The text ends with the tree state, read after the release (C:reply-and-handback).
  assert.equal(reply.text, `${firstLine}\nworking tree clean`);
}

test('release --plan X removes a lock holding X and deletes X/, with a nothing reply', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  // Another run's folder (a sweep candidate) is not this release's to delete.
  const other = writeRunFolder(runDir, crypto.randomUUID());

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
  assert.equal(fs.existsSync(other), true, "another run's folder is kept");
});

test('release --plan X on a lock holding Y is a no-op that keeps Y\'s lock and folder', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  const holder = crypto.randomUUID();
  writeLock(runDir, { planId: holder, created: CREATED });
  writeRunFolder(runDir, holder);
  // X's own folder, left behind: a no-op returns before touching any run folder.
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(runDir), before);
});

test('release --plan X with no lock is a no-op', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(runDir), before);
});

test('release --plan X with no .commit-plan at all is a no-op that creates none', async (t) => {
  const c = createRepo(t);

  const result = await runCommit(c, ['release', '--plan', crypto.randomUUID()]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.existsSync(runDirOf(c)), false);
});

const UNPARSEABLE_LOCKS = [
  ['not JSON', (planId) => `{"planId":"${planId}"`],
  ['JSON without a planId', () => ({ created: CREATED })],
  ['a JSON array', (planId) => [planId]],
  ['JSON null', () => 'null'],
  ['an uppercase planId', (planId) => ({ planId: planId.toUpperCase(), created: CREATED })],
];

for (const [label, content] of UNPARSEABLE_LOCKS) {
  test(`release --plan X on an unparseable lock (${label}) is a no-op`, async (t) => {
    const c = createRepo(t);
    const runDir = runDirOf(c);
    const planId = crypto.randomUUID();
    writeLock(runDir, content(planId));
    writeRunFolder(runDir, planId);
    const before = snapshot(runDir);

    const result = await runCommit(c, ['release', '--plan', planId]);

    assertNothingReply(result, NOTHING_TO_RELEASE);
    assert.deepEqual(snapshot(runDir), before);
  });
}

test('release --plan X when the lock path is a directory is a no-op', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(runDir, 'lock'), { recursive: true });
  writeRunFolder(runDir, planId);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.existsSync(path.join(runDir, planId, 'state.json')), true);
});

// Story 206: a forged lock cannot make `release` delete anything outside `.commit-plan/`.
// Only a lock holding the call's own `--plan` value (itself a minted UUID, checked by M1)
// releases, so a lock naming a path never matches.
test('a lock naming a traversal or absolute path deletes nothing outside .commit-plan/', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const inRepo = path.join(c.repoDir, 'victim');
  const outside = path.join(c.root, 'victim');
  for (const dir of [inRepo, outside]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
  }
  c.git(['add', 'victim/keep.txt']);
  c.git(['commit', '-q', '-m', 'victim']);
  const forged = ['../victim', '../../victim', outside, `${crypto.randomUUID()}/../../victim`];

  for (const name of forged) {
    writeLock(runDir, { planId: name, created: CREATED });
    const result = await runCommit(c, ['release', '--plan', crypto.randomUUID()]);

    assertNothingReply(result, NOTHING_TO_RELEASE);
    assert.equal(fs.readFileSync(path.join(inRepo, 'keep.txt'), 'utf8'), 'keep\n', name);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep\n', name);
    assert.equal(fs.existsSync(path.join(runDir, 'lock')), true, `the forged lock ${name} is kept`);
  }
});

// A `.commit-plan` that is a link (a junction on Windows, a directory symlink elsewhere)
// is not a run-folder directory: `release` never follows it, so a matching lock behind it
// deletes nothing (C:run-folder, story 206).
test('release does not follow a .commit-plan link to a directory outside the repo', async (t) => {
  const c = createRepo(t);
  const target = path.join(c.root, 'elsewhere');
  const planId = crypto.randomUUID();
  writeLock(target, { planId, created: CREATED });
  writeRunFolder(target, planId);
  fs.symlinkSync(target, runDirOf(c), 'junction');
  const before = snapshot(target);

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.deepEqual(snapshot(target), before);
});

test('release deletes a <planId> junction without following it into its target', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
  fs.symlinkSync(target, path.join(runDir, planId), 'junction');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the junction entry is gone');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n', 'the target is kept');
});

test('release deletes a link nested inside <planId>/ without descending into its target', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  const folder = writeRunFolder(runDir, planId);
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
  fs.symlinkSync(target, path.join(folder, 'nested'), 'junction');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(folder), false, 'the run folder is gone');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n', "the nested link's target is kept");
});

test('release --plan X when .commit-plan is a regular file is a no-op', async (t) => {
  const c = createRepo(t);
  const planId = crypto.randomUUID();
  // The `/.commit-plan/` exclude line (C:run-folder) only matches the directory form; ignore
  // the plain-file form too so the tree stays clean and this test isolates finding 2's
  // no-op case, not finding 3's separate dirty-tree gap.
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '.commit-plan\n');
  fs.writeFileSync(runDirOf(c), 'not a directory\n');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, NOTHING_TO_RELEASE);
  assert.equal(fs.readFileSync(runDirOf(c), 'utf8'), 'not a directory\n');
});

test('release --plan X removes a matching lock even when X/ does not exist', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });

  const result = await runCommit(c, ['release', '--plan', planId]);

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

// Finding 3 (review-RUN-01): the release itself (lock and folder gone) succeeds, but the
// reply's tree-state read only renders a clean tree today (the walking skeleton's thin
// read; CHG-04 completes it with the "N files left" case), so a release on a dirty tree
// still ends the call `internal` even though the run has already ended.
test('release on a dirty tree still ends the run, but the reply fails internal (thin tree-state read, CHG-04)', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  c.writeFile('dirty.txt', 'x\n');

  const result = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false, 'the lock is removed');
  assert.equal(fs.existsSync(path.join(runDir, planId)), false, 'the run folder is deleted');
  assert.equal(result.exitCode, 1, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'internal');
});

test('release run from a subdirectory releases the run of the toplevel', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  c.writeFile('sub/file.txt', 'x\n');
  c.git(['add', 'sub/file.txt']);
  c.git(['commit', '-q', '-m', 'sub']);

  const result = await runCommit(c, ['release', '--plan', planId], { cwd: path.join(c.repoDir, 'sub') });

  assertNothingReply(result, 'nothing committed');
  assert.equal(fs.existsSync(path.join(runDir, 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDir, planId)), false);
});

test('release with no git binary on PATH exits 1 env and deletes nothing', async (t) => {
  const c = createRepo(t);
  const runDir = runDirOf(c);
  const planId = crypto.randomUUID();
  writeLock(runDir, { planId, created: CREATED });
  writeRunFolder(runDir, planId);
  const before = snapshot(runDir);
  const emptyBin = path.join(c.root, 'empty-bin');
  fs.mkdirSync(emptyBin);
  const env = {};
  for (const key of Object.keys(c.env)) {
    if (key.toUpperCase() === 'PATH') env[key] = undefined;
  }
  env.PATH = emptyBin;

  const result = await runCommit(c, ['release', '--plan', planId], { env });

  assert.equal(result.exitCode, 1, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'env');
  assert.deepEqual(snapshot(runDir), before);
});
