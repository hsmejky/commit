'use strict';

// INT-27 (docs/roadmap/12-integration.md, Q23 docs/decisions/q23-guard-heartbeat.md): the
// guard, fed the worker's `plan` script call, writes the heartbeat, and the next `plan` in
// that repo reports the guard active; without a heartbeat under 15 minutes, the `committed`
// reply at the end of the INT-02 first-slice path carries the "guard did not run" notice.
// `env.guard`'s own active/not-seen branching (`guardState`/`samePathTree`) is GRD-17's,
// not repeated here.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, runGuard, COMMIT_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const GUARD_NOTICE = 'Guard hook did not run: `node` missing from the hook\'s PATH, plugin hooks '
  + 'disabled, or `disableAllHooks` set. Direct `git commit` is not blocked.';
const HEADER = 'feat: change a file';

let scriptCall;
beforeEach(async () => {
  scriptCall = await loadLib('script-call');
});

function dirtyCase(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  return c;
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function writeWorkerPlan(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: groups.map(({ header, files }) => ({ header, body: null, files, hunks: [], reason: 'test' })),
    notIncluded: [],
  }));
}

// review-INT-27-r2 Medium-1: a repo config layer's unknown key (CFG-06, workflows.mjs
// loadConfigLayers) is a notice `plan` stores that is not the guard notice, so it pins the
// fix at workflows.mjs:1074 (`[...storedNotices, ...validated.notices]`) against a
// regression to the old guard-only filter, which every other `check` test here cannot catch
// since each has only the guard notice stored.
function writeRepoConfig(c, value) {
  c.writeFile('.claude/commit.json', JSON.stringify(value));
}

// review-INT-27-r2 Low-3: a `ghp_` token built at run time (tests/plan-placement-bans-seam1
// .test.js), used below for a scan-hit notice that is `check`'s own (M14 `validatePlan`),
// to pin its order after plan's stored notices (the guard notice here).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

for (const toolName of ['Bash', 'PowerShell']) {
  test(`Seam 2 then Seam 1 (${toolName}): the guard fed the exact plan script call writes the heartbeat, and the following plan reports no guard notice`, async (t) => {
    const c = dirtyCase(t);
    const command = scriptCall.build({ scriptPath: COMMIT_ENTRY, subcommand: 'plan' });

    const guarded = await runGuard(c, { command, toolName, agentType: 'commit:commit-worker' });

    assert.equal(guarded.exitCode, 0, detail(guarded));
    assert.notEqual(guarded.heartbeat, null, 'the heartbeat file was written');
    assert.equal(guarded.heartbeat.command, 'commit.cjs plan');

    const planned = await runCommit(c, ['plan']);

    assert.equal(planned.exitCode, 0, detail(planned));
    const folder = path.join(c.repoDir, '.commit-plan', planned.json.planId);
    const state = JSON.parse(fs.readFileSync(path.join(folder, 'state.json'), 'utf8'));
    const planJson = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8'));
    assert.equal(planJson.env.guard, 'active');
    assert.deepEqual(state.notices, []);
  });
}

test('Seam 1: the INT-02 first-slice run with no heartbeat in the Claude home ends with the guard notice in the committed reply', async (t) => {
  const c = dirtyCase(t);

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: HEADER, files: ['a.txt'] }]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed');
  assert.deepEqual(checked.json.notices, [GUARD_NOTICE]);
  assert.deepEqual(checked.json.reply.notices, [GUARD_NOTICE]);
});

test('Seam 1: no heartbeat plus an unknown config key carries every stored notice, guard first', async (t) => {
  const c = createCase(t);
  // The repo config is committed with the seed (not left dirty), so it is not itself a
  // candidate unit `plan --split` must place.
  writeRepoConfig(c, { workerModel: 'haiku' });
  c.git(['add', '--', '.claude/commit.json']);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: HEADER, files: ['a.txt'] }]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const configWarning = "the repo config (.claude/commit.json) key 'workerModel' is unknown; ignored";
  assert.deepEqual(checked.json.notices, [GUARD_NOTICE, configWarning]);
  assert.deepEqual(checked.json.reply.notices, [GUARD_NOTICE, configWarning]);
});

test('Seam 1: no heartbeat, the guard notice stored by plan precedes a left-out scan hit, check’s own notice', async (t) => {
  const c = createCase(t);
  c.writeFile('src/b.js', 'one\ntwo\n');
  c.git(['add', '--', 'src/b.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('src/b.js', `one\ntwo\nconst token = "${githubToken('f')}";\n`);

  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [],
    notIncluded: [{ path: 'src/b.js', hunks: null, reason: 'scan: github-token' }],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  // Zero groups: nothing to commit, so (as in plan-placement-bans-seam1.test.js) only
  // `notices` is asserted; `reply` is a different shape with no groups to report on.
  assert.deepEqual(checked.json.notices, [GUARD_NOTICE, 'src/b.js:3 github-token left out']);
});
