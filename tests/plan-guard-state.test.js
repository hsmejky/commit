'use strict';

// GRD-17 (docs/roadmap/02-guard.md): S1 `guardState` and `samePathTree` (Q23, C:guard
// "Heartbeat", docs/spec/modules-shared-and-guard.md S1). `plan` reports `env.guard: active`
// for a heartbeat under 15 minutes old whose realpathed `cwd` is inside the toplevel or
// contains it, and `not-seen` with the guard notice otherwise; C:plan step 8 then stores the
// notices (the guard's, step 1's detached HEAD, the sweep's cleanup errors, ...) in
// `state.json` `notices` (KD-R67). Guard and `plan` resolve the Claude home the same way
// (S1 `resolveClaudeHome`, shared by both entry points).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCase, runCommit, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const GUARD_NOTICE = 'Guard hook did not run: `node` missing from the hook\'s PATH, plugin hooks '
  + 'disabled, or `disableAllHooks` set. Direct `git commit` is not blocked.';
const DETACHED_HEAD_NOTICE = 'HEAD is detached: new commits will not be on any branch';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const CASE_FOLDS = process.platform === 'win32' || process.platform === 'darwin';

let heartbeat;

beforeEach(async () => {
  heartbeat = await loadLib('heartbeat');
});

// --- Seam 3: samePathTree, pure -------------------------------------------------------------

test('Seam 3: samePathTree matches the same path, either inside the other, and nothing else', () => {
  const { samePathTree } = heartbeat;
  const cases = [
    ['/a/b', '/a/b', true],
    ['/a/b/c', '/a/b', true],
    ['/a', '/a/b', true],
    ['/a/b/', '/a/b', true],
    ['/a/bc', '/a/b', false],
    ['/a/b', '/a/bc', false],
    ['/x/b', '/a/b', false],
    ['/', '/a/b', true],
    ['C:\\Users\\me\\repo\\src', 'C:/Users/me/repo', true],
    ['C:\\', 'C:/Users/me/repo', true],
    ['D:\\repo', 'C:/repo', false],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(samePathTree(a, b, { caseFold: false }), expected, `${a} vs ${b}`);
  }
});

test('Seam 3: samePathTree folds case only when asked', () => {
  const { samePathTree } = heartbeat;
  assert.equal(samePathTree('C:\\Users\\Me\\Repo\\src', 'c:/users/me/repo', { caseFold: true }), true);
  assert.equal(samePathTree('/Users/Me/Repo', '/users/me/repo', { caseFold: false }), false);
});

test('Seam 3: resolveClaudeHome is CLAUDE_CONFIG_DIR when set, else <OS home>/.claude', () => {
  const { resolveClaudeHome } = heartbeat;
  const home = path.join(os.tmpdir(), 'home');
  const thrower = () => { throw new Error('homedir must not be read'); };
  assert.equal(resolveClaudeHome({ CLAUDE_CONFIG_DIR: '/cfg' }, thrower), '/cfg');
  assert.equal(resolveClaudeHome({}, () => home), path.join(home, '.claude'));
  assert.equal(resolveClaudeHome({ CLAUDE_CONFIG_DIR: '' }, () => home), path.join(home, '.claude'));
});

// --- Seam 3: guardState over a temporary Claude home ---------------------------------------

function tempDirs(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-state-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const claudeHome = path.join(root, 'claude');
  const toplevel = path.join(root, 'repo');
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(toplevel, 'src'), { recursive: true });
  fs.mkdirSync(other);
  fs.mkdirSync(path.join(claudeHome, 'commit-guard'), { recursive: true });
  return { root, claudeHome, toplevel, other };
}

function writeBeat(claudeHome, value) {
  const file = path.join(claudeHome, 'commit-guard', 'heartbeat.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('Seam 3: guardState is active for a fresh heartbeat in, below or above the toplevel', (t) => {
  const { root, claudeHome, toplevel } = tempDirs(t);
  const now = () => 1_000_000_000;
  // Git reports the toplevel with forward slashes on Windows too.
  const gitToplevel = toplevel.replace(/\\/g, '/');
  for (const cwd of [toplevel, path.join(toplevel, 'src'), root]) {
    writeBeat(claudeHome, { ts: now() - 14 * MINUTE_MS, cwd, command: 'commit.cjs plan' });
    assert.equal(heartbeat.guardState({ claudeHome, toplevel: gitToplevel, now }), 'active', cwd);
  }
});

