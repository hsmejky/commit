'use strict';

// GIT-12 (docs/roadmap/06-git-adapters.md): M11 SSH readiness through the agent. `ssh-add`
// is the one in the directory of the `ssh-keygen` git runs (on Windows Git for Windows'
// `usr/bin`, located from `git --exec-path`, first), `-L` is compared by key type and base64
// blob, exit 1/2 count as an empty list, any other exit or a timeout means the check was not
// run, and a `false` resting on a check that was not run becomes `"unknown"` (C:plan "SSH
// readiness", Q18, story 170). Seam 1: the shipped entry point through the FND-04 harness.
//
// No test reaches the developer's own agent: the case env never carries `SSH_AUTH_SOCK`
// (process-seam's host allowlist), the stub cases put a shim directory holding a placeholder
// `ssh-keygen` and a scripted `ssh-add` first on PATH, and the real-agent case starts its own
// `ssh-agent` on a socket of its own and kills it afterwards. Script shims are POSIX-only:
// shell-less spawn on Windows finds only `.com` and `.exe` files (roadmap KD-R21); the
// "no `ssh-add` next to `ssh-keygen`" cases need no script and run everywhere, and the
// Windows `usr/bin` lookup order is pinned on M11's exported locator directly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

const SIGNING_LOCKED_TEXT = 'signing key locked — unlock it (e.g. sign once in a terminal), then `/commit`';

let locateSshAdd;
beforeEach(async () => {
  ({ locateSshAdd } = await loadLib('signing-probe'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// SSH wire-format string: a 4-byte big-endian length, then the bytes.
function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function ed25519Blob(fill) {
  return Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, fill))]);
}

const KEY_BLOB = ed25519Blob(7);
const KEY_LINE = `ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture@example`;
const OTHER_LINE = `ssh-ed25519 ${ed25519Blob(9).toString('base64')} other@example`;

// A complete `openssh-key-v1` file header (magic, cipher, kdf, kdf options, one public key)
// built in memory, so the probe can read the public part without a `.pub` beside it; the
// private section is a placeholder the probe never reads.
function opensshKeyFile(cipher, publicBlob = KEY_BLOB) {
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(cipher),
    sshString(cipher === 'none' ? 'none' : 'bcrypt'),
    sshString(cipher === 'none' ? '' : Buffer.alloc(24, 1)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(Buffer.alloc(16, 3)),
  ]);
  const wrapped = body.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n?$/, '\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}-----END OPENSSH PRIVATE KEY-----\n`;
}

const ENCRYPTED_PEM = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n'
  + 'DEK-Info: AES-128-CBC,FAKE0000FAKE0000FAKE0000FAKE0000\n\n'
  + 'FAKE0KEY0BODY0FOR0TESTS0ONLY0==\n-----END RSA PRIVATE KEY-----\n';

// A seeded repo with SSH signing on; `dirty` leaves one modified file so `plan` reaches the
// probe. The signing config is written after the seed commit, so the harness's own
// `git commit` never signs.
function sshRepo(t, { dirty = true } = {}) {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  if (dirty) c.writeFile('README.md', 'changed\n');
  c.git(['config', 'commit.gpgsign', 'true']);
  c.git(['config', 'gpg.format', 'ssh']);
  return c;
}

function caseHostPath(c) {
  const key = Object.keys(c.env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : c.env[key];
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

// Env overrides putting a shim directory first on PATH: a placeholder `ssh-keygen` (never
// run; it only marks the directory as the one git's `ssh-keygen` lives in) and, when
// `sshAdd` is given, a POSIX `ssh-add` script with that body. On Windows `GIT_EXEC_PATH`
// points at an empty Git-for-Windows-shaped tree, so the real `usr/bin` is never found.
// `extraDirs` go on PATH after the shim directory, before the host PATH.
function sshShim(c, { sshAdd, extraDirs = [] } = {}) {
  const dir = path.join(c.root, 'ssh-shim');
  fs.mkdirSync(dir, { recursive: true });
  const exe = process.platform === 'win32' ? '.exe' : '';
  writeExecutable(path.join(dir, `ssh-keygen${exe}`), '#!/bin/sh\nexit 99\n');
  if (sshAdd !== undefined) writeExecutable(path.join(dir, 'ssh-add'), `#!/bin/sh\n${sshAdd}\n`);
  const env = pathOverride(c, [dir, ...extraDirs, caseHostPath(c)]);
  if (process.platform === 'win32') {
    const execPath = path.join(c.root, 'fake-git', 'mingw64', 'libexec', 'git-core');
    fs.mkdirSync(execPath, { recursive: true });
    env.GIT_EXEC_PATH = execPath;
  }
  return env;
}

// An `ssh-add` body that answers `-L` with `lines` and exits `code`.
function listing(lines, code = 0) {
  const out = lines.map((line) => `echo '${line}'`).join('\n');
  return `[ "$1" = "-L" ] || exit 64\n${out}\nexit ${code}`;
}

async function plan(c, env, options = {}) {
  return runCommit(c, ['plan'], { env, ...options });
}

async function storedSigning(c, env, options) {
  const result = await plan(c, env, options);
  assert.equal(result.exitCode, 0, detail(result));
  const planJson = path.join(c.repoDir, '.commit-plan', result.json.planId, 'plan.json');
  return JSON.parse(fs.readFileSync(planJson, 'utf8')).signing;
}

function assertSigningLocked(result) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'signing', detail(result));
  assert.equal(result.json.error.message, SIGNING_LOCKED_TEXT, detail(result));
}

