'use strict';

// PRE-10 (docs/roadmap/00-prerequisites-and-spikes.md): proof that an LFS-tracked change
// behaves as Q11 (docs/decisions/q11-atomic-commits-by-functionality.md, the "filtered
// files" table row) assumes: `git diff` shows the change as a pointer diff before it is
// staged, `git add` of the whole file runs the clean filter and stores the object under
// `.git/lfs/objects`, and the staged diff then matches the diff `plan` would have hashed
// beforehand. See docs/decisions/open-verification-items.md ("Filtered files (Q11)") for
// the outcome this test backs.
//
// Requires `git-lfs` on PATH; skips cleanly (reason in the skip message) when it is not
// installed, per the same item ("The test suite covers the mechanism with a `sed` clean
// filter; this spike covers LFS itself.").
//
// Verified here against the current release only. Git 2.34 coverage is the CI
// `ubuntu:22.04` container job (FND-03), not yet built; this test does not claim it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Fixed author, committer and dates, per docs/spec/testing-good-tests.md.
const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Commit Test',
  GIT_AUTHOR_EMAIL: 'commit-test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Commit Test',
  GIT_COMMITTER_EMAIL: 'commit-test@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

// The pinned diff options from Q11 ("Every diff the script runs uses pinned options"),
// so this proof exercises the exact invocation shape `plan` and `commit` will use.
const PINNED_DIFF_ARGS = [
  '--no-ext-diff', '--no-color', '--no-textconv', '--no-relative', '-U3',
  '--inter-hunk-context=0', '--indent-heuristic', '-M', '--diff-algorithm=myers',
  '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/',
];

function hasGitLfs() {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...FIXED_ENV },
    encoding: 'utf8',
  });
}

// A throwaway repo under the OS temp dir, torn down by the caller. Kept local to this
// test file rather than tests/helpers/ so a concurrently-running agent's own git-repo
// helper (PRE-09) cannot collide with it.
function makeLfsRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'commit-pre10-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Commit Test']);
  git(dir, ['config', 'user.email', 'commit-test@example.invalid']);
  git(dir, ['lfs', 'install', '--local']);
  return dir;
}

const lfsAvailable = hasGitLfs();

test(
  'an LFS-tracked change diffs as a pointer, and staging it matches the pre-add diff and stores the object',
  { skip: lfsAvailable ? false : 'git-lfs is not installed on this machine' },
  () => {
    const dir = makeLfsRepo();
    try {
      git(dir, ['lfs', 'track', '*.bin']);
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(path.join(dir, 'assets', 'data.bin'), 'hello world content v1');
      git(dir, ['add', '.gitattributes', 'assets/data.bin']);
      git(dir, ['commit', '-q', '-m', 'init']);

      const newContent = 'hello world content v2 longer';
      writeFileSync(path.join(dir, 'assets', 'data.bin'), newContent);

      // AC1: `git diff` shows the LFS-tracked change as a pointer diff, not the real bytes.
      const unstagedDiff = git(dir, ['diff', ...PINNED_DIFF_ARGS, '--', 'assets/data.bin']);
      assert.match(unstagedDiff, /^-oid sha256:[0-9a-f]{64}$/m, 'old pointer line');
      assert.match(unstagedDiff, /^\+oid sha256:[0-9a-f]{64}$/m, 'new pointer line');
      assert.doesNotMatch(unstagedDiff, /hello world content/, 'raw content must not appear in the diff');

      // AC2: `git add` of the whole file stores the object under .git/lfs/objects, keyed
      // by the content's own sha256, and the staged diff then matches the diff `plan`
      // would have hashed before the add.
      const expectedOid = createHash('sha256').update(newContent).digest('hex');
      git(dir, ['add', 'assets/data.bin']);

      const objectPath = path.join(
        dir, '.git', 'lfs', 'objects', expectedOid.slice(0, 2), expectedOid.slice(2, 4), expectedOid,
      );
      assert.ok(existsSync(objectPath), `LFS object not found at ${objectPath}`);
      assert.equal(readFileSync(objectPath, 'utf8'), newContent, 'stored object holds the real content');

      const stagedDiff = git(dir, ['diff', '--cached', ...PINNED_DIFF_ARGS, '--', 'assets/data.bin']);
      assert.equal(
        stagedDiff, unstagedDiff,
        'the staged diff must match the diff `plan` hashed before `git add`',
      );
      assert.match(stagedDiff, new RegExp(`^\\+oid sha256:${expectedOid}$`, 'm'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
