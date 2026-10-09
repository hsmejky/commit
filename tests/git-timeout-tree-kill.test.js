'use strict';

// GIT-07 (docs/roadmap/06-git-adapters.md): M2 `run` takes its timeout from the call's
// deadline (`withDeadline`, docs/spec/modules-m1-m9.md M2), never spawns a call whose budget
// is already spent, and past the timeout, or when an `onStdout` consumer throws, kills the
// whole process tree (POSIX: the process group; Windows: `taskkill /T`), not only the
// direct child. M2 `run` called directly, as GIT-05's and GIT-12's own M2 cases are (KD-R77).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { heartbeat, killLeftovers, stopped } = require('./helpers/heartbeat.js');

let processAdapter;
beforeEach(async () => {
  processAdapter = await loadLib('process-adapter');
});

const NOT_SPAWNED = Object.freeze({
  code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true, spawnedAt: null,
});

// A child that writes `marker` as soon as it runs, then exits: `run` resolves only once the
// child has closed, so a marker still absent after the call proves it never ran.
function markerScript(marker) {
  return `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`;
}

const HANG = 'setTimeout(() => {}, 60000)';

test('run inside a deadline scope already spent is not spawned and reports timedOut', async (t) => {
  const c = createCase(t, { repo: false });
  const marker = path.join(c.root, 'spawned');
  const scope = { deadline: 1_000, now: () => 1_000 };

  const result = await processAdapter.withDeadline(scope, () => processAdapter.run(
    process.execPath, ['-e', markerScript(marker)], { cwd: os.tmpdir(), env: c.env },
  ));

  assert.deepEqual(result, NOT_SPAWNED);
  assert.equal(scope.expired, true, 'the spent deadline is recorded on the scope');
  assert.equal(fs.existsSync(marker), false, 'the child was spawned');
});

test('run with an explicit timeoutMs at or below 0 is not spawned and reports timedOut', async (t) => {
  const c = createCase(t, { repo: false });
  for (const timeoutMs of [0, -1]) {
    const marker = path.join(c.root, `spawned${timeoutMs}`);
    const result = await processAdapter.run(
      process.execPath, ['-e', markerScript(marker)], { cwd: os.tmpdir(), env: c.env, timeoutMs },
    );
    assert.deepEqual(result, NOT_SPAWNED, `timeoutMs ${timeoutMs}`);
    assert.equal(fs.existsSync(marker), false, `timeoutMs ${timeoutMs}: the child was spawned`);
  }
});

test('run inside a deadline scope times out at deadline - now() and marks the scope expired', async (t) => {
  const c = createCase(t, { repo: false });
  const scope = { deadline: 10_300, now: () => 10_000 };

  const result = await processAdapter.withDeadline(scope, () => processAdapter.run(
    process.execPath, ['-e', HANG], { cwd: os.tmpdir(), env: c.env },
  ));

  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(scope.expired, true);
});

test('an explicit timeoutMs smaller than the deadline\'s budget binds and leaves the scope unexpired', async (t) => {
  const c = createCase(t, { repo: false });
  const scope = { deadline: 60_000, now: () => 0 };

  const result = await processAdapter.withDeadline(scope, () => processAdapter.run(
    process.execPath, ['-e', HANG], { cwd: os.tmpdir(), env: c.env, timeoutMs: 200 },
  ));

  assert.equal(result.timedOut, true);
  assert.notEqual(scope.expired, true, 'the explicit timeout, not the deadline, ended the call');
});

test('a call that ends inside its deadline leaves the scope unexpired', async (t) => {
  const c = createCase(t, { repo: false });
  const scope = { deadline: 60_000, now: () => 0 };

  const result = await processAdapter.withDeadline(scope, () => processAdapter.run(
    process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: os.tmpdir(), env: c.env },
  ));

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString('utf8'), 'ok');
  assert.notEqual(scope.expired, true);
});

test('withDeadline requires a deadline and a clock', () => {
  assert.throws(() => processAdapter.withDeadline({ deadline: 1 }, () => {}), /now/);
  assert.throws(() => processAdapter.withDeadline({ now: () => 0 }, () => {}), /deadline/);
});

// A child that starts a grandchild in its own process tree (not `detached`: same process
// group on POSIX, a child process Windows' `taskkill /T` walks), both ticking a heartbeat;
// with `announce`, the child writes one stdout chunk once the grandchild has ticked.
function treeScript(child, grandchild, { announce = false } = {}) {
  return "const { spawn } = require('child_process');"
    + `spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat(grandchild))}],`
    + " { cwd: require('os').tmpdir(), stdio: 'ignore' });"
    + `${heartbeat(child)}`
    + (announce
      ? ` const fs = require('fs'); const wait = setInterval(() => {`
        + ` if (fs.existsSync(${JSON.stringify(`${grandchild}.beat`)})) { clearInterval(wait); process.stdout.write('first\\n'); }`
        + ' }, 50);'
      : '');
}

