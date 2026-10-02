'use strict';

// RUN-05 (docs/roadmap/09-runs.md): `plan` step 3 checks `.commit-plan`, adds the exclude
// line once to the common dir's `info/exclude`, mints the `planId` and creates the
// provisional run folder; `discard` removes it on every outcome that takes no lock
// (C:run-folder, C:plan step 3, M12 `create`/`discard`, stories 196 and 207). Seam 1: the
// shipped entry point as a subprocess through the FND-04 harness.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const EXCLUDE_LINE = '/.commit-plan';

function seedCommit(c) {
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
}

function excludeLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line === EXCLUDE_LINE);
}

function assertNothingReply(result) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  assert.equal(result.json.ok, true, detail);
  assert.equal(result.json.reply.status, 'nothing', detail);
}

test('plan adds the /.commit-plan exclude line once, also after a second plan', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const exclude = path.join(c.repoDir, '.git', 'info', 'exclude');

  assertNothingReply(await runCommit(c, ['plan']));
  assert.deepEqual(excludeLines(exclude), [EXCLUDE_LINE]);

  assertNothingReply(await runCommit(c, ['plan']));
  assert.deepEqual(excludeLines(exclude), [EXCLUDE_LINE]);
});

test('after plan, git status shows no .commit-plan path and .gitignore stays absent', async (t) => {
  const c = createCase(t);
  seedCommit(c);

  assertNothingReply(await runCommit(c, ['plan']));

  // Git lists no empty directory, so a file is put in the run-folder directory to show the
  // exclude line itself keeps it out.
  fs.writeFileSync(path.join(c.repoDir, '.commit-plan', 'stray'), 'x\n');
  assert.equal(c.git(['status', '--porcelain', '-uall']), '');
  assert.equal(fs.existsSync(path.join(c.repoDir, '.gitignore')), false);
});

test('in a linked worktree the exclude line goes to the common dir, once (story 196)', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const linked = path.join(c.root, 'linked');
  c.git(['worktree', 'add', '-q', linked]);
  const commonExclude = path.join(c.repoDir, '.git', 'info', 'exclude');

  assertNothingReply(await runCommit(c, ['plan'], { cwd: linked }));
  assertNothingReply(await runCommit(c, ['plan'], { cwd: linked }));

  assert.deepEqual(excludeLines(commonExclude), [EXCLUDE_LINE]);
  assert.equal(fs.existsSync(path.join(c.repoDir, '.git', 'worktrees', 'linked', 'info')), false);
  assert.deepEqual(fs.readdirSync(path.join(linked, '.commit-plan')), []);
  fs.writeFileSync(path.join(linked, '.commit-plan', 'stray'), 'x\n');
  assert.equal(c.git(['status', '--porcelain', '-uall'], { cwd: linked }), '');
  assert.equal(fs.existsSync(path.join(linked, '.gitignore')), false);
});

test('plan on a clean tree leaves no <planId> folder and no lock', async (t) => {
  const c = createCase(t);
  seedCommit(c);

  const result = await runCommit(c, ['plan']);

  assertNothingReply(result);
  assert.equal(result.json.planId, null);
  assert.equal(result.json.runDir, null);
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), []);
});
