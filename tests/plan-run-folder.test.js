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

// AC1: the run-folder directory check (C:run-folder, story 207).
const REFUSAL_TEXT = '`.commit-plan` is tracked or not a plain directory; remove it by hand';

function assertRunFolderRefusal(result) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.equal(result.json.error.message, REFUSAL_TEXT, detail);
}

test('.commit-plan as a plain file refuses plan with state, and the file is unchanged', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const file = path.join(c.repoDir, '.commit-plan');
  fs.writeFileSync(file, 'mine\n');

  assertRunFolderRefusal(await runCommit(c, ['plan']));
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n');
});

test('a tracked .commit-plan path refuses plan with state, and the directory is unchanged', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  c.writeFile('.commit-plan/notes.txt', 'tracked\n');
  c.git(['add', '-f', '.commit-plan/notes.txt']);
  c.git(['commit', '-q', '-m', 'track it']);

  assertRunFolderRefusal(await runCommit(c, ['plan']));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), ['notes.txt']);
});

// A link in place of `.commit-plan` to a directory outside the repo: the refusal writes
// nothing through it (the target stays empty).
async function assertLinkRefused(t, type) {
  const c = createCase(t);
  seedCommit(c);
  const target = path.join(c.root, 'elsewhere');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, path.join(c.repoDir, '.commit-plan'), type);
  } catch (err) {
    // A Windows directory symlink needs Developer Mode or an elevated shell.
    if (err.code === 'EPERM' && type === 'dir') return t.skip('creating a directory symlink needs privileges here');
    throw err;
  }

  assertRunFolderRefusal(await runCommit(c, ['plan']));
  assert.deepEqual(fs.readdirSync(target), []);
}

test('a symlinked .commit-plan refuses plan with state, and nothing is written through it', async (t) => {
  await assertLinkRefused(t, 'dir');
});

// Junctions exist only on Windows; POSIX has the symlink case above.
test('a .commit-plan junction refuses plan with state, and nothing is written through it',
  { skip: process.platform !== 'win32' && 'junctions are Windows-only' },
  async (t) => {
    await assertLinkRefused(t, 'junction');
  });
