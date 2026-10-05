'use strict';

// CHG-21 (docs/roadmap/07-change-set.md): M10 `stage`'s whole-file units, staged with
// `git add -A` over their paths on stdin (both paths of a rename), ignored paths and a gitlink
// whose submodule `.gitmodules` sets to `ignore = all` in a separate `git add -A -f` (Q11, Q18,
// C:commit-release (c)). Seam 1: `plan --split`, the groups written into `state.json` as
// `check` stores them, then `commit --plan <id> --all`; each commit's tree is read back with
// git. The force-added ignored file, the staged 60-file directory under `--staged` and the
// `stage-failed` cases wait for EXE-10, EXE-11 and EXE-19 (KD-R97).

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

// review-CHG-21 L2/L3: the worktree `.gitmodules` is deleted but the real index (already
// reset to HEAD by `stage`) still holds one, so git falls back to the index blob and still
// skips the gitlink on git 2.54 (`git config --blob :.gitmodules`); without the fallback this
// fails as `mismatch` on 2.54 (git 2.34 and 2.43 stage the gitlink either way, unaffected).
test('a pointer change in a submodule with ignore = all survives a deleted worktree .gitmodules', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['config', '-f', '.gitmodules', 'submodule.libs/x.ignore', 'all']);
  c.git(['add', '.gitmodules']);
  c.git(['commit', '-q', '-m', 'ignore all']);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });
  fs.unlinkSync(path.join(c.repoDir, '.gitmodules'));

  const result = await commitGroups(c, all);

  assert.equal(result.json.commits.length, 1);
  assert.equal(rev(c, 'HEAD:libs/x'), sub.prev);
  // `.gitmodules` itself is also deleted by this scenario (plan sees the worktree deletion
  // too); the pointer change is what proves the index fallback found `ignore = all`.
  assert.equal(c.git(['diff', '--ignore-submodules=none', '--name-only', 'HEAD~1', 'HEAD']), '.gitmodules\nlibs/x\n');
});

// The plan hashes a filtered file in its cleaned form (CHG-10); `git add -A` runs the same
// filter, so the verify finds the plan's hash and the commit holds the cleaned blob.
test('a sed clean filter file is committed as its cleaned form, with the plan hash', async (t) => {
  const c = createCase(t);
  c.writeFile('clean.txt', 'keep\nme\n');
  c.writeFile('.gitattributes', 'clean.txt filter=strip\n');
  c.git(['add', '--', 'clean.txt', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'filter.strip.clean', "sed -e '/^SECRET/d'"]);
  c.writeFile('clean.txt', 'keep\nSECRET local\nme\nmore\n');

  const result = await commitGroups(c, all);

  assert.equal(result.json.commits.length, 1);
  assert.equal(c.git(['cat-file', 'blob', 'HEAD:clean.txt']), 'keep\nme\nmore\n');
  assert.equal(rev(c, 'HEAD:clean.txt'), c.git(['hash-object', '--path', 'clean.txt', 'clean.txt']).trim());
});

// Q11: whole-file paths go to `git add -A` on stdin, never on argv. 200 renames are the most
// `split` plans without collapsing new files (C:untracked-files' total cap), so the paths are
// long instead: 400 paths of about 100 characters exceed Windows' 32 767-character command
// line. The new names stay in the tracked `d/`, which the per-directory cap never collapses.
test('a rename group whose paths exceed the command-line limit is committed', async (t) => {
  const c = createCase(t);
  const stem = (i) => `d/${'r'.repeat(90)}-${String(i).padStart(3, '0')}`;
  const count = 200;
  for (let i = 0; i < count; i++) c.writeFile(`${stem(i)}.old`, `file ${i}\n`);
  c.git(['add', '--', 'd']);
  c.git(['commit', '-q', '-m', 'seed']);
  for (let i = 0; i < count; i++) {
    fs.renameSync(path.join(c.repoDir, `${stem(i)}.old`), path.join(c.repoDir, `${stem(i)}.new`));
  }

  const result = await commitGroups(c, all);

  assert.equal(result.json.commits.length, 1);
  const status = c.git(['diff', '-M', '--name-status', 'HEAD~1', 'HEAD']).trim().split('\n');
  assert.equal(status.length, count);
  assert.equal(status.filter((line) => line.startsWith('R100\t')).length, count);
  assert.equal(c.git(['ls-files', 'd']).trim().split('\n').filter((p) => p.endsWith('.new')).length, count);
});

// CHG-09: the untracked file inside the submodule is its own dirt, not a pointer change; the
// pointer change alone is staged and committed.
test('a pointer change in a submodule with untracked files inside is committed', async (t) => {
  const c = createCase(t);
  const sub = withSubmodule(c);
  c.git(['checkout', '-q', sub.prev], { cwd: sub.inner });
  fs.writeFileSync(path.join(sub.inner, 'build.out'), 'junk\n');
  c.writeFile('a.txt', 'A\n');

  const result = await commitGroups(c, all);

  assert.equal(result.json.commits.length, 1);
  assert.equal(rev(c, 'HEAD:libs/x'), sub.prev);
  assert.equal(c.git(['diff', '--ignore-submodules=none', '--name-only', 'HEAD~1', 'HEAD']), 'a.txt\nlibs/x\n');
  // The untracked file stays where it was, outside the commit.
  assert.equal(c.git(['diff', '--ignore-submodules=dirty', '--name-only', 'HEAD']), '');
  assert.equal(c.git(['status', '--porcelain'], { cwd: sub.inner }), '?? build.out\n');
});
