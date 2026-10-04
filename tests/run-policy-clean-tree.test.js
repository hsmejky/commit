'use strict';

// RUN-15 (docs/roadmap/09-runs.md, C:plan step 6, stories 156, 219): M15 `planRefusal`'s
// post-scan order (`staged-hit`, then the clean tree, then `signing`) and the clean tree's
// message, naming the hidden-only, collapsed-only, `stagedExcluded`-only, non-UTF-8-only,
// `dirtySubmodules`-only and `embeddedRepos`-only reasons M18 still found clean. Pure unit
// tests (review-CFG-02 finding 7's pattern): no git process, so they run on every host.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib.js');

const OK_GIT = { status: 'ok', version: { major: 2, minor: 40, text: '2.40.0' } };
const WORKTREE = { kind: 'worktree' };

test('M15 planRefusal orders staged-hit before the clean tree before signing', async () => {
  const { planRefusal } = await loadLib('run-policy');

  const stagedHit = { hidden: [], hits: ['a.txt'], notUtf8: [] };
  const clean = { hidden: { count: 1, sample: ['.env'] } };
  const signing = { ready: false };

  // staged-hit beats the clean tree and signing, even when both would also refuse.
  assert.equal(
    planRefusal({ git: OK_GIT, repo: WORKTREE, stagedHit, clean, signing }).code,
    'staged-hit',
  );
  // the clean tree beats signing, once staged-hit is clean.
  assert.equal(
    planRefusal({ git: OK_GIT, repo: WORKTREE, clean, signing }).code,
    'nothing',
  );
  // signing is reached only once staged-hit and the clean tree are both clean/absent.
  assert.equal(
    planRefusal({ git: OK_GIT, repo: WORKTREE, signing }).code,
    'signing-locked',
  );
  // a dirty tree with a locked key still refuses signing, not "nothing".
  assert.equal(
    planRefusal({ git: OK_GIT, repo: WORKTREE, signing }).message.includes('signing key locked'),
    true,
  );
});

test('M15 planRefusal names a hidden-only clean tree\'s count and path', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE, clean: { hidden: { count: 1, sample: ['.env'] } },
  });
  assert.equal(refusal.code, 'nothing');
  assert.equal(refusal.message, 'nothing to commit: 1 hidden file: `.env`');
});

test('M15 planRefusal names a hidden-only clean tree with a remainder past the sample', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE,
    clean: { hidden: { count: 7, sample: ['a', 'b', 'c', 'd', 'e'] } },
  });
  assert.equal(refusal.message, 'nothing to commit: 7 hidden files: `a`, `b`, `c`, `d`, `e`, +2 more');
});

test('M15 planRefusal names a collapsed-only clean tree\'s directory and count', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE,
    clean: { collapsed: [{ dir: 'dist', count: 412 }] },
  });
  assert.equal(refusal.message, 'nothing to commit: `dist` (412 collapsed)');
});

test('M15 planRefusal names a dirtySubmodules-only clean tree\'s path', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE, clean: { dirtySubmodules: ['libs/x'] },
  });
  assert.equal(refusal.message, 'nothing to commit: dirty submodule: `libs/x`');
});

test('M15 planRefusal names a notUtf8-only clean tree in its already-escaped \\xNN form', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE, clean: { notUtf8: ['bad\\xe9.txt'] },
  });
  assert.equal(refusal.message, 'nothing to commit: path not UTF-8: `bad\\xe9.txt`');
});

test('M15 planRefusal names an embeddedRepos-only clean tree\'s path', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE, clean: { embeddedRepos: ['nested'] },
  });
  assert.equal(refusal.message, 'nothing to commit: embedded repository: `nested`');
});

test('M15 planRefusal names a staged-but-hidden-only clean tree\'s path', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({
    git: OK_GIT, repo: WORKTREE,
    clean: { stagedExcluded: [{ path: '.env', reason: 'hidden' }] },
  });
  assert.equal(refusal.message, 'nothing to commit: staged but hidden: `.env`');
});

test('M15 planRefusal reports a plain "nothing to commit" when nothing is left to name', async () => {
  const { planRefusal } = await loadLib('run-policy');
  const refusal = planRefusal({ git: OK_GIT, repo: WORKTREE, clean: {} });
  assert.equal(refusal.message, 'nothing to commit');
});
