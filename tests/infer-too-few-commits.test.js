'use strict';

// INF-01 (docs/roadmap/14-infer-and-commit-config.md): `infer` end to end with too few
// commits. M3 reads the last 200 non-merge messages, M19 counts them, and under 20 the
// outcome is `too-few-commits` (C:infer). Read-only: no lock, no run folder. Seam 1 through
// the shipped entry point (docs/spec/testing-seams.md), plus M19's own pure checks.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { assertPureSource } = require('./helpers/assert-pure-source.js');

let infer;
beforeEach(async () => {
  ({ infer } = await loadLib('history-inference'));
});

function commitMessages(c, messages) {
  messages.forEach((message, i) => {
    c.writeFile('file.txt', `${i}\n`);
    c.git(['add', 'file.txt']);
    c.git(['commit', '-q', '-m', message]);
  });
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.version, 1);
  assert.equal(result.json.ok, true);
}

function assertNoRunFolder(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.commit-plan')), false, `.commit-plan created in ${dir}`);
}

function assertRefusal(result, pattern) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.version, 1, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.match(result.json.error.message, pattern);
}

test('infer on 5 conventional commits is too-few-commits with ccShare over the 5 read', async (t) => {
  const c = createCase(t);
  commitMessages(c, ['feat: a', 'fix: b', 'docs: c', 'chore: d', 'test: e']);
  const statusBefore = c.git(['status', '--porcelain', '--untracked-files=all']);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.deepEqual(result.json, {
    version: 1,
    ok: true,
    outcome: 'too-few-commits',
    commitCount: 5,
    ccShare: 1,
    nonConventional: 0,
    wouldFail: null,
    proposal: null,
    configJson: null,
  });
  assertNoRunFolder(c.repoDir);
  assert.equal(c.git(['status', '--porcelain', '--untracked-files=all']), statusBefore);
});

test('infer on an unborn repo is too-few-commits with commitCount 0 and ccShare null', async (t) => {
  const c = createCase(t);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.outcome, 'too-few-commits');
  assert.equal(result.json.commitCount, 0);
  assert.equal(result.json.ccShare, null);
  assert.equal(result.json.nonConventional, 0);
  assert.equal(result.json.proposal, null);
  assert.equal(result.json.wouldFail, null);
  assert.equal(result.json.configJson, null);
  assertNoRunFolder(c.repoDir);
});

test('infer outside a repository exits 6 state with plan\'s text', async (t) => {
  const c = createCase(t, { repo: false });
  const dir = path.join(c.root, 'plain');
  fs.mkdirSync(dir);

  const result = await runCommit(c, ['infer'], { cwd: dir });

  assertRefusal(result, /^not a git repository \(or not inside its working tree\); run \/commit inside one$/);
  assertNoRunFolder(dir);
});

test('infer in a bare repository exits 6 state with plan\'s text', async (t) => {
  const c = createCase(t, { repo: false });
  const bare = path.join(c.root, 'bare.git');
  c.git(['init', '-q', '--bare', bare], { cwd: c.root });

  const result = await runCommit(c, ['infer'], { cwd: bare });

  assertRefusal(result, /^a bare repository has no working tree; run \/commit inside a working tree$/);
  assertNoRunFolder(bare);
});

test('M19 infer: ccShare and nonConventional count every message read', () => {
  const output = infer(['feat: a', 'WIP stuff', 'fix(x): b', 'update readme']);
  assert.deepEqual(output, {
    outcome: 'too-few-commits',
    commitCount: 4,
    ccShare: 0.5,
    nonConventional: 2,
    wouldFail: null,
    proposal: null,
  });
});

test('M19 infer: 19 messages are still too-few-commits', () => {
  const output = infer(Array.from({ length: 19 }, (_, i) => `feat: change ${i}`));
  assert.equal(output.outcome, 'too-few-commits');
  assert.equal(output.commitCount, 19);
  assert.equal(output.ccShare, 1);
});

test('M19 history-inference module stays pure', () => {
  assertPureSource('history-inference', { allowImports: ['./message-grammar.mjs'] });
});
