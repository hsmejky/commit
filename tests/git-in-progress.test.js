'use strict';

// GIT-03 (docs/roadmap/06-git-adapters.md, Q21, story 184): `plan` refuses before any run
// folder exists on an in-progress merge, cherry-pick, revert, rebase, bisect, paused
// sequence or pending `merge --squash`, all domain code `in-progress` (CLI kind `state`),
// detected from one M2 `gitPath` call (M3 `inProgressState`, review target). Seam 1 only
// (docs/spec/testing-seams.md): the shipped entry point as a subprocess through the FND-04
// harness, with each in-progress state built with real git.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

function assertNoRunFolder(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.commit-plan')), false, `.commit-plan created in ${dir}`);
}

function assertStateRefusal(result) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.equal(typeof result.json.error.message, 'string');
  return result.json.error.message;
}

// Writes file.txt with `content`, stages and commits it with the given subject.
function commitFile(c, content, subject) {
  c.writeFile('file.txt', content);
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', subject]);
  return c.git(['rev-parse', 'HEAD']).trim();
}

test('plan during a conflicted merge exits 6 state with the finish-or-abort text', async (t) => {
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

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'finish it with `git commit --no-edit`, or abort it');
  assertNoRunFolder(c.repoDir);
});

test('plan during a conflicted cherry-pick exits 6 state with the finish-or-abort text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  const pick = commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  try {
    c.git(['cherry-pick', pick]);
  } catch {
    // Conflict expected: leaves CHERRY_PICK_HEAD.
  }

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'finish it with `git commit --no-edit`, or abort it');
  assertNoRunFolder(c.repoDir);
});

test('plan during a conflicted revert exits 6 state with the finish-or-abort text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  const toRevert = commitFile(c, 'b\n', 'change to revert');
  commitFile(c, 'c\n', 'later change');
  try {
    c.git(['revert', '--no-edit', toRevert]);
  } catch {
    // Conflict expected: leaves REVERT_HEAD.
  }

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'finish it with `git commit --no-edit`, or abort it');
  assertNoRunFolder(c.repoDir);
});

test('plan during a rebase stopped at edit exits 6 state with the continue-by-hand text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  commitFile(c, 'b\n', 'to edit');
  commitFile(c, 'c\n', 'after');
  // A node script used as GIT_SEQUENCE_EDITOR: rewrites the todo's first "pick" to "edit",
  // cross-platform (no shell script needed).
  const editorScript = path.join(c.root, 'make-edit.js');
  fs.writeFileSync(editorScript, [
    "const fs = require('fs');",
    'const file = process.argv[2];',
    "const lines = fs.readFileSync(file, 'utf8').split('\\n');",
    "lines[0] = lines[0].replace(/^pick/, 'edit');",
    "fs.writeFileSync(file, lines.join('\\n'));",
    '',
  ].join('\n'));

  c.git(['rebase', '-i', 'HEAD~2'], {
    env: { GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editorScript}"` },
  });

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'continue the rebase by hand');
  assertNoRunFolder(c.repoDir);
});

test('plan during a bisect exits 6 state, naming bisect', async (t) => {
  const c = createCase(t);
  const good = commitFile(c, 'a\n', 'base');
  commitFile(c, 'b\n', 'middle');
  const bad = commitFile(c, 'c\n', 'bad');
  c.git(['bisect', 'start', bad, good]);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.match(message, /bisect/i);
  assertNoRunFolder(c.repoDir);
});

test('plan on a pending merge --squash exits 6 state with the squash text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  c.writeFile('other.txt', 'x\n');
  c.git(['add', 'other.txt']);
  c.git(['commit', '-q', '-m', 'other change']);
  c.git(['checkout', '-q', 'main']);
  c.git(['merge', '--squash', 'other']);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(
    message,
    'a squashed merge is staged: commit it by hand, or drop it with `git reset --merge`',
  );
  assertNoRunFolder(c.repoDir);
});

// Story 184, Q21: a multi-pick cherry-pick paused after its first conflicted pick was
// committed by hand (plain `git commit`, not `cherry-pick --continue`) leaves no
// CHERRY_PICK_HEAD, only `sequencer/` (the todo still lists the second pick) — still refused,
// with the paused-sequence text rather than the merge/cherry-pick/revert one.
test('plan during a paused multi-pick cherry-pick (sequencer only) exits 6 state with the continue-or-abort text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  const firstPick = commitFile(c, 'b\n', 'first pick');
  c.writeFile('second.txt', 'y\n');
  c.git(['add', 'second.txt']);
  c.git(['commit', '-q', '-m', 'second pick']);
  const secondPick = c.git(['rev-parse', 'HEAD']).trim();
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  try {
    c.git(['cherry-pick', firstPick, secondPick]);
  } catch {
    // Conflict expected on the first pick: leaves CHERRY_PICK_HEAD and sequencer/.
  }
  c.writeFile('file.txt', 'resolved\n');
  c.git(['add', 'file.txt']);
  // Plain commit, not `cherry-pick --continue`: removes CHERRY_PICK_HEAD but never advances
  // the sequencer todo, which still lists the second pick.
  c.git(['commit', '-q', '-m', 'resolved by hand']);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'continue or abort it by hand');
  assertNoRunFolder(c.repoDir);
});

