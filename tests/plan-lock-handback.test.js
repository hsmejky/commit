'use strict';

// INT-05 (docs/roadmap/12-integration.md, C:reply-and-handback `lock` row, Q22): the `lock`
// handback's `respawn` repeats the refused call's own mode flag next to `takeOver`
// (`plan --staged`/`plan --split`), which tests/plan-step7.test.js's live-lock cases do not
// cover (they only exercise a bare `plan` call, whose respawn has no `mode` line).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { parseBaseCallerRule, parseHandbackRule } = require('./helpers/reply-contract-doc.js');

const OTHER_PLAN_ID = '11111111-1111-4111-8111-111111111111';

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function folderNames(c) {
  return fs.readdirSync(runDirOf(c)).filter((name) => name !== 'lock').sort();
}

// Writes the run lock with a fixed mtime a minute in the past: fresh (under 15 minutes) and
// whole seconds, so `touched` has one exact ISO form (same as tests/plan-step7.test.js).
function placeLock(c, content) {
  const lock = path.join(runDirOf(c), 'lock');
  fs.writeFileSync(lock, content);
  const minuteAgo = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  fs.utimesSync(lock, minuteAgo, minuteAgo);
}

function assertLockRefusal(result, kind) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, kind);
}

async function placeLockAndPlan(t, flag) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  placeLock(c, JSON.stringify({ planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' }));

  const result = await runCommit(c, flag === null ? ['plan'] : ['plan', `--${flag}`]);
  return { c, result };
}

for (const flag of ['staged', 'split']) {
  test(`plan --${flag} refused by a live lock gets a lock handback whose respawn repeats the mode flag`, async (t) => {
    const { c, result } = await placeLockAndPlan(t, flag);

    assertLockRefusal(result, 'lock');
    const { reply } = result.json;
    assert.equal(reply.status, 'handback');
    assert.equal(reply.handback.kind, 'lock');
    // The lock's `created` is pinned to '2026-09-26T13:58:02.000Z' and its mtime to a minute
    // before `placeLock` writes it (TZ=UTC, process-seam.js): exact HH:MM and an idle value in
    // 60-69 s, loose enough for the time the call itself takes (review-INT-05 finding 3).
    assert.match(
      reply.handback.question,
      /^A \/commit run started at 13:58 holds the lock, last active 6\d s ago\. It may still be running \(a subagent committing in parallel\); taking it over resets its index mid-commit\. Take it over\?$/,
    );
    assert.deepEqual(reply.handback.answers, [
      { label: 'take over', respawn: `takeOver: ${OTHER_PLAN_ID}\nmode: ${flag}` },
      { label: 'wait' },
    ]);
    assert.deepEqual(reply.handback.ifNoUser, { answer: 'wait', returnToParent: true });
    assert.equal(reply.callerRule, `${parseBaseCallerRule()} ${parseHandbackRule()}`);
    assert.deepEqual(folderNames(c), []);
  });
}

test('plan (no mode flag) refused by a live lock gets a lock handback whose respawn has no mode line', async (t) => {
  const { c, result } = await placeLockAndPlan(t, null);

  assertLockRefusal(result, 'lock');
  const { reply } = result.json;
  assert.equal(reply.status, 'handback');
  assert.deepEqual(reply.handback.answers, [
    { label: 'take over', respawn: `takeOver: ${OTHER_PLAN_ID}` },
    { label: 'wait' },
  ]);
  assert.deepEqual(folderNames(c), []);
});

test('plan --reword refused by a live lock gets a lock handback whose respawn has takeOver only', async (t) => {
  const { c, result } = await placeLockAndPlan(t, 'reword');

  assertLockRefusal(result, 'lock');
  const { reply } = result.json;
  assert.equal(reply.status, 'handback');
  assert.deepEqual(reply.handback.answers, [
    { label: 'take over', respawn: `takeOver: ${OTHER_PLAN_ID}` },
    { label: 'wait' },
  ]);
  assert.deepEqual(folderNames(c), []);
});

// review-INT-05 finding 2: a live lock with a readable `planId` but a `created` that is
// garbage (plan-step7.test.js's sibling case has it missing instead) reads as unreadable, the
// same as `heldMessage`'s own text (`lockHolderClock`, run.mjs) — no `lock` handback, no
// "started at NaN:NaN".
test('plan refused by a live lock with a planId but a garbage created gets no handback', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  placeLock(c, JSON.stringify({ planId: OTHER_PLAN_ID, created: 'garbage' }));

  const result = await runCommit(c, ['plan']);

  assertLockRefusal(result, 'lock');
  assert.equal(result.json.error.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
  const { reply } = result.json;
  assert.equal(reply.status, 'failed');
  assert.equal(reply.handback, null);
  assert.equal(reply.callerRule, parseBaseCallerRule());
  assert.deepEqual(folderNames(c), []);
});
