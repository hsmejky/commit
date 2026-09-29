'use strict';

// PRE-09 (docs/roadmap/00-prerequisites-and-spikes.md): proof that the temporary index
// (Q11 step 1, docs/decisions/q11-atomic-commits-by-functionality.md) behaves as the
// change-set engine (M10) will assume. Each repo is built fresh in an OS temp directory with
// a fixed author, committer and dates via env, isolated from any host git config, and
// removed after the test.
//
// This test is deliberately version-agnostic: it names no git version and skips nothing, so
// the same assertions run unmodified on the current release here and on git 2.34 in the
// `ubuntu:22.04` CI container job (FND-03, not yet built). It was run locally only against
// the git release installed on this machine; see the roadmap slice's commit message for the
// exact version. If a future CI run on git 2.34 disagrees with these assertions, that is a
// Q11 amendment, not a change to this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: 'Commit Test',
  GIT_AUTHOR_EMAIL: 'commit-test@example.com',
  GIT_COMMITTER_NAME: 'Commit Test',
  GIT_COMMITTER_EMAIL: 'commit-test@example.com',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
};

// Builds a fresh repo in its own temp directory, isolated from the host's git config (no
// system or user config, fixed HOME) so the check does not depend on what is installed on
// this machine. Returns the repo directory and the env every git call in the test should use.
function makeRepo() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-pre09-'));
  const emptyConfig = path.join(homeDir, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const repoDir = path.join(homeDir, 'repo');
  fs.mkdirSync(repoDir);
  const env = {
    ...process.env,
    ...FIXED_IDENTITY,
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
  };
  return { homeDir, repoDir, env };
}

function git(repoDir, env, args, extraEnv) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    env: extraEnv ? { ...env, ...extraEnv } : env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function writeFile(repoDir, relPath, content) {
  fs.writeFileSync(path.join(repoDir, relPath), content);
}

function commitAll(repoDir, env, message) {
  git(repoDir, env, ['add', '-A']);
  git(repoDir, env, ['commit', '-q', '-m', message]);
}

// Copies the real index into a sibling file and resets that copy to HEAD, as Q11 step 1
// prescribes ("Copy the real index to git-index in the run folder and git reset -q the
// copy"). Returns the copy's path, to be passed as GIT_INDEX_FILE.
function copyIndexResetToHead(repoDir, env) {
  const indexCopy = path.join(repoDir, '..', 'git-index');
  fs.copyFileSync(path.join(repoDir, '.git', 'index'), indexCopy);
  git(repoDir, env, ['reset', '-q'], { GIT_INDEX_FILE: indexCopy });
  return indexCopy;
}

function cleanup(t, homeDir) {
  t.after(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
}

// --- AC 1: intent-to-add paths diff as A, with their content ------------------------------

test('git diff -M against an index copy with a git add -N entry shows the path as A with its content', (t) => {
  const { homeDir, repoDir, env } = makeRepo();
  cleanup(t, homeDir);

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  writeFile(repoDir, 'base.txt', 'base\n');
  commitAll(repoDir, env, 'base');

  writeFile(repoDir, 'new.txt', 'hello new\n');
  const indexCopy = copyIndexResetToHead(repoDir, env);
  git(repoDir, env, ['add', '-N', 'new.txt'], { GIT_INDEX_FILE: indexCopy });

  const nameStatus = git(repoDir, env, ['diff', '-M', '--name-status'], { GIT_INDEX_FILE: indexCopy });
  assert.equal(nameStatus, 'A\tnew.txt\n');

  const full = git(repoDir, env, ['diff', '-M'], { GIT_INDEX_FILE: indexCopy });
  assert.match(full, /diff --git a\/new\.txt b\/new\.txt/);
  assert.match(full, /new file mode/);
  assert.match(full, /^\+hello new$/m);
});

// --- AC 2: a deleted path plus an intent-to-add path pair as R ----------------------------

test('a plain mv pairs as R after the temporary-index steps', (t) => {
  const { homeDir, repoDir, env } = makeRepo();
  cleanup(t, homeDir);

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  writeFile(repoDir, 'old.txt', 'alpha\nbeta\ngamma\n');
  commitAll(repoDir, env, 'base');

  fs.renameSync(path.join(repoDir, 'old.txt'), path.join(repoDir, 'renamed.txt'));

  const indexCopy = copyIndexResetToHead(repoDir, env);
  git(repoDir, env, ['add', '-N', 'renamed.txt'], { GIT_INDEX_FILE: indexCopy });

  const nameStatus = git(repoDir, env, ['diff', '-M', '--name-status'], { GIT_INDEX_FILE: indexCopy });
  assert.equal(nameStatus, 'R100\told.txt\trenamed.txt\n');
});

test('a git mv pairs as R after the temporary-index steps (step 1 deletes the old path, step 2 adds the new one)', (t) => {
  const { homeDir, repoDir, env } = makeRepo();
  cleanup(t, homeDir);

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  writeFile(repoDir, 'old2.txt', 'alpha\nbeta\ngamma\n');
  commitAll(repoDir, env, 'base');

  git(repoDir, env, ['mv', 'old2.txt', 'renamed2.txt']);

  // The staged-new path the real script would discover via the AC 3 query and add -N into
  // the copy (Q11 step 2).
  const stagedNew = git(repoDir, env, [
    'diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only',
  ]).trim();
  assert.equal(stagedNew, 'renamed2.txt');

  const indexCopy = copyIndexResetToHead(repoDir, env);
  git(repoDir, env, ['add', '-N', stagedNew], { GIT_INDEX_FILE: indexCopy });

  const nameStatus = git(repoDir, env, ['diff', '-M', '--name-status'], { GIT_INDEX_FILE: indexCopy });
  assert.equal(nameStatus, 'R100\told2.txt\trenamed2.txt\n');
});

// --- AC 3: the staged-new-paths query lists a git mv's new path, and works on an unborn HEAD

test('git diff --cached --no-renames --diff-filter=A lists only a git mv\'s new path', (t) => {
  const { homeDir, repoDir, env } = makeRepo();
  cleanup(t, homeDir);

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  writeFile(repoDir, 'old3.txt', 'content\n');
  commitAll(repoDir, env, 'base');

  git(repoDir, env, ['mv', 'old3.txt', 'renamed3.txt']);

  const names = git(repoDir, env, [
    'diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only',
  ]);
  assert.equal(names, 'renamed3.txt\n');
});

test('git diff --cached --no-renames --diff-filter=A works on an unborn HEAD', (t) => {
  const { homeDir, repoDir, env } = makeRepo();
  cleanup(t, homeDir);

  git(repoDir, env, ['init', '-q', '-b', 'main', '.']);
  // No commit yet: HEAD is unborn.
  const headRev = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir, env, encoding: 'utf8' });
  assert.notEqual(headRev.status, 0, 'HEAD must be unborn for this case');

  writeFile(repoDir, 'a.txt', 'x\n');
  writeFile(repoDir, 'b.txt', 'y\n');
  git(repoDir, env, ['add', 'a.txt', 'b.txt']);

  const names = git(repoDir, env, [
    'diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only',
  ]);
  assert.deepEqual(names.split('\n').filter(Boolean).sort(), ['a.txt', 'b.txt']);
});
