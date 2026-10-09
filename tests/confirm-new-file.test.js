'use strict';

// INT-10 (docs/roadmap/12-integration.md, Q16, C:untracked-files, stories 88, 152, 153): an
// untracked candidate joins the plan as a whole-file unit, so a `split` run that adds a new
// file confirms even with one group; gitignored and hidden files are neither units nor
// `notIncluded` entries.

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

async function planAndCheck(c, files) {
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header: 'feat: add c', body: null, files, hunks: [] }],
    notIncluded: [],
  }));
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  return { planId, runDir, planned, checked };
}

test('Seam 1 (AC1): one modified plus one new file in one group -> confirm naming the new file; yes commits both', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  const { checked } = await planAndCheck(c, ['a.txt', 'c.txt']);

  const { reply } = checked.json;
  assert.equal(reply.status, 'handback');
  assert.equal(reply.handback.kind, 'confirm');
  assert.deepEqual(checked.json.confirm.reasons, ['new file c.txt']);
  assert.ok(reply.text.includes('c.txt'), reply.text);
  assert.deepEqual(reply.handback.answers.map((a) => a.label), ['yes', 'edit', 'no']);

  const yes = reply.handback.answers[0];
  const match = /^node "([^"]+)" (.*)$/.exec(yes.run);
  assert.ok(match, `a single node "<script>" command: ${yes.run}`);
  const result = await runCommit(c, match[2].split(' '));

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'committed');
  assert.equal(result.json.reply.commits.length, 1);
  const files = c.git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['a.txt', 'c.txt']);
});

test('Seam 1 (AC2): gitignored and hidden untracked files are not units and not in notIncluded', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', '.gitignore': 'ignored.log\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  c.writeFile('ignored.log', 'noise\n');
  c.writeFile('.hidden-note', 'secret\n');
  const { planned, checked, runDir } = await planAndCheck(c, ['a.txt', 'c.txt']);

  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const unitPaths = new Set(state.units.map((unit) => unit.path));
  assert.deepEqual([...unitPaths].sort(), ['a.txt', 'c.txt']);
  assert.ok(!JSON.stringify(planned.json.untracked ?? []).includes('ignored.log'), detail(planned));
  const wire = JSON.stringify(checked.json);
  assert.ok(!wire.includes('ignored.log'), 'gitignored file appears nowhere in check');
  assert.ok(!unitPaths.has('.hidden-note'), 'hidden file is not a unit');
  assert.ok(!(checked.json.reply.text.split('Not included')[1] ?? '').includes('.hidden-note'), 'hidden file is not listed as not included');
  assert.deepEqual(checked.json.notIncluded ?? [], [], 'nothing in notIncluded');
});
