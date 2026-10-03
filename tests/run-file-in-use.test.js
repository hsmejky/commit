'use strict';

// RUN-09 (docs/roadmap/09-runs.md, Q22, C:run-folder "lock" row and "Versioned"): Windows
// file-in-use errors map to `busy`, at Seam 1 (docs/spec/testing-seams.md). The cross-OS cases
// inject the errno through the FND-10 fault preload, whose faults persist for the whole call:
// the lock link failing `EPERM`/`EBUSY` on every try is retried about a second (six attempts,
// a real ~1 s of sleep per case), then the hard-link probe decides; `ENOTSUP`/`ENOSYS` refuse
// `run-folder` at once; a `state.json` rename failing `EPERM` on every try is retried the same
// way before it counts as a failure. The Windows-only case holds the real lock open with
// `FileShare.None` from a PowerShell child. A fault that clears partway through the retries
// is M12's in-process case (tests/run.test.js); KD-R23 records why no Seam 1 case has one.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
// The `busy` file-in-use text (run.mjs `BUSY_FILE_IN_USE_MESSAGE`): on Windows the same text as
// a live `call.lock`, elsewhere its own permission-or-in-use text.
const BUSY_TEXT = process.platform === 'win32'
  ? 'another /commit call on this run is still running; try again once it has finished'
  : "the run's lock could not be read or replaced (permission denied or in use); try again";
const RUN_FOLDER_TEXT = "the run folder's filesystem does not support hard links";

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

// Two modified tracked files, so `plan` reaches step 7 (`state.json`, the lock link).
function modifiedRepo(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'changed\n');
  return c;
}

// `plan` under the fault preload, with its call-order log: every intercepted link/rename
// target, as a path relative to the run-folder directory with the run's `planId` replaced by
// `<planId>`, so a case can assert the exact sequence of attempts.
async function planWithFault(t, faultEnv) {
  const c = modifiedRepo(t);
  const log = path.join(c.root, 'fs-calls.log');
  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_LOG: log, ...faultEnv },
  });
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const calls = lines.map((line) => path.relative(runDirOf(c), line).split(path.sep).join('/')
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\//, '<planId>/'));
  return { c, result, calls };
}

function assertRefused(c, result, kind, message) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, kind, detail(result));
  assert.equal(result.json.error.message, message, detail(result));
  assert.deepEqual(fs.readdirSync(runDirOf(c)), [], 'no lock, no lock temporary file and no run folder left');
}

const SIX_LOCK_LINKS = Array(6).fill('lock');
const PROBE_LINK = '<planId>/hardlink-probe.link';

for (const code of ['EPERM', 'EBUSY']) {
  test(`plan: the lock link failing ${code} on every try → retried, the probe succeeds → exit 6 lock (busy)`, async (t) => {
    const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_LINK_BASENAME: `lock=${code}` });

    assertRefused(c, result, 'lock', BUSY_TEXT);
    assert.deepEqual(calls, ['<planId>/state.json', ...SIX_LOCK_LINKS, PROBE_LINK]);
  });
}

test('plan: the lock link failing EPERM on every try and the probe link failing ENOTSUP → exit 6 state (run-folder)', async (t) => {
  const { c, result, calls } = await planWithFault(t, {
    COMMIT_TEST_FAULT_LINK_BASENAME: 'lock=EPERM,hardlink-probe.link=ENOTSUP',
  });

  assertRefused(c, result, 'state', RUN_FOLDER_TEXT);
  assert.deepEqual(calls, ['<planId>/state.json', ...SIX_LOCK_LINKS, PROBE_LINK]);
});

for (const code of ['ENOTSUP', 'ENOSYS']) {
  test(`plan: the lock link failing ${code} → exit 6 state (run-folder) at once, one attempt and no probe`, async (t) => {
    const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_LINK_BASENAME: `lock=${code}` });

    assertRefused(c, result, 'state', RUN_FOLDER_TEXT);
    assert.deepEqual(calls, ['<planId>/state.json', 'lock']);
  });
}

test('plan: a state.json rename failing EPERM on every try → retried six times, then internal, nothing left', async (t) => {
  const { c, result, calls } = await planWithFault(t, { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json=EPERM' });

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  assert.deepEqual(fs.readdirSync(runDirOf(c)), [], 'no lock and no run folder left');
  assert.deepEqual(calls, Array(6).fill('<planId>/state.json'), 'six attempts, and no lock link');
});

// The holder: a PowerShell child opens `HOLD_PATH` with `FileShare.None`, prints `ready`, and
// keeps the handle until the test writes the marker file `RELEASE_PATH` (or 60 s pass, so a
// crashed test never leaves it running), then closes it and exits.
const HOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$file = [System.IO.File]::Open($env:HOLD_PATH, 'Open', 'ReadWrite', 'None')",
  "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
  '$deadline = (Get-Date).AddSeconds(60)',
  'while (-not (Test-Path -LiteralPath $env:RELEASE_PATH) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }',
  '$file.Close()',
].join('; ');

async function holdExclusively(t, file, releasePath) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOLDER_SCRIPT], {
    env: { ...process.env, HOLD_PATH: file, RELEASE_PATH: releasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = '';
  while (!stdout.includes('ready')) {
    const raced = await Promise.race([once(child.stdout, 'data'), exited.then(() => null)]);
    if (raced === null) throw new Error(`holder exited before ready: ${stderr}`);
    stdout += raced[0];
  }
  return async () => {
    fs.writeFileSync(releasePath, '');
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, `holder failed: ${stderr}`);
  };
}

test('commit --plan X --all while another process holds the lock with FileShare.None → exit 6 lock (busy), the run kept', {
  skip: process.platform !== 'win32' && 'FileShare.None is a Windows share mode; POSIX opens never exclude each other',
}, async (t) => {
  const c = modifiedRepo(t);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId } = planned.json;
  const lock = path.join(runDirOf(c), 'lock');
  const release = await holdExclusively(t, lock, path.join(c.root, 'release-lock'));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);
  await release();

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.equal(result.json.error.message, BUSY_TEXT, detail(result));
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).planId, planId, 'the lock is kept, still naming the run');
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId, 'state.json')), true, 'the run folder is kept');
});
