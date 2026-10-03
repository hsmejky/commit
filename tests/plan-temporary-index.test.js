'use strict';

// CHG-05 (docs/roadmap/07-change-set.md:134-154): Seam 1 for the temporary index built from
// the inventory's untracked candidates, staged-new paths and pre-staged paths (Q11 steps
// 1-3). The lists themselves and the snapshot's rename/A-unit behavior are pinned in-process
// in `tests/change-set-units.test.js` (KD-R1: no Seam 1 observable for the unit table before
// CHG-03b); this file only checks what `plan` (steps 4-7) wires through the shipped entry
// point: one test per AC.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');

const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unitsByPath(result, filePath) {
  return result.json.hunks.hunks.filter((entry) => entry.path === filePath);
}

test('an untracked file is an A unit; plan.json lists it under untracked.candidates with the hidden count and sample', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('newfile.txt', 'line1\nline2\n');
  for (let i = 1; i <= 7; i += 1) c.writeFile(`.h${i}`, 'x\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const added = unitsByPath(result, 'newfile.txt');
  assert.equal(added.length, 1, detail(result));
  assert.equal(added[0].status, 'A');

  const plan = readJson(path.join(result.json.runDir, 'plan.json'));
  assert.deepEqual(plan.untracked.candidates, [{ path: 'newfile.txt', bucket: 'code', binary: false }]);
  assert.equal(plan.untracked.hidden.count, 7);
  assert.deepEqual(plan.untracked.hidden.sample, ['.h1', '.h2', '.h3', '.h4', '.h5']);
});

test('a plain mv of a tracked file gives one R unit with oldPath', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': 'body\n' });
  fs.renameSync(path.join(c.repoDir, 'old.txt'), path.join(c.repoDir, 'new.txt'));

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const renames = result.json.hunks.hunks.filter((entry) => entry.status === 'R');
  assert.equal(renames.length, 1, detail(result));
  assert.equal(renames[0].path, 'new.txt');
  assert.equal(renames[0].oldPath, 'old.txt');
});

test('a git mv of a tracked file also gives one R unit with oldPath', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': 'body\n' });
  c.git(['mv', 'old.txt', 'new.txt']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const renames = result.json.hunks.hunks.filter((entry) => entry.status === 'R');
  assert.equal(renames.length, 1, detail(result));
  assert.equal(renames[0].path, 'new.txt');
  assert.equal(renames[0].oldPath, 'old.txt');
});

test('git add newfile under split gives an A unit, stored with ignored: false', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('newfile.txt', 'new\n');
  c.git(['add', 'newfile.txt']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const added = unitsByPath(result, 'newfile.txt');
  assert.equal(added.length, 1, detail(result));
  assert.equal(added[0].status, 'A');
  const state = readJson(path.join(result.json.runDir, 'state.json'));
  assert.deepEqual(state.stagedNew, [{ path: 'newfile.txt', ignored: false }]);
});

test('git add newfile on an unborn HEAD also gives an A unit', async (t) => {
  const c = createCase(t);
  c.writeFile('newfile.txt', 'new\n');
  c.git(['add', 'newfile.txt']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const added = unitsByPath(result, 'newfile.txt');
  assert.equal(added.length, 1, detail(result));
  assert.equal(added[0].status, 'A');
});

test('a force-added gitignored file is a unit, stored with ignored: true', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', '.gitignore': 'ignored.txt\n' });
  c.writeFile('ignored.txt', 'secret\n');
  c.git(['add', '-f', 'ignored.txt']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const added = unitsByPath(result, 'ignored.txt');
  assert.equal(added.length, 1, detail(result));
  assert.equal(added[0].status, 'A');
  const state = readJson(path.join(result.json.runDir, 'state.json'));
  assert.deepEqual(state.stagedNew, [{ path: 'ignored.txt', ignored: true }]);
});

test('on an unborn HEAD, git add newfile && git mv newfile renamed gives one A unit for renamed, no R', async (t) => {
  const c = createCase(t);
  c.writeFile('newfile', 'x\n');
  c.git(['add', 'newfile']);
  c.git(['mv', 'newfile', 'renamed']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => [entry.path, entry.status, entry.oldPath]),
    [['renamed', 'A', null]],
    detail(result),
  );
});

test('the real index is byte-identical before and after plan', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('untracked.txt', 'new\n');
  c.writeFile('staged.txt', 'staged\n');
  c.git(['add', 'staged.txt']);
  const before = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: c.repoDir, env: c.env });
  assert.equal(before.status, 0, String(before.stderr));

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const after = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: c.repoDir, env: c.env });
  assert.equal(after.status, 0, String(after.stderr));
  assert.ok(after.stdout.equals(before.stdout), 'the real index changed');
});

// A `git` shim on PATH that fails every `add` call (the temporary index's `git add -N`) and
// delegates everything else to the real git, cross-platform-safe because it only runs on
// POSIX (KD-R21).
function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

function failingAddShim(c) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const git = realGit(c);
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "add" ]; then',
    '  exit 1',
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return pathOverride(c, [dir, c.env.PATH]);
}

test('a failing git add -N into the temporary index exits 4 git and leaves no run folder', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('newfile.txt', 'new\n');
  const env = failingAddShim(c);

  const result = await runCommit(c, ['plan'], { env });

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), []);
});
