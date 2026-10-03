'use strict';

// GIT-09 (docs/roadmap/06-git-adapters.md): M3 history reads (`recentSubjects`, the last 10
// subjects; `oldMessage`; the last 200 non-merge messages for `infer`) and, with `--reword`,
// the unborn, merge-commit, root-commit and pushed facts (Q20, Q21, C:plan steps 1-2,
// C:plan-hunks, stories 176 and 177). `plan --reword` refuses an unborn or merge-commit HEAD
// (`state`) and a HEAD contained in a remote-tracking ref (`pushed`) before any run folder
// exists; a root commit is accepted and its fact stored for CHG-15. Seam 1 through the
// shipped entry point; the `infer` read, which no subcommand uses yet, through M3 itself;
// the M15 rows and the M13 output field as pure units.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;
const MERGE_TEXT = 'HEAD is a merge commit; reword it by hand';

let repoProbe;
let runPolicy;
let hunkIndex;
beforeEach(async () => {
  repoProbe = await loadLib('repo-probe');
  runPolicy = await loadLib('run-policy');
  hunkIndex = await loadLib('hunk-index');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function commitEmpty(c, subject) {
  c.git(['commit', '-q', '--allow-empty', '-m', subject]);
}

// Writes file.txt with `content`, stages and commits it with the given subject (same
// pattern as tests/git-in-progress.test.js).
function commitFile(c, content, subject) {
  c.writeFile('file.txt', content);
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', subject]);
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function folderOf(c, result) {
  return path.join(c.repoDir, '.commit-plan', result.json.planId);
}

function stored(c, result, name) {
  return JSON.parse(fs.readFileSync(path.join(folderOf(c, result), name), 'utf8'));
}

function assertNoRunFolder(c) {
  assert.equal(fs.existsSync(path.join(c.repoDir, '.commit-plan')), false, '.commit-plan was created');
}

function assertRefusal(result, kind) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, kind, detail(result));
}

// A commit object with a (fake) `gpgsig` header, written straight to the object store and
// made HEAD: with `log.showSignature=true` an unpinned `git log` would try to verify it and
// print gpg's lines on stdout ahead of the subject.
function commitSigned(c, subject) {
  const tree = c.git(['write-tree']).trim();
  const parent = c.git(['rev-parse', 'HEAD']).trim();
  const file = path.join(c.root, 'signed-commit.txt');
  fs.writeFileSync(file, [
    `tree ${tree}`,
    `parent ${parent}`,
    'author Commit Test Author <author@example.com> 1704067200 +0000',
    'committer Commit Test Committer <committer@example.com> 1704153600 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEzBAABCAAdFiEE',
    ' -----END PGP SIGNATURE-----',
    '',
    subject,
    '',
  ].join('\n'));
  const sha = c.git(['hash-object', '-t', 'commit', '-w', file]).trim();
  c.git(['update-ref', 'refs/heads/main', sha]);
}

function spawnLog(c) {
  return path.join(c.root, 'spawns.jsonl');
}

// A stub `gpg.program` (review-GIT-09 finding 2): always "verifies" and writes a fixed
// stderr line, so the signature-leak test is deterministic on hosts without a real gpg
// binary (and never spawns one, which would create `~/.gnupg` in the real HOME).
function gpgStub(c) {
  const dir = path.join(c.root, 'gpg-stub');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'fake-gpg.js');
  fs.writeFileSync(script, "process.stderr.write('gpg: Good signature from fake key\\n');\nprocess.exit(0);\n");
  if (process.platform === 'win32') {
    const wrapper = path.join(dir, 'fake-gpg.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(dir, 'fake-gpg.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function recordedGitArgs(c) {
  return fs.readFileSync(spawnLog(c), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => Array.isArray(e.args))
    .map((e) => e.args);
}

// --- AC1: recentSubjects ---

test('plan stores and returns the last 10 subjects, newest first, with log.showSignature=true not leaking', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  for (let i = 1; i <= 11; i += 1) commitEmpty(c, `feat: change ${i}`);
  commitSigned(c, 'fix: signed change');
  c.git(['config', 'log.showSignature', 'true']);
  c.git(['config', 'gpg.program', gpgStub(c)]);
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const expected = ['fix: signed change'];
  for (let i = 11; i >= 3; i -= 1) expected.push(`feat: change ${i}`);
  assert.deepEqual(stored(c, result, 'state.json').recentSubjects, expected);
  assert.deepEqual(stored(c, result, 'plan.json').recentSubjects, expected);
  assert.deepEqual(result.json.hunks.recentSubjects, expected);
});

test('plan without --reword stores no oldMessage and never runs the pushed check', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: spawnLog(c) },
  });

  assert.equal(result.exitCode, 0, detail(result));
  const state = stored(c, result, 'state.json');
  assert.deepEqual(state.recentSubjects, ['seed']);
  assert.equal(Object.hasOwn(state, 'oldMessage'), false);
  assert.equal(Object.hasOwn(result.json.hunks, 'oldMessage'), false);
  assert.deepEqual(recordedGitArgs(c).filter((args) => args.includes('for-each-ref')), []);
});

