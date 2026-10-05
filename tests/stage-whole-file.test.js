'use strict';

// CHG-21 (docs/roadmap/07-change-set.md): M10 `stage`'s whole-file units, staged with
// `git add -A` over their paths on stdin (both paths of a rename), ignored paths and a gitlink
// whose submodule `.gitmodules` sets to `ignore = all` in a separate `git add -A -f` (Q11, Q18,
// C:commit-release (c)). Seam 1: `plan --split`, the groups written into `state.json` as
// `check` stores them, then `commit --plan <id> --all`; each commit's tree is read back with
// git.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// `plan --split`, then `pick(units)` → one ID list per group, written as `check` stores them,
// then `commit --all`.
async function commitGroups(c, pick) {
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const statePath = path.join(planned.json.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = pick(state.units).map((units, i) => ({
    n: i + 1, units, header: `feat: group ${i + 1}`, body: '', committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const result = await runCommit(c, ['commit', '--plan', planned.json.planId, '--all']);
  assert.equal(result.exitCode, 0, detail(result));
  return result;
}

const all = (units) => [units.map((unit) => unit.id)];
const rev = (c, spec, cwd) => c.git(['rev-parse', spec], cwd === undefined ? {} : { cwd }).trim();

// A superproject with `a.txt` and a submodule at `libs/x` whose source repo has two commits,
// checked out at the newer one.
function withSubmodule(c) {
  const sourceDir = path.join(c.root, 'sub');
  fs.mkdirSync(sourceDir);
  c.git(['init', '-q', '-b', 'main', '.'], { cwd: sourceDir });
  fs.writeFileSync(path.join(sourceDir, 'inner.txt'), 'one\n');
  c.git(['add', 'inner.txt'], { cwd: sourceDir });
  c.git(['commit', '-q', '-m', 'one'], { cwd: sourceDir });
  fs.writeFileSync(path.join(sourceDir, 'inner.txt'), 'two\n');
  c.git(['commit', '-q', '-am', 'two'], { cwd: sourceDir });

  c.writeFile('a.txt', 'a\n');
  c.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sourceDir, 'libs/x']);
  c.git(['add', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const inner = path.join(c.repoDir, 'libs', 'x');
  return { inner, prev: rev(c, 'HEAD~1', inner) };
}

// A plain `git add -A` skips this gitlink with a hint and exits 0 on newer git (2.54), so
// without `-f` the verify finds no pointer change staged and the group refuses `mismatch`
// (review-CHG-09 finding 1); git 2.34 stages it either way.
test('a pointer change in a submodule with ignore = all in .gitmodules is committed', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['config', '-f', '.gitmodules', 'submodule.libs/x.ignore', 'all']);
  c.git(['add', '.gitmodules']);
  c.git(['commit', '-q', '-m', 'ignore all']);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });

  const result = await commitGroups(c, all);

  assert.equal(result.json.commits.length, 1);
  assert.equal(rev(c, 'HEAD:libs/x'), sub.prev);
  assert.equal(c.git(['diff', '--ignore-submodules=none', '--name-only', 'HEAD~1', 'HEAD']), 'libs/x\n');
});