test(
  'past its timeout, run kills the whole tree: the grandchild stops too',
  { timeout: 90_000 },
  async (t) => {
    let root = null;
    killLeftovers(t, () => (root === null ? [] : [path.join(root, 'child'), path.join(root, 'grandchild')]));
    const c = createCase(t, { repo: false });
    root = c.root;
    const child = path.join(root, 'child');
    const grandchild = path.join(root, 'grandchild');

    // Ten seconds of real time for both processes to start, even on a loaded runner.
    const result = await processAdapter.run(process.execPath, ['-e', treeScript(child, grandchild)], {
      cwd: os.tmpdir(), env: c.env, timeoutMs: 10_000,
    });

    assert.equal(result.timedOut, true);
    assert.ok(fs.existsSync(`${grandchild}.beat`), 'the grandchild never started within the timeout');
    assert.equal(await stopped(child), true, 'the child was not killed');
    assert.equal(await stopped(grandchild), true, 'the grandchild survived: only the direct child was killed');
  },
);

// review-GIT-07 finding Low-5: every heartbeat process used above dies on SIGTERM, so a
// regression that dropped the SIGKILL escalation (process-adapter.mjs `killTree`) would still
// pass every case above. POSIX only: a grandchild that ignores SIGTERM forces the SIGKILL
// step, so the call must take at least `KILL_GRACE_MS`.
test(
  'past its timeout, a grandchild that ignores SIGTERM is still killed, after the SIGKILL grace',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async (t) => {
    let root = null;
    killLeftovers(t, () => (root === null ? [] : [path.join(root, 'child'), path.join(root, 'grandchild')]));
    const c = createCase(t, { repo: false });
    root = c.root;
    const child = path.join(root, 'child');
    const grandchild = path.join(root, 'grandchild');
    const script = "const { spawn } = require('child_process');"
      + `spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {});${heartbeat(grandchild)}`)}],`
      + " { cwd: require('os').tmpdir(), stdio: 'ignore' });"
      + heartbeat(child);

    const startedAt = Date.now();
    const result = await processAdapter.run(process.execPath, ['-e', script], {
      cwd: os.tmpdir(), env: c.env, timeoutMs: 500,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, true);
    assert.equal(await stopped(child), true, 'the child was not killed');
    assert.equal(await stopped(grandchild), true, 'the SIGTERM-ignoring grandchild survived SIGKILL');
    assert.ok(
      elapsedMs >= processAdapter.KILL_GRACE_MS,
      `a SIGTERM-ignoring member must force the SIGKILL step: expected at least `
        + `${processAdapter.KILL_GRACE_MS}ms, took ${elapsedMs}ms`,
    );
  },
);

test(
  'an onStdout that throws kills the whole tree: the grandchild stops too',
  { timeout: 60_000 },
  async (t) => {
    let root = null;
    killLeftovers(t, () => (root === null ? [] : [path.join(root, 'child'), path.join(root, 'grandchild')]));
    const c = createCase(t, { repo: false });
    root = c.root;
    const child = path.join(root, 'child');
    const grandchild = path.join(root, 'grandchild');

    await assert.rejects(
      processAdapter.run(process.execPath, ['-e', treeScript(child, grandchild, { announce: true })], {
        cwd: os.tmpdir(),
        env: c.env,
        onStdout: () => { throw new Error('consumer failed'); },
      }),
      /consumer failed/,
    );

    assert.equal(await stopped(child), true, 'the child was not killed');
    assert.equal(await stopped(grandchild), true, 'the grandchild survived: only the direct child was killed');
  },
);

// CHG-23: `beforeKill` (M10 `commitGuarded` only) runs once, synchronously, before a timeout's
// tree kill; a throw is swallowed; an `onStdout` failure is not a timeout and never calls it.
test('run: beforeKill is called once before a timeout kill and a throw does not stop the kill', async (t) => {
  const c = createCase(t, { repo: false });
  let calls = 0;

  const result = await processAdapter.run(process.execPath, ['-e', HANG], {
    cwd: os.tmpdir(),
    env: c.env,
    timeoutMs: 200,
    beforeKill: () => {
      calls += 1;
      throw new Error('marker write failed');
    },
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(calls, 1);
});

test('run: beforeKill is not called when an onStdout failure ends the run', async (t) => {
  const c = createCase(t, { repo: false });
  let calls = 0;

  await assert.rejects(processAdapter.run(
    process.execPath, ['-e', "console.log('x'); setTimeout(() => {}, 60000)"],
    {
      cwd: os.tmpdir(),
      env: c.env,
      timeoutMs: 30_000,
      onStdout: () => { throw new Error('consumer failed'); },
      beforeKill: () => { calls += 1; },
    },
  ), /consumer failed/);

  assert.equal(calls, 0);
});
