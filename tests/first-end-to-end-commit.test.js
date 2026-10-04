'use strict';

// INT-02 (docs/roadmap/12-integration.md, Further Notes "First slice"): the thinnest
// end-to-end path, the script called directly with no worker. `plan --split` on two modified
// tracked files, a one-group file-level worker plan written by the test, then `check --plan`,
// which validates the plan and, with no confirmation logic yet (RUN-18), commits it in the
// same process as `commit --all` (C:check `confirm: null`): its output is `commit --all`'s
// with `groups`, `notIncluded` and `notices` merged in, plus the `committed` reply
// (C:reply-and-handback). The message is committed as planned, without a trailer (MSG-07).
// Seam 1 only.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, COMMIT_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADER = 'feat: change both files';

let BASE_CALLER_RULE;
let scriptCall;
let workflows;
let lockKeptNotice;
beforeEach(async () => {
  ({ BASE_CALLER_RULE } = await loadLib('reply'));
  scriptCall = await loadLib('script-call');
  workflows = await loadLib('workflows');
  ({ lockKeptNotice } = await loadLib('run'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with two committed files, both modified (no hooks, signing or filtered files).
function twoModifiedFiles(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\nlines\n');
  return c;
}

// `git diff --numstat -z HEAD`, the parser oracle: `added\tdeleted\tpath\0` per file (no
// rename in this fixture), keyed by path.
function numstat(c) {
  const result = spawnSync('git', ['diff', '--numstat', '-z', 'HEAD'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  const counts = {};
  for (const record of result.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const [added, deleted, file] = record.split('\t');
    counts[file] = { added: Number(added), deleted: Number(deleted) };
  }
  return counts;
}

function writeWorkerPlan(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: groups.map(({ header, files }) => ({ header, body: null, files, hunks: [], reason: 'test' })),
    notIncluded: [],
  }));
}

function lockPath(c) {
  return path.join(c.repoDir, '.commit-plan', 'lock');
}

// The commit message of `rev`, read raw from the commit object (everything after the first
// blank line), so a trailer or a rewritten header would show.
function rawMessage(c, rev) {
  const object = c.git(['cat-file', 'commit', rev]);
  return object.slice(object.indexOf('\n\n') + 2);
}

test('plan --split on two modified tracked files: planId, two whole-file units, the run folder and the lock; the index untouched', async (t) => {
  const c = twoModifiedFiles(t);
  const indexFile = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexFile);

  const planned = await runCommit(c, ['plan', '--split']);

  assert.equal(planned.exitCode, 0, detail(planned));
  assert.equal(planned.json.version, 1);
  assert.equal(planned.json.ok, true);
  assert.match(planned.json.planId, UUID_V4);
  const units = planned.json.hunks.hunks;
  assert.deepEqual(units.map(({ id, path: file, status, body }) => ({ id, path: file, status, body })), [
    { id: 'h1', path: 'a.txt', status: 'M', body: 'file' },
    { id: 'h2', path: 'b.txt', status: 'M', body: 'file' },
  ]);

  // C:run-folder: absolute, `path.resolve`d from the toplevel, forward slashes on Windows too.
  const { runDir } = planned.json;
  const toplevel = c.git(['rev-parse', '--show-toplevel']).trim();
  assert.equal(path.isAbsolute(runDir), true);
  assert.equal(runDir.includes('\\'), false, runDir);
  assert.equal(runDir, path.resolve(toplevel, '.commit-plan', planned.json.planId).split(path.sep).join('/'));
  assert.deepEqual(fs.readdirSync(runDir).filter((name) => ['state.json', 'plan.json', 'hunks.txt'].includes(name)).sort(),
    ['hunks.txt', 'plan.json', 'state.json']);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(c), 'utf8')).planId, planned.json.planId);

  // Parser oracle: per-file added and removed counts equal `git diff --numstat -z`.
  const planJson = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
  const counts = Object.fromEntries(planJson.tracked.map(({ path: file, added, deleted }) => [file, { added, deleted }]));
  assert.deepEqual(counts, numstat(c));
  assert.deepEqual(counts, { 'a.txt': { added: 1, deleted: 0 }, 'b.txt': { added: 2, deleted: 0 } });

  // Story 70: the real index is byte-identical before and after `plan`.
  assert.deepEqual(fs.readFileSync(indexFile), indexBefore);
});

