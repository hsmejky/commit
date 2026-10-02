'use strict';

// GIT-02 (docs/roadmap/06-git-adapters.md): M3 reads branch, detached and unborn HEAD from
// one porcelain v2 `--branch` status call (Q21, stories 182/183); `plan` stores `state` and
// the expected HEAD (`null` when unborn) and adds the detached-HEAD notice. Seam 1 only
// (docs/spec/testing-seams.md): M3 spawns git, so it is exercised only through the shipped
// entry point as a subprocess, like GIT-01's probe before it.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

function seedCommit(c) {
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
}

test('plan on a branch with one commit stores the branch state and the expected HEAD', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const headSha = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.deepEqual(result.json.state, { kind: 'branch', branch: 'main', unborn: false });
  assert.equal(result.json.expectedHead, headSha);
});

test('plan on an unborn repo stores unborn: true and a null expected HEAD, with no error', async (t) => {
  const c = createCase(t);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.deepEqual(result.json.state, { kind: 'branch', branch: 'main', unborn: true });
  assert.equal(result.json.expectedHead, null);
  assert.equal(result.json.reply.status, 'nothing');
});

test('plan on a detached HEAD stores state.kind detached and adds the detached-HEAD notice', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const headSha = c.git(['rev-parse', 'HEAD']).trim();
  c.git(['checkout', '-q', '--detach', headSha]);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.deepEqual(result.json.state, { kind: 'detached', branch: null, unborn: false });
  assert.equal(result.json.expectedHead, headSha);
  assert.ok(
    result.json.reply.notices.some((n) => /detached/i.test(n)),
    JSON.stringify(result.json.reply.notices),
  );
});

test('plan reads branch and HEAD from exactly one porcelain v2 status call', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const branchStatusCalls = entries.filter(
    (e) => Array.isArray(e.args) && e.args.includes('--branch') && e.args.includes('--porcelain=v2'),
  );
  assert.equal(branchStatusCalls.length, 1, JSON.stringify(entries));
  assert.deepEqual(branchStatusCalls[0].args, [
    'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules=all',
  ]);
});
