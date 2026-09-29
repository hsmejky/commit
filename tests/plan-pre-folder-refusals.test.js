'use strict';

// GIT-01 (docs/roadmap/06-git-adapters.md): `plan` refuses outside a usable repo and on an
// unusable git before any run folder exists (C:plan steps 1-2, C:cli-and-exit-codes `env`
// and `state` rows, stories 185 and 202). Seam 1 only (docs/spec/testing-modules.md, M2 and
// M3 rows): the shipped entry point as a subprocess through the FND-04 harness.
//
// The PATH git shim cases are POSIX-only: shell-less spawn on Windows finds only `.com` and
// `.exe` files, so a script shim is never run there (roadmap KD-R21, spec KD-S35). The "no
// git on PATH" case needs no shim and runs on every platform.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

// Env overrides that replace the case's PATH (whatever its spelling: Windows keeps `Path`)
// with `dirs`.
function pathOverride(c, dirs) {
  const overrides = {};
  for (const key of Object.keys(c.env)) {
    if (key.toUpperCase() === 'PATH') overrides[key] = undefined;
  }
  overrides.PATH = dirs.join(path.delimiter);
  return overrides;
}

function assertNoRunFolder(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.commit-plan')), false, `.commit-plan created in ${dir}`);
}

function assertRefusal(result, kind, exitCode) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, exitCode, detail);
  assert.equal(result.json.version, 1, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, kind, detail);
  assert.equal(typeof result.json.error.message, 'string');
}

test('plan in a directory that is not a repository exits 6 state and creates no .commit-plan', async (t) => {
  const c = createCase(t, { repo: false });
  const dir = path.join(c.root, 'plain');
  fs.mkdirSync(dir);

  const result = await runCommit(c, ['plan'], { cwd: dir });

  assertRefusal(result, 'state', 6);
  assert.match(result.json.error.message, /not a git repository/);
  assertNoRunFolder(dir);
  assertNoRunFolder(c.root);
});

test('plan in a bare repository exits 6 state and creates no .commit-plan', async (t) => {
  const c = createCase(t, { repo: false });
  const bare = path.join(c.root, 'bare.git');
  c.git(['init', '-q', '--bare', bare], { cwd: c.root });

  const result = await runCommit(c, ['plan'], { cwd: bare });

  assertRefusal(result, 'state', 6);
  assert.match(result.json.error.message, /bare repository/);
  assertNoRunFolder(bare);
});

test('plan with no git binary on PATH exits 1 env and creates no .commit-plan', async (t) => {
  const c = createCase(t);
  const emptyBin = path.join(c.root, 'empty-bin');
  fs.mkdirSync(emptyBin);

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [emptyBin]) });

  assertRefusal(result, 'env', 1);
  assert.match(result.json.error.message, /git was not found/);
  assertNoRunFolder(c.repoDir);
});

// The real git, for a shim that answers `--version` itself and hands every other call on.
function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

function gitShim(c, versionLine) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo '${versionLine}'; exit 0; fi`,
    `exec '${realGit(c)}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return dir;
}

test('plan with a PATH git shim reporting git 2.33 exits 1 env naming the version', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  const shimDir = gitShim(c, 'git version 2.33.9');

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [shimDir, c.env.PATH]) });

  assertRefusal(result, 'env', 1);
  assert.match(result.json.error.message, /2\.33\.9/);
  assert.match(result.json.error.message, /2\.34/);
  assertNoRunFolder(c.repoDir);
});

test('plan with a PATH git shim reporting an unreadable version exits 1 env', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  const shimDir = gitShim(c, 'not a git at all');

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [shimDir, c.env.PATH]) });

  assertRefusal(result, 'env', 1);
  assertNoRunFolder(c.repoDir);
});

test('plan with a PATH git shim reporting exactly git 2.34.0 goes on', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  const shimDir = gitShim(c, 'git version 2.34.0 (Apple Git-1)');

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [shimDir, c.env.PATH]) });

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

test('every spawn of plan goes through M2 with windowsHide, and an async stdout is never decoded', async (t) => {
  const c = createCase(t);
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const spawns = entries.filter((e) => e.api !== 'stdout.setEncoding');
  // The version check and toplevel lookup (spawnSync) and at least one asynchronous git
  // call (the tree state) are recorded.
  assert.ok(spawns.some((e) => e.api === 'spawnSync' && e.args[0] === '--version'), JSON.stringify(spawns));
  assert.ok(spawns.some((e) => e.api === 'spawn'), JSON.stringify(spawns));
  for (const entry of spawns) {
    assert.equal(entry.caller, 'lib/process-adapter.mjs', JSON.stringify(entry));
    assert.equal(entry.windowsHide, true, JSON.stringify(entry));
    assert.ok(['spawn', 'spawnSync'].includes(entry.api), JSON.stringify(entry));
    if (entry.api === 'spawn') assert.equal(entry.encoding, null, JSON.stringify(entry));
  }
  assert.deepEqual(entries.filter((e) => e.api === 'stdout.setEncoding'), []);
});

// M15 is pure (docs/spec/modules.md): the run-policy module's raw source holds no process,
// clock, filesystem or import.
test('M15 run policy module stays pure', () => {
  const { assertPureSource } = require('./helpers/assert-pure-source');
  assertPureSource('run-policy');
});
