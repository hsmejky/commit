'use strict';

// RUN-08 (docs/roadmap/09-runs.md): `plan` step 7 ends with M12 `sweep` (Q22, C:run-folder,
// story 195). It deletes `<planId>/` folders older than 24 hours that the lock does not name,
// and aged lock temporary files; it considers only entries named in the minted form and never
// follows a link. Seam 1: the shipped entry point as a subprocess through the FND-04 harness.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const HOUR_MS = 60 * 60 * 1000;
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const RECENT_ID = '22222222-2222-4222-8222-222222222222';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const TEMP_ID = '44444444-4444-4444-8444-444444444444';
const LETTERS_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

// A seeded repo with one modified tracked file, so `plan` reaches step 7 and takes the lock.
function dirtyCase(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  return c;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function assertPlanned(result) {
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  return result.json.planId;
}

// Sets an entry's mtime `hours` before now; `lutimesSync` so a link's own time changes, never
// its target's.
function age(file, hours, { link = false } = {}) {
  const when = new Date(Date.now() - hours * HOUR_MS);
  (link ? fs.lutimesSync : fs.utimesSync)(file, when, when);
}

// A run folder with a file in it, aged after the write (a write inside refreshes its mtime).
function runFolder(c, planId, hours) {
  const folder = path.join(runDirOf(c), planId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'state.json'), '{}\n');
  age(folder, hours);
  return folder;
}

test('plan sweeps a 25-hour-old run folder and keeps a 1-hour-old one and its own', async (t) => {
  const c = dirtyCase(t);
  const old = runFolder(c, OLD_ID, 25);
  const recent = runFolder(c, RECENT_ID, 1);

  const planId = assertPlanned(await runCommit(c, ['plan']));

  assert.equal(fs.existsSync(old), false, 'the 25-hour-old folder is swept');
  assert.equal(fs.existsSync(path.join(recent, 'state.json')), true, 'the 1-hour-old folder is kept');
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId, 'plan.json')), true, 'the run\'s own folder is kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8')).planId, planId);
});

test('plan keeps the folder the lock names, whatever its age', async (t) => {
  const c = dirtyCase(t);
  // From the moment `plan.json` exists (after the lock and step 7's re-reads, right before
  // the sweep), the call's clock reads 25 hours on: its own folder, named by the lock, is then
  // past the cutoff by that clock.
  // The event is the run's own `<planId>/plan.json`, whose `planId` is not known in advance.
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'childPath', dir: runDirOf(c), name: 'plan.json' }, elapsedMs: 25 * HOUR_MS },
  ]));
  // A folder 30 minutes old by the real clock, so 25.5 hours old by the shifted one: swept,
  // which shows the sweep read the shifted clock.
  const old = runFolder(c, OLD_ID, 0.5);

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  const planId = assertPlanned(result);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId, 'plan.json')), true, 'the locked folder is kept');
});

test('plan leaves an aged entry not in the minted form and an aged link untouched', async (t) => {
  const c = dirtyCase(t);
  const runDir = runDirOf(c);
  fs.mkdirSync(runDir);
  const notMinted = [
    'not-a-plan-id',
    LETTERS_ID.toUpperCase(),
    `${OLD_ID}.bak`,
    '11111111-1111-1111-8111-111111111111', // version nibble 1, not a v4 UUID
  ];
  for (const name of notMinted) runFolder(c, name, 25);
  // Leftover-looking files whose names are not the minted lock temporary form.
  for (const name of ['lock-x.tmp', `lock-${LETTERS_ID.toUpperCase()}.tmp`, `${OLD_ID}.tmp`]) {
    fs.writeFileSync(path.join(runDir, name), 'x');
    age(path.join(runDir, name), 25);
  }
  // A minted-form link to a folder outside `.commit-plan/`, link and target both aged.
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
  age(target, 25);
  const link = path.join(runDir, LINK_ID);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  age(link, 25, { link: true });

  assertPlanned(await runCommit(c, ['plan']));

  for (const name of notMinted) {
    assert.equal(fs.existsSync(path.join(runDir, name, 'state.json')), true, `${name} is kept`);
  }
  for (const name of ['lock-x.tmp', `lock-${LETTERS_ID.toUpperCase()}.tmp`, `${OLD_ID}.tmp`]) {
    assert.equal(fs.readFileSync(path.join(runDir, name), 'utf8'), 'x', `${name} is kept`);
  }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is kept');
  assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n', 'the link\'s target is intact');
});

test('plan removes an aged lock temporary file and keeps a fresh one', async (t) => {
  const c = dirtyCase(t);
  const runDir = runDirOf(c);
  fs.mkdirSync(runDir);
  const aged = path.join(runDir, `lock-${TEMP_ID}.tmp`);
  fs.writeFileSync(aged, JSON.stringify({ planId: TEMP_ID, created: new Date().toISOString() }));
  age(aged, 25);
  const fresh = path.join(runDir, `lock-${RECENT_ID}.tmp`);
  fs.writeFileSync(fresh, JSON.stringify({ planId: RECENT_ID, created: new Date().toISOString() }));
  age(fresh, 1);

  assertPlanned(await runCommit(c, ['plan']));

  assert.equal(fs.existsSync(aged), false, 'the aged lock temporary file is removed');
  assert.equal(fs.existsSync(fresh), true, 'a fresh one may be another plan\'s, mid-acquire');
});
