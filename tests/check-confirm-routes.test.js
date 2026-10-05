'use strict';

// RUN-18 (docs/roadmap/09-runs.md, C:check, Q16, Q17): M15 `afterCheck`'s routing over M15
// `computeConfirm`'s decision, once a worker plan validates with at least one whole-file
// group. Each AC below is RUN-18's own Seam-1 row; INT-02's own first-slice case (AC3) is
// not duplicated here: `tests/first-end-to-end-commit.test.js` asserts `confirm: null`, the
// in-process commit and the `committed` reply with no handback.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function lockPath(runDir) {
  return path.join(path.dirname(runDir), 'lock');
}

function statePath(runDir) {
  return path.join(runDir, 'state.json');
}

function storedState(runDir) {
  return JSON.parse(fs.readFileSync(statePath(runDir), 'utf8'));
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeWorkerPlan(runDir, value) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify(value));
}

function oneGroup(files, extra = {}) {
  return { version: 1, source: 'worker', groups: [{ header: 'feat: x', body: null, files, hunks: [], ...extra }], notIncluded: [] };
}

async function plannedSplit(c, planArgs = ['plan']) {
  const result = await runCommit(c, planArgs);
  assert.equal(result.exitCode, 0, detail(result));
  return { planId: result.json.planId, runDir: path.join(c.repoDir, '.commit-plan', result.json.planId) };
}

// Added lines whose total UTF-8 length is at least `bytes` (same helper as
// tests/run-policy-confirm.test.js), well clear of the scanner's 1 MB skip boundary.
function bigAddedContent(bytes) {
  const lines = [];
  let rest = bytes;
  while (rest >= 1024) {
    lines.push(`${'x'.repeat(1023)}\n`);
    rest -= 1024;
  }
  if (rest > 0) lines.push(`${'y'.repeat(Math.max(rest - 1, 1))}\n`);
  return lines.join('');
}

// AC1: a new file in a group (interactive) -> a `confirm` handback. HEAD unchanged, the run
// kept, `awaitingConfirm` stored.
test('Seam 1 (AC1): a new file in a group, interactive -> confirm handback, run kept, HEAD unchanged', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['a.txt', 'c.txt']));
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'handback');
  assert.equal(checked.json.reply.handback.kind, 'confirm');
  assert.deepEqual(checked.json.confirm, { reasons: ['new file c.txt'], humanOnly: false });
  assert.equal(checked.json.reply.commits.length, 0);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD is unchanged');
  assert.equal(storedState(runDir).awaitingConfirm, true);
  assert.equal(fs.existsSync(lockPath(runDir)), true, 'the run lock is kept');
  assert.equal(fs.existsSync(runDir), true, 'the run folder is kept');
});

// AC2: a `humanOnly` reason with `--no-user` -> `handedBack`, lock and folder gone.
test('Seam 1 (AC2): a humanOnly reason with --no-user -> handedBack, lock and folder gone', async (t) => {
  const c = createCase(t);
  seed(c, { 'big.txt': 'keep\n' });
  c.writeFile('big.txt', `keep\n${bigAddedContent(1024 * 1024 + 8192)}`);
  const { planId, runDir } = await plannedSplit(c, ['plan', '--split', '--no-user']);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  writeWorkerPlan(runDir, oneGroup(['big.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'handback');
  assert.equal(checked.json.reply.handback.kind, 'handedBack');
  assert.equal(checked.json.confirm.humanOnly, true);
  assert.equal(checked.json.reply.handback.question, null);
  assert.equal(checked.json.reply.planId, null);
  assert.equal(checked.json.reply.commits.length, 0);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD is unchanged');
  assert.equal(fs.existsSync(lockPath(runDir)), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is deleted');
});

// AC4: `confirm` set, `interactive: false`, not `humanOnly` -> commits in-process same as
// `confirm: null` (C:check `interactive: false` row).
test('Seam 1 (AC4): confirm set, --no-user, not humanOnly -> commits same as confirm null', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  const { planId, runDir } = await plannedSplit(c, ['plan', '--split', '--no-user']);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  writeWorkerPlan(runDir, oneGroup(['a.txt', 'c.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.confirm, { reasons: ['new file c.txt'], humanOnly: false });
  assert.equal(checked.json.reply.status, 'committed');
  assert.equal(checked.json.reply.handback, null);
  assert.equal(checked.json.reply.commits.length, 1);
  assert.notEqual(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD moved: a real commit happened');
  assert.equal(fs.existsSync(lockPath(runDir)), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is deleted');
});

// AC5: zero groups (every unit in `notIncluded`) -> exit 0, `status: "nothing"`, `text`
// lists each `notIncluded` reason, lock+folder gone, no `confirm` handback.
test('Seam 1 (AC5): zero groups -> nothing, notIncluded reasons listed, lock and folder gone', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const { planId, runDir } = await plannedSplit(c);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [],
    notIncluded: [{ path: 'a.txt', hunks: null, reason: 'leaving out for now' }],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.confirm, null);
  assert.equal(checked.json.reply.status, 'nothing');
  assert.equal(checked.json.reply.handback, null);
  assert.ok(checked.json.reply.text.includes('a.txt: leaving out for now'), checked.json.reply.text);
  assert.equal(checked.json.reply.commits.length, 0);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD is unchanged');
  assert.equal(fs.existsSync(lockPath(runDir)), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is deleted');
});
