'use strict';

// EXE-15 (docs/roadmap/10-commit-executor.md): hook-rewrite detection. In `split`, while a
// later group is still pending, the worktree diff's hash set right before and right after a
// group's own `git commit` call is compared (that group's own committed hashes taken out
// first). A difference records `treeChangedDuringCommit: n` in the run state (C:commit-release,
// Q18), and the next group's `unmatched` (`diff-changed`) refusal then names that group as the
// likely cause of a repo hook (lint-staged, a formatter) rewriting files, instead of the
// generic "files changed since plan" text.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const UNMATCHED_TEXT = 'files changed since plan, run /commit again';
function hookRewriteText(n) {
  return `files changed during the commit of group ${n} — a repo hook (lint-staged, a `
    + 'formatter) likely rewrote them; run /commit again';
}

// Two committed files, each modified, a `plan --split` run, and two stored groups, one per
// file, in a, b order, as `check` stores them.
async function twoGroupRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: `feat: change ${name}`,
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed };
}

// A fixture `pre-commit` hook (runs during every `git commit` in the repo) that, only on its
// first invocation, rewrites `b.txt`'s tracked content in the worktree. A marker file stops
// it from acting again during group 2's own commit.
function installRewriteHook(c) {
  const marker = path.join(c.root, 'rewrite-done');
  const bPath = path.join(c.repoDir, 'b.txt');
  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    `const bPath = ${JSON.stringify(bPath)};`,
    'if (!fs.existsSync(marker)) {',
    "  fs.writeFileSync(marker, '1');",
    "  fs.writeFileSync(bPath, 'b\\nrewritten-by-hook\\n');",
    '}',
    '',
  ].join('\n'));
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  const slash = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);
}

test('a pre-commit hook rewrites group 2\'s file during group 1\'s commit → group 2 refused diff-changed naming group 1 as the likely hook-rewrite cause', async (t) => {
  const { c, planId, seed } = await twoGroupRun(t);
  installRewriteHook(c);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, hookRewriteText(1), detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: 'feat: change a' }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
  assert.equal(
    fs.readFileSync(path.join(c.repoDir, 'b.txt'), 'utf8'),
    'b\nrewritten-by-hook\n',
    "the hook's rewrite is left in the worktree, never committed",
  );
});

test('two groups and no hook, group 2 edited after plan → the generic text, not the hook-rewrite variant (treeChangedDuringCommit never set)', async (t) => {
  const { c, planId, seed } = await twoGroupRun(t);
  c.writeFile('b.txt', 'b\nedited after plan\n');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT, detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
});
