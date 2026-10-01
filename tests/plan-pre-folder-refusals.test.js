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

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

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

test('plan with a PATH git shim whose --version fails exits 1 env naming the failure', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  const dir = path.join(c.root, 'shim-bin-fail');
  fs.mkdirSync(dir);
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo \'fatal: boom\' 1>&2; exit 1; fi',
    `exec '${realGit(c)}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [dir, c.env.PATH]) });

  assertRefusal(result, 'env', 1);
  assert.match(result.json.error.message, /boom/);
  assertNoRunFolder(c.repoDir);
});

test('plan with a PATH git file that cannot be executed exits 1 env, not internal', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  const dir = path.join(c.root, 'shim-bin-noexec');
  fs.mkdirSync(dir);
  const fakeGit = path.join(dir, 'git');
  fs.writeFileSync(fakeGit, 'not executable\n');
  fs.chmodSync(fakeGit, 0o644);

  // The non-executable file is the only `git` on PATH: a PATH search (execvp) skips a
  // file it gets EACCES on and runs a later `git` instead, so with the host PATH after it
  // the real git would run. Execution needs an x bit even for root, so this is EACCES on
  // every POSIX runner.
  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [dir]) });

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

test('plan with a PATH git shim that never answers --version exits 5 timeout', { skip: SHIM_SKIP, timeout: 30_000 }, async (t) => {
  const c = createCase(t);
  const dir = path.join(c.root, 'shim-bin-hang');
  fs.mkdirSync(dir);
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then sleep 100; fi',
    `exec '${realGit(c)}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);

  const result = await runCommit(c, ['plan'], { env: pathOverride(c, [dir, c.env.PATH]), timeoutMs: 25_000 });

  assertRefusal(result, 'timeout', 5);
  assertNoRunFolder(c.repoDir);
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
  const spawns = entries.filter((e) => e.api === 'spawn' || e.api === 'spawnSync');
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

  // GIT-01 review finding 6: the child's 'spawn' event (spawnedAt's precondition) really
  // fires. (A clean-tree `git status` call's stdout is 0 bytes, so no 'data' event fires
  // here at all; the Buffer-shaped data-chunk assertion below uses a call whose stdout is
  // never empty instead.)
  assert.ok(
    entries.some((e) => e.api === 'child.spawn-event' && e.caller === 'lib/process-adapter.mjs'),
    JSON.stringify(entries),
  );
});

test('plan in a bare repository: the async classifying git call keeps stdout as a Buffer', async (t) => {
  const c = createCase(t, { repo: false });
  const bare = path.join(c.root, 'bare.git');
  c.git(['init', '-q', '--bare', bare], { cwd: c.root });
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    cwd: bare,
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assertRefusal(result, 'state', 6);
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  // `git rev-parse --is-bare-repository` (M3 `classifyNoWorkTree`, run through the async M2
  // `run`) succeeds inside a bare repository and writes "true\n": its stdout is never empty
  // here, so this proves `run()`'s internal `Buffer.concat(stdout)` is really fed Buffer
  // chunks, not decoded strings (GIT-01 review finding 6).
  const dataEntries = entries.filter((e) => e.api === 'stdout.data');
  assert.ok(dataEntries.length > 0, JSON.stringify(entries));
  for (const entry of dataEntries) assert.equal(entry.isBuffer, true, JSON.stringify(entry));
});

// M15 is pure (docs/spec/modules.md): the run-policy module's raw source holds no process,
// clock, filesystem or import.
test('M15 run policy module stays pure', () => {
  const { assertPureSource } = require('./helpers/assert-pure-source');
  assertPureSource('run-policy');
});

