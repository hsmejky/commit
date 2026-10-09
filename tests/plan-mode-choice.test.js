'use strict';

// INT-13 (docs/roadmap/12-integration.md): the `modeChoice` handback's answers (C:reply-and-
// handback handback table, Q9): `staged` and `split` are respawns holding the answer's `mode`
// alone, `ifNoUser` is `split`; the mixed-index call leaves no lock or run folder. A fully
// staged index (after `git add -A`) plans `split` with no question (story 82).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function mixed(c) {
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('b.txt', 'b2\n');
}

test('Seam 1: a mixed index answers staged and split as respawns with mode, ifNoUser split', async (t) => {
  const c = createCase(t);
  mixed(c);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const { handback } = result.json.reply;
  assert.equal(handback.kind, 'modeChoice');
  assert.deepEqual(handback.answers, [
    { label: 'staged', respawn: 'mode: staged' },
    { label: 'split', respawn: 'mode: split' },
  ]);
  assert.deepEqual(handback.ifNoUser, { answer: 'split' });
  assert.match(result.json.reply.callerRule, /For a respawn, spawn commit:commit-worker/);
  const runs = path.join(c.repoDir, '.commit-plan');
  assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], [], 'no lock or run folder left');
});

test('the staged answer respawn holds mode alone; its plan --staged call plans staged', async (t) => {
  const c = createCase(t);
  mixed(c);

  const result = await runCommit(c, ['plan']);
  const staged = result.json.reply.handback.answers.find((a) => a.label === 'staged');
  assert.equal(staged.respawn, 'mode: staged');
  // The respawned call is `plan --staged`: it finds no lock and plans staged.
  const again = await runCommit(c, ['plan', '--staged']);
  assert.equal(again.exitCode, 0, detail(again));
  assert.equal(again.json.mode, 'staged');
});

test('every change staged (git add -A) plans split with no question (story 82)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  c.writeFile('new.txt', 'n\n');
  c.git(['add', '-A']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'split');
  assert.equal(result.json.reply, null);
});
