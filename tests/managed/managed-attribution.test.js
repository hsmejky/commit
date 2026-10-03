'use strict';

// CFG-11 (docs/roadmap/04-config-and-attribution.md): Seam 1 coverage of M5's managed
// settings layer against the real, platform-fixed `managed-settings.json` path (PRE-16),
// through the shipped entry point — commit.cjs always derives this path from
// `process.platform` itself; there is no way to inject a different one (no test-only
// switch). That directory is machine-wide, so this file is deliberately NOT matched by the
// default `tests/*.test.js` glob `npm test` runs (this file lives one directory deeper); CI
// runs it in a separate, final `node --test "tests/managed/*.test.js"` invocation, after
// the main suite, on every job (docs/spec/testing-seams.md Seam 1). On ubuntu-latest and
// macos-latest only, the workflow `sudo mkdir -p`s and `chown`s the managed directory to
// the normal user immediately before that invocation (PRE-16); windows-latest (already
// administrator) and the `ubuntu:22.04` container job (already root) need no such step.
// Every case:
//  - skips, not fakes, outside CI (`CI` unset): it must never write to the real system path
//    on a contributor's own machine.
//  - skips, not fakes, when the host already has its own `managed-settings.json` or
//    `managed-settings.d`: this run cannot tell either apart from one it would write itself,
//    so neither is this suite's to touch, overwrite or (for the drop-in directory) recursively
//    delete.
//  - writes the file itself and removes it in `t.after`, pass or fail.
// The resolver's own precedence, warnings and two-pass logic are pinned at the unit level
// (tests/attribution.test.js) with an injected `managedDir`, never a real path; this file
// only has to prove the shipped entry point actually reaches the real one.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCase, runCommit, managedSettingsPath, hostHasManagedSettings,
  managedDropInDir, hostHasManagedDropIn,
} = require('../helpers/process-seam.js');

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Writes `value` to the real managed-settings.json path and registers its removal, whether
 * or not the test that wrote it passes.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} value
 */
function writeManagedSettings(t, value) {
  const filePath = managedSettingsPath();
  // Registered before any write, so a throw mid-setup (e.g. `mkdirSync` on a read-only host)
  // still cleans up whatever got created (CFG-11 review finding 3).
  t.after(() => {
    fs.rmSync(filePath, { force: true });
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function skipUnlessRunnable(t) {
  if (!process.env.CI) {
    t.skip('the managed-layer Seam 1 case writes the real system managed directory; CI only');
    return true;
  }
  if (hostHasManagedSettings()) {
    t.skip('the host already has its own managed-settings.json; not this suite\'s to touch');
    return true;
  }
  if (hostHasManagedDropIn()) {
    t.skip('the host already has its own managed-settings.d; not this suite\'s to touch');
    return true;
  }
  return false;
}

test('on CI, managed attribution.commit beats project-local, project and user layers, source managed', async (t) => {
  if (skipUnlessRunnable(t)) return;
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  fs.mkdirSync(path.join(c.claudeHome), { recursive: true });
  fs.writeFileSync(path.join(c.claudeHome, 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: User <u@x>' } }));
  c.writeFile(path.join('.claude', 'settings.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: Project <p@x>' } }));
  c.writeFile(path.join('.claude', 'settings.local.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: Local <l@x>' } }));
  writeManagedSettings(t, { attribution: { commit: 'Co-Authored-By: Managed <m@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  const expected = { trailer: 'Co-Authored-By: Managed <m@x>', source: 'managed' };
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution, expected);
  assert.deepEqual(readJson(path.join(folder, 'state.json')).attribution, expected);
});

test('on CI, a managed-settings.d drop-in file beside the real managed-settings.json has no effect', async (t) => {
  if (skipUnlessRunnable(t)) return;
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  const dropInDir = managedDropInDir();
  // Registered before any write (this directory or the managed file below), so a throw
  // mid-setup still cleans up (CFG-11 review finding 3). `skipUnlessRunnable` already
  // guarantees `dropInDir` does not exist yet, so a recursive removal here only ever
  // deletes what this case itself created.
  t.after(() => fs.rmSync(dropInDir, { recursive: true, force: true }));
  writeManagedSettings(t, { attribution: { commit: 'Co-Authored-By: Managed <m@x>' } });
  fs.mkdirSync(dropInDir, { recursive: true });
  fs.writeFileSync(path.join(dropInDir, '10-override.json'),
    JSON.stringify({ attribution: { commit: 'Co-Authored-By: DropIn <d@x>' } }));
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const folder = path.join(runDirOf(c), result.json.planId);
  assert.deepEqual(readJson(path.join(folder, 'plan.json')).attribution,
    { trailer: 'Co-Authored-By: Managed <m@x>', source: 'managed' });
});
