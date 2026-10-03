'use strict';

// GIT-10 (docs/roadmap/06-git-adapters.md): M11 `probeSigning` reads `commit.gpgsign` with
// `--type=bool` and `gpg.format`, and `plan` stores the result in `plan.json` `signing` at
// step 6, after the clean-tree check (Q18, C:plan `signing`, stories 169 and 171). Seam 1:
// the shipped entry point as a subprocess through the FND-04 harness. GIT-11 adds SSH
// readiness from the key file (key-source table, header parse); the `ssh-add -L` check is
// GIT-12's, so every case the header alone cannot clear (an encrypted key, a missing or
// unrecognised private key file, an unresolved key source) still gives `"unknown"`, never
// `false`.
//
// The signing config is set after the seed commit, so the harness's own `git commit` never
// tries to sign. Nothing here runs gpg, gpgsm, ssh-keygen or ssh-add: the probe reads config
// and, for GIT-11, key files, only.
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

async function storedSigning(c, options, argv = ['plan']) {
  const result = await runCommit(c, argv, options);
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

// "Custom" boundary (C:plan `signing`, Q18): explicitly naming the default program is still
// the default, for both formats.
test('plan with gpg.program=gpg explicitly set still counts as the default (ready "prompt")', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.program', 'gpg']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with gpg.format=ssh and gpg.ssh.program=ssh-keygen explicitly set still counts as the default', async (t) => {
  const c = changedRepo(t, [
    ['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['gpg.ssh.program', 'ssh-keygen'],
  ]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

// openpgp compares the basename, case-insensitive with `.exe` stripped (ssh keeps a literal
// compare, so a non-literal `ssh-keygen` path is not tested here as "default").
test('plan with gpg.program=gpg2 counts as the default (ready "prompt")', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.program', 'gpg2']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with an absolute path to the default gpg counts as the default (ready "prompt")', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.program', '/usr/local/bin/gpg']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with gpg.program=GPG.EXE (case-insensitive, .exe stripped) counts as the default', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.program', 'GPG.EXE']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

// `gpg.program` and `gpg.openpgp.program` are one setting to git: whichever comes last in
// config order wins, not an OR of both keys' custom-ness.
test('plan with gpg.openpgp.program custom then gpg.program=gpg later uses the default (last key wins)', async (t) => {
  const c = changedRepo(t, [
    ['commit.gpgsign', 'true'], ['gpg.openpgp.program', 'custom-gpg'], ['gpg.program', 'gpg'],
  ]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

test('plan with gpg.format=ssh set globally and gpg.format=openpgp set in the repo uses the repo value (last wins across scopes)', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true']]);
  c.git(['config', '--global', 'gpg.format', 'ssh']);
  c.git(['config', 'gpg.format', 'openpgp']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'openpgp', ready: 'prompt' });
});

// M11 "cannot decide -> unknown": a non-boolean commit.gpgsign is git's own config error,
// which `git commit` will report; the probe does not throw (review-GIT-10 finding 4).
test('plan with a non-boolean commit.gpgsign stores { enabled: true, ready: "unknown" } and goes ahead', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'maybe']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, ready: 'unknown' });
});

// Until GIT-11, the default `gpg.ssh.program` is never decided; with `user.signingKey` unset
// this stays `"unknown"` after GIT-11 too (C:plan SSH readiness table, first rows).
test('plan with gpg.format=ssh, the default program and no signing key stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

// GIT-11: SSH readiness from the key file. These build file content directly (never run
// ssh-keygen): an `openssh-key-v1` file needs only the magic and a length-prefixed cipher
// name to exercise the probe's own parser; the PEM fixtures mirror
// tests/fixtures/scan-patterns/private-key/*.

function opensshKeyFile(cipher) {
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  const cipherBuf = Buffer.from(cipher, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(cipherBuf.length, 0);
  const base64 = Buffer.concat([magic, lenBuf, cipherBuf]).toString('base64');
  const wrapped = base64.replace(/(.{70})/g, '$1\n').replace(/\n?$/, '\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}-----END OPENSSH PRIVATE KEY-----\n`;
}

const UNENCRYPTED_PEM = '-----BEGIN PRIVATE KEY-----\nFAKE0KEY0BODY0FOR0TESTS0ONLY0==\n-----END PRIVATE KEY-----\n';
const ENCRYPTED_PEM = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n'
  + 'DEK-Info: AES-128-CBC,FAKE0000FAKE0000FAKE0000FAKE0000\n\n'
  + 'FAKE0KEY0BODY0FOR0TESTS0ONLY0==\n-----END RSA PRIVATE KEY-----\n';

test('plan with gpg.format=ssh and an unencrypted OpenSSH or PEM key file stores ready true (no agent involved)', async (t) => {
  for (const [name, content] of [['id_ed25519', opensshKeyFile('none')], ['id_rsa', UNENCRYPTED_PEM]]) {
    const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
    c.writeFile(name, content);
    c.git(['config', 'user.signingKey', name]);
    assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: true }, name);
  }
});

test('plan with a passphrase-protected SSH key file stores ready "unknown" (no ssh-add check yet)', async (t) => {
  for (const [name, content] of [['id_ed25519', opensshKeyFile('aes256-ctr')], ['id_rsa', ENCRYPTED_PEM]]) {
    const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
    c.writeFile(name, content);
    c.git(['config', 'user.signingKey', name]);
    assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' }, name);
  }
});

test('plan with user.signingKey set to a .pub path reads the private file beside it', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  c.writeFile('id_ed25519.pub', 'ssh-ed25519 AAAAFAKE comment\n');
  c.writeFile('id_ed25519', opensshKeyFile('none'));
  c.git(['config', 'user.signingKey', 'id_ed25519.pub']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: true });
});

test('plan with user.signingKey set to a .pub path without its private file stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  c.writeFile('id_ed25519.pub', 'ssh-ed25519 AAAAFAKE comment\n');
  c.git(['config', 'user.signingKey', 'id_ed25519.pub']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

test('plan with user.signingKey starting with ~/ expands against the injected OS home', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  const dir = path.join(c.osHome, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'id_ed25519'), opensshKeyFile('none'));
  c.git(['config', 'user.signingKey', '~/.ssh/id_ed25519']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: true });
});

test('plan with user.signingKey starting with ~user/ stores ready "unknown" (cannot resolve another user\'s home)', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  c.git(['config', 'user.signingKey', '~someoneelse/.ssh/id_ed25519']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

test('plan with user.signingKey set to a literal key stores ready "unknown" (no private key file)', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  c.git(['config', 'user.signingKey', 'ssh-ed25519 AAAAFAKE comment']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

test('plan with user.signingKey pointing to a file with no recognised header stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [['commit.gpgsign', 'true'], ['gpg.format', 'ssh']]);
  c.writeFile('not_a_key', 'just some text\n');
  c.git(['config', 'user.signingKey', 'not_a_key']);
  assert.deepEqual(await storedSigning(c), { enabled: true, format: 'ssh', ready: 'unknown' });
});

test('plan with gpg.format=ssh, user.signingKey unset and gpg.ssh.defaultKeyCommand set stores ready "unknown"', async (t) => {
  const c = changedRepo(t, [
    ['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['gpg.ssh.defaultKeyCommand', 'echo key'],
  ]);
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

// `--reword` takes the lock on a clean tree too (Q9, Q20), reaching the probe the same way.
test('plan --reword on a clean tree also stores signing', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'commit.gpgsign', 'true']);
  c.git(['config', 'gpg.format', 'x509']);

  const signing = await storedSigning(c, undefined, ['plan', '--reword']);
  assert.deepEqual(signing, { enabled: true, format: 'x509', ready: 'unknown' });
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