test('check --plan with a one-group plan commits it in the same process: the planned header byte for byte, both files, a committed reply, the run gone', async (t) => {
  const c = twoModifiedFiles(t);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: HEADER, files: ['a.txt', 'b.txt'] }]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const shas = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'HEAD gains exactly one commit');
  const [sha] = shas;
  assert.equal(rawMessage(c, sha), `${HEADER}\n`, 'the planned header byte for byte, no trailer');
  assert.equal(c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]), 'a.txt\nb.txt\n');

  // C:check: `commit --all`'s output with `groups`, `notIncluded` and `notices` merged in.
  const { json } = checked;
  assert.equal(json.ok, true);
  assert.equal(json.groups.length, 1);
  assert.equal(json.groups[0].header, HEADER);
  assert.deepEqual(json.groups[0].files.map((file) => file.path), ['a.txt', 'b.txt']);
  assert.deepEqual(json.notIncluded, []);
  assert.deepEqual(json.notices, []);
  assert.deepEqual(json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(json.failed, null);
  assert.deepEqual(json.remaining, []);
  assert.equal(json.error, null);
  assert.equal(json.gitOutput, null);
  assert.deepEqual(json.unstaged, []);
  assert.equal(json.handback, undefined, 'no interim top-level handback');

  // C:reply-and-handback: no confirmation step, a `committed` reply.
  assert.deepEqual(json.reply, {
    version: 1,
    status: 'committed',
    planId: null,
    text: `${sha} ${HEADER}\nworking tree clean`,
    commits: [{ n: 1, sha, header: HEADER }],
    notices: [],
    callerRule: BASE_CALLER_RULE,
    handback: null,
  });

  // Story 194: the lock and the run folder are gone after the commit.
  assert.equal(fs.existsSync(lockPath(c)), false, 'the lock is gone');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
});

// The clock steps to `elapsedMs` once this call's first `git commit` has landed (as in
// tests/commit-all.test.js `scheduleAfterNextCommit`), so group 1 commits and group 2 meets
// EXE-16's budget stop.
function runCheckWithBudgetStopAfterGroupOne(c, planId, elapsedMs) {
  const reflog = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim();
  const atLeast = (reflog === '' ? 0 : reflog.split('\n').length) + 1;
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast }, elapsedMs },
  ]));
  return runCommit(c, ['check', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });
}

test('a budget stop after group 1 under check: the continue handback moves into reply.handback, the run kept', async (t) => {
  const c = twoModifiedFiles(t);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [
    { header: 'feat: change a', files: ['a.txt'] },
    { header: 'feat: change b', files: ['b.txt'] },
  ]);

  const checked = await runCheckWithBudgetStopAfterGroupOne(c, planId, 61_000);

  assert.equal(checked.exitCode, 0, detail(checked));
  const shas = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 is committed');
  const { json } = checked;
  assert.deepEqual(json.commits, [{ n: 1, sha: shas[0], header: 'feat: change a' }]);
  assert.deepEqual(json.remaining, [2]);
  assert.equal(json.failed, null);
  assert.equal(json.handback, undefined, 'the interim top-level handback is gone');
  assert.equal(json.groups.length, 2);
  assert.deepEqual(json.notIncluded, []);
  assert.deepEqual(json.notices, []);

  assert.equal(json.reply.status, 'handback');
  assert.equal(json.reply.planId, planId);
  assert.deepEqual(json.reply.commits, json.commits);
  assert.deepEqual(json.reply.notices, []);
  assert.equal(json.reply.callerRule, BASE_CALLER_RULE);
  assert.deepEqual(json.reply.handback, {
    kind: 'continue',
    question: null,
    answers: [{
      label: 'continue',
      run: scriptCall.build({ scriptPath: COMMIT_ENTRY, subcommand: 'commit', args: ['--plan', planId, '--all'] }),
      timeoutMs: 600_000,
    }],
    ifNoUser: { answer: 'continue' },
  });
  assert.equal(json.reply.text.split('\n')[0], `${shas[0]} feat: change a`);
  assert.equal(fs.existsSync(runDir), true, 'the run is kept for the continue call');
  assert.equal(fs.existsSync(lockPath(c)), true, 'the lock is kept');
});

