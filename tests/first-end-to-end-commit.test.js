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
beforeEach(async () => {
  ({ BASE_CALLER_RULE } = await loadLib('reply'));
  scriptCall = await loadLib('script-call');
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