// --- AC2: the reword refusals and the root-commit fact ---

test('plan --reword on an unborn HEAD exits 6 state naming it, with no run folder and no pushed check', async (t) => {
  const c = createCase(t);

  const result = await runCommit(c, ['plan', '--reword'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: spawnLog(c) },
  });

  assertRefusal(result, 'state');
  assert.match(result.json.error.message, /unborn/);
  assertNoRunFolder(c);
  assert.deepEqual(recordedGitArgs(c).filter((args) => args.includes('for-each-ref')), []);
});

test('plan --reword during a conflicted merge refuses state before rewordFacts ever spawns (review-GIT-09 finding 5)', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  try {
    c.git(['merge', 'other']);
  } catch {
    // Conflict expected: git exits non-zero, leaving MERGE_HEAD.
  }

  const result = await runCommit(c, ['plan', '--reword'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: spawnLog(c) },
  });

  assertRefusal(result, 'state');
  assert.equal(result.json.error.message, 'finish it with `git commit --no-edit`, or abort it');
  assertNoRunFolder(c);
  assert.deepEqual(recordedGitArgs(c).filter((args) => args.includes('for-each-ref')), []);
  assert.deepEqual(recordedGitArgs(c).filter((args) => args.includes('rev-list')), []);
});

test('plan --reword on a merge commit exits 6 state with the recorded text and no run folder', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.git(['checkout', '-q', '-b', 'side']);
  commitEmpty(c, 'feat: side work');
  c.git(['checkout', '-q', 'main']);
  commitEmpty(c, 'feat: main work');
  c.git(['merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side']);

  const result = await runCommit(c, ['plan', '--reword']);

  assertRefusal(result, 'state');
  assert.equal(result.json.error.message, MERGE_TEXT);
  assertNoRunFolder(c);
});

test('plan --reword on a HEAD a remote-tracking ref points at exits 6 pushed with no run folder', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  const result = await runCommit(c, ['plan', '--reword']);

  assertRefusal(result, 'pushed');
  assert.match(result.json.error.message, /pushed/);
  assertNoRunFolder(c);
});

test('plan --reword on a HEAD behind a remote-tracking ref (another branch pushed past it) exits 6 pushed', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.git(['checkout', '-q', '-b', 'topic']);
  commitEmpty(c, 'feat: topic work');
  c.git(['update-ref', 'refs/remotes/upstream/topic', 'HEAD']);
  c.git(['checkout', '-q', 'main']);

  const result = await runCommit(c, ['plan', '--reword']);

  assertRefusal(result, 'pushed');
  assertNoRunFolder(c);
});

test('plan --reword on a HEAD ahead of every remote-tracking ref is accepted, not a root commit', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  commitEmpty(c, 'feat: not pushed yet');

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword');
  assert.equal(stored(c, result, 'state.json').rootCommit, false);
});

test('plan --reword on a root commit is accepted and stores the root-commit fact', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword');
  assert.equal(stored(c, result, 'state.json').rootCommit, true);
});

test('plan --reword on a detached HEAD behaves the same as on a branch (review-GIT-09 finding 6)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.git(['checkout', '-q', '--detach']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword');
  assert.equal(stored(c, result, 'state.json').rootCommit, true);
});

// --- AC3: oldMessage byte-exact ---

test('plan --reword on a clean tree stores oldMessage byte-exact (UTF-8) and returns it in the hunk index', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  const message = 'fix: café naïve ✓\n\nA body line with trailing spaces  \n\nSigned-off-by: Zoë <zoe@example.com>\n';
  const file = path.join(c.root, 'message.txt');
  fs.writeFileSync(file, message, 'utf8');
  c.git(['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', file]);
  c.git(['config', 'log.showSignature', 'true']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  const stateBytes = fs.readFileSync(path.join(folderOf(c, result), 'state.json'));
  assert.equal(JSON.parse(stateBytes.toString('utf8')).oldMessage, message);
  assert.equal(result.json.hunks.oldMessage, message);
  assert.deepEqual(stored(c, result, 'state.json').recentSubjects, ['fix: café naïve ✓', 'seed']);
});