test('Seam 3: guardState is not-seen for an old, absent, foreign, null-cwd, malformed or non-file heartbeat', (t) => {
  const { claudeHome, toplevel, other } = tempDirs(t);
  const now = () => 1_000_000_000;
  const fresh = now() - MINUTE_MS;
  const file = path.join(claudeHome, 'commit-guard', 'heartbeat.json');
  assert.equal(heartbeat.guardState({ claudeHome, toplevel, now }), 'not-seen', 'absent');
  const cases = [
    ['15 minutes old', { ts: now() - 15 * MINUTE_MS, cwd: toplevel, command: 'commit.cjs plan' }],
    ['another repo', { ts: fresh, cwd: other, command: 'commit.cjs plan' }],
    ['cwd null', { ts: fresh, cwd: null, command: 'commit.cjs plan' }],
    ['cwd relative', { ts: fresh, cwd: 'repo', command: 'commit.cjs plan' }],
    ['cwd missing on disk', { ts: fresh, cwd: path.join(toplevel, 'gone'), command: 'commit.cjs plan' }],
    ['ts a string', { ts: String(fresh), cwd: toplevel, command: 'commit.cjs plan' }],
    ['far-future ts', { ts: now() + HOUR_MS, cwd: toplevel, command: 'commit.cjs plan' }],
    ['not JSON', '{"ts":'],
    ['JSON null', 'null'],
  ];
  for (const [label, value] of cases) {
    writeBeat(claudeHome, value);
    assert.equal(heartbeat.guardState({ claudeHome, toplevel, now }), 'not-seen', label);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(heartbeat.guardState({ claudeHome, toplevel, now }), 'not-seen', 'a directory');
  assert.equal(heartbeat.guardState({ claudeHome: undefined, toplevel, now }), 'not-seen', 'no Claude home');
});

// --- Seam 1: plan through the shipped entry point ------------------------------------------

function dirtyCase(t, options) {
  const c = createCase(t, options);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  return c;
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Runs `plan` and returns its run folder's `plan.json` `env` and `state.json` `notices`.
async function planFacts(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  const folder = path.join(c.repoDir, '.commit-plan', result.json.planId);
  return {
    env: readJson(path.join(folder, 'plan.json')).env,
    notices: readJson(path.join(folder, 'state.json')).notices,
  };
}

function seamBeat(c, value) {
  fs.mkdirSync(path.join(c.claudeHome, 'commit-guard'), { recursive: true });
  return writeBeat(c.claudeHome, value);
}

test('Seam 1: a fresh heartbeat from inside the toplevel reports active, no guard notice', async (t) => {
  const c = dirtyCase(t);
  fs.mkdirSync(path.join(c.repoDir, 'src'));
  seamBeat(c, { ts: Date.now(), cwd: path.join(c.repoDir, 'src'), command: 'commit.cjs plan' });
  const { env, notices } = await planFacts(c);
  assert.deepEqual(env, { node: process.versions.node, git: env.git, guard: 'active' });
  assert.match(env.git, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(notices, []);
});

test('Seam 1: a fresh heartbeat whose cwd contains the toplevel reports active', async (t) => {
  const c = dirtyCase(t);
  seamBeat(c, { ts: Date.now(), cwd: c.root, command: 'commit.cjs plan' });
  assert.equal((await planFacts(c)).env.guard, 'active');
});

for (const [label, value] of [
  ['absent', undefined],
  ['16 minutes old', (c) => ({ ts: Date.now() - 16 * MINUTE_MS, cwd: c.repoDir, command: 'commit.cjs plan' })],
  ['another repo', (c) => ({ ts: Date.now(), cwd: c.osHome, command: 'commit.cjs plan' })],
  ['cwd null', () => ({ ts: Date.now(), cwd: null, command: 'commit.cjs plan' })],
  ['not valid JSON', () => '{"ts":1,'],
  ['a directory', 'dir'],
]) {
  test(`Seam 1: heartbeat ${label} → not-seen with the guard notice, and the run goes on`, async (t) => {
    const c = dirtyCase(t);
    if (value === 'dir') fs.mkdirSync(path.join(c.claudeHome, 'commit-guard', 'heartbeat.json'), { recursive: true });
    else if (value !== undefined) seamBeat(c, value(c));
    const { env, notices } = await planFacts(c);
    assert.equal(env.guard, 'not-seen');
    assert.deepEqual(notices, [GUARD_NOTICE]);
  });
}

test('Seam 1: a case-differing heartbeat cwd matches on Windows and macOS',
  { skip: !CASE_FOLDS && 'paths are case-sensitive here' },
  async (t) => {
    const c = dirtyCase(t);
    const flipped = c.repoDir.replace(/[a-z]/gi, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
    seamBeat(c, { ts: Date.now(), cwd: flipped, command: 'commit.cjs plan' });
    assert.equal((await planFacts(c)).env.guard, 'active');
  });

test('Seam 1: without CLAUDE_CONFIG_DIR plan reads the heartbeat the guard wrote under <OS home>/.claude', async (t) => {
  const c = dirtyCase(t, { claudeConfigDir: false });
  const guarded = await runGuard(c, { command: 'node "/opt/plugin/commit.cjs" plan' });
  assert.equal(guarded.heartbeatPath, path.join(c.osHome, '.claude', 'commit-guard', 'heartbeat.json'));
  assert.notEqual(guarded.heartbeat, null);
  const { env, notices } = await planFacts(c);
  assert.equal(env.guard, 'active');
  assert.deepEqual(notices, []);
});

test('Seam 1: state.json stores the guard notice ahead of the detached-HEAD notice', async (t) => {
  const c = dirtyCase(t);
  c.git(['checkout', '-q', '--detach']);
  assert.deepEqual((await planFacts(c)).notices, [GUARD_NOTICE, DETACHED_HEAD_NOTICE]);
});

test('Seam 1: state.json stores the sweep\'s cleanup errors with the guard notice',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as non-root' },
  async (t) => {
    const c = dirtyCase(t);
    const id = '11111111-1111-4111-8111-111111111111';
    const stuck = path.join(c.repoDir, '.commit-plan', id);
    fs.mkdirSync(stuck, { recursive: true });
    fs.writeFileSync(path.join(stuck, 'nested'), 'x');
    const when = new Date(Date.now() - 25 * HOUR_MS);
    fs.utimesSync(stuck, when, when);
    fs.chmodSync(stuck, 0o555); // its entries cannot be unlinked
    let facts;
    try {
      facts = await planFacts(c);
    } finally {
      fs.chmodSync(stuck, 0o755);
    }
    assert.deepEqual(facts.notices, [
      GUARD_NOTICE,
      `\`.commit-plan/${id}\` was not swept (EACCES); the 24-hour sweep retries it`,
    ]);
  });
