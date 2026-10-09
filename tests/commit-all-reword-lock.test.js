'use strict';

// EXE-21 (docs/roadmap/10-commit-executor.md): a killed reword (`--amend --only`) removes only
// its own `index.lock` (Q18, story 215). Seam 1 with the stepping clock
// (tests/helpers/clock-preload.mjs): the clock reads 535 s at the call's first group, so the
// amend gets a 5 s budget and M2 kills the sleeping `pre-commit` hook tree at it. The hook
// first records whether `index.lock` exists (git holds it across hooks in `--amend --only`).
// M10 `commitGuarded` owns the two-marker rule (CHG-23); these cases pin the executor's reply.

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

async function killedReword(t, hookLines) {
  const c = createCase(t);
  const hb = path.join(c.claudeHome, 'commit-guard');
  fs.mkdirSync(hb, { recursive: true });
  fs.writeFileSync(path.join(hb, 'heartbeat.json'), JSON.stringify({ ts: Date.now(), cwd: c.repoDir, command: 'commit.cjs plan' }));
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', 'fix: old message']);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups: [{ header: 'fix: better message', body: null, files: [], hunks: [] }], notIncluded: [],
  }));
  const lock = path.join(c.repoDir, '.git', 'index.lock');
  const record = path.join(c.root, 'lock.recorded');
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\n[ -f '${slash(lock)}' ] && : > '${slash(record)}'\n${hookLines(slash(lock)).join('\n')}\nexec sleep 120\n`);
  fs.chmodSync(hook, 0o755);

  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
  const result = await runCommit(c, ['check', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });
  return { c, result, lock, record };
}

test('AC1: the plugin\'s own leftover index.lock is removed, no lock notice', TEST_TIMEOUT, async (t) => {
  const { result, lock, record } = await killedReword(t, () => []);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(result.json.error.kind, 'timeout', detail(result));
  assert.ok(fs.existsSync(record), 'the hook saw index.lock while it ran');
  assert.equal(fs.existsSync(lock), false, 'the own lock is removed');
  assert.ok(!result.json.notices.some((n) => /index\.lock/.test(n)), JSON.stringify(result.json.notices));
});

test('AC2: a lock another process created (older than the first marker) is kept, with the notice', TEST_TIMEOUT, async (t) => {
  const { result, lock, record } = await killedReword(t, (l) => [`touch -d '2000-01-01 00:00:00' '${l}'`]);

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(record), 'the hook saw index.lock while it ran');
  assert.ok(fs.existsSync(lock), 'a foreign lock is never removed');
  assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
});
