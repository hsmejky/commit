'use strict';

// GIT-07 (docs/roadmap/06-git-adapters.md): M11 `probeSigning` under the call's deadline scope
// (M2 `withDeadline`, docs/spec/modules-m1-m9.md). A probe git call that times out ends as
// `ready: "unknown"` (M11, C:plan "the probe never stalls `plan`"), never as a thrown error;
// a timed-out `git --exec-path` means the `ssh-add -L` check was not run, on every platform;
// `ssh-add` takes the smaller of its fixed 5 s and the scope's budget. M11 called directly,
// as GIT-05's and GIT-12's own M2 cases are (KD-R77).
//
// The scope's clock is scripted per call: `run` reads `scope.now()` once, at its own start,
// so the Nth probe call can be given a spent budget (never spawned, `timedOut`) while every
// other call runs normally. No wall-clock assert.

const fs = require('node:fs');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

let probeSigning;
let withDeadline;
beforeEach(async () => {
  ({ probeSigning } = await loadLib('signing-probe'));
  ({ withDeadline } = await loadLib('process-adapter'));
});

const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

const LITERAL_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGl0ZXN0a2V5Zm9ydGhlZGVhZGxpbmVwcm9iZQ== probe';

// A deadline scope whose `now()` is spent (at the deadline) on the listed 1-based calls only.
// The probe's calls, in order: 1 `commit.gpgsign`, 2 `gpg.*`, 3 `user.signingKey`,
// 4 `git --exec-path`, 5 `ssh-add -L`.
function scriptedScope(spentCalls) {
  let calls = 0;
  const scope = {
    deadline: 1_000,
    now: () => {
      calls += 1;
      return spentCalls.includes(calls) ? 1_000 : 0;
    },
  };
  return scope;
}

function sshRepo(t, signingKey = LITERAL_KEY) {
  const c = createCase(t);
  c.git(['config', 'commit.gpgsign', 'true']);
  c.git(['config', 'gpg.format', 'ssh']);
  c.git(['config', 'user.signingKey', signingKey]);
  return c;
}

function probe(c, scope, env = c.env) {
  return withDeadline(scope, () => probeSigning({
    toplevel: c.repoDir, env, now: () => 0, osHome: c.osHome,
  }));
}

// A PATH shim directory: a placeholder `ssh-keygen` and an `ssh-add` that writes `marker`
// and lists `LITERAL_KEY`, so a check that runs would make the key ready (`true`).
function listingShim(c, marker) {
  const dir = path.join(c.root, 'ssh-shim');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of [
    ['ssh-keygen', 'exit 99'],
    ['ssh-add', `: > '${marker}'\necho '${LITERAL_KEY}'\nexit 0`],
  ]) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  const env = {};
  let hostPath = '';
  for (const [key, value] of Object.entries(c.env)) {
    if (key.toUpperCase() === 'PATH') hostPath = value;
    else env[key] = value;
  }
  env.PATH = [dir, hostPath].join(path.delimiter);
  return env;
}

test('a timed-out commit.gpgsign read gives enabled with ready "unknown"', async (t) => {
  const c = sshRepo(t);
  const scope = scriptedScope([1]);
  assert.deepEqual(await probe(c, scope), { enabled: true, ready: 'unknown' });
  assert.equal(scope.expired, true);
});

test('a timed-out gpg.* read gives enabled with ready "unknown", not a throw', async (t) => {
  const c = sshRepo(t);
  const scope = scriptedScope([2]);
  assert.deepEqual(await probe(c, scope), { enabled: true, ready: 'unknown' });
  assert.equal(scope.expired, true);
});

test('a timed-out user.signingKey read gives ready "unknown", not a throw', async (t) => {
  const c = sshRepo(t);
  const scope = scriptedScope([3]);
  assert.deepEqual(await probe(c, scope), { enabled: true, format: 'ssh', ready: 'unknown' });
  assert.equal(scope.expired, true);
});

test('a timed-out git --exec-path means the ssh-add check was not run, on every platform', async (t) => {
  const c = sshRepo(t);
  const marker = path.join(c.root, 'ssh-add-ran');
  // review-GIT-07 finding Low-8: on win32 this case is a no-op proof. The listing shim's
  // `#!/bin/sh` scripts are not found by shell-less spawn there (KD-R21), and an exec path
  // that could not be read (`null`) already skips the check on Windows, so the assertions
  // hold with or without the timed-out handling; POSIX CI carries the proof.
  const env = process.platform === 'win32' ? c.env : listingShim(c, marker);
  const scope = scriptedScope([4]);
  assert.deepEqual(await probe(c, scope, env), { enabled: true, format: 'ssh', ready: 'unknown' });
  assert.equal(scope.expired, true);
  assert.equal(fs.existsSync(marker), false);
});

test('ssh-add takes the deadline scope\'s budget when it is below its fixed 5 s', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  const marker = path.join(c.root, 'ssh-add-ran');
  const env = listingShim(c, marker);
  const scope = scriptedScope([5]);
  assert.deepEqual(await probe(c, scope, env), { enabled: true, format: 'ssh', ready: 'unknown' });
  assert.equal(scope.expired, true);
  assert.equal(fs.existsSync(marker), false);
});

test('the listing shim alone makes the literal key ready (control for the cases above)', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  const marker = path.join(c.root, 'ssh-add-ran');
  const env = listingShim(c, marker);
  const scope = scriptedScope([]);
  assert.deepEqual(await probe(c, scope, env), { enabled: true, format: 'ssh', ready: true });
  assert.equal(scope.expired, undefined);
  assert.equal(fs.existsSync(marker), true);
});
