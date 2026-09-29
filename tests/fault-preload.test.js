'use strict';

// FND-10 (docs/roadmap/01-foundation.md): the fault-injection preload
// (tests/helpers/fault-preload.mjs) that Seam 1 cases load with Node's `--import` to inject
// failures a fixture cannot otherwise cause (docs/spec/testing-seams.md, "Fault-injection
// preload at Seam 1"). Driven here through stub entry points in tests/fixtures/fault/, not
// the shipped scripts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createCase, runEntry } = require('./helpers/process-seam.js');

const RUN_OPS = path.join(__dirname, 'fixtures', 'fault', 'run-ops.cjs');
const RUN_NAMED_IMPORTS = path.join(__dirname, 'fixtures', 'fault', 'run-named-imports.cjs');
// `--import` requires a file:// URL on Windows (a bare `C:\...` path is read as a URL scheme).
const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;

// Runs a stub program against `script` under the preload, with the given env, and returns the
// parsed `results` array.
async function runOps(c, script, program, env) {
  const result = await runEntry(c, script, [JSON.stringify(program)], {
    nodeArgs: ['--import', PRELOAD],
    env,
  });
  assert.equal(result.exitCode, 0, `stub failed: ${result.stderr}`);
  return JSON.parse(result.stdout).results;
}

// --- AC1: os.userInfo() fault -----------------------------------------------------------

test('with the userInfo fault unset, os.userInfo() returns normally', async (t) => {
  const c = createCase(t, { repo: false });
  const [result] = await runOps(c, RUN_OPS, [{ op: 'userInfo' }], {});
  assert.equal(result.ok, true);
});

test('with the userInfo fault set, os.userInfo() throws shaped like the real SystemError', async (t) => {
  const c = createCase(t, { repo: false });
  const [result] = await runOps(c, RUN_OPS, [{ op: 'userInfo' }], {
    COMMIT_TEST_FAULT_USERINFO: '1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ERR_SYSTEM_ERROR');
  assert.equal(result.info && result.info.code, 'ENOENT');
});

// --- AC2: a named fs boundary fails only for a target path matching the basename ---------

test('renameSync fails only for a target path matching the configured basename', async (t) => {
  const c = createCase(t, { repo: false });
  const hit = path.join(c.root, 'state.json');
  const miss = path.join(c.root, 'other.json');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: path.join(c.root, 'src-a'), content: 'a' },
      { op: 'write', path: path.join(c.root, 'src-b'), content: 'b' },
      { op: 'renameSync', oldPath: path.join(c.root, 'src-a'), newPath: hit },
      { op: 'renameSync', oldPath: path.join(c.root, 'src-b'), newPath: miss },
    ],
    { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
  );
  const [, , failed, ok] = results;
  assert.equal(failed.ok, false);
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(hit), false, 'the faulted rename must not have happened');
  assert.equal(fs.existsSync(miss), true, 'the non-matching rename must have gone through');
});

test('linkSync fails only for a target path matching the configured basename', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const hit = path.join(c.root, 'run.lock');
  const miss = path.join(c.root, 'other.lock');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'linkSync', existing, newPath: hit },
      { op: 'linkSync', existing, newPath: miss },
    ],
    { COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock' },
  );
  const [, failed, ok] = results;
  assert.equal(failed.ok, false);
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(hit), false);
  assert.equal(fs.existsSync(miss), true);
});

test('the callback forms of link and rename fail for a matching target path too, and leave a non-matching call alone', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const existing2 = path.join(c.root, 'src-miss');
  const linkHit = path.join(c.root, 'run.lock');
  const linkMiss = path.join(c.root, 'other.lock');
  const renameSrc = path.join(c.root, 'src2');
  const renameSrc2 = path.join(c.root, 'src3');
  const renameHit = path.join(c.root, 'state.json');
  const renameMiss = path.join(c.root, 'other-state.json');
  const logFile = path.join(c.root, 'calls.log');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'write', path: existing2, content: 'x2' },
      { op: 'write', path: renameSrc, content: 'y' },
      { op: 'write', path: renameSrc2, content: 'y2' },
      { op: 'link', existing, newPath: linkHit },
      { op: 'link', existing: existing2, newPath: linkMiss },
      { op: 'rename', oldPath: renameSrc, newPath: renameHit },
      { op: 'rename', oldPath: renameSrc2, newPath: renameMiss },
    ],
    {
      COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock',
      COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json',
      COMMIT_TEST_FAULT_LOG: logFile,
    },
  );
  const [, , , , linkResult, linkMissResult, renameResult, renameMissResult] = results;
  assert.equal(linkResult.ok, false);
  assert.equal(linkMissResult.ok, true);
  assert.equal(renameResult.ok, false);
  assert.equal(renameMissResult.ok, true);
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [linkHit, linkMiss, renameHit, renameMiss]);
});

