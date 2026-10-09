'use strict';

// INT-12 (docs/roadmap/12-integration.md, Q16, C:confirmation-triggers `resumed` row, C:worker-input
// `resume`/`edit`, stories 47, 93-95, 181, 222): a separate `plan --hunks --plan <id>` call marks
// the run `resumed` (CHG-19 builds it); the next `check` then confirms even a single tracked group
// (reason `edited plan`), in `split`, `staged` and `reword`, interactive only. `one` is offered
// only in `split` with several groups. Seam 1 throughout.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  files = { ...files, '.claude/commit.json': '{ "body": "optional" }\n' };
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeGroups(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups, notIncluded: [],
  }));
}

function group(header, files) {
  return { header, body: null, files, hunks: [] };
}

function stateOf(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

async function plan(c, argv = ['plan']) {
  const planned = await runCommit(c, argv);
  assert.equal(planned.exitCode, 0, detail(planned));
  return { planId: planned.json.planId, runDir: planned.json.runDir };
}

async function resume(c, planId) {
  const hunks = await runCommit(c, ['plan', '--hunks', '--plan', planId]);
  assert.equal(hunks.exitCode, 0, detail(hunks));
  return hunks;
}

function check(c, planId) {
  return runCommit(c, ['check', '--plan', planId]);
}

function labels(checked) {
  return checked.json.reply.handback.answers.map((a) => a.label);
}

function twoFileCase(t) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  return c;
}

test('Seam 1 (AC1): a separate plan --hunks keeps the IDs and the notices, resets the lint counter; a bad check after it -> exit 2, no reply', async (t) => {
  const c = twoFileCase(t);
  const { planId, runDir } = await plan(c);
  const before = stateOf(runDir);
  assert.ok(before.notices.length > 0, 'no heartbeat: the guard notice is stored');
  const ids = before.units.map((u) => u.id);

  writeGroups(runDir, [group('feat: x', ['nope.txt'])]);
  const first = await check(c, planId);
  assert.equal(first.exitCode, 2, detail(first));
  assert.equal(stateOf(runDir).lintFailures, 1);

  await resume(c, planId);
  const after = stateOf(runDir);
  assert.equal(after.lintFailures, 0, 'the counter is reset');
  assert.equal(after.resumed, true);
  assert.deepEqual(after.units.map((u) => u.id), ids);
  assert.deepEqual(after.notices, before.notices);

  const bad = await check(c, planId);
  assert.equal(bad.exitCode, 2, detail(bad));
  assert.equal(bad.json.reply ?? null, null, 'a plain lint failure carries no reply');
});

test('Seam 1 (AC2, story 95): a following check with one tracked group -> confirm whose reason is the edited plan', async (t) => {
  const c = twoFileCase(t);
  const { planId, runDir } = await plan(c);
  await resume(c, planId);
  writeGroups(runDir, [group('feat: x', ['a.txt', 'b.txt'])]);

  const checked = await check(c, planId);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'handback');
  assert.equal(checked.json.reply.handback.kind, 'confirm');
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
  assert.equal(checked.json.reply.handback.humanOnly, false);
});

test('Seam 1 (AC3, stories 94, 222): `one` is absent from a single-group confirmation; a one-group plan after `one` commits every included file', async (t) => {
  const c = twoFileCase(t);
  const { planId, runDir } = await plan(c);
  writeGroups(runDir, [group('feat: a', ['a.txt']), group('fix: b', ['b.txt'])]);
  const several = await check(c, planId);
  assert.deepEqual(labels(several), ['yes', 'edit', 'one', 'no']);

  // The `one` respawn re-plans: a separate `plan --hunks`, then one group over everything.
  await resume(c, planId);
  writeGroups(runDir, [group('feat: all', ['a.txt', 'b.txt'])]);
  const single = await check(c, planId);
  assert.deepEqual(single.json.confirm.reasons, ['edited plan']);
  assert.deepEqual(labels(single), ['yes', 'edit', 'no']);

  const yes = single.json.reply.handback.answers[0];
  const match = /^node "([^"]+)" (.*)$/.exec(yes.run);
  assert.ok(match, yes.run);
  const done = await runCommit(c, match[2].split(' '));
  assert.equal(done.exitCode, 0, detail(done));
  assert.equal(done.json.reply.status, 'committed');
  assert.equal(done.json.reply.commits.length, 1);
  const files = c.git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['a.txt', 'b.txt']);
});

test('Seam 1 (AC3): a staged confirmation offers no `one`', async (t) => {
  const c = twoFileCase(t);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  const { planId, runDir } = await plan(c, ['plan', '--staged']);
  await resume(c, planId);
  writeGroups(runDir, [group('feat: x', [])]);

  const checked = await check(c, planId);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
  assert.deepEqual(labels(checked), ['yes', 'edit', 'no']);
});

test('Seam 1 (AC4): an edit to a known path between plan and plan --hunks -> diff-changed, run ended', async (t) => {
  const c = twoFileCase(t);
  const { planId } = await plan(c);
  c.writeFile('a.txt', 'one\nmore\nagain\n');

  const result = await runCommit(c, ['plan', '--hunks', '--plan', planId]);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed');
  const dir = path.join(c.repoDir, '.commit-plan');
  const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => e !== '.gitignore') : [];
  assert.deepEqual(left, [], 'lock and run folder gone');
});

test('Seam 1 (AC5): `resumed` alone triggers confirm in staged, no humanOnly (--no-user cannot combine with --staged)', async (t) => {
  const c = twoFileCase(t);
  c.git(['add', '--', 'a.txt']);
  const { planId, runDir } = await plan(c, ['plan', '--staged']);
  await resume(c, planId);
  writeGroups(runDir, [group('feat: x', [])]);
  const checked = await check(c, planId);
  assert.equal(checked.json.reply.handback.kind, 'confirm');
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
});

test('Seam 1 (AC5): `resumed` alone triggers confirm in split with one group and no other trigger', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const { planId, runDir } = await plan(c);
  await resume(c, planId);
  writeGroups(runDir, [group('feat: x', ['a.txt'])]);
  const checked = await check(c, planId);
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
});

test('Seam 1 (AC6, story 181): `resumed` triggers confirm in a reword run; under --no-user it gives none', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.git(['commit', '-q', '-am', 'fix: old message']);
  const { planId, runDir } = await plan(c, ['plan', '--reword']);
  await resume(c, planId);
  writeGroups(runDir, [group('fix: better message', [])]);
  const checked = await check(c, planId);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm');
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
  assert.deepEqual(labels(checked), ['yes', 'edit', 'no']);

  const c2 = createCase(t);
  seed(c2, { 'a.txt': 'one\n' });
  c2.writeFile('a.txt', 'one\nmore\n');
  c2.git(['commit', '-q', '-am', 'fix: old message']);
  const second = await plan(c2, ['plan', '--reword', '--no-user']);
  await resume(c2, second.planId);
  writeGroups(second.runDir, [group('fix: better message', [])]);
  const nu = await check(c2, second.planId);
  assert.equal(nu.json.confirm ?? null, null);
  assert.equal(nu.json.reply.status, 'committed');
});