const READY = (ready) => ({ enabled: true, format: 'ssh', ready });

// --- No `ssh-add` next to git's `ssh-keygen`: runs on every platform. ---

test('no ssh-add next to git\'s ssh-keygen: a passphrase key file stores ready "unknown"', async (t) => {
  for (const [name, content] of [['id_ed25519', opensshKeyFile('aes256-ctr')], ['id_rsa', ENCRYPTED_PEM]]) {
    const c = sshRepo(t);
    c.writeFile(name, content);
    c.writeFile(`${name}.pub`, `${KEY_LINE}\n`);
    c.git(['config', 'user.signingKey', name]);
    assert.deepEqual(await storedSigning(c, sshShim(c)), READY('unknown'), name);
  }
});

test('no ssh-add next to git\'s ssh-keygen: a literal key stores ready "unknown"', async (t) => {
  for (const literal of [`key::${KEY_LINE}`, KEY_LINE]) {
    const c = sshRepo(t);
    c.git(['config', 'user.signingKey', literal]);
    assert.deepEqual(await storedSigning(c, sshShim(c)), READY('unknown'), literal);
  }
});

test('no ssh-add next to git\'s ssh-keygen: a .pub without its private file stores ready "unknown"', async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519.pub', `${KEY_LINE}\n`);
  c.git(['config', 'user.signingKey', 'id_ed25519.pub']);
  assert.deepEqual(await storedSigning(c, sshShim(c)), READY('unknown'));
});

test('no ssh-add next to git\'s ssh-keygen: an unencrypted key file stores ready true', async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519', opensshKeyFile('none'));
  c.git(['config', 'user.signingKey', 'id_ed25519']);
  assert.deepEqual(await storedSigning(c, sshShim(c)), READY(true));
});

// --- `ssh-add` stubs next to the shim `ssh-keygen` (POSIX). ---

test('a passphrase key listed by ssh-add -L stores ready true', { skip: SHIM_SKIP }, async (t) => {
  for (const [name, setup] of [
    ['.pub beside the key', (c) => { c.writeFile('k', opensshKeyFile('aes256-ctr')); c.writeFile('k.pub', `${KEY_LINE}\n`); }],
    ['public part of the openssh-key-v1 file', (c) => c.writeFile('k', opensshKeyFile('aes256-ctr'))],
  ]) {
    const c = sshRepo(t);
    setup(c);
    c.git(['config', 'user.signingKey', 'k']);
    const env = sshShim(c, { sshAdd: listing([OTHER_LINE, KEY_LINE]) });
    assert.deepEqual(await storedSigning(c, env), READY(true), name);
  }
});

test('ssh-add -L is compared by key type and blob, not by comment', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.git(['config', 'user.signingKey', `key::${KEY_LINE}`]);
  const [type, blob] = KEY_LINE.split(' ');
  const env = sshShim(c, { sshAdd: listing([`${type} ${blob} a-different-comment`]) });
  assert.deepEqual(await storedSigning(c, env), READY(true));
});

test('a passphrase key file not in any agent refuses exit 6 signing with the recorded text', { skip: SHIM_SKIP }, async (t) => {
  for (const [label, sshAdd] of [
    ['another key listed', listing([OTHER_LINE])],
    ['no identities (exit 1)', listing([], 1)],
  ]) {
    const c = sshRepo(t);
    c.writeFile('id_ed25519', opensshKeyFile('aes256-ctr'));
    c.git(['config', 'user.signingKey', 'id_ed25519']);
    const result = await plan(c, sshShim(c, { sshAdd }));
    assert.equal(result.exitCode, 6, `${label}\n${detail(result)}`);
    assertSigningLocked(result);
  }
});