test('the in-progress git-path lookups use exactly one rev-parse --git-path call', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  try {
    c.git(['merge', 'other']);
  } catch {
    // Conflict expected.
  }
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 6);
  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const gitPathCalls = entries.filter(
    (e) => Array.isArray(e.args) && e.args[0] === 'rev-parse' && e.args.includes('--git-path'),
  );
  assert.equal(gitPathCalls.length, 1, JSON.stringify(entries));
  // One call naming every marker (8 `--git-path` pairs), not one call per marker.
  const gitPathNames = gitPathCalls[0].args.filter((_, i) => gitPathCalls[0].args[i - 1] === '--git-path');
  assert.deepEqual(gitPathNames, [
    'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
    'BISECT_LOG', 'sequencer', 'SQUASH_MSG',
  ]);
});

// review-GIT-03 finding 1: a rebase stopped on a conflicting `merge` todo command leaves both
// a rebase marker (`rebase-merge`) and `MERGE_HEAD`. The rebase marker must win, so the advice
// is the rebase one, not the merge finish-or-abort text.
test('plan during a rebase stopped on a conflicting merge todo exits 6 state with the rebase text', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  // A node script used as GIT_SEQUENCE_EDITOR: rewrites the todo to a `merge` command against
  // `other`, cross-platform (no shell script needed).
  const editorScript = path.join(c.root, 'make-merge.js');
  fs.writeFileSync(editorScript, [
    "const fs = require('fs');",
    'const file = process.argv[2];',
    "fs.writeFileSync(file, 'merge other\\n');",
    '',
  ].join('\n'));

  try {
    c.git(['rebase', '-i', 'HEAD'], {
      env: { GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editorScript}"` },
    });
  } catch {
    // Conflict expected: leaves both MERGE_HEAD and rebase-merge.
  }
  // Confirms the fixture actually produced both markers (otherwise this test would pass for
  // the wrong reason).
  assert.equal(fs.existsSync(path.join(c.repoDir, '.git', 'MERGE_HEAD')), true);
  assert.equal(fs.existsSync(path.join(c.repoDir, '.git', 'rebase-merge')), true);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'continue the rebase by hand');
  assertNoRunFolder(c.repoDir);
});

// review-GIT-03 finding 2: the `gitPath` lookups go through `rev-parse --git-path`, which
// resolves relative to the calling worktree, so a linked worktree's own markers (under
// `.git/worktrees/<name>/`) are read, not the main worktree's.
test('plan during a conflicted merge in a linked worktree exits 6 state there', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');

  const wtDir = path.join(c.root, 'wt');
  c.git(['worktree', 'add', '-b', 'wt-branch', wtDir, 'main']);
  try {
    c.git(['merge', 'other'], { cwd: wtDir });
  } catch {
    // Conflict expected: leaves MERGE_HEAD under the linked worktree's own git-path.
  }

  const result = await runCommit(c, ['plan'], { cwd: wtDir });

  const message = assertStateRefusal(result);
  assert.equal(message, 'finish it with `git commit --no-edit`, or abort it');
  assertNoRunFolder(wtDir);
});

test('plan in a linked worktree goes on while only the main worktree has a merge in progress', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['checkout', '-q', '-b', 'other']);
  commitFile(c, 'b\n', 'other change');
  c.git(['checkout', '-q', 'main']);
  commitFile(c, 'c\n', 'main change');
  try {
    c.git(['merge', 'other']);
  } catch {
    // Conflict expected in the main worktree only: leaves MERGE_HEAD under the main .git.
  }

  const wtDir = path.join(c.root, 'wt');
  c.git(['worktree', 'add', '-b', 'wt-branch', wtDir, 'HEAD']);

  const result = await runCommit(c, ['plan'], { cwd: wtDir });

  // Not a refusal: the clean-tree `nothing` reply runs past `createRunFolder` (step 3), so
  // (unlike the refusal tests above) `.commit-plan` itself is expected to exist here, same as
  // the no-false-positive test below.
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

test('plan on a clean branch with no in-progress operation goes on (no false positive)', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});
