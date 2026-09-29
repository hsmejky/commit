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
// filter; this spike covers LFS itself."), *unless* `COMMIT_REQUIRE_LFS=1` is set, in which
// case a missing git-lfs fails the test instead of skipping it: the CI `ubuntu:22.04`
// min-git container job (FND-03) installs git-lfs, sets that variable, and runs git 2.34.1,
// so a broken container image is caught there rather than silently skipping.
//
// Verified against the current release locally, and against git 2.34.1 with git-lfs in the
// CI `ubuntu:22.04` min-git container job (FND-03). See
// docs/decisions/open-verification-items.md ("Filtered files (Q11)") for both runs.

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

// The pinned diff options and `-c` config pins from Q11 ("Every diff the script runs uses
// pinned options ... from the toplevel"), so this proof exercises the exact invocation shape
// `plan` and `commit` will use, not a bare `git diff`. Matches
// tests/temporary-index.test.js (PRE-09) verbatim.
const PINNED_DIFF_ARGS = [
  '--no-ext-diff', '--no-color', '--no-textconv', '--no-relative', '-U3',
  '--inter-hunk-context=0', '--indent-heuristic', '-M', '--diff-algorithm=myers',
  '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/',
];
const PINNED_CONFIG_ARGS = ['-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false'];

// Q9: every git call drops every inherited `GIT_*` environment variable, so a variable set
// on the host (or by whatever launched this test run) cannot influence the checks here. The
// env each call needs (fixed identity, git-config isolation, and — for diff calls only —
// literal pathspecs) is set explicitly by the caller, not inherited.
function withoutInheritedGitVars(env) {
  const filtered = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('GIT_')) filtered[key] = value;
  }
  return filtered;
}

// Isolated from the host's git config (no system or user config, fixed HOME) so the checks
// do not depend on what is installed on this machine, mirroring
// tests/temporary-index.test.js's makeRepo() (PRE-09). Returns the base env (used for
// `init`/`config`/`lfs`/`add`/`commit`) and a variant with `GIT_LITERAL_PATHSPECS=1` added
// (Q9: only the `diff` calls run with it, which is what makes this proof's `diff` calls the
// exact invocation shape `plan` and `commit` will use). The caller owns `homeDir` and
// removes it.
function buildEnv(homeDir) {
  const emptyConfig = path.join(homeDir, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const env = {
    ...withoutInheritedGitVars(process.env),
    ...FIXED_ENV,
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
  };
  return { env, diffEnv: { ...env, GIT_LITERAL_PATHSPECS: '1' } };
}

function git(cwd, env, args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

// Raw bytes, not decoded, per Q11: a diff's content must be compared byte-for-byte, not as
// a possibly-lossy UTF-8 string.
function gitBuffer(cwd, env, args) {
  return execFileSync('git', args, { cwd, env });
}

function hasGitLfs() {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'commit-pre10-probe-'));
  try {
    const { env } = buildEnv(homeDir);
    execFileSync('git', ['lfs', 'version'], { env, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// A throwaway repo under the OS temp dir, torn down by the caller. Kept local to this
// test file rather than tests/helpers/ so a concurrently-running agent's own git-repo
// helper (PRE-09) cannot collide with it.
function makeLfsRepo() {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'commit-pre10-'));
  const { env, diffEnv } = buildEnv(homeDir);
  const dir = path.join(homeDir, 'repo');
  mkdirSync(dir);
  git(dir, env, ['init', '-q', '-b', 'main']);
  git(dir, env, ['config', 'user.name', 'Commit Test']);
  git(dir, env, ['config', 'user.email', 'commit-test@example.invalid']);
  git(dir, env, ['lfs', 'install', '--local']);
  return { dir, homeDir, env, diffEnv };
}

const lfsAvailable = hasGitLfs();
const requireLfs = process.env.COMMIT_REQUIRE_LFS === '1';

test(
  'an LFS-tracked change diffs as a pointer, and staging it matches the pre-add diff and stores the object',
  { skip: lfsAvailable || requireLfs ? false : 'git-lfs is not installed on this machine' },
  () => {
    if (!lfsAvailable) {
      assert.fail(
        'COMMIT_REQUIRE_LFS=1 is set but git-lfs is not installed (expected in the CI '
        + 'ubuntu:22.04 container job, FND-03, which installs it)',
      );
    }

    const { dir, homeDir, env, diffEnv } = makeLfsRepo();
    try {
      git(dir, env, ['lfs', 'track', '*.bin']);
      mkdirSync(path.join(dir, 'assets'));
      writeFileSync(path.join(dir, 'assets', 'data.bin'), 'hello world content v1');
      git(dir, env, ['add', '.gitattributes', 'assets/data.bin']);
      git(dir, env, ['commit', '-q', '-m', 'init']);

      const newContent = 'hello world content v2 longer';
      writeFileSync(path.join(dir, 'assets', 'data.bin'), newContent);

      // AC1: `git diff` shows the LFS-tracked change as a pointer diff, not the real bytes.
      const unstagedDiffBuf = gitBuffer(
        dir, diffEnv, [...PINNED_CONFIG_ARGS, 'diff', ...PINNED_DIFF_ARGS, '--', 'assets/data.bin'],
      );
      const unstagedDiff = unstagedDiffBuf.toString('utf8');
      assert.match(unstagedDiff, /^-oid sha256:[0-9a-f]{64}$/m, 'old pointer line');
      assert.match(unstagedDiff, /^\+oid sha256:[0-9a-f]{64}$/m, 'new pointer line');
      assert.doesNotMatch(unstagedDiff, /hello world content/, 'raw content must not appear in the diff');

      // AC2: `git add` of the whole file stores the object under .git/lfs/objects, keyed
      // by the content's own sha256, and the staged diff then matches the diff `plan`
      // would have hashed before the add.
      const expectedOid = createHash('sha256').update(newContent).digest('hex');
      git(dir, env, ['add', 'assets/data.bin']);

      const objectPath = path.join(
        dir, '.git', 'lfs', 'objects', expectedOid.slice(0, 2), expectedOid.slice(2, 4), expectedOid,
      );
      assert.ok(existsSync(objectPath), `LFS object not found at ${objectPath}`);
      assert.equal(readFileSync(objectPath, 'utf8'), newContent, 'stored object holds the real content');

      const stagedDiffBuf = gitBuffer(
        dir, diffEnv,
        [...PINNED_CONFIG_ARGS, 'diff', '--cached', ...PINNED_DIFF_ARGS, '--', 'assets/data.bin'],
      );
      assert.deepEqual(
        stagedDiffBuf, unstagedDiffBuf,
        'the staged diff must match the diff `plan` hashed before `git add`, byte for byte',
      );
      assert.match(
        stagedDiffBuf.toString('utf8'), new RegExp(`^\\+oid sha256:${expectedOid}$`, 'm'),
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
);
