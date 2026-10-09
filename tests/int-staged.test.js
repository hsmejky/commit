'use strict';

// INT-14 (docs/roadmap/12-integration.md; Q11, Q16, C:plan, C:cli-and-exit-codes, stories 83, 84,
// 85, 142, 225) at Seam 1: `plan --staged` plans the index as one group, `check --plan` commits
// exactly the staged content and reports the rest; an empty index and a staged hit or a hidden
// staged-new path are refused with the lock and run folder gone.

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

function unitIds(runDir) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return state.units.map((unit) => unit.id);
}

function writeGroup(runDir, header) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header, body: null, files: [], hunks: unitIds(runDir), reason: header }],
    notIncluded: [],
  }));
}

function assertGone(c) {
  const dir = path.join(c.repoDir, '.commit-plan');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'lock gone');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'run folder gone');
}

test('story 83: a staged subset → one commit of exactly the staged content, the rest left and reported', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('b.txt', 'b2\n');
  c.writeFile('new.txt', 'n\n');
  const planned = await runCommit(c, ['plan', '--staged']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeGroup(runDir, 'feat: change a');

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits.length, 1, detail(checked));
  assert.equal(c.git(['show', '--format=', '--name-only', 'HEAD']).trim(), 'a.txt');
  assert.equal(c.git(['rev-list', '--count', 'HEAD']).trim(), '2');
  assert.equal(c.git(['status', '--porcelain']).split('\n').filter(Boolean).sort().join('|'), ' M b.txt|?? new.txt');
  assert.match(String(checked.json.reply.text ?? checked.stdout), /2 files|b\.txt/, detail(checked));
});

test('story 84: a staged new directory of 60 files commits whole', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  for (let i = 1; i <= 60; i += 1) c.writeFile(`gen/f${String(i).padStart(2, '0')}.txt`, `f${i}\n`);
  c.git(['add', '--', 'gen']);
  const planned = await runCommit(c, ['plan', '--staged']);
  assert.equal(planned.exitCode, 0, detail(planned));
  writeGroup(planned.json.runDir, 'feat: add gen');

  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(c.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'gen']).trim().split('\n').length, 60);
  assert.equal(c.git(['status', '--porcelain']).trim(), '');
});

test('story 225: --staged with an empty index → exit 1 usage (domain code staged-empty)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');

  const result = await runCommit(c, ['plan', '--staged']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'usage', detail(result));
  assert.match(result.json.error.message, /nothing is staged/, detail(result));
  assertGone(c);
});

test('story 142: a staged scan hit → exit 6 staged-hit, lock and folder gone', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', `a\nconst t = "${'gh' + 'p_' + 'a'.repeat(36)}";\n`);
  c.git(['add', '--', 'a.txt']);

  const result = await runCommit(c, ['plan', '--staged']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'staged-hit', detail(result));
  assertGone(c);
});

test('story 142: a hidden staged-new path → exit 6 staged-hit, lock and folder gone', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('.env', 'SECRET=1\n');
  c.git(['add', '-f', '--', '.env']);

  const result = await runCommit(c, ['plan', '--staged']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'staged-hit', detail(result));
  assertGone(c);
});
