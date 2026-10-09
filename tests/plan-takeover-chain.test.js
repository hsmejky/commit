'use strict';

// RUN-25 (docs/roadmap/09-runs.md, Q22, C:run-folder "Orphan renamed locks" and "A failed
// repair"): a takeover killed during its repair is recovered through the renamed lock chain,
// an orphan renamed lock is adopted, a failing repair keeps the chain, and a step-7 orphan that
// needs the repair refuses. Seam 1 at the process boundary.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pathToFileURL } = require('node:url');
const { COMMIT_ENTRY, createCase, runCommit } = require('./helpers/process-seam.js');

const TEST_TIMEOUT = { timeout: 90_000 };
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const slash = (p) => p.replace(/\\/g, '/');
const HEADERS = ['feat: change a', 'feat: change b'];
const RENAMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MISSING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

async function killableRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  c.git(['add', '--', 'a.txt']);
  const planned = await runCommit(c, ['plan', '--split']);
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
  return { c, planId, statePath, commitPlan: path.dirname(path.dirname(statePath)) };
}

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
  else process.kill(-child.pid, 'SIGKILL');
}

async function untilExists(file, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A `commit --plan --all` SIGKILLed mid-commit: the group is staged and `indexReset` is set.
async function killMidCommit(c, planId) {
  const started = path.join(c.root, 'hook.started');
  installHook(c, 'pre-commit', [`: > '${slash(started)}'`, 'exec sleep 120']);
  const child = spawn(process.execPath, [COMMIT_ENTRY, 'commit', '--plan', planId, '--all'], {
    cwd: c.repoDir, env: c.env, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await untilExists(started);
  killTree(child);
  await closed;
  fs.rmSync(path.join(c.repoDir, '.git', 'hooks', 'pre-commit'));
}

function entries(commitPlan) {
  return fs.readdirSync(commitPlan).sort();
}

// The lock renamed away to `lock.<renamer>`, as a takeover killed between its rename and its
// link leaves it (the renamed file keeps the killed run's content and mtime).
function renameLock(commitPlan, renamer) {
  fs.renameSync(path.join(commitPlan, 'lock'), path.join(commitPlan, `lock.${renamer}`));
}

function ageFile(file) {
  const then = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(file, then, then);
}

test('Seam 1: a takeover killed during its repair, then taken over -> the first run facts repair, every chain folder and renamed lock gone', TEST_TIMEOUT, async (t) => {
  const { c, planId, commitPlan } = await killableRun(t);
  await killMidCommit(c, planId);
  // The killed takeover: it renamed the lock to `lock.<K>`, linked its own lock (naming K) and
  // died in its repair, its folder holding no `state.json`.
  renameLock(commitPlan, RENAMER);
  fs.mkdirSync(path.join(commitPlan, RENAMER));
  fs.writeFileSync(path.join(commitPlan, 'lock'), JSON.stringify({ planId: RENAMER, created: '2026-09-26T13:58:02.000Z' }));
  ageFile(path.join(commitPlan, 'lock'));
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\n');

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the first run facts repaired the index');
  const notices = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8')).notices.join('\n');
  assert.match(notices, /reset the partial staging/, notices);
  assert.deepEqual(entries(commitPlan), ['lock', result.json.planId].sort(), 'the chain folders and renamed locks are gone');
});

test('Seam 1: a foreign index.lock blocking the repair -> exit 6 index-lock, chain kept, own lock and folder gone; once removed, the next plan repairs', TEST_TIMEOUT, async (t) => {
  const { c, planId, commitPlan } = await killableRun(t);
  await killMidCommit(c, planId);
  ageFile(path.join(commitPlan, 'lock'));
  const indexLock = path.join(c.repoDir, '.git', 'index.lock');
  fs.writeFileSync(indexLock, '');

  const failed = await runCommit(c, ['plan', '--split']);

  assert.equal(failed.exitCode, 6, detail(failed));
  assert.equal(failed.json.error.kind, 'index-lock', detail(failed));
  const notices = failed.json.reply.notices.join('\n');
  assert.match(notices, new RegExp(`took over the stale /commit run \`${planId}\``), notices);
  assert.match(notices, /index repair failed/, notices);
  const left = entries(commitPlan);
  assert.equal(left.includes('lock'), false, 'the new run lock is gone');
  assert.equal(left.includes(planId), true, 'the taken-over folder remains');
  assert.equal(left.filter((name) => name.startsWith('lock.')).length, 1, 'the renamed lock remains');
  assert.equal(left.length, 2, `the new run folder is gone: ${left}`);

  fs.rmSync(indexLock);
  const retried = await runCommit(c, ['plan', '--split']);

  assert.equal(retried.exitCode, 0, detail(retried));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the next plan adopted the chain and repaired');
  assert.deepEqual(entries(commitPlan), ['lock', retried.json.planId].sort());
});

test('Seam 1: an orphan lock.<planId> with no lock in place -> plan adopts it at step 3, repairs, and the chain is gone', TEST_TIMEOUT, async (t) => {
  const { c, planId, commitPlan } = await killableRun(t);
  await killMidCommit(c, planId);
  renameLock(commitPlan, RENAMER);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '');
  assert.deepEqual(entries(commitPlan), ['lock', result.json.planId].sort());
  // Review RUN-25 finding 4: no lock was in place, so no run is said to have been idle.
  const notices = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8')).notices.join('\n');
  assert.match(notices, new RegExp('adopted the leftover of a killed takeover of the /commit run .' + planId), notices);
  assert.doesNotMatch(notices, /idle for/, notices);
});

test('Seam 1: a renamed lock whose chain ends at a missing folder -> counted done, no repair, deleted', TEST_TIMEOUT, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  // Staged, so a repair that wrongly ran would show as a reset.
  c.git(['add', '--', 'a.txt']);
  const commitPlan = path.join(c.repoDir, '.commit-plan');
  fs.mkdirSync(commitPlan);
  fs.writeFileSync(path.join(commitPlan, `lock.${RENAMER}`), JSON.stringify({ planId: MISSING, created: '2026-09-26T13:58:02.000Z' }));

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(entries(commitPlan), ['lock', result.json.planId].sort());
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\n', 'no repair reset the staging');
  const notices = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8')).notices.join('\n');
  assert.doesNotMatch(notices, /reset the partial staging/, notices);
  assert.match(notices, /its run had already ended/, notices);
});

test('Seam 1: an orphan that appears after peek and needs the repair -> exit 6 diff-changed, chain kept, own lock and folder gone', TEST_TIMEOUT, async (t) => {
  const { c, planId, statePath, commitPlan } = await killableRun(t);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.indexReset = true;
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  fs.rmSync(path.join(commitPlan, 'lock'));
  const orphan = path.join(commitPlan, `lock.${RENAMER}`);
  // The first index write of the run (after step 3's peek, before step 7) places the orphan.
  installHook(c, 'post-index-change', [
    `if [ -d '${slash(commitPlan)}' ] && [ ! -e '${slash(orphan)}' ]; then`,
    `  printf '{"planId":"${planId}","created":"2026-09-26T13:58:02.000Z"}' > '${slash(orphan)}'`,
    'fi',
    'exit 0',
  ]);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.match(result.json.reply.notices.join('\n'), /staging must be repaired first/, detail(result));
  assert.deepEqual(entries(commitPlan), [planId, `lock.${RENAMER}`].sort(), 'only the chain remains');
});

// Review RUN-25 finding 1: a repair whose reset the deadline ended is a timeout, and its
// "repair failed" notice names the deadline, not "git reset failed".
test('Seam 1: the deadline ending the repair reset -> exit 5 timeout, the repair-failed notice names the deadline, chain kept', TEST_TIMEOUT, async (t) => {
  const { c, planId, commitPlan } = await killableRun(t);
  await killMidCommit(c, planId);
  ageFile(path.join(commitPlan, 'lock'));
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
  // `git reset` writes the index: the hook stalls it until the deadline kills the call.
  installHook(c, 'post-index-change', ['exec sleep 120']);

  const result = await runCommit(c, ['plan', '--split'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
    timeoutMs: 60_000,
  });

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  const notices = result.json.reply.notices.join('\n');
  assert.match(notices, /index repair failed \(\/commit passed its 540-second deadline\)/, notices);
  const left = entries(commitPlan);
  assert.equal(left.includes(planId), true, 'the taken-over folder remains');
  assert.equal(left.includes('lock'), false, 'the new run lock is gone');
});

// Review RUN-25 finding 5: a step-7 orphan with no facts to check is finished there.
test('Seam 1: an orphan that appears after peek and has no facts -> finished at step 7, plan goes on', TEST_TIMEOUT, async (t) => {
  const { c, commitPlan } = await killableRun(t);
  fs.rmSync(path.join(commitPlan, 'lock'));
  const orphan = path.join(commitPlan, `lock.${RENAMER}`);
  installHook(c, 'post-index-change', [
    `if [ -d '${slash(commitPlan)}' ] && [ ! -e '${slash(orphan)}' ]; then`,
    `  printf '{"planId":"${MISSING}","created":"2026-09-26T13:58:02.000Z"}' > '${slash(orphan)}'`,
    'fi',
    'exit 0',
  ]);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(fs.existsSync(orphan), false, 'the orphan was deleted');
  const notices = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8')).notices.join('\n');
  assert.match(notices, /its run had already ended/, notices);
});