// review-CFG-02 finding 7: `planRefusal` had no pure unit test at all, so nothing pinned the
// refusal order (C:plan step 2: `env`, `config`, `state`) on a host where the PATH-shim Seam
// 1 route is skipped (KD-R21, Windows).
test('M15 planRefusal orders env before config before state', async () => {
  const { loadLib } = require('./helpers/load-lib.js');
  const { planRefusal } = await loadLib('run-policy');

  const oldGit = { status: 'ok', version: { major: 2, minor: 33, text: '2.33.0' } };
  const okGit = { status: 'ok', version: { major: 2, minor: 40, text: '2.40.0' } };
  const configError = { error: 'the repo config (.claude/commit.json) is not valid JSON' };
  const notARepo = { kind: 'not-a-repo' };

  // env beats config and state, even when both would also refuse.
  assert.equal(
    planRefusal({ git: oldGit, repo: notARepo, config: configError }).code,
    'env',
  );
  // config beats state, once env is clean.
  assert.equal(
    planRefusal({ git: okGit, repo: notARepo, config: configError }).code,
    'config',
  );
  // state is reached only once env and config are both clean.
  assert.equal(
    planRefusal({ git: okGit, repo: notARepo, config: null }).code,
    'not-a-repo',
  );
});

// review-RUN-03 finding 2: `releaseDeadline` moved here from `workflows.mjs` (M18) once
// CFG-03 freed `run-policy.mjs`; it is small and pure (M15), so it gets its own unit test
// rather than only the Seam 1 coverage in tests/release.test.js.
test('M15 releaseDeadline is the call\'s start plus 45 s', async () => {
  const { loadLib } = require('./helpers/load-lib.js');
  const { releaseDeadline, RELEASE_DEADLINE_MS } = await loadLib('run-policy');

  assert.equal(RELEASE_DEADLINE_MS, 45_000);
  assert.equal(releaseDeadline(1_000), 46_000);
  assert.equal(releaseDeadline(0), 45_000);
});

// CFG-02 (docs/roadmap/04-config-and-attribution.md): the repo config layer, read from the
// worktree (M4), checked by `plan` step 2 before any run folder or lock exists (Q6).

test('plan with unparseable repo config JSON exits 1 config, naming the repo layer, and creates no .commit-plan', async (t) => {
  const c = createCase(t);
  c.writeFile('.claude/commit.json', '{ "types": [');

  const result = await runCommit(c, ['plan']);

  assertRefusal(result, 'config', 1);
  assert.match(result.json.error.message, /repo/);
  assert.match(result.json.error.message, /\.claude[/\\]commit\.json/);
  assertNoRunFolder(c.repoDir);
});