test('the promise forms of link and rename fail for a matching target path too, and leave a non-matching call alone', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const existing2 = path.join(c.root, 'src-miss');
  const linkHit = path.join(c.root, 'run.lock');
  const linkMiss = path.join(c.root, 'other.lock');
  const renameSrc = path.join(c.root, 'src2');
  const renameSrc2 = path.join(c.root, 'src3');
  const renameHit = path.join(c.root, 'state.json');
  const renameMiss = path.join(c.root, 'other-state.json');
  const logFile = path.join(c.root, 'calls.log');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'write', path: existing2, content: 'x2' },
      { op: 'write', path: renameSrc, content: 'y' },
      { op: 'write', path: renameSrc2, content: 'y2' },
      { op: 'linkPromise', existing, newPath: linkHit },
      { op: 'linkPromise', existing: existing2, newPath: linkMiss },
      { op: 'renamePromise', oldPath: renameSrc, newPath: renameHit },
      { op: 'renamePromise', oldPath: renameSrc2, newPath: renameMiss },
    ],
    {
      COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock',
      COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json',
      COMMIT_TEST_FAULT_LOG: logFile,
    },
  );
  const [, , , , linkResult, linkMissResult, renameResult, renameMissResult] = results;
  assert.equal(linkResult.ok, false);
  assert.equal(linkMissResult.ok, true);
  assert.equal(renameResult.ok, false);
  assert.equal(renameMissResult.ok, true);
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [linkHit, linkMiss, renameHit, renameMiss]);
});

// --- a list of `name[=code]` entries lets different targets fail with different codes -----

test('the link and rename basenames accept a comma-separated list of name[=code] entries', async (t) => {
  const c = createCase(t, { repo: false });
  const existingA = path.join(c.root, 'src-a');
  const existingB = path.join(c.root, 'src-b');
  const existingC = path.join(c.root, 'src-c');
  const lockTarget = path.join(c.root, 'run.lock');
  const probeTarget = path.join(c.root, 'probe.tmp');
  const missTarget = path.join(c.root, 'other.tmp');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: existingA, content: 'a' },
      { op: 'write', path: existingB, content: 'b' },
      { op: 'write', path: existingC, content: 'c' },
      { op: 'linkSync', existing: existingA, newPath: lockTarget },
      { op: 'linkSync', existing: existingB, newPath: probeTarget },
      { op: 'linkSync', existing: existingC, newPath: missTarget },
    ],
    { COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock=EPERM,probe.tmp=ENOTSUP' },
  );
  const [, , , lockResult, probeResult, missResult] = results;
  assert.equal(lockResult.ok, false);
  assert.equal(lockResult.code, 'EPERM');
  assert.equal(probeResult.ok, false);
  assert.equal(probeResult.code, 'ENOTSUP');
  assert.equal(missResult.ok, true);
});

test('a name[=code] list entry without a code falls back to the configured default code', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const target = path.join(c.root, 'state.json');
  const results = await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'renameSync', oldPath: existing, newPath: target },
    ],
    {
      COMMIT_TEST_FAULT_RENAME_BASENAME: 'other.json,state.json',
      COMMIT_TEST_FAULT_RENAME_CODE: 'EEXIST',
    },
  );
  const [, renameResult] = results;
  assert.equal(renameResult.ok, false);
  assert.equal(renameResult.code, 'EEXIST');
});

// --- AC3: the errno option controls the injected error's code; default is EIO -------------

test('the injected error code defaults to EIO, and follows the configured code', async (t) => {
  for (const code of [undefined, 'EEXIST', 'EPERM']) {
    const c = createCase(t, { repo: false });
    const src = path.join(c.root, 'src');
    const target = path.join(c.root, 'state.json');
    const results = await runOps(
      c,
      RUN_OPS,
      [
        { op: 'write', path: src, content: 'x' },
        { op: 'renameSync', oldPath: src, newPath: target },
      ],
      {
        COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json',
        ...(code ? { COMMIT_TEST_FAULT_RENAME_CODE: code } : {}),
      },
    );
    const [, renameResult] = results;
    assert.equal(renameResult.ok, false);
    assert.equal(renameResult.code, code || 'EIO');
  }
});