// review-INT-02 Medium-1: a clock whose value depends on who is asking. Every direct
// `now()` read from workflows.mjs (the pre-step `pastDeadline` checks in both CHECK_STEPS and
// the separate `commitCheckedGroups` call, plus M15 `nextStep`'s own read in
// commit-executor.mjs) sees a value comfortably under `ctx.deadline`, so the call never ends
// `timed-out` on that account. Only a `now()` read from inside process-adapter.mjs itself
// (M2's own `callBudget`, which reads `scope.now()` to size an M2 call's timeout while a
// GIT-07 deadline scope is active) sees `deadlineAt`, exactly `ctx.deadline`: were
// `commitCheckedGroups` still one of `CHECK_STEPS` (the pre-fix shape), that reading would
// spend the shared scope's budget on the group's own `git commit` call, set `scope.expired`,
// and `runStepsWithin` would then discard whatever `commitAll` returned for a bare
// `{ refusal: 'timed-out' }` with no `commits`. The fix runs `commitCheckedGroups` through a
// second, unscoped `runSteps` call, so no GIT-07 scope is active once it runs: M2's
// `callBudget` finds no scope to read `now()` from at all (`deadlineScope.getStore()` is
// `undefined`), the call-stack-keyed reading never gates anything, and the single group
// commits for real.
// review-INT-02 N8: `counter` is incremented every time the stack match fires, so the test
// can assert the clock actually exercised the `process-adapter.mjs` branch at least once —
// without it, a frame-depth or module-rename change that silently stops the match from ever
// firing would still pass the test under the pre-fix shape too.
function clockAtDeadlineInsideM2(callStarted, deadlineAt, counter) {
  return () => {
    const caller = new Error().stack.split('\n')[2] ?? '';
    if (!caller.includes('process-adapter.mjs')) return callStarted;
    counter.hits += 1;
    return deadlineAt;
  };
}

test('review-INT-02 Medium-1: check commits a one-group plan even though a deadline-scoped M2 call would have spent the GIT-07 scope', async (t) => {
  const c = twoModifiedFiles(t);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: HEADER, files: ['a.txt', 'b.txt'] }]);

  const callStarted = Date.UTC(2026, 0, 1);
  const deadlineAt = callStarted + 540_000; // M15 DEADLINE_MS, matches run-policy.deadline().
  const counter = { hits: 0 };
  const injected = {
    env: c.env,
    now: clockAtDeadlineInsideM2(callStarted, deadlineAt, counter),
    claudeHome: c.claudeHome,
    cwd: c.repoDir,
    callStarted,
    osUser: null,
    scriptPath: 'commit.cjs',
  };

  const result = await workflows.check({ plan: planId }, injected, { cwd: c.repoDir });

  assert.equal(result.failure, undefined, JSON.stringify(result));
  const shas = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'the one group is committed, not lost to a bare timeout');
  const [sha] = shas;
  assert.deepEqual(result.output.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(result.output.reply.status, 'committed');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
  assert.equal(fs.existsSync(lockPath(c)), false, 'the lock is gone');
  assert.equal(counter.hits > 0, true, 'the clock actually exercised the M2 call-stack branch');
});

// review-INT-02 Low-3 (C:reply-and-handback: `planId` is `null` "when no run folder is
// kept"): `releaseOpen`'s `busy` outcome (the lock rename hit a file-in-use error) keeps the
// folder and reports `kept: true`; `committedOutput` must then keep `reply.planId` instead of
// nulling it. Forced by patching `fs.renameSync` to throw `EBUSY` for the lock's own rename
// target, standing in for a locked-file rename failure (the real failure is OS/timing-
// dependent, Seam 1 cannot force it directly).
test('review-INT-02 Low-3: a committed reply keeps planId when release could not remove the lock', async (t) => {
  const c = twoModifiedFiles(t);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: HEADER, files: ['a.txt', 'b.txt'] }]);

  const callStarted = Date.UTC(2026, 0, 1);
  const injected = {
    env: c.env,
    now: () => callStarted,
    claudeHome: c.claudeHome,
    cwd: c.repoDir,
    callStarted,
    osUser: null,
    scriptPath: 'commit.cjs',
  };
  const lockFile = lockPath(c);
  const original = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (src === lockFile) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return original(src, dest);
  };
  let result;
  try {
    result = await workflows.check({ plan: planId }, injected, { cwd: c.repoDir });
  } finally {
    fs.renameSync = original;
  }

  assert.equal(result.failure, undefined, JSON.stringify(result));
  assert.equal(result.output.reply.status, 'committed');
  assert.equal(result.output.reply.planId, planId, 'planId is kept, not nulled, since the run folder is still held');
  assert.equal(fs.existsSync(runDir), true, 'the run folder is still kept (release could not remove the lock)');
  assert.equal(fs.existsSync(lockFile), true, 'the lock itself is still kept too');
  assert.equal(result.output.notices.includes(lockKeptNotice(planId)), true,
    'the busy release notice reaches reply.notices');
});