test('plan with no repo config file gets no config refusal and goes on', async (t) => {
  const c = createCase(t);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

// CFG-03 (docs/roadmap/04-config-and-attribution.md, Q6, stories 106 and 110): pure
// `validateLayer`, wired into `loadConfig`, stops `plan` on a wrong JSON type, an
// out-of-range or non-integer number, or a bad or empty `types` array.

const CFG_03_BAD_VALUES = [
  ['maxSubjectLength', '"72"'],
  ['maxSubjectLength', '19'],
  ['maxSubjectLength', '201'],
  ['maxSubjectLength', '0'],
  ['maxSubjectLength', '72.5'],
  ['types', '[]'],
  ['types', '["Feat"]'],
  ['types', '["1x"]'],
  ['types', '"feat"'],
  ['scope', '3'],
  ['subjectCase', 'true'],
];

for (const [key, rawValue] of CFG_03_BAD_VALUES) {
  test(`plan with repo config ${key}: ${rawValue} exits 1 config naming the key and creates no .commit-plan`, async (t) => {
    const c = createCase(t);
    c.writeFile('.claude/commit.json', `{ "${key}": ${rawValue} }`);

    const result = await runCommit(c, ['plan']);

    assertRefusal(result, 'config', 1);
    // review-CFG-03 finding 6: anchored on the layer and key together (not just the key
    // appearing anywhere), so the test pins "naming the key" rather than "mentioning the
    // word" (a future message about another key could otherwise still contain this key's
    // name in passing).
    assert.match(
      result.json.error.message,
      new RegExp(`repo config \\(\\.claude/commit\\.json\\) ${key}\\b`),
    );
    assertNoRunFolder(c.repoDir);
  });
}

test('plan with repo config maxSubjectLength at both range boundaries (20 and 200) goes on', async (t) => {
  for (const value of [20, 200]) {
    const c = createCase(t);
    c.writeFile('.claude/commit.json', `{ "maxSubjectLength": ${value} }`);
    // Committed, so the tree stays clean and `plan` reaches the `nothing` reply instead of
    // steps 7-8 (not built yet): only the config load and validation is under test here.
    c.git(['add', '.claude/commit.json']);
    c.git(['commit', '-q', '-m', 'add config']);

    const result = await runCommit(c, ['plan']);

    assert.equal(result.exitCode, 0, `${value}: stdout ${result.stdout}\nstderr ${result.stderr}`);
    assert.equal(result.json.reply.status, 'nothing', String(value));
  }
});

const CFG_03_NON_OBJECT_TOP_LEVELS = ['[]', 'null', '42', '"x"'];

for (const body of CFG_03_NON_OBJECT_TOP_LEVELS) {
  test(`plan with a repo config top level of ${body} exits 1 config naming the repo layer and creates no .commit-plan`, async (t) => {
    const c = createCase(t);
    c.writeFile('.claude/commit.json', body);

    const result = await runCommit(c, ['plan']);

    assertRefusal(result, 'config', 1);
    assert.match(result.json.error.message, /repo/);
    assert.match(result.json.error.message, /\.claude[/\\]commit\.json/);
    assertNoRunFolder(c.repoDir);
  });
}

// CFG-04 (docs/roadmap/04-config-and-attribution.md, Q5, Q6, story 112): the user layer,
// read from `commit.json` directly under the Claude home the entry point resolves once
// (`CLAUDE_CONFIG_DIR`, else `.claude` in the OS home) and injects.

test('plan with an unparseable user config under CLAUDE_CONFIG_DIR exits 1 config naming the user layer', async (t) => {
  const c = createCase(t); // claudeConfigDir: true (default): CLAUDE_CONFIG_DIR = c.claudeHome.
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), '{ "types": [');

  const result = await runCommit(c, ['plan']);

  assertRefusal(result, 'config', 1);
  assert.match(result.json.error.message, /user/);
  assert.match(result.json.error.message, /commit\.json/);
  assertNoRunFolder(c.repoDir);
});

test('plan ignores an invalid commit.json in the OS-home .claude while CLAUDE_CONFIG_DIR is set', async (t) => {
  const c = createCase(t); // claudeConfigDir: true: CLAUDE_CONFIG_DIR = c.claudeHome, not <osHome>/.claude.
  const osHomeClaudeDir = path.join(c.osHome, '.claude');
  fs.mkdirSync(osHomeClaudeDir, { recursive: true });
  fs.writeFileSync(path.join(osHomeClaudeDir, 'commit.json'), '{ "types": [');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

test('plan without CLAUDE_CONFIG_DIR reads the user layer from the OS-home .claude/commit.json', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  fs.mkdirSync(c.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), '{ "types": [');

  const result = await runCommit(c, ['plan']);

  assertRefusal(result, 'config', 1);
  assert.match(result.json.error.message, /user/);
  assertNoRunFolder(c.repoDir);
});

test('plan without CLAUDE_CONFIG_DIR goes on when the OS-home user layer is valid', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  fs.mkdirSync(c.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), '{ "types": ["feat"] }');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

// review-CFG-04 finding 5: interpretation (b) (the user layer is read regardless of repo
// state, so `config` precedes `state`) had no Seam 1 pin outside a usable repo.
test('plan with an invalid user config outside a repository exits 1 config, not state', async (t) => {
  const c = createCase(t, { repo: false });
  fs.writeFileSync(path.join(c.claudeHome, 'commit.json'), '{ "types": [');
  const dir = path.join(c.root, 'plain');
  fs.mkdirSync(dir);

  const result = await runCommit(c, ['plan'], { cwd: dir });

  assertRefusal(result, 'config', 1);
  assert.match(result.json.error.message, /user/);
  assertNoRunFolder(dir);
});
