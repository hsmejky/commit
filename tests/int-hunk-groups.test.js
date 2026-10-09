'use strict';

// INT-18 (docs/roadmap/12-integration.md; Q11, C:plan-hunks, C:worker-plan, stories 63, 64, 67,
// 91) at Seam 1: a modified file's hunks split across two groups commit as two commits, each
// holding exactly its planned hunks.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`);
}

async function check(c, planId, runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
  return runCommit(c, ['check', '--plan', planId]);
}

function group(header, hunks) {
  return { header, body: null, files: [], hunks, reason: header };
}

// `f.txt`: lines 1 and 30 edited, two distant hunks.
async function twoHunkRun(t, extraArgs = []) {
  const c = createCase(t);
  const lines = numbered(30);
  c.writeFile('f.txt', lines.join(''));
  c.git(['add', '--', 'f.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[29] = 'last\n';
  c.writeFile('f.txt', edited.join(''));
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split', ...extraArgs]);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return { c, planId, runDir, seed, ids: state.units.map((unit) => unit.id) };
}

test('Seam 1: two distant hunks in two groups → two commits, each diff its planned hunk, final blob equals the working tree', async (t) => {
  const { c, planId, runDir, seed, ids } = await twoHunkRun(t, ['--no-user']);
  assert.equal(ids.length, 2);
  const working = fs.readFileSync(path.join(c.repoDir, 'f.txt'));

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: first line', [ids[0]]), group('feat: last line', [ids[1]])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits.length, 2, detail(checked));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 2);
  const patchOf = (sha) => c.git(['show', '--format=', '-U0', sha]).split('\n').filter((l) => /^[+-][^+-]/.test(l));
  assert.deepEqual(patchOf(shas[0]), ['-1', '+first']);
  assert.deepEqual(patchOf(shas[1]), ['-30', '+last']);
  const blob = execBlob(c, 'HEAD:f.txt');
  assert.deepEqual(blob, working);
  assert.equal(c.git(['status', '--porcelain']), '');
});

function execBlob(c, spec) {
  const { spawnSync } = require('node:child_process');
  return spawnSync('git', ['show', spec], { cwd: c.repoDir }).stdout;
}

test('story 91: the confirm block shows the hunk count per file for a hunk plan', async (t) => {
  const { c, planId, runDir, ids } = await twoHunkRun(t);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: first line', [ids[0]]), group('feat: last line', [ids[1]])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits, undefined, detail(checked));
  assert.equal(checked.json.reply.status, 'handback', detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));
  assert.match(checked.json.reply.text, /1\. feat: first line\n   f\.txt \(1 hunk\)\n2\. feat: last line\n   f\.txt \(1 hunk\)/);
  assert.equal(c.git(['diff', '--name-only']), 'f.txt\n');
});

test('story 67: identical hunks of one file split across groups → lint error', async (t) => {
  const c = createCase(t);
  const block = ['a\n', 'b\n', 'c\n', 'old\n', 'd\n', 'e\n', 'f\n'];
  const filler = numbered(10);
  c.writeFile('f.txt', [...block, ...filler, ...block, ...filler].join(''));
  c.git(['add', '--', 'f.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const edit = (lines) => lines.map((line) => (line === 'old\n' ? 'new\n' : line));
  const tail = [...filler];
  tail[9] = 'ten\n';
  c.writeFile('f.txt', [...edit(block), ...filler, ...edit(block), ...tail].join(''));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const [h1, h2, h3] = state.units.map((unit) => unit.id);

  const checked = await check(c, planId, runDir, {
    groups: [group('feat: one', [h1, h3]), group('feat: two', [h2])],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.ok(checked.json.errors.length >= 1, detail(checked));
});
