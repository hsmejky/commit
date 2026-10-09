'use strict';

// EXE-14 (docs/roadmap/10-commit-executor.md, Q18, C:commit-release): after a group's
// `git commit`, M3 `headTree()` is compared with the tree M16 recorded for the backstop
// (`writeTree`). A difference with no extra commit (a hook staged more) adds a notice naming
// the group; the commit is kept. Seam 1 only.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const HEADER = 'feat: change a';
const TREE_NOTICE = 'committed tree differs from the scanned index (group 1)';

async function oneGroupRun(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: null, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId };
}

function installNodeHook(c, script, hookName = 'pre-commit') {
  const scriptPath = path.join(c.root, `${hookName}-hook.js`);
  fs.writeFileSync(scriptPath, script);
  const hook = path.join(c.repoDir, '.git', 'hooks', hookName);
  const slash = (p) => p.replace(/[\\]/g, '/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);
}

test('a pre-commit hook that git-adds another file → exit 0, the commit holds it, a notice names group 1', async (t) => {
  const { c, planId } = await oneGroupRun(t);
  installNodeHook(c, [
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    `const repoDir = ${JSON.stringify(c.repoDir)};`,
    "fs.writeFileSync(repoDir + '/hook-added.txt', 'from the hook');",
    "execFileSync('git', ['add', '--', 'hook-added.txt'], { cwd: repoDir });",
    '',
  ].join('\n'));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const files = c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n');
  assert.deepEqual(files, ['a.txt', 'hook-added.txt']);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(result.json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.deepEqual(result.json.notices, [TREE_NOTICE]);
  assert.ok(result.json.reply.notices.includes(TREE_NOTICE), detail(result));
});

test('no hook → no tree notice', async (t) => {
  const { c, planId } = await oneGroupRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.notices, []);
});

test('a post-commit hook that adds a new file and commits it → only the another-commit notice, no tree notice', async (t) => {
  const { c, planId } = await oneGroupRun(t);
  const marker = path.join(c.root, 'extra-commit-done');
  installNodeHook(c, [
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    `const marker = ${JSON.stringify(marker)};`,
    `const repoDir = ${JSON.stringify(c.repoDir)};`,
    'if (!fs.existsSync(marker)) {',
    '  fs.writeFileSync(marker, "1");',
    "  fs.writeFileSync(repoDir + '/hook-added.txt', 'from the hook');",
    "  execFileSync('git', ['add', '--', 'hook-added.txt'], { cwd: repoDir });",
    "  execFileSync('git', ['commit', '-q', '-m', 'extra'], { cwd: repoDir });",
    '}',
    '',
  ].join('\n'), 'post-commit');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  // The tree check runs only when HEAD's first parent matched this group's own commit.
  assert.deepEqual(result.json.notices, ['another commit was made during group 1; later groups refused']);
});
