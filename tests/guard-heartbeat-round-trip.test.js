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

for (const toolName of ['Bash', 'PowerShell']) {
  test(`Seam 2 then Seam 1 (${toolName}): the guard fed the exact plan script call writes the heartbeat, and the following plan reports no guard notice`, async (t) => {
    const c = dirtyCase(t);
    const command = scriptCall.build({ scriptPath: COMMIT_ENTRY, subcommand: 'plan' });

    const guarded = await runGuard(c, { command, toolName });

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
