'use strict';

// EXE-17 (docs/roadmap/10-commit-executor.md): a hung `git commit` is killed at the deadline.
// Seam 1 with the stepping clock (tests/helpers/clock-preload.mjs): the clock already reads
// 535 s at the call's first group, so `git commit` gets a 5 s budget (540 s deadline) and M2
// kills the hook tree at it. Each timeout case costs about 10 s of real time (5 s budget plus
// the 5 s kill grace).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const SPAWN_RECORD_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'spawn-record-preload.mjs')).href;
const HEAD_UNREAD_NOTICE = 'HEAD could not be read after the failure; a commit may exist';
const TEST_TIMEOUT = { timeout: 90_000 };
const TIMEOUT_TEXT = 'git commit did not finish in 9 min — a pre-commit hook or a signing prompt may be waiting';
const slash = (p) => p.replace(/\\/g, '/');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const HEADERS = ['feat: change a', 'feat: change b'];

// Two committed files, each modified, a `plan --split` run and two stored groups naming one
// file's units each (tests/commit-all-git-failed.test.js `threeGroupRun`, two groups).
async function twoGroupRun(t, planArgs = ['plan', '--split']) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, planArgs);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed, statePath, lockPath: path.join(path.dirname(runDir), 'lock') };
}

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

// A hook that records its pid and a "started" marker, then becomes a long `sleep`.
function sleepingHook(c, name, pidFile, startedFile) {
  installHook(c, name, [`echo $$ > '${slash(pidFile)}'`, `: > '${slash(startedFile)}'`, 'exec sleep 120']);
}

function schedule(c, steps) {
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(steps));
  return schedulePath;
}

// The clock reads 535 s from the call's first group onward.
function runAt535(c, planId) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, [{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]) },
  });
}

function spawnedGit(log) {
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((e) => e.file === 'git');
}

function pidGone(pidFile) {
  if (process.platform === 'win32') return true; // an msys pid is not a Windows pid
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('AC1: a sleeping pre-commit hook at 535 s -> exit 5 with the text, hook tree gone, no commit, run released', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, seed, lockPath } = await twoGroupRun(t);
  const pidFile = path.join(c.root, 'hook.pid');
  sleepingHook(c, 'pre-commit', pidFile, path.join(c.root, 'hook.started'));

  const result = await runAt535(c, planId);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.equal(result.json.error.message, TIMEOUT_TEXT);
  assert.equal(result.json.sha, undefined);
  assert.ok(fs.existsSync(pidFile), 'the hook ran');
  assert.ok(pidGone(pidFile), 'the hook tree was killed');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), seed, 'no commit landed');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the group\'s staging was taken back out');
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1, 2]);
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('AC2: a sleeping post-commit hook -> exit 5, sha is the new HEAD, "did not exit in time"', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, seed, lockPath } = await twoGroupRun(t);
  sleepingHook(c, 'post-commit', path.join(c.root, 'hook.pid'), path.join(c.root, 'hook.started'));

  const result = await runAt535(c, planId);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  const headNow = c.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(headNow, seed, 'git committed anyway');
  assert.equal(result.json.sha, headNow);
  assert.equal(result.json.error.message, `committed as \`${headNow}\`, but git did not exit in time`);
  assert.deepEqual(result.json.commits, [{ n: 1, sha: headNow, header: HEADERS[0] }]);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [2]);
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('AC3: the clock stepped past 580 s before cleanup -> unstage not spawned, exit 5, unstaged null, notice, run kept', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, statePath, seed, lockPath } = await twoGroupRun(t);
  const started = path.join(c.root, 'hook.started');
  sleepingHook(c, 'pre-commit', path.join(c.root, 'hook.pid'), started);
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const steps = [
    { event: { type: 'path', path: marker }, elapsedMs: 535_000 },
    { event: { type: 'path', path: started }, elapsedMs: 590_000 },
  ];

  const spawnLog = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD, '--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, steps), COMMIT_TEST_SPAWN_LOG: spawnLog },
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.equal(result.json.error.message, TIMEOUT_TEXT);
  assert.equal(result.json.unstaged, null);
  // The spawn record proves it: after the `git commit` spawn no git call was spawned
  // (not the `git reset`, not the HEAD re-read; both are past `cleanupDeadline`).
  const gitCalls = spawnedGit(spawnLog);
  const commitAt = gitCalls.findIndex((e) => e.args[0] === 'commit');
  assert.notEqual(commitAt, -1, 'git commit was spawned');
  assert.deepEqual(gitCalls.slice(commitAt + 1).map((e) => e.args[0]), [], JSON.stringify(gitCalls.slice(commitAt)));
  assert.ok(result.json.notices.includes('group 1 staging may remain, the next /commit repairs it'),
    JSON.stringify(result.json.notices));
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), seed);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\n', 'the reset was never spawned: staging remains');
  assert.ok(fs.existsSync(lockPath), 'the run lock is kept');
  assert.ok(fs.existsSync(runDir), 'the run folder is kept');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).indexReset, true);
  assert.equal(fs.existsSync(path.join(runDir, 'call.lock')), false, 'call.lock is gone');

  // The criterion's last clause (KD-R110, RUN-23): the next `plan --take-over <planId>` resets
  // the staging and releases the run.
  const takeover = await runCommit(c, ['plan', '--split', '--take-over', planId]);
  assert.equal(takeover.exitCode, 0, detail(takeover));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the takeover reset the staging');
  assert.equal(fs.existsSync(runDir), false, 'the old run folder is gone');
  const stored = JSON.parse(fs.readFileSync(path.join(takeover.json.runDir, 'state.json'), 'utf8'));
  assert.ok(stored.notices.some((notice) => /reset the partial staging/.test(notice)), JSON.stringify(stored.notices));
});

