'use strict';

// RUN-05 (docs/roadmap/09-runs.md): `plan` step 3 checks `.commit-plan`, adds the exclude
// line once to the common dir's `info/exclude`, mints the `planId` and creates the
// provisional run folder; `discard` removes it on every outcome that takes no lock
// (C:run-folder, C:plan step 3, M12 `create`/`discard`, stories 196 and 207). Seam 1: the
// shipped entry point as a subprocess through the FND-04 harness.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let repoProbe;
let workflows;
beforeEach(async () => {
  repoProbe = await loadLib('repo-probe');
  workflows = await loadLib('workflows');
});

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

// review-RUN-05 finding 5: the tracked case names the actual variant found, not always
// `.commit-plan` itself.
function trackedRefusalText(variant) {
  return `\`${variant}\` is tracked; remove it by hand`;
}

// A refusal returns before the exclude line is added (review-RUN-05 finding 11).
function excludeText(c) {
  return fs.readFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), 'utf8');
}

function assertRunFolderRefusal(result, expectedMessage = REFUSAL_TEXT) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.equal(result.json.error.message, expectedMessage, detail);
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
  const before = excludeText(c);

  assertRunFolderRefusal(await runCommit(c, ['plan']), trackedRefusalText('.commit-plan'));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), ['notes.txt']);
  assert.equal(excludeText(c), before);
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
  const before = excludeText(c);

  assertRunFolderRefusal(await runCommit(c, ['plan']));
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(excludeText(c), before);
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

// review-RUN-05 finding 1: a case-variant tracked `.commit-plan` (`.Commit-Plan/...`) is the
// same directory on a case-insensitive filesystem (Windows, macOS), so it refuses `plan` on
// every platform. The index entry is added without a working-tree file, so this case runs the
// same on a case-sensitive and a case-insensitive filesystem.
function trackWithoutFile(c, relPath) {
  const blob = c.git(['rev-parse', 'HEAD:README.md']).trim();
  c.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${relPath}`]);
}

test('a case-variant tracked .Commit-Plan path refuses plan with state, info/exclude untouched', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  trackWithoutFile(c, '.Commit-Plan/notes.txt');
  const before = excludeText(c);

  assertRunFolderRefusal(await runCommit(c, ['plan']), trackedRefusalText('.Commit-Plan'));
  assert.equal(excludeText(c), before);
});

test('isTracked matches .commit-plan and paths under it in any ASCII case, nothing else', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  for (const relPath of ['x/.commit-plan', '.commit-planner/a', '.commit-plan.bak']) trackWithoutFile(c, relPath);
  const ask = () => repoProbe.isTracked('.commit-plan', { cwd: c.repoDir, env: c.env });

  assert.equal(await ask(), null);
  trackWithoutFile(c, '.COMMIT-PLAN');
  assert.equal(await ask(), '.COMMIT-PLAN');
  c.git(['rm', '-q', '--cached', '.COMMIT-PLAN']);
  trackWithoutFile(c, '.Commit-Plan/deep/notes.txt');
  assert.equal(await ask(), '.Commit-Plan');
});

// review-RUN-05 finding 7: the index is sorted bytewise, so every case variant and every
// `.commit-plan/…` path sorts strictly before `.commit-plan0`; the scan stops there without
// missing one. An upper-case variant and a subpath are both planted past that bound.
test('isTracked early exit does not miss a case variant or a subpath past the bound', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  trackWithoutFile(c, '.commit-plan0'); // sorts just past the bound; not a match
  trackWithoutFile(c, '.commit-planZ'); // sorts well past the bound; not a match
  const ask = () => repoProbe.isTracked('.commit-plan', { cwd: c.repoDir, env: c.env });

  assert.equal(await ask(), null);
  trackWithoutFile(c, '.Commit-Plan'); // an upper-case variant, sorting before the bound
  assert.equal(await ask(), '.Commit-Plan');
  c.git(['rm', '-q', '--cached', '.Commit-Plan']);
  trackWithoutFile(c, '.commit-plan/x'); // a subpath, also sorting before the bound
  assert.equal(await ask(), '.commit-plan');
});

// review-RUN-05 finding 6: the tracked check reads the index without a pathspec, so an
// inherited `GIT_LITERAL_PATHSPECS` (which GIT-05 also pins) cannot hide a tracked path.
test('an exported GIT_LITERAL_PATHSPECS=1 still refuses a tracked .commit-plan', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  trackWithoutFile(c, '.commit-plan/notes.txt');

  assertRunFolderRefusal(
    await runCommit(c, ['plan'], { env: { GIT_LITERAL_PATHSPECS: '1' } }),
    trackedRefusalText('.commit-plan'),
  );
});

// Whether the filesystem under `dir` folds case (Windows and macOS defaults).
function foldsCase(dir) {
  fs.writeFileSync(path.join(dir, 'case-probe'), '');
  return fs.existsSync(path.join(dir, 'CASE-PROBE'));
}

// review-RUN-05 finding 1 as the threat itself: on a case-insensitive filesystem the tracked
// `.Commit-Plan/` directory is what `.commit-plan` resolves to, and nothing is written into it.
test('on a case-insensitive filesystem a checked-out .Commit-Plan/ refuses plan, nothing written into it', async (t) => {
  const c = createCase(t);
  if (!foldsCase(c.root)) return t.skip('the filesystem here is case-sensitive');
  seedCommit(c);
  c.writeFile('.Commit-Plan/notes.txt', 'tracked\n');
  c.git(['add', '-f', '.Commit-Plan/notes.txt']);
  c.git(['commit', '-q', '-m', 'track it']);
  const before = excludeText(c);

  assertRunFolderRefusal(await runCommit(c, ['plan']), trackedRefusalText('.Commit-Plan'));
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.Commit-Plan')), ['notes.txt']);
  assert.equal(excludeText(c), before);
});

// review-RUN-05 finding 4: `plan` discards the provisional folder in its `finally`; a removal
// error there never changes the outcome or replaces the original error (C:run-folder). In
// process, so `fs.rmSync` can fail the way a Windows file lock past its retries does.
function failRemoval(t) {
  const fsModule = require('node:fs');
  t.mock.method(fsModule, 'rmSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });
}

function planInProcess(c) {
  const injected = { env: c.env, now: () => Date.UTC(2026, 0, 1), claudeHome: c.claudeHome, cwd: c.repoDir };
  return workflows.plan({}, injected, { cwd: c.repoDir });
}

test('a discard that cannot remove the folder keeps the nothing outcome and adds a notice', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  failRemoval(t);

  const result = await planInProcess(c);
  t.mock.restoreAll();

  assert.equal(result.output.reply.status, 'nothing');
  const [planId] = fs.readdirSync(path.join(c.repoDir, '.commit-plan'));
  assert.deepEqual(result.output.reply.notices, [
    `run folder \`.commit-plan/${planId}\` was not removed (EBUSY); the 24-hour sweep removes it`,
  ]);
});

test('a discard that cannot remove the folder never replaces the original error of plan', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  c.writeFile('README.md', 'changed\n');
  failRemoval(t);
  // CHG-03b: the original error is now a failed `state.json` rename at step 7.
  t.mock.method(require('node:fs'), 'renameSync', () => {
    throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
  });

  const thrown = await planInProcess(c).then(() => null, (err) => err);
  t.mock.restoreAll();

  assert.equal(thrown && thrown.code, 'EIO');
});
