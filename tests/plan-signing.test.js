'use strict';

// GIT-10 (docs/roadmap/06-git-adapters.md): M11 `probeSigning` reads `commit.gpgsign` with
// `--type=bool` and `gpg.format`, and `plan` stores the result in `plan.json` `signing` at
// step 6, after the clean-tree check (Q18, C:plan `signing`, stories 169 and 171). Seam 1:
// the shipped entry point as a subprocess through the FND-04 harness. SSH readiness from the
// key file is GIT-11's, the `ssh-add -L` check GIT-12's; until then an SSH setup with the
// default `gpg.ssh.program` gives `"unknown"`, never `false`.
//
// The signing config is set after the seed commit, so the harness's own `git commit` never
// tries to sign. Nothing here runs gpg, gpgsm or ssh-keygen: the probe reads config only.
//
// The prompt note's place in the stored notices and the `plan` reply is not observable yet
// (roadmap KD-R67): the path that reaches the probe ends with the hunk index, whose reply is
// `null`, and stored notices arrive with GRD-15.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

let planRefusal;
beforeEach(async () => {
  ({ planRefusal } = await loadLib('run-policy'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A seeded repo with one modified file, so `plan` passes the clean-tree check and reaches
// the probe; `config` is then written into the repo config, after the seed commit.
function changedRepo(t, config = []) {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('README.md', 'changed\n');
  for (const [key, value] of config) c.git(['config', key, value]);
  return c;
}

async function storedSigning(c, options) {
  const result = await runCommit(c, ['plan'], options);
  assert.equal(result.exitCode, 0, detail(result));
  const planJson = path.join(c.repoDir, '.commit-plan', result.json.planId, 'plan.json');
  return JSON.parse(fs.readFileSync(planJson, 'utf8')).signing;
}

test('plan with commit.gpgsign unset stores signing { enabled: false }', async (t) => {
  const c = changedRepo(t);
  assert.deepEqual(await storedSigning(c), { enabled: false });
});

test('plan with commit.gpgsign=false stores signing { enabled: false }', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'false'], ['gpg.format', 'ssh']]);
  assert.deepEqual(await storedSigning(c), { enabled: false });
});

// `yes` is true only when read with `--type=bool`.
test('plan with openpgp signing enabled stores ready "prompt" and goes ahead', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'yes']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with gpg.format=x509 stores ready "unknown" and goes ahead', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'x509']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'x509', ready: 'unknown' });
});

test('plan with a custom gpg.program stores ready "unknown" and goes ahead', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.program', 'custom-gpg']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'unknown' });
});

test('plan with a custom gpg.openpgp.program stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [
    ['commit.gpgsign', 'true'], ['gpg.format', 'openpgp'], ['gpg.openpgp.program', 'custom-gpg'],
  ]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'unknown' });
});

test('plan with gpg.format=ssh and a custom gpg.ssh.program stores ready "prompt"', async (t) => {
  const c = changedRepo(t, [
    ['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['gpg.ssh.program', 'op-ssh-sign'],
  ]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'prompt' });
});

// Until GIT-11, the default `gpg.ssh.program` is never decided; with `user.signingKey` unset
// this stays `"unknown"` after GIT-11 too (C:plan SSH readiness table, first rows).
test('plan with gpg.format=ssh, the default program and no signing key stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

test('plan sees commit.gpgsign=true set only through an exported GIT_CONFIG_SYSTEM file', async (t) => {
  const c = changedRepo(t);
  // The case isolates git with GIT_CONFIG_NOSYSTEM=1 and an empty global file; this case
  // drops the first and points GIT_CONFIG_SYSTEM at a file that enables signing.
  const systemConfig = path.join(c.root, 'system.gitconfig');
  fs.writeFileSync(systemConfig, '[commit]\n\tgpgsign = true\n');

  const signing = await storedSigning(c, {
    env: { GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: systemConfig },
  });

  assert.deepEqual(signing, { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with signing enabled spawns only git, never a signing program', async (t) => {
  for (const config of [
    [['commit.gpgsign', 'true']],
    [['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['gpg.ssh.program', 'op-ssh-sign']],
    [['commit.gpgsign', 'true'], ['gpg.format', 'x509']],
  ]) {
    const c = changedRepo(t, config);
    const log = path.join(c.root, 'spawns.jsonl');

    await storedSigning(c, {
      nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
      env: { COMMIT_TEST_SPAWN_LOG: log },
    });

    const spawns = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => typeof entry.file === 'string');
    assert.ok(spawns.length > 0);
    for (const entry of spawns) {
      assert.equal(path.basename(entry.file, '.exe').toLowerCase(), 'git', JSON.stringify(entry));
      assert.equal(entry.args.includes('commit'), false, JSON.stringify(entry));
    }
  }
});

const okFacts = Object.freeze({
  git: { status: 'ok', version: { major: 2, minor: 40, text: '2.40.0' } },
  repo: { kind: 'worktree', toplevel: '/repo' },
});

test('M15 planRefusal refuses signing-locked with the recorded text when ready is false', () => {
  const refusal = planRefusal({ ...okFacts, signing: { enabled: true, format: 'ssh', ready: false } });
  assert.equal(refusal.code, 'signing-locked');
  assert.equal(
    refusal.message,
    'signing key locked — unlock it (e.g. sign once in a terminal), then `/commit`',
  );
});

test('M15 planRefusal goes on for signing disabled, "prompt" and "unknown"', () => {
  for (const signing of [
    { enabled: false },
    { enabled: true, format: 'openpgp', ready: 'prompt' },
    { enabled: true, format: 'x509', ready: 'unknown' },
    { enabled: true, format: 'ssh', ready: true },
  ]) {
    assert.equal(planRefusal({ ...okFacts, signing }), null, JSON.stringify(signing));
  }
});

test('M15 planRefusal puts signing after the state rows', () => {
  const refusal = planRefusal({
    ...okFacts,
    unmerged: true,
    signing: { enabled: true, format: 'ssh', ready: false },
  });
  assert.equal(refusal.code, 'unmerged');
});
