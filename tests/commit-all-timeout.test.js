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

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule(c, steps) },
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.equal(result.json.error.message, TIMEOUT_TEXT);
  assert.equal(result.json.unstaged, null);
  assert.ok(result.json.notices.includes('group 1 staging may remain, the next /commit repairs it'),
    JSON.stringify(result.json.notices));
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), seed);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\n', 'the reset was never spawned: staging remains');
  assert.ok(fs.existsSync(lockPath), 'the run lock is kept');
  assert.ok(fs.existsSync(runDir), 'the run folder is kept');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).indexReset, true);
  assert.equal(fs.existsSync(path.join(runDir, 'call.lock')), false, 'call.lock is gone');

  // The criterion's last clause (the next `plan --take-over <planId>` resets the staging) is the
  // takeover repair's own (RUN-23/RUN-25, EXE-01 item 2): M12 `acquire` does not build it yet.
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
