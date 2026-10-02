'use strict';

// GIT-02 (docs/roadmap/06-git-adapters.md), review-GIT-02 finding 2: direct library-level
// tests for M3 `head()`/`headTree()`, since neither has a caller through `plan` yet
// (GIT-09/EXE add that) and Seam 1 (tests/git-head-state.test.js) cannot reach them.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase } = require('./helpers/process-seam.js');

let repoProbe;
beforeEach(async () => {
  repoProbe = await loadLib('repo-probe');
});

test('head() and headTree() on a branch return the current HEAD and its tree', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  const expectedHead = c.git(['rev-parse', 'HEAD']).trim();
  const expectedTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  assert.equal(await repoProbe.head({ cwd: c.repoDir, env: c.env }), expectedHead);
  assert.equal(await repoProbe.headTree({ cwd: c.repoDir, env: c.env }), expectedTree);
});

test('head() and headTree() on a detached HEAD still return the same SHA/tree', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  c.git(['checkout', '-q', '--detach', sha]);

  assert.equal(await repoProbe.head({ cwd: c.repoDir, env: c.env }), sha);
  assert.equal(
    await repoProbe.headTree({ cwd: c.repoDir, env: c.env }),
    c.git(['rev-parse', 'HEAD^{tree}']).trim(),
  );
});

test('head() and headTree() on an unborn HEAD return null', async (t) => {
  const c = createCase(t);

  assert.equal(await repoProbe.head({ cwd: c.repoDir, env: c.env }), null);
  assert.equal(await repoProbe.headTree({ cwd: c.repoDir, env: c.env }), null);
});