test('plan --reword stores a CRLF, no-trailing-newline message byte-exact (review-GIT-09 finding 4)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  const message = 'fix: crlf\r\n\r\nbody line\r\nno trailing newline';
  const file = path.join(c.root, 'message.txt');
  fs.writeFileSync(file, message, 'utf8');
  c.git(['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', file]);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(stored(c, result, 'state.json').oldMessage, message);
  assert.equal(result.json.hunks.oldMessage, message);
});

// --- M3 directly ---

test('M3 rewordFacts on an unborn HEAD (null) spawns nothing and reports unborn', async () => {
  const facts = await repoProbe.rewordFacts({ cwd: '/nonexistent', env: {}, head: null });
  assert.deepEqual(facts, { unborn: true, merge: false, root: false, pushed: false });
});

test('M3 historyMessages returns the last 200 non-merge messages, newest first, byte-exact', async (t) => {
  const c = createCase(t);
  // 204 linear commits through fast-import (one spawn), then a merge on top.
  const lines = [];
  for (let i = 1; i <= 204; i += 1) {
    const msg = `feat: change ${i}\n\nbody ${i}\n`;
    lines.push('commit refs/heads/main', `committer T <t@example.com> ${1704067200 + i} +0000`,
      `data ${Buffer.byteLength(msg)}`, msg);
  }
  const imported = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: c.repoDir, env: c.env, input: `${lines.join('\n')}\n`,
  });
  assert.equal(imported.status, 0, String(imported.stderr));
  c.git(['checkout', '-q', '-f', 'main']);
  c.git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  commitEmpty(c, 'feat: side');
  c.git(['checkout', '-q', 'main']);
  c.git(['merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side']);
  c.git(['config', 'log.showSignature', 'true']);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const messages = await repoProbe.historyMessages({ cwd: c.repoDir, env: c.env, head });

  assert.equal(messages.length, 200);
  // The side commit carries the fixture's later committer date, so it sorts first.
  assert.equal(messages[0], 'feat: side\n');
  assert.equal(messages[1], 'feat: change 204\n\nbody 204\n');
  assert.equal(messages[199], 'feat: change 6\n\nbody 6\n');
  assert.equal(messages.some((m) => m.startsWith('Merge')), false);
  assert.deepEqual(await repoProbe.historyMessages({ cwd: c.repoDir, env: c.env, head: null }), []);
});

// --- M15 and M13 as pure units ---

test('M15 planRefusal: the reword rows come after the state rows, unborn and merge as state, then pushed', () => {
  const okGit = { status: 'ok', version: { major: 2, minor: 40, text: '2.40.0' } };
  const repo = { kind: 'worktree', toplevel: '/repo' };
  const none = { unborn: false, merge: false, root: false, pushed: false };

  assert.equal(planRefusal({ git: okGit, repo, reword: { ...none, unborn: true } }).code, 'unborn');
  const merge = planRefusal({ git: okGit, repo, reword: { ...none, merge: true, pushed: true } });
  assert.deepEqual(merge, { code: 'merge', message: MERGE_TEXT });
  assert.equal(planRefusal({ git: okGit, repo, reword: { ...none, pushed: true } }).code, 'pushed');
  assert.equal(planRefusal({ git: okGit, repo, reword: { ...none, root: true } }), null);
  assert.equal(planRefusal({ git: okGit, repo, reword: null }), null);
  // An in-progress state is refused first, ahead of any reword row.
  assert.equal(
    planRefusal({ git: okGit, repo, inProgress: { kind: 'merge' }, reword: { ...none, merge: true } }).code,
    'in-progress',
  );

  function planRefusal(facts) {
    return runPolicy.planRefusal(facts);
  }
});

test('M13 renderHunks returns oldMessage in reword mode only', () => {
  const base = { runDir: '/r', config: { values: {} }, recentSubjects: [] };
  const reword = hunkIndex.renderHunks({ ...base, mode: 'reword', oldMessage: 'fix: old\n' }, []);
  assert.equal(reword.stdoutObj.oldMessage, 'fix: old\n');
  const split = hunkIndex.renderHunks({ ...base, mode: 'split', oldMessage: 'fix: old\n' }, []);
  assert.equal(Object.hasOwn(split.stdoutObj, 'oldMessage'), false);
});
