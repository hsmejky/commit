'use strict';

// CHG-04 (docs/roadmap/07-change-set.md): M10 `indexFingerprint` (a hash of
// `git ls-files --stage -z`, read-only, no index lock) recorded by `plan` at step 4, before
// the inventory's own git calls, stored in `state.json` and re-read at step 7 (C:plan): a
// changed fingerprint with an unchanged HEAD releases the lock, deletes the folder and
// refuses with exit 6 `diff-changed` (domain code `index-changed`), except in `reword`. All
// at Seam 1.
//
// The index change comes from the fixture itself, cross-platform: a `clean` filter on one
// file that, the first time it runs once the provisional run folder exists, stages another
// path. Its file's edit changes its size, so `git status` (step 1's HEAD state, step 4's
// inventory) decides "modified" from the stat data alone and never runs the filter; the
// first run is the step-5 snapshot diff, which reads the working-tree bytes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');

// The `index-changed` refusal text, recorded in C:cli-and-exit-codes next to `head-moved`
// (Q18); workflows.mjs emits it verbatim.
const INDEX_CHANGED_TEXT = 'the index changed since plan (staged elsewhere?), run /commit again';

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

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function folderNames(c) {
  return fs.readdirSync(runDirOf(c)).filter((name) => name !== 'lock').sort();
}

function forwardSlashes(p) {
  return p.split(path.sep).join('/');
}

// The oracle: SHA-256 hex over the raw stdout bytes of `git ls-files --stage -z`.
function fingerprintOf(c) {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  return crypto.createHash('sha256').update(result.stdout).digest('hex');
}

// A `clean` filter on `a.txt` that passes its input through and, the first time it runs
// once a provisional run folder exists in `.commit-plan/`, stages `b.txt` (outside any
// temporary index: the real one). Filters run from the toplevel.
function stagingFilter(c) {
  const marker = forwardSlashes(path.join(c.root, 'filter-fired'));
  const script = path.join(c.root, 'stager.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'for d in .commit-plan/*/; do',
    `  if [ -d "$d" ] && [ ! -e '${marker}' ]; then`,
    `    : > '${marker}'`,
    '    git add -- b.txt </dev/null >/dev/null 2>&1',
    '  fi',
    'done',
    'exec cat',
    '',
  ].join('\n'));
  c.git(['config', 'filter.stager.clean', `sh '${forwardSlashes(script)}'`]);
  c.writeFile('.gitattributes', 'a.txt filter=stager\n');
  return { marker };
}

test('plan whose index is changed between the inventory and the lock, HEAD unchanged, exits 6 diff-changed and leaves no lock or folder', async (t) => {
  const c = createCase(t);
  const filter = stagingFilter(c);
  seed(c, { '.gitattributes': 'a.txt filter=stager\n', 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const head = c.git(['rev-parse', 'HEAD']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'diff-changed');
  assert.equal(result.json.error.message, INDEX_CHANGED_TEXT);
  assert.ok(fs.existsSync(filter.marker), 'the filter never ran with a run folder in place');
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'b.txt\n', 'the fixture staged b.txt');
  assert.equal(c.git(['rev-parse', 'HEAD']), head, 'HEAD is unchanged');
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false, 'the lock is released');
  assert.deepEqual(folderNames(c), [], 'the run folder is deleted');
});

test('plan with an unchanged index stores the fingerprint of git ls-files --stage -z in state.json', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const expected = fingerprintOf(c);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const state = JSON.parse(fs.readFileSync(path.join(runDirOf(c), result.json.planId, 'state.json'), 'utf8'));
  assert.equal(state.indexFingerprint, expected);
  assert.equal(fingerprintOf(c), expected, 'plan left the index entries as they were');
});

test('the fingerprint read works while an index.lock exists and never rewrites the index', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const indexFile = path.join(c.repoDir, '.git', 'index');
  const lockFile = path.join(c.repoDir, '.git', 'index.lock');
  const expected = fingerprintOf(c);
  const before = fs.readFileSync(indexFile);
  fs.writeFileSync(lockFile, 'foreign');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const state = JSON.parse(fs.readFileSync(path.join(runDirOf(c), result.json.planId, 'state.json'), 'utf8'));
  assert.equal(state.indexFingerprint, expected);
  assert.ok(fs.readFileSync(indexFile).equals(before), 'the index is byte-identical');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'foreign', 'the foreign index.lock is left alone');
});

function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

// A `git` shim on PATH that stages `b.txt` at the first git call once `.commit-plan/lock`
// exists (step 7's HEAD re-read), then hands every call on to the real git.
function stageAfterLockShim(c) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const marker = path.join(c.root, 'shim-fired');
  const git = realGit(c);
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ] && [ -e .commit-plan/lock ]; then`,
    `  : > '${marker}'`,
    `  '${git}' add -- b.txt`,
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { env: pathOverride(c, [dir, c.env.PATH]), marker };
}

test('plan --reword does not check the index fingerprint at step 7', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('b.txt', 'two\nmore\n');
  const shim = stageAfterLockShim(c);

  const result = await runCommit(c, ['plan', '--reword'], { env: shim.env });

  assert.equal(result.exitCode, 0, detail(result));
  assert.ok(fs.existsSync(shim.marker), 'the shim never saw a call after the lock');
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'b.txt\n');
  assert.ok(fs.existsSync(path.join(runDirOf(c), 'lock')), 'the reword run keeps its lock');
});

test('plan whose index is staged after the lock is taken, in split, exits 6 diff-changed', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const shim = stageAfterLockShim(c);

  const result = await runCommit(c, ['plan'], { env: shim.env });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed');
  assert.equal(result.json.error.message, INDEX_CHANGED_TEXT);
  assert.ok(fs.existsSync(shim.marker));
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false);
  assert.deepEqual(folderNames(c), []);
});