// --- AC4: a named ESM import sees the fault exactly as a property access does -------------

test('a stub using named ESM imports (import { renameSync } from node:fs) sees the fault too', async (t) => {
  const c = createCase(t, { repo: false });
  const src = path.join(c.root, 'src');
  const target = path.join(c.root, 'state.json');
  const results = await runOps(
    c,
    RUN_NAMED_IMPORTS,
    [
      { op: 'write', path: src, content: 'x' },
      { op: 'renameSync', oldPath: src, newPath: target },
    ],
    { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
  );
  const [, renameResult] = results;
  assert.equal(renameResult.ok, false);
  assert.equal(renameResult.code, 'EIO');
  assert.equal(fs.existsSync(target), false);
});

test('a stub using named ESM imports (import { linkSync } from node:fs) sees the fault too', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const target = path.join(c.root, 'run.lock');
  const results = await runOps(
    c,
    RUN_NAMED_IMPORTS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'linkSync', existing, newPath: target },
    ],
    { COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock' },
  );
  const [, linkResult] = results;
  assert.equal(linkResult.ok, false);
  assert.equal(linkResult.code, 'EIO');
  assert.equal(fs.existsSync(target), false);
});

test('a stub using named ESM imports (import { link, rename } from node:fs/promises) sees the fault too', async (t) => {
  const c = createCase(t, { repo: false });
  const existing = path.join(c.root, 'src');
  const linkTarget = path.join(c.root, 'run.lock');
  const renameSrc = path.join(c.root, 'src2');
  const renameTarget = path.join(c.root, 'state.json');
  const results = await runOps(
    c,
    RUN_NAMED_IMPORTS,
    [
      { op: 'write', path: existing, content: 'x' },
      { op: 'write', path: renameSrc, content: 'y' },
      { op: 'linkPromise', existing, newPath: linkTarget },
      { op: 'renamePromise', oldPath: renameSrc, newPath: renameTarget },
    ],
    { COMMIT_TEST_FAULT_LINK_BASENAME: 'run.lock', COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
  );
  const [, , linkResult, renameResult] = results;
  assert.equal(linkResult.ok, false);
  assert.equal(fs.existsSync(linkTarget), false);
  assert.equal(renameResult.ok, false);
  assert.equal(fs.existsSync(renameTarget), false);
});

test('a stub using named ESM imports (import { userInfo } from node:os) sees the fault too', async (t) => {
  const c = createCase(t, { repo: false });
  const [result] = await runOps(c, RUN_NAMED_IMPORTS, [{ op: 'userInfo' }], {
    COMMIT_TEST_FAULT_USERINFO: '1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ERR_SYSTEM_ERROR');
  assert.equal(result.info && result.info.code, 'ENOENT');
});

// --- AC5: call-order logging ---------------------------------------------------------------

test('with call-order logging on, each intercepted call appends its target path in order', async (t) => {
  const c = createCase(t, { repo: false });
  const logFile = path.join(c.root, 'calls.log');
  const srcA = path.join(c.root, 'src-a');
  const srcB = path.join(c.root, 'src-b');
  const linkTarget = path.join(c.root, 'run.lock');
  const renameTarget = path.join(c.root, 'state.json');
  await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: srcA, content: 'a' },
      { op: 'write', path: srcB, content: 'b' },
      { op: 'linkSync', existing: srcA, newPath: linkTarget },
      { op: 'renameSync', oldPath: srcB, newPath: renameTarget },
    ],
    { COMMIT_TEST_FAULT_LOG: logFile },
  );
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [linkTarget, renameTarget]);
});

test('with call-order logging off, no log file is written', async (t) => {
  const c = createCase(t, { repo: false });
  const logFile = path.join(c.root, 'calls.log');
  const src = path.join(c.root, 'src');
  await runOps(
    c,
    RUN_OPS,
    [
      { op: 'write', path: src, content: 'x' },
      { op: 'linkSync', existing: src, newPath: path.join(c.root, 'run.lock') },
    ],
    {},
  );
  assert.equal(fs.existsSync(logFile), false);
});

// --- AC6: the preload lives only in the test tree -------------------------------------------

test('the packaged plugin directory contains no reference to the fault preload', () => {
  const pluginDir = path.join(__dirname, '..', 'plugin');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, 'utf8').includes('fault-preload')) offenders.push(full);
    }
  })(pluginDir);
  assert.deepEqual(offenders, []);
});
