'use strict';

// EXE-23 (docs/roadmap/10-commit-executor.md): signing at commit time is never disabled
// (Q18, story 169). `commit` runs `git commit` with the repo's signing config untouched: no
// `-c commit.gpgsign=false`, no `--no-gpg-sign`, and M2's scrub keeps an exported
// `GIT_CONFIG_SYSTEM` (the keep-set), so `commit.gpgsign=true` set only there still signs.
// Seam 1: `plan --split`, one stored group, then `commit --plan <id> --all` through the
// entry point. The signing key is a fresh SSH key without passphrase, generated in the
// case's temp dir (never the developer's home or agent); the cases skip where `ssh-keygen`
// is missing.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const HEADER = 'feat: change one file';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function sshKeygenMissing() {
  // No host env beyond PATH: nothing here may reach the developer's own agent or home.
  const probe = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  return probe.error && probe.error.code === 'ENOENT' ? 'ssh-keygen not on PATH' : false;
}

function caseHostPath(c) {
  const key = Object.keys(c.env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : c.env[key];
}

// Forward slashes: the path goes into git config and on to whichever `ssh-keygen` git runs
// (Git for Windows' MSYS one reads a `C:/...` path as it is).
function slashed(file) {
  return file.replace(/\\/g, '/');
}

// A fixture key without passphrase in the case root, and an `allowedSignersFile` naming
// the case's committer for it.
function fixtureKey(c) {
  const key = path.join(c.root, 'signing-key');
  const generated = spawnSync(
    'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key],
    { env: { PATH: caseHostPath(c), HOME: c.osHome }, encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, `ssh-keygen: ${generated.stderr}`);
  const allowedSigners = path.join(c.root, 'allowed-signers');
  const publicLine = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  fs.writeFileSync(allowedSigners, `${c.env.GIT_COMMITTER_EMAIL} ${publicLine}\n`);
  return { key, allowedSigners };
}

// A seeded repo with one changed file and SSH signing configured in the repo, `plan --split`
// run, and one stored group naming every unit, as `check` stores it. `commit.gpgsign=true`
// goes into the repo config, or with `systemOnly` only into a `GIT_CONFIG_SYSTEM` file: the
// case isolates git with GIT_CONFIG_NOSYSTEM=1, so the returned `env` drops that and points
// GIT_CONFIG_SYSTEM at the file, for `plan` and `commit` alike. The signing config is written
// after the seed commit, so the harness's own `git commit` never signs.
async function signedRun(t, { systemOnly = false } = {}) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  const { key, allowedSigners } = fixtureKey(c);
  c.git(['config', 'gpg.format', 'ssh']);
  c.git(['config', 'user.signingKey', slashed(key)]);
  let env = {};
  if (systemOnly) {
    const systemConfig = path.join(c.root, 'system.gitconfig');
    fs.writeFileSync(systemConfig, '[commit]\n\tgpgsign = true\n');
    env = { GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: systemConfig };
  } else {
    c.git(['config', 'commit.gpgsign', 'true']);
  }

  const planned = await runCommit(c, ['plan', '--split'], { env });
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: null, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, allowedSigners, env };
}

// The commit verifies against the allowed signers: `verify-commit` exits 0 (`c.git` throws
// otherwise) and `%G?` reads `G`, a good signature from a known principal.
function assertSigned(c, sha, allowedSigners) {
  const verifyConfig = ['-c', `gpg.ssh.allowedSignersFile=${slashed(allowedSigners)}`];
  c.git([...verifyConfig, 'verify-commit', sha]);
  assert.equal(c.git([...verifyConfig, 'log', '-1', '--format=%G?', sha]), 'G\n');
}

test('commit.gpgsign=true with an SSH key: the commit is signed and verifies', { skip: sshKeygenMissing() }, async (t) => {
  const { c, planId, allowedSigners } = await signedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha);
  assertSigned(c, sha, allowedSigners);
});

test('commit.gpgsign=true set only in a GIT_CONFIG_SYSTEM file: the commit is still signed', { skip: sshKeygenMissing() }, async (t) => {
  const { c, planId, allowedSigners, env } = await signedRun(t, { systemOnly: true });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], { env });

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  assertSigned(c, sha, allowedSigners);
});
