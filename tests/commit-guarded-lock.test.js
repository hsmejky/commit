'use strict';

// CHG-23 (docs/roadmap/07-change-set.md): M10 `commitGuarded` and the stale `index.lock`
// (Q18). Seam 1 with the stepping clock (tests/helpers/clock-preload.mjs): the clock reads
// 535 s at the call's first group, so `git commit` gets a 5 s budget and M2 kills the hook
// tree at it. A hook that ignores SIGTERM keeps the process group alive for the kill grace
// (5 s), and a detached survivor process sets `index.lock` up while the kill is running, so
// the lock's mtime relative to the two markers is exact. Each timeout case costs about 10 s.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const TEST_TIMEOUT = { timeout: 90_000 };
const LEFT_NOTICE = 'index.lock was left in place — if no git process is running, check it and remove it by hand';
const slash = (p) => p.replace(/\\/g, '/');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

function runAt535(c, argv) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
  return runCommit(c, argv, { nodeArgs: ['--import', CLOCK_PRELOAD], env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath } });
}

// `reword` of HEAD: `--amend --only` is a partial commit and holds `index.lock` across its hooks.
async function rewordRun(t) {
  const c = createCase(t);
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', 'fix: old']);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  fs.writeFileSync(path.join(planned.json.runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups: [{ header: 'fix: new', body: null, files: [], hunks: [] }], notIncluded: [],
  }));
  return { c, argv: ['check', '--plan', planned.json.planId] };
}

// A plain `git commit` through `split`: git releases `index.lock` before its hooks run.
async function splitRun(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const statePath = path.join(planned.json.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header: 'feat: change a', body: null, committed: false }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, argv: ['commit', '--plan', planned.json.planId, '--all'] };
}

const lockOf = (c) => path.join(c.repoDir, '.git', 'index.lock');

// The survivor outlives the killed tree (its launcher exits at once): once the second marker
// exists it waits 0.5 s, then makes sure `index.lock` exists and sets its mtime to
// `markerStart - startOffsetMs` or `markerKill + killOffsetMs`.
function installSurvivor(c, { startOffsetMs, killOffsetMs }) {
  const gitDir = path.join(c.repoDir, '.git');
  const survivor = path.join(c.root, 'survivor.js');
  const target = startOffsetMs === undefined ? `kill + ${killOffsetMs}` : `start - ${startOffsetMs}`;
  fs.writeFileSync(survivor, `
const fs = require('node:fs');
const dir = ${JSON.stringify(gitDir)};
const lock = dir + '/index.lock';
const deadline = Date.now() + 30000;
(function poll() {
  if (!fs.existsSync(dir + '/commit-guard-kill')) {
    if (Date.now() < deadline) setTimeout(poll, 20);
    return;
  }
  const giveUp = Date.now() + 2500;
  setTimeout(function create() {
    // git may still be cleaning up its own lock (POSIX removes it on SIGTERM): wait, bounded.
    if (fs.existsSync(lock) && Date.now() < giveUp) return setTimeout(create, 20);
    const start = fs.statSync(dir + '/commit-guard-start').mtimeMs;
    const kill = fs.statSync(dir + '/commit-guard-kill').mtimeMs;
    const at = ${target};
    if (!fs.existsSync(lock)) fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(at), new Date(at));
  }, 500);
})();
`);
  const launcher = path.join(c.root, 'launcher.js');
  fs.writeFileSync(launcher, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(survivor)}], { detached: true, stdio: 'ignore' }).unref();\n`);
  installHook(c, 'pre-commit', [
    `if [ -e '${slash(lockOf(c))}' ]; then : > '${slash(path.join(c.root, 'lock.seen'))}'; fi`,
    `'${slash(process.execPath)}' '${slash(launcher)}'`,
    'trap "" TERM',
    'sleep 120',
  ]);
}

// On POSIX git removes its own index.lock on SIGTERM, so this test alone does not prove M10's
// removal there; the cross-OS proof is the AC2 1.5 s case (the survivor re-creates the lock).
test('AC1: reword, sleeping hook at 535 s -> index.lock existed during the hook and is gone after the kill', TEST_TIMEOUT, async (t) => {
  const { c, argv } = await rewordRun(t);
  installHook(c, 'pre-commit', [
    `if [ -e '${slash(lockOf(c))}' ]; then : > '${slash(path.join(c.root, 'lock.seen'))}'; fi`,
    'exec sleep 120',
  ]);

  const result = await runAt535(c, argv);

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(path.join(c.root, 'lock.seen')), 'the lock existed while the hook slept');
  assert.equal(fs.existsSync(lockOf(c)), false, 'the lock is removed');
  assert.ok(!result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.git')).filter((n) => n.startsWith('commit-guard-')), [], 'no marker is left');
});

test('AC1: reword, a lock created after the kill began is kept', TEST_TIMEOUT, async (t) => {
  const { c, argv } = await rewordRun(t);
  installSurvivor(c, { killOffsetMs: 1000 });

  const result = await runAt535(c, argv);

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(lockOf(c)), 'the foreign lock is kept');
  assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
});

test('AC2: reword, a lock 1.5 s before the first marker is stale and removed', TEST_TIMEOUT, async (t) => {
  const { c, argv } = await rewordRun(t);
  installSurvivor(c, { startOffsetMs: 1500 });

  const result = await runAt535(c, argv);

  assert.equal(result.exitCode, 5, detail(result));
  assert.equal(fs.existsSync(lockOf(c)), false, 'inside the widened lower bound: removed');
});

test('AC2: reword, a lock 2.5 s before the first marker is kept', TEST_TIMEOUT, async (t) => {
  const { c, argv } = await rewordRun(t);
  installSurvivor(c, { startOffsetMs: 2500 });

  const result = await runAt535(c, argv);

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(lockOf(c)), 'just before the lower bound: kept');
  assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
});

test('AC3: split, a hook that creates index.lock -> the lock stays and the notice says so', TEST_TIMEOUT, async (t) => {
  const { c, argv } = await splitRun(t);
  installHook(c, 'pre-commit', [`: > '${slash(lockOf(c))}'`, 'exec sleep 120']);

  const result = await runAt535(c, argv);

  assert.equal(result.exitCode, 5, detail(result));
  assert.ok(fs.existsSync(lockOf(c)), 'a plain commit never removes the lock');
  assert.ok(result.json.notices.includes(LEFT_NOTICE), JSON.stringify(result.json.notices));
});

// Static: Q18's "one module owns the markers, the spawn and the removal". Comments and the
// notice text (returned by M10, KD-R17) do not count; code lines naming the lock file or a
// marker file outside change-set.mjs do.
test('AC4: no code outside M10 names index.lock or a marker file', () => {
  const root = path.join(__dirname, '..', 'plugin');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) files.push(full);
    }
  }(root));
  assert.ok(files.length > 10);
  const hits = [];
  for (const file of files) {
    if (path.basename(file) === 'change-set.mjs') continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/index\.lock|commit-guard-(start|kill)/.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
