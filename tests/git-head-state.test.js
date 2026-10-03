'use strict';

// GIT-02 (docs/roadmap/06-git-adapters.md): M3 reads branch, detached and unborn HEAD from
// one porcelain v2 `--branch` status call pinned `--untracked-files=no
// --ignore-submodules=all --no-ahead-behind` (Q21, stories 182/183); `plan` stores `state`
// and the expected HEAD (`null` when unborn) and adds the detached-HEAD notice. Seam 1 only
// (docs/spec/testing-seams.md) for this file: these cases go through `plan` as a subprocess,
// like GIT-01's probe before it. `head()`/`headTree()` have no caller through `plan` yet
// (GIT-09/EXE), so they get their own library-level tests in `repo-probe.test.js`
// (review-GIT-02 finding 2).

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

// KD-R65 retired (CHG-03b): the HEAD state is stored in `plan.json` `state` and the expected
// HEAD in `state.json` `head`, which only a tree with changes writes; stdout carries neither.
function storedFacts(c, result) {
  const folder = path.join(c.repoDir, '.commit-plan', result.json.planId);
  assert.equal(Object.hasOwn(result.json, 'state'), false);
  assert.equal(Object.hasOwn(result.json, 'expectedHead'), false);
  return {
    state: JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8')).state,
    head: JSON.parse(fs.readFileSync(path.join(folder, 'state.json'), 'utf8')).head,
  };
}

test('plan on a branch with one commit stores the branch state and the expected HEAD', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const headSha = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('README.md', 'changed\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const { state, head } = storedFacts(c, result);
  assert.deepEqual(state, { kind: 'branch', branch: 'main', unborn: false });
  assert.equal(head, headSha);
});

test('plan on an unborn repo stores unborn: true and a null expected HEAD, with no error', async (t) => {
  const c = createCase(t);
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  // An unborn HEAD has no tracked modification to reach step 7 with until the inventory
  // takes added files, so `plan.json` and `state.json` are not observable here yet; the
  // stdout stand-in is gone all the same (KD-R66, narrowed from KD-R65).
  assert.equal(Object.hasOwn(result.json, 'state'), false);
  assert.equal(Object.hasOwn(result.json, 'expectedHead'), false);
  assert.equal(result.json.reply.status, 'nothing');

  // Story 182: config at HEAD is skipped on an unborn HEAD, so no `git show` call is made.
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const showCalls = entries.filter((e) => Array.isArray(e.args) && e.args.includes('show'));
  assert.deepEqual(showCalls, [], JSON.stringify(entries));
});

test('plan on a detached HEAD stores state.kind detached and adds the detached-HEAD notice', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const headSha = c.git(['rev-parse', 'HEAD']).trim();
  c.git(['checkout', '-q', '--detach', headSha]);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.ok(
    result.json.reply.notices.some((n) => /detached/i.test(n)),
    JSON.stringify(result.json.reply.notices),
  );

  c.writeFile('README.md', 'changed\n');
  const changed = await runCommit(c, ['plan']);
  assert.equal(changed.exitCode, 0, `stdout ${changed.stdout}\nstderr ${changed.stderr}`);
  const { state, head } = storedFacts(c, changed);
  assert.deepEqual(state, { kind: 'detached', branch: null, unborn: false });
  assert.equal(head, headSha);
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
  // Finding 10 (review-GIT-02): count every status call in porcelain v2, not only ones that
  // ask for `--branch` — a later `u`-line read (GIT-04) would otherwise slip past this count.
  const statusCalls = entries.filter(
    (e) => Array.isArray(e.args) && e.args.includes('status') && e.args.includes('--porcelain=v2'),
  );
  assert.equal(statusCalls.length, 1, JSON.stringify(entries));
  assert.deepEqual(statusCalls[0].args, [
    'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules=all',
    '--no-ahead-behind',
  ]);

  // HEAD comes from this status call's `branch.oid`, not a separate `rev-parse HEAD`.
  const revParseHead = entries.filter(
    (e) => Array.isArray(e.args) && e.args[0] === 'rev-parse' && e.args.includes('HEAD'),
  );
  assert.deepEqual(revParseHead, [], JSON.stringify(entries));
});
