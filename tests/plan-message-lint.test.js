'use strict';

// PLN-06 (docs/roadmap/08-plan-validation.md): each group's message runs through M6 `lint`
// against the stored config values and M8 `scanText`; errors carry the group number, and a
// scan error carries the `scanText` spans (never the matched value) for M17's future
// redaction. Built on PLN-01's file-level tracer. Until CFG-05 wires `plan`'s real layered
// config into `state.json`, `validatePlan` falls back to the Q6 defaults (see
// plan-validator.mjs's DEFAULT_MESSAGE_VALUES): 11 standard types, scope/body forbidden,
// maxSubjectLength 72, subjectCase lower.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with one committed, then modified, file and a `plan` run holding the lock.
async function plannedRun(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function writeWorkerPlan(runDir, header, body) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header, body, files: ['a.txt'], hunks: [] }],
    notIncluded: [],
  }));
}

test('a header that is not type(scope)!: description fails lint with group 1, no type check', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'Feat: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "header is not 'type(scope)!: description'" },
  ]);
});

test('a type not in the default types fails lint with group 1', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'wip: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "type 'wip' not in types" },
  ]);
});

test('a scan hit in the message fails with message contains `local-path`, never the matched text', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  // Built at run time so this file holds no literal hit (SCN-05 convention); a footer line
  // (allowed token `Refs`) keeps `body: forbidden` (the Q6 default) from also firing, so
  // this is the only lint error.
  const homePath = '/ho' + 'me/jdoe-fixture/app';
  writeWorkerPlan(runDir, 'feat: x', `Refs: see ${homePath}`);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.errors.length, 1);
  assert.equal(checked.json.errors[0].group, 1);
  assert.equal(checked.json.errors[0].reason, 'message contains `local-path`');
  assert.equal(checked.stdout.includes(homePath), false, detail(checked));
  assert.equal(checked.stdout.includes('jdoe-fixture'), false, detail(checked));
});

test('a footer with a disallowed token fails lint', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'feat: x', 'Note: see #12');

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.errors.length, 1);
  assert.equal(checked.json.errors[0].group, 1);
  assert.match(
    checked.json.errors[0].reason,
    /^`Note` is not an allowed footer token\. If this is body text, rephrase it or add a non-footer line to the paragraph\.$/,
  );
});

test('an allowed footer token passes lint', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'feat: x', 'Closes #12');

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
});

// Static: validatePlan threads `osUser` straight through to M8 `scanText` (EXE-01 item 1).
test('validatePlan passes osUser through to scanText', async () => {
  const { validatePlan } = await loadLib('plan-validator');
  const units = [{ id: 'h1', path: 'a.txt', status: 'M' }];
  const bytes = Buffer.from(JSON.stringify({
    groups: [{ header: 'feat: x', body: 'Refs: /srv/jdoe-fixture/x', files: ['a.txt'] }],
  }));

  const withOsUser = validatePlan(bytes, { mode: 'split', units }, { osUser: 'jdoe-fixture' });
  assert.equal(withOsUser.ok, false);
  assert.equal(withOsUser.errors[0].reason, 'message contains `local-path`');

  const withoutOsUser = validatePlan(bytes, { mode: 'split', units }, {});
  assert.equal(withoutOsUser.ok, true);
});

// FND-10 Seam 1: os.userInfo() throws, so commit.cjs falls back to USER/USERNAME; `osUser`
// reaches M14 unchanged and `state.json` never stores it (EXE-01 item 1).
test('FND-10: os.userInfo() throwing falls back to USER/USERNAME for the message scan', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'feat: x', 'Refs: /srv/jdoe1/x');

  const checked = await runCommit(c, ['check', '--plan', planId], {
    nodeArgs: ['--import', PRELOAD],
    env: { COMMIT_TEST_FAULT_USERINFO: '1', USER: 'jdoe1', USERNAME: 'jdoe1' },
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.errors[0].reason, 'message contains `local-path`');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(JSON.stringify(state).includes('jdoe1'), false);
});
