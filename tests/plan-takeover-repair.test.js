'use strict';

// RUN-23 (docs/roadmap/09-runs.md, Q18, Q22, C:run-folder takeover): a takeover of a killed
// run repairs the index before inventory. M12 `acquire` returns `killedRun` from the old
// run's `state.json`; M18 resets the index only when something is staged and every staged
// path belongs to the killed group's paths. Seam 1 at the process boundary.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { COMMIT_ENTRY, createCase, runCommit } = require('./helpers/process-seam.js');

const TEST_TIMEOUT = { timeout: 90_000 };
const slash = (p) => p.replace(/\\/g, '/');
const HEADERS = ['feat: change a', 'feat: change b'];

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

// Two committed files, both modified, `a.txt` staged (so `preStaged` is `[a.txt]`), a
// `plan --split` run and two stored groups, one file each, as in commit-all-timeout.test.js.
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
  return { c, planId, runDir, statePath, lockPath: path.join(path.dirname(runDir), 'lock') };
}

// A successful `plan` stores the takeover's notices in the new run's `state.json` (step 8); `check`
// later merges them into its reply.
function storedNotices(result) {
  return JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8')).notices.join('\n');
}

function ageLock(lockPath) {
  const then = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(lockPath, then, then);
}

function setState(statePath, change) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  change(state);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
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

// A `commit --plan --all` call SIGKILLed (its whole process tree) while the pre-commit hook
// sleeps: the group is staged and `indexReset` is set.
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

// Records, whenever the index is written while `armed` exists, whether the old run's folder is
// still in place: the observable for "the folder outlives the repair".
function folderMarkerHook(c, planId) {
  const armed = path.join(c.root, 'armed');
  const marker = path.join(c.root, 'folder-at-repair');
  installHook(c, 'post-index-change', [
    `if [ -e '${slash(armed)}' ]; then if [ -f '.commit-plan/${planId}/state.json' ]; then echo present; else echo gone; fi >> '${slash(marker)}'; fi`,
    'exit 0',
  ]);
  return { armed, marker };
}

test('Seam 1: a SIGKILLed commit, lock aged, plan -> index reset, takeover/reset/unstaged notices, folder kept during the repair then gone', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killMidCommit(c, planId);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\n', 'the killed group is still staged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).indexReset, true);
  ageLock(lockPath);
  const { armed, marker } = folderMarkerHook(c, planId);
  fs.writeFileSync(armed, '');

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the index was reset');
  const notices = storedNotices(result);
  assert.match(notices, new RegExp(`took over the stale /commit run \`${planId}\``), notices);
  assert.match(notices, /reset the partial staging/, notices);
  assert.match(notices, /the killed run's reset had unstaged: a\.txt/, notices);
  assert.equal(result.json.mode, 'split', 'inventory saw a clean index');
  assert.equal(fs.readFileSync(marker, 'utf8').split(/\r?\n/)[0], 'present', 'the old folder still existed when the repair ran');
  assert.equal(fs.existsSync(runDir), false, 'the old folder is gone after the takeover');
});

test('Seam 1: group 1 committed, killed in phase (a) of group 2, takeover -> no reset, no reset notice, unstaged notice given', TEST_TIMEOUT, async (t) => {
  const { c, planId, statePath } = await killableRun(t);
  c.git(['reset', '-q', '--', '.']);
  setState(statePath, (state) => {
    state.groups[0].committed = true;
    state.indexReset = true;
  });

  const result = await runCommit(c, ['plan', '--split', '--take-over', planId]);

  assert.equal(result.exitCode, 0, detail(result));
  const notices = storedNotices(result);
  assert.match(notices, /replaced the \/commit run/, notices);
  assert.doesNotMatch(notices, /reset the partial staging/, notices);
  assert.match(notices, /the killed run's reset had unstaged: a\.txt/, notices);
});

test('Seam 1: the unstaged and reset notices survive a later staged-empty refusal', TEST_TIMEOUT, async (t) => {
  const { c, planId, statePath } = await killableRun(t);
  setState(statePath, (state) => { state.indexReset = true; });

  const result = await runCommit(c, ['plan', '--staged', '--take-over', planId]);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(c.git(['diff', '--cached', '--name-only']), '');
  const notices = result.json.reply.notices.join('\n');
  assert.match(notices, /reset the partial staging/, notices);
  assert.match(notices, /the killed run's reset had unstaged: a\.txt/, notices);
});

test('Seam 1: no indexReset in the old state -> no repair, the index is left alone', TEST_TIMEOUT, async (t) => {
  const { c, planId } = await killableRun(t);

  const result = await runCommit(c, ['plan', '--split', '--take-over', planId]);

  assert.equal(result.exitCode, 0, detail(result));
  const notices = storedNotices(result);
  assert.doesNotMatch(notices, /reset the partial staging|unstaged:/, notices);
});

test('Seam 1: staging beyond the killed group is left untouched (killedLeftover is RUN-24)', TEST_TIMEOUT, async (t) => {
  const { c, planId, statePath } = await killableRun(t);
  setState(statePath, (state) => { state.indexReset = true; state.preStaged = []; });
  c.git(['add', '--', 'b.txt']);

  await runCommit(c, ['plan', '--split', '--no-user', '--take-over', planId]);

  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n', 'nothing was reset');
});
