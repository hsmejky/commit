'use strict';

// RUN-21 (docs/roadmap/09-runs.md, Q22, C:plan step 3, C:run-folder): the automatic takeover
// of a stale lock at Seam 1. `plan`'s step-3 `peek` finds a lock untouched for 15 minutes
// (by mtime against the injected clock; an unparseable lock by mtime alone), M12 `acquire({
// takeOver })` renames it to `lock.<own planId>`, verifies it and links its own lock, and
// `finishTakeover` deletes the old folder, then the renamed lock. The takeover notice names
// the stale `planId` and rides in every output `plan` ends with.
//
// The HEAD-moved case uses a PATH git shim and is POSIX-only (roadmap KD-R21, spec KD-S35).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';
const STALE_ID = '11111111-1111-4111-8111-111111111111';
const STALE_AGE_MS = 16 * 60 * 1000;
// The `busy` file-in-use text (run.mjs `BUSY_FILE_IN_USE_MESSAGE`), tests/run-file-in-use.test.js's
// own copy: needed here for the takeover rename's own busy case.
const BUSY_TEXT = process.platform === 'win32'
  ? 'another /commit call on this run is still running; try again once it has finished'
  : "the run's lock could not be read or replaced (permission denied or in use); try again";

// The notice texts M12 `takeoverNotice` builds (C:plan step 3).
function takeoverNotice(planId) {
  return `took over the stale /commit run \`${planId}\` (idle for 15 minutes or more)`;
}
const UNREADABLE_TAKEOVER_NOTICE = 'took over a stale, unreadable /commit lock (idle for 15 minutes or more)';

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

function entries(c) {
  return fs.existsSync(runDirOf(c)) ? fs.readdirSync(runDirOf(c)).sort() : [];
}

function lockContent(c) {
  return JSON.parse(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'));
}

function ageLock(c) {
  const lock = path.join(runDirOf(c), 'lock');
  const aged = new Date(Math.floor(Date.now() / 1000) * 1000 - STALE_AGE_MS);
  fs.utimesSync(lock, aged, aged);
}

// A stale old run: its folder (holding `state.json`, or the files given) and a lock naming it
// (or `content`), with the lock's mtime aged 16 minutes.
function staleRun(c, { content, files = { 'state.json': '{}\n' } } = {}) {
  fs.mkdirSync(path.join(runDirOf(c), STALE_ID), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(runDirOf(c), STALE_ID, name), text);
  fs.writeFileSync(
    path.join(runDirOf(c), 'lock'),
    content ?? JSON.stringify({ planId: STALE_ID, created: '2026-09-26T13:58:02.000Z' }),
  );
  ageLock(c);
}

function storedNotices(c, planId) {
  return JSON.parse(fs.readFileSync(path.join(runDirOf(c), planId, 'state.json'), 'utf8')).notices;
}

// No `call.lock` anywhere under `.commit-plan` (RUN-20 item 10: M12 `run.close()` removes it
// when a call ends; `plan` never takes one).
function assertNoCallLock(c) {
  const found = fs.readdirSync(runDirOf(c), { recursive: true }).filter((name) => path.basename(String(name)) === 'call.lock');
  assert.deepEqual(found, []);
}

test('Seam 1 (AC1, AC4): a lock aged 16 minutes is taken over; the old run then meets taken-over', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const first = await runCommit(c, ['plan']);
  assert.equal(first.exitCode, 0, detail(first));
  const oldId = first.json.planId;
  ageLock(c);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const { planId } = result.json;
  assert.notEqual(planId, oldId);
  assert.equal(result.json.hunks.ok, true, detail(result));
  assert.equal(lockContent(c).planId, planId);
  assert.deepEqual(entries(c), ['lock', planId].sort(), 'the old folder and every lock.<planId> are gone');
  assert.ok(storedNotices(c, planId).includes(takeoverNotice(oldId)), JSON.stringify(storedNotices(c, planId)));
  assertNoCallLock(c);

  const old = await runCommit(c, ['commit', '--plan', oldId, '--all']);

  assert.equal(old.exitCode, 6, detail(old));
  assert.equal(old.json.ok, false);
  assert.equal(old.json.error.kind, 'lock', detail(old));
  assert.equal(old.json.error.message, 'this run was taken over by another /commit; run /commit again');
  assert.equal(lockContent(c).planId, planId, 'the new run keeps the lock');
  assertNoCallLock(c);
});

test('Seam 1 (AC2): a stale lock on a clean tree → nothing to commit with the takeover notice, no lock left', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  staleRun(c);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'nothing', detail(result));
  assert.ok(result.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(result));
  assert.deepEqual(entries(c), []);
});

test('Seam 1 (AC3): a stale unparseable lock is taken over automatically', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  staleRun(c, { content: 'not json' });

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const { planId } = result.json;
  assert.equal(lockContent(c).planId, planId);
  assert.ok(storedNotices(c, planId).includes(UNREADABLE_TAKEOVER_NOTICE), JSON.stringify(storedNotices(c, planId)));
  // An unparseable lock names no folder: the old one is left for the 24-hour sweep.
  assert.deepEqual(entries(c), [STALE_ID, 'lock', planId].sort());
});