// AC4: through `check --plan`. Group 1 commits; its post-commit hook flags it, and group 2's
// staging of b.txt (a `post-index-change` hook) then steps the clock to 590 s, so group 2's
// `git commit` and its unstage are both spent and not spawned.
test('AC4: check --plan, group 2 timed out after group 1 committed -> the run is kept', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await twoGroupRun(t, ['plan', '--split', '--no-user']);
  const committedFlag = path.join(c.root, 'group1.committed');
  const marker = path.join(c.root, 'clock-marker');
  installHook(c, 'post-commit', [`: > '${slash(committedFlag)}'`]);
  installHook(c, 'post-index-change', [
    `if [ -e '${slash(committedFlag)}' ] && git diff --cached --name-only | grep -q '^b.txt$'; then : > '${slash(marker)}'; fi`,
    'exit 0',
  ]);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: ['a', 'b'].map((name, i) => ({ header: HEADERS[i], body: null, files: [`${name}.txt`], hunks: [] })),
    notIncluded: [],
  }));
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  delete state.groups;
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);

  const result = await runCommit(c, ['check', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, [{ event: { type: 'path', path: marker }, elapsedMs: 590_000 }]) },
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.equal(result.json.commits.length, 1, 'group 1 is committed');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
  assert.ok(fs.existsSync(lockPath), 'the run lock is kept');
  assert.ok(fs.existsSync(runDir), 'the run folder is kept');
  assert.equal(fs.existsSync(path.join(runDir, 'call.lock')), false, 'call.lock is gone');
});

// Review Medium-4: a post-commit hook that hangs past the deadline while the clock then steps past
// 580 s: the commit exists, but the HEAD re-read is not spawned, so the reply cannot name it.
// It must not read as a plain "no commit": a notice says a commit may exist.
test('a skipped HEAD re-read after a killed git commit adds a notice (a commit may exist)', TEST_TIMEOUT, async (t) => {
  const { c, planId, seed } = await twoGroupRun(t);
  const started = path.join(c.root, 'hook.started');
  sleepingHook(c, 'post-commit', path.join(c.root, 'hook.pid'), started);
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const steps = [
    { event: { type: 'path', path: marker }, elapsedMs: 535_000 },
    { event: { type: 'path', path: started }, elapsedMs: 590_000 },
  ];
  const spawnLog = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD, '--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, steps), COMMIT_TEST_SPAWN_LOG: spawnLog },
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.message, TIMEOUT_TEXT);
  assert.notEqual(c.git(['rev-parse', 'HEAD']).trim(), seed, 'git committed anyway');
  assert.equal(result.json.sha, undefined, 'the unread HEAD cannot be named');
  assert.ok(result.json.notices.includes(HEAD_UNREAD_NOTICE), JSON.stringify(result.json.notices));
  const gitCalls = spawnedGit(spawnLog);
  const commitAt = gitCalls.findIndex((e) => e.args[0] === 'commit');
  assert.deepEqual(gitCalls.slice(commitAt + 1).map((e) => e.args[0]), [], 'no git call after the commit');
});

// EXE-01 item 3 / "…, but the script failed": an unexpected throw after `git commit` landed. The
// post-commit hook garbles the index, so the library's own index read right after the commit
// throws; HEAD (re-read in `commitAll`'s cleanup) is not the expected one.
test('an internal throw after git commit landed -> exit 1, sha, "committed as <sha>, but the script failed"', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, seed, lockPath } = await twoGroupRun(t);
  installHook(c, 'post-commit', ['printf "garbage" > "$(git rev-parse --git-path index)"']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  const headNow = c.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(headNow, seed, 'git committed');
  assert.equal(result.json.sha, headNow);
  assert.equal(result.json.error.message, `committed as \`${headNow}\`, but the script failed`);
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// EXE-17 / INT-31 AC2 (EXE-01 item 3): a `staged` run's stored group writes no state.json before
// `git commit`, so the FND-10 preload failing the `state.json` rename with EIO first hits the
// write after the commit landed.
async function stagedRun(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('a.txt', 'a\nmore\n');
  c.git(['add', '--', 'a.txt']);
  const planned = await runCommit(c, ['plan', '--staged']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: 'feat: staged change', body: null, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed, lockPath: path.join(path.dirname(runDir), 'lock') };
}

test('the state.json write failing after git commit landed -> exit 1, sha, "committed as <sha>, but the script failed"', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, seed, lockPath } = await stagedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
  });

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  const headNow = c.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(headNow, seed, 'git committed');
  assert.equal(result.json.sha, headNow);
  assert.equal(result.json.error.message, `committed as \`${headNow}\`, but the script failed`);
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// The same internal throw, but the clock has passed `cleanupDeadline` (a post-commit hook's marker
// steps it to 590 s): the HEAD re-read is not spawned, so no `sha`; the notice says it.
test('the state.json write failing after git commit with the cleanup budget spent -> exit 1, no sha, HEAD-unread notice', TEST_TIMEOUT, async (t) => {
  const { c, planId, seed } = await stagedRun(t);
  const started = path.join(c.root, 'hook.started');
  installHook(c, 'post-commit', [`: > '${slash(started)}'`]);
  const steps = [{ event: { type: 'path', path: started }, elapsedMs: 590_000 }];

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD, '--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, steps), COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
  });

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  assert.notEqual(c.git(['rev-parse', 'HEAD']).trim(), seed, 'git committed');
  assert.equal(result.json.sha, undefined, 'the unread HEAD cannot be named');
  assert.ok(result.json.reply.notices.includes(HEAD_UNREAD_NOTICE), JSON.stringify(result.json.reply.notices));
});