test('an ssh-add stub exiting 2 (no agent) with a passphrase key refuses exit 6 signing', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_rsa', ENCRYPTED_PEM);
  c.writeFile('id_rsa.pub', `${KEY_LINE}\n`);
  c.git(['config', 'user.signingKey', 'id_rsa']);
  assertSigningLocked(await plan(c, sshShim(c, { sshAdd: 'echo "Could not open a connection to your authentication agent." >&2\nexit 2' })));
});

test('a literal key not listed by ssh-add -L refuses exit 6 signing', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.git(['config', 'user.signingKey', `key::${KEY_LINE}`]);
  assertSigningLocked(await plan(c, sshShim(c, { sshAdd: listing([OTHER_LINE]) })));
});

test('an ssh-add exit other than 0, 1 or 2 means the check did not run: "unknown"', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519', opensshKeyFile('aes256-ctr'));
  c.git(['config', 'user.signingKey', 'id_ed25519']);
  assert.deepEqual(await storedSigning(c, sshShim(c, { sshAdd: listing([OTHER_LINE], 3) })), READY('unknown'));
});

test('an ssh-add stub that sleeps past the fixed timeout gives "unknown", plan not stalled', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519', opensshKeyFile('aes256-ctr'));
  c.git(['config', 'user.signingKey', 'id_ed25519']);
  assert.deepEqual(await storedSigning(c, sshShim(c, { sshAdd: 'exec sleep 60' })), READY('unknown'));
});

test('a PATH ssh-add that is not next to git\'s ssh-keygen is never used', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519', opensshKeyFile('aes256-ctr'));
  c.git(['config', 'user.signingKey', 'id_ed25519']);
  const elsewhere = path.join(c.root, 'elsewhere-bin');
  fs.mkdirSync(elsewhere);
  writeExecutable(path.join(elsewhere, 'ssh-add'), `#!/bin/sh\n${listing([KEY_LINE])}\n`);
  const env = sshShim(c, { extraDirs: [elsewhere] });
  assert.deepEqual(await storedSigning(c, env), READY('unknown'));
});

test('a locked key on a clean tree reports nothing to commit, not signing', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t, { dirty: false });
  c.writeFile('.git/info/k', opensshKeyFile('aes256-ctr'));
  c.git(['config', 'user.signingKey', path.join(c.repoDir, '.git', 'info', 'k')]);
  const result = await plan(c, sshShim(c, { sshAdd: listing([], 1) }));
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'nothing', detail(result));
});

test('the SSH probe spawns only git and the ssh-add next to git\'s ssh-keygen', { skip: SHIM_SKIP }, async (t) => {
  const c = sshRepo(t);
  c.writeFile('id_ed25519', opensshKeyFile('aes256-ctr'));
  c.git(['config', 'user.signingKey', 'id_ed25519']);
  const log = path.join(c.root, 'spawns.jsonl');
  const env = { ...sshShim(c, { sshAdd: listing([KEY_LINE]) }), COMMIT_TEST_SPAWN_LOG: log };
  await storedSigning(c, env, { nodeArgs: ['--import', SPAWN_RECORD_PRELOAD] });

  const spawns = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => typeof entry.file === 'string');
  const sshAdds = spawns.filter((entry) => path.basename(entry.file) === 'ssh-add');
  assert.deepEqual(sshAdds.map((entry) => [entry.file, entry.args]), [
    [path.join(c.root, 'ssh-shim', 'ssh-add'), ['-L']],
  ]);
  for (const entry of spawns) {
    if (sshAdds.includes(entry)) continue;
    assert.equal(path.basename(entry.file, '.exe').toLowerCase(), 'git', JSON.stringify(entry));
  }
});

// --- A real agent the fixture starts itself (POSIX, OpenSSH tools on PATH). ---