// RUN-21 review Medium-1: moved from the in-process tests/run.test.js (M12 `acquire`
// unit directly) to this Seam 1 process boundary, now that the fault preload's
// COMMIT_TEST_FAULT_RENAME_BASENAME can match the takeover rename's source basename
// (`lock`), not only a rename's target.
test('Seam 1: a file in use on the takeover rename is busy, the stale lock and folder stay', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  staleRun(c);

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=EBUSY' },
  });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.error.message, BUSY_TEXT, detail(result));
  assert.equal(lockContent(c).planId, STALE_ID, 'the stale lock is untouched');
  assert.deepEqual(entries(c), [STALE_ID, 'lock'].sort(), 'the old folder and its lock both stay');
});

// RUN-21 review Medium-1 (the "ENOENT with the lock still in place" case): the takeover
// rename's own ENOENT re-peek (RUN-20b item 4) finds the same, untouched stale lock, since
// the fault throws before any real rename happens — refuses `held` naming the stale holder
// itself, with its original fields and unchanged (aged) mtime. Interactive by default, so
// this is a `lock` handback, not a bare refusal.
test('Seam 1: a rename ENOENT on the takeover with the stale lock still in place refuses held naming it', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  staleRun(c);

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'lock=ENOENT' },
  });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  const touched = new Date(fs.statSync(path.join(runDirOf(c), 'lock')).mtimeMs).toISOString();
  const { error } = result.json;
  assert.deepEqual(
    { planId: error.planId, created: error.created, touched: error.touched },
    { planId: STALE_ID, created: '2026-09-26T13:58:02.000Z', touched },
    detail(result),
  );
  assert.equal(result.json.reply.handback.kind, 'lock', detail(result));
  assert.equal(lockContent(c).planId, STALE_ID, 'the stale lock is untouched');
  assert.deepEqual(entries(c), [STALE_ID, 'lock'].sort(), 'the old folder and its lock both stay');
});

test('Seam 1 (AC7): the takeover notice survives a later staged-empty refusal', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  staleRun(c);

  const result = await runCommit(c, ['plan', '--staged']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'usage', detail(result));
  assert.ok(result.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(result));
  assert.deepEqual(entries(c), []);
});

test('Seam 1 (AC7): the takeover notice survives a later timeout', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  // No `state.json` in the old folder: the clock steps past 540 s once the new run writes its
  // own at step 7, after the takeover.
  staleRun(c, { files: { 'hunks.txt': '' } });
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'childPath', dir: runDirOf(c), name: 'state.json' }, elapsedMs: 541_000 },
  ]));

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.ok(result.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(result));
  assert.deepEqual(entries(c), []);
});

// A plan after a takeover on a tree whose one group adds a new file (a `confirm` reason),
// with the worker plan written; returns the run's `planId`.
async function plannedAfterTakeover(c, planArgs) {
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  staleRun(c);
  const planned = await runCommit(c, planArgs);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId } = planned.json;
  fs.writeFileSync(path.join(runDirOf(c), planId, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header: 'feat: x', body: null, files: ['a.txt', 'c.txt'], hunks: [] }],
    notIncluded: [],
  }));
  return planId;
}

// The handback's `notices` carry it; its `text` gets them once RPL-05 builds the `Notices:`
// block, and the `committed` reply after a `confirm` answer is INT-09's `--confirmed` (KD-R102).
test('Seam 1 (AC7): on a tree needing confirmation the notice reaches the confirm handback', async (t) => {
  const c = createCase(t);
  const planId = await plannedAfterTakeover(c, ['plan']);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));
  assert.ok(checked.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(checked));
});

test('Seam 1 (AC7): the same tree with --no-user commits in-process, and the committed reply carries the notice', async (t) => {
  const c = createCase(t);
  const planId = await plannedAfterTakeover(c, ['plan', '--split', '--no-user']);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed', detail(checked));
  assert.ok(checked.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(checked));
  assert.deepEqual(entries(c), [], 'the run ended with its commit');
  // review-RUN-21 Low-2: this in-process `check --plan` commit takes and drops its own
  // `call.lock` (RUN-20 item 10), the one case among this file's `assertNoCallLock` callers
  // that actually exercises it.
  assertNoCallLock(c);
});

// RUN-20 item 12, takeover path: step 7's HEAD re-read runs after a takeover too (RUN-06
// covers the path with no takeover). The shim commits at the first HEAD read once the lock
// is this run's own (it no longer names the stale run).
test('Seam 1 (AC6): HEAD moved after the takeover → head-moved carrying the takeover notice', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  staleRun(c);
  const shimDir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(shimDir);
  const marker = path.join(c.root, 'shim-fired');
  const git = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' }).stdout.trim();
  assert.ok(git, 'no git on the host PATH');
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']
    .map((key) => `${key}='${c.env[key]}'`).join(' ');
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ] && [ -e .commit-plan/lock ] && ! grep -q '${STALE_ID}' .commit-plan/lock`
      + ' && [ "$*" = "rev-parse --verify -q HEAD" ]; then',
    `  : > '${marker}'`,
    `  ${identity} '${git}' commit -q --allow-empty -m moved || exit 97`,
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [shimDir, c.env.PATH]) });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'head-moved', detail(result));
  assert.ok(fs.existsSync(marker), 'the shim never saw a HEAD read after the takeover');
  assert.ok(result.json.reply.notices.includes(takeoverNotice(STALE_ID)), detail(result));
  assert.deepEqual(entries(c), []);
});
