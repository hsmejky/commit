'use strict';

// INT-17 (docs/roadmap/12-integration.md; Q17, C:reply-and-handback `handedBack` row, stories
// 100, 102, 103) at Seam 1: `--no-user` commits plain confirmations without a handback, turns a
// `humanOnly` confirmation into a `handedBack` handback with the lock and folder released, and
// commits the rest when a size-skipped file is left out. Story 102 as settled by PRE-15: an
// honest worker never answers a `handedBack`; the forged-answer gap is Q25's and not asserted.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function group(header, hunks) {
  return { header, body: null, files: [], hunks, reason: header };
}

function unitId(runDir, file) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return state.units.find((unit) => unit.path === file).id;
}

function write(runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
}

function seedBig(c) {
  c.writeFile('a.txt', 'one\n');
  c.writeFile('big.txt', 'seed\n');
  c.git(['add', '--', 'a.txt', 'big.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\ntwo\n');
  c.writeFile('big.txt', 'seed\n' + 'x'.repeat(1024 * 1024 + 10) + '\n');
}

test('Seam 1: two groups under --no-user -> both committed, no handback (story 100)', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'one\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\ntwo\n');
  c.writeFile('b.txt', 'one\ntwo\n');
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  write(runDir, {
    groups: [group('feat: grow a', [unitId(runDir, 'a.txt')]), group('feat: grow b', [unitId(runDir, 'b.txt')])],
    notIncluded: [],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed', detail(checked));
  assert.equal(checked.json.reply.handback ?? null, null);
  assert.equal(checked.json.commits.length, 2);
  assert.equal(c.git(['status', '--porcelain']).trim(), '');
});

test('a humanOnly trigger under --no-user -> handedBack, question null, lock and folder released', async (t) => {
  const c = createCase(t);
  seedBig(c);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  write(runDir, {
    groups: [group('feat: grow big', [unitId(runDir, 'big.txt'), unitId(runDir, 'a.txt')])],
    notIncluded: [],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const { reply } = checked.json;
  assert.equal(reply.status, 'handback', detail(checked));
  assert.equal(reply.handback.kind, 'handedBack');
  assert.equal(reply.handback.question, null);
  assert.deepEqual(reply.handback.ifNoUser, { returnToParent: true });
  assert.ok(reply.text.startsWith('nothing committed — run /commit to plan again'), reply.text);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(fs.existsSync(runDir), false, 'the run folder is deleted');
});

test('a size-skipped file left out under --no-user -> the rest commits, the notice is in the text (story 103)', async (t) => {
  const c = createCase(t);
  seedBig(c);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const sizeSkipped = planned.json.hunks.summaryOnly.find((entry) => entry.path === 'big.txt');
  assert.equal(sizeSkipped?.reason, 'size', 'the script itself size-skipped big.txt');
  write(runDir, {
    groups: [group('feat: grow a', [unitId(runDir, 'a.txt')])],
    notIncluded: [{ path: 'big.txt', hunks: [unitId(runDir, 'big.txt')], reason: 'too big' }],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const { reply } = checked.json;
  assert.equal(reply.status, 'committed', detail(checked));
  assert.equal(checked.json.commits.length, 1);
  assert.equal(c.git(['show', '--format=', '--name-only', 'HEAD']).trim(), 'a.txt');
  assert.match(reply.text, /big\.txt/, reply.text);
  assert.match(reply.text, /too big/, reply.text);
});