function sshToolsMissing() {
  if (process.platform === 'win32') return 'the fixture agent case is POSIX-only';
  for (const tool of ['ssh-agent', 'ssh-add', 'ssh-keygen']) {
    // No `SSH_AUTH_SOCK` (or anything else of the host env): `ssh-add -?` connects to
    // whatever agent that names before it parses `-?`, so passing the host env here would
    // reach the developer's own agent (review-GIT-12 finding 6).
    const probe = spawnSync(tool, ['-?'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
    if (probe.error && probe.error.code === 'ENOENT') return `${tool} not on PATH`;
  }
  return false;
}

function mustRun(cmd, args, env) {
  const result = spawnSync(cmd, args, { env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// Starts an `ssh-agent` on a socket of its own (a short path: Unix socket paths are capped
// near 104 bytes), loads a fresh key into it, then puts a passphrase on the key file, so
// the agent holds a key whose file alone reads as locked.
function fixtureAgent(t, c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
  const sock = path.join(dir, 'agent.sock');
  const env = { PATH: caseHostPath(c), HOME: c.osHome, SSH_AUTH_SOCK: sock };
  const started = mustRun('ssh-agent', ['-s', '-a', sock], env);
  const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(started)[1]);
  t.after(() => {
    try { process.kill(pid); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const key = path.join(c.root, 'agentkey');
  mustRun('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key], env);
  mustRun('ssh-add', ['-q', key], env);
  mustRun('ssh-keygen', ['-q', '-p', '-P', '', '-N', 'fixture-passphrase', '-f', key], env);
  return { sock, key, publicLine: fs.readFileSync(`${key}.pub`, 'utf8').trim() };
}

test('a fixture-owned ssh-agent: a loaded passphrase key and a literal key in it are ready, a literal key not in it refuses', { skip: sshToolsMissing() }, async (t) => {
  const c = sshRepo(t);
  const agent = fixtureAgent(t, c);
  const env = { SSH_AUTH_SOCK: agent.sock };

  c.git(['config', 'user.signingKey', agent.key]);
  assert.deepEqual(await storedSigning(c, env), READY(true), 'passphrase key file loaded in the agent');

  // A fresh repo per `plan`: the first one holds the run lock.
  const literal = sshRepo(t);
  literal.git(['config', 'user.signingKey', `key::${agent.publicLine}`]);
  assert.deepEqual(await storedSigning(literal, env), READY(true), 'literal key in the agent');

  const other = sshRepo(t);
  other.git(['config', 'user.signingKey', `key::${OTHER_LINE}`]);
  assertSigningLocked(await plan(other, env));
});

// --- M11's locator: which `ssh-add` it takes (a direct call, every platform). ---

function toolTree(root, files) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeExecutable(path.join(root, file), '#!/bin/sh\nexit 0\n');
  }
}

test('locateSshAdd on Windows takes Git for Windows\' usr/bin (from the exec path) before PATH', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  toolTree(root, [
    'Git/usr/bin/ssh-keygen.exe', 'Git/usr/bin/ssh-add.exe',
    'OpenSSH/ssh-keygen.exe', 'OpenSSH/ssh-add.exe',
  ]);
  const execPath = path.join(root, 'Git', 'mingw64', 'libexec', 'git-core');
  fs.mkdirSync(execPath, { recursive: true });
  const env = { Path: path.join(root, 'OpenSSH') };
  assert.equal(
    locateSshAdd({ execPath, env, platform: 'win32' }),
    path.join(root, 'Git', 'usr', 'bin', 'ssh-add.exe'),
  );
});

test('locateSshAdd takes the ssh-add beside the first ssh-keygen on PATH, or none', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  toolTree(root, ['a/ssh-keygen', 'b/ssh-keygen', 'b/ssh-add', 'c/ssh-add']);
  const execPath = path.join(root, 'git-core');
  fs.mkdirSync(execPath);
  const at = (...dirs) => ({ PATH: dirs.map((d) => path.join(root, d)).join(path.delimiter) });
  assert.equal(locateSshAdd({ execPath, env: at('b', 'a'), platform: 'linux' }), path.join(root, 'b', 'ssh-add'));
  assert.equal(locateSshAdd({ execPath, env: at('a', 'b', 'c'), platform: 'linux' }), null);
  assert.equal(locateSshAdd({ execPath, env: at('c'), platform: 'linux' }), null);
});

// M2 `run`'s `timeoutMs` (the `ssh-add` call's fixed timeout until GIT-07): a child past it
// is killed and the call resolves at once with `timedOut: true` (every platform).
test('M2 run with timeoutMs kills a child past it and resolves timedOut', async () => {
  const { run } = await loadLib('process-adapter');
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: os.tmpdir(), env: process.env, timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

// Past the timeout, `run` kills only the direct child (its JSDoc); a grandchild the child
// left holding the inherited stdout/stderr pipes must not make the call wait for it
// (review-GIT-12 finding 7). `sh` backgrounds a 60 s `sleep` and then itself waits on it, so
// the direct child (`sh`) is the one `run` kills at 200 ms; the orphaned `sleep` keeps the
// pipes open for the rest of its 60 s unless `run` resolves without waiting for a `close`
// that depends on it.
test('M2 run with timeoutMs resolves without waiting for an orphaned grandchild on the pipes', { skip: process.platform === 'win32' && 'POSIX-only (sh)' }, async () => {
  const { run } = await loadLib('process-adapter');
  const started = Date.now();
  const result = await run('sh', ['-c', 'sleep 60 & wait'], {
    cwd: os.tmpdir(), env: process.env, timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - started < 10_000, 'resolved well under the grandchild\'s 60 s lifetime');
});
