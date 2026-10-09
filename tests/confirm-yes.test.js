'use strict';

// INT-09 (docs/roadmap/12-integration.md, Q16, C:reply-and-handback `confirm`, story 87, 91,
// 92, 208): a `split` run with several groups gets a `confirm` handback from `check`; its
// `yes` answer's `run` (`commit --all --confirmed`) commits every group in order.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// The default `body: "forbidden"` would refuse the groups' bodies, so the seed commit carries
// a config allowing them.
function seed(c, files) {
  files = { ...files, '.claude/commit.json': '{ "body": "optional" }\n' };
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeWorkerPlan(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups, notIncluded: [],
  }));
}

function group(header, files, body = null) {
  return { header, body, files, hunks: [] };
}

// Plans, writes a worker plan and runs `check`: the kept `confirm` handback.
async function confirmed(c, groups) {
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId } = planned.json;
  const runDir = path.join(c.repoDir, '.commit-plan', planId);
  writeWorkerPlan(runDir, groups);
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  return { planId, runDir, checked };
}

function twoGroupCase(t) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  return c;
}

const TWO_GROUPS = [
  group('feat: change a', ['a.txt'], 'Explains a.'),
  group('fix: change b', ['b.txt']),
];

// Runs an answer's `run` string verbatim: `node "<script>" <args…>` -> the script's own args.
function runAnswer(c, answer) {
  const match = /^node "([^"]+)" (.*)$/.exec(answer.run);
  assert.ok(match, `a single node "<script>" command: ${answer.run}`);
  return runCommit(c, match[2].split(' '));
}

test('Seam 1 (AC1, AC2): two groups -> confirm handback with yes/edit/one/no, ifNoUser yes', async (t) => {
  const c = twoGroupCase(t);
  const { planId, checked } = await confirmed(c, TWO_GROUPS);

  const { reply } = checked.json;
  assert.equal(reply.status, 'handback');
  const { handback } = reply;
  assert.equal(handback.kind, 'confirm');
  assert.equal(handback.humanOnly, false);
  assert.equal(handback.question, 'Commit as proposed? To change it, type your changes under Other.');
  assert.deepEqual(handback.answers.map((a) => a.label), ['yes', 'edit', 'one', 'no']);
  const [yes, edit, one, no] = handback.answers;
  assert.match(yes.run, new RegExp(`^node "[^"]+commit\.cjs" commit --plan ${planId} --all --confirmed$`));
  assert.equal(yes.timeoutMs, 600000);
  assert.deepEqual(edit, { label: 'edit', respawn: `resume: ${planId}\nedit: {text}`, needsText: true });
  assert.deepEqual(one, { label: 'one', respawn: `resume: ${planId}\nedit: one` });
  assert.match(no.run, new RegExp(`^node "[^"]+commit\.cjs" release --plan ${planId}$`));
  assert.equal(no.timeoutMs, 60000);
  assert.deepEqual(handback.ifNoUser, { answer: 'yes', returnToParent: false });
  assert.match(reply.callerRule, /If question is null, run the only answer/);
});

test('Seam 1 (AC2): a single-group confirm (new file) offers no `one`', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  const { checked } = await confirmed(c, [group('feat: x', ['a.txt', 'c.txt'])]);

  const labels = checked.json.reply.handback.answers.map((a) => a.label);
  assert.deepEqual(labels, ['yes', 'edit', 'no']);
});

test('Seam 1 (AC3): the confirm block shows header, body and files, 20 files per group then +N more', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const names = [];
  for (let i = 1; i <= 21; i += 1) {
    const name = `f${String(i).padStart(2, '0')}.txt`;
    names.push(name);
    c.writeFile(name, 'x\n');
  }
  const { checked } = await confirmed(c, [
    group('feat: many', names, 'Many files.'),
    group('fix: a', ['a.txt']),
  ]);

  const lines = checked.json.reply.text.split('\n');
  assert.equal(lines[0], 'Proposed commits:');
  assert.equal(lines[1], '1. feat: many');
  assert.equal(lines[2], '   Many files.');
  assert.equal(lines[3], `   ${names.slice(0, 20).map((n) => `${n} (new)`).join(', ')}, +1 more`);
  assert.equal(lines[4], '2. fix: a');
  assert.equal(lines[5], '   a.txt');
  assert.match(lines[6], /^Confirm: 2 groups, new file f01\.txt/);
});

test('Seam 1 (AC4): running the yes command verbatim commits both groups in order and replies committed', async (t) => {
  const c = twoGroupCase(t);
  const { checked } = await confirmed(c, TWO_GROUPS);

  const result = await runAnswer(c, checked.json.reply.handback.answers[0]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'committed');
  assert.equal(result.json.reply.commits.length, 2);
  const log = c.git(['log', '--format=%s', '-n', '2']).trim().split('\n');
  assert.deepEqual(log, ['fix: change b', 'feat: change a']);
});

test('Seam 1 (AC5): commit --all without --confirmed -> usage unconfirmed, run kept', async (t) => {
  const c = twoGroupCase(t);
  const { planId, runDir } = await confirmed(c, TWO_GROUPS);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'usage', detail(result));
  assert.match(result.json.error.message, /confirm/);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(fs.existsSync(runDir), true, 'the run is kept');
});

test('Seam 1 (AC6): running the no release command verbatim -> nothing, lock and folder gone, index unchanged', async (t) => {
  const c = twoGroupCase(t);
  const { runDir, checked } = await confirmed(c, TWO_GROUPS);
  const indexBefore = c.git(['ls-files', '-s']);

  const result = await runAnswer(c, checked.json.reply.handback.answers[3]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'nothing');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the lock is gone');
  assert.equal(c.git(['ls-files', '-s']), indexBefore);
});

// A skipped (over-size) file is a humanOnly reason (C:confirmation-triggers); interactively it
// is a `confirm` handback whose `ifNoUser` is `no` handed to the parent (C:reply-and-handback).
test('Seam 1 (AC1): a humanOnly confirm -> ifNoUser is no, returnToParent true, humanOnly true', async (t) => {
  const c = createCase(t);
  seed(c, { 'big.txt': 'keep\n' });
  const lines = [];
  for (let i = 0; i < 1100; i += 1) lines.push(`${'x'.repeat(1023)}\n`);
  c.writeFile('big.txt', `keep\n${lines.join('')}`);
  const { checked } = await confirmed(c, [group('feat: big', ['big.txt'])]);

  const { handback } = checked.json.reply;
  assert.equal(handback.kind, 'confirm');
  assert.equal(handback.humanOnly, true);
  assert.deepEqual(handback.ifNoUser, { answer: 'no', returnToParent: true });
});
