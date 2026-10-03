'use strict';

// RUN-06 (docs/roadmap/09-runs.md): what runs around step 7's `acquire` at Seam 1 — the lost
// race (`EEXIST` → `held`), the HEAD re-read after the lock is taken (`head-moved`), `plan
// --reword` taking the lock on a clean tree, and `release` ending that run.
//
// The PATH git shim cases are POSIX-only: shell-less spawn on Windows finds only `.com` and
// `.exe` files, so a script shim is never run there (roadmap KD-R21, spec KD-S35). The
// fault-preload `EEXIST` case (docs/spec/testing-seams.md) covers `held` on every platform.
// Each shim keys its action to run-folder state, not to a call count (KD-R27): the HEAD
// shim fires at the first HEAD read once `.commit-plan/lock` exists, the lock shim at the
// first git call once the provisional folder exists and no lock does.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';
const OTHER_PLAN_ID = '11111111-1111-4111-8111-111111111111';

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

function folderNames(c) {
  return fs.readdirSync(runDirOf(c)).filter((name) => name !== 'lock').sort();
}

function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

// A `git` shim on PATH: runs `action` (shell lines) once, when `condition` (a shell test)
// first holds at a git call, then hands every call on to the real git. Every git call runs
// from the toplevel (Q9), so relative `.commit-plan` paths name the run-folder directory.
function gitShim(c, { condition, action }) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const marker = path.join(c.root, 'shim-fired');
  const git = realGit(c);
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ] && ${condition}; then`,
    `  : > '${marker}'`,
    ...action(git).map((line) => `  ${line}`),
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return { env: pathOverride(c, [dir, c.env.PATH]), marker };
}

function assertLockRefusal(result, kind) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, kind);
}

test('plan --reword on a clean tree exits 0 and takes the lock; release then removes the lock and the folder', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });

  const planned = await runCommit(c, ['plan', '--reword']);

  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, mode } = planned.json;
  assert.equal(mode, 'reword');
  const lock = JSON.parse(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'));
  assert.equal(lock.planId, planId);
  assert.ok(fs.statSync(path.join(runDirOf(c), planId)).isDirectory());

  const released = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(released.exitCode, 0, detail(released));
  assert.equal(released.json.reply.status, 'nothing');
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId)), false);
});
