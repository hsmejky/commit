'use strict';

// EXE-18 (docs/roadmap/10-commit-executor.md): `index.lock` after a timed-out plain commit
// is left with a notice (Q18, story 215). Seam 1 with the stepping clock
// (tests/helpers/clock-preload.mjs): the clock reads 535 s at the call's first group, so the
// plain `git commit` gets a 5 s budget and M2 kills the hook tree at it, in `split` and in
// `staged`. M10 `commitGuarded` owns the lock rule (CHG-23); these cases pin the executor's
// reply: exit 5 (EXE-17), the lock kept and the notice present, or no lock and no notice.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const TEST_TIMEOUT = { timeout: 90_000 };
const LEFT_NOTICE = 'index.lock was left in place — if no git process is running, check it and remove it by hand';
const slash = (p) => p.replace(/\\/g, '/');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

function runAt535(c, planId) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });
}

// One modified (`split`) or modified-and-staged (`staged`) file and one stored group.
async function modeRun(t, mode) {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  if (mode === 'staged') c.git(['add', 'a.txt']);
  const planned = await runCommit(c, ['plan', `--${mode}`]);
  assert.equal(planned.exitCode, 0, detail(planned));
  const statePath = path.join(planned.json.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header: 'feat: change a', body: null, committed: false }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId: planned.json.planId };
}

const lockOf = (c) => path.join(c.repoDir, '.git', 'index.lock');

for (const mode of ['split', 'staged']) {
  test(`AC1: ${mode}, a hook that creates index.lock then sleeps, killed at the deadline -> exit 5, lock kept, notice`, TEST_TIMEOUT, async (t) => {
    const { c, planId } = await modeRun(t, mode);
    const started = path.join(c.root, 'hook.started');
    installHook(c, 'pre-commit', [`: > '${slash(lockOf(c))}'`, `: > '${slash(started)}'`, 'exec sleep 120']);

    const result = await runAt535(c, planId);

    assert.equal(result.exitCode, 5, detail(result));
    assert.ok(fs.existsSync(started), 'the hook ran before the timeout');
    assert.ok(fs.existsSync(started), 'the hook ran before the timeout');
    assert.equal(result.json.error.kind, 'timeout', detail(result));
    assert.ok(fs.existsSync(lockOf(c)), 'a plain commit never removes the lock');
    assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
  });

  test(`AC2: ${mode}, no lock left after a killed commit -> no index.lock notice`, TEST_TIMEOUT, async (t) => {
    const { c, planId } = await modeRun(t, mode);
    const started = path.join(c.root, 'hook.started');
    installHook(c, 'pre-commit', [`: > '${slash(started)}'`, 'exec sleep 120']);

    const result = await runAt535(c, planId);

    assert.equal(result.exitCode, 5, detail(result));
    assert.equal(result.json.error.kind, 'timeout', detail(result));
    assert.ok(fs.existsSync(started), 'the hook ran before the timeout');
    assert.equal(fs.existsSync(lockOf(c)), false);
    assert.ok(!result.json.notices.some((n) => /index\.lock/.test(n)), JSON.stringify(result.json.notices));
  });
}
