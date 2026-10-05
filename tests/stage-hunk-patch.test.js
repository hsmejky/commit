'use strict';

// CHG-20 (docs/roadmap/07-change-set.md): M10 `stage` on the real index builds a patch from
// the current ranges (git's own per-file header lines verbatim, then the group's raw hunk
// bytes) and applies it with `git apply --cached --whitespace=nowarn` (Q11, Q18,
// C:commit-release (c)), so a file split across groups commits each group's hunks only.
// Seam 1: `plan --split`, the groups written into `state.json` as `check` stores them, then
// `commit --plan <id> --all`; each commit's tree is read back with git.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function numbered(count, prefix = 'line') {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

// Replaces the 1-based lines of `text` named in `edits` (line number → new text, which may
// hold a newline to add a line).
function edit(text, edits) {
  const lines = text.split('\n');
  for (const [n, next] of Object.entries(edits)) lines[Number(n) - 1] = next;
  return lines.join('\n');
}

// `plan --split`, then `pick(units)` → one ID list per group (stored units in file order),
// written as `check` stores them, then `commit --all`.
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

const ids = (units, file) => units.filter((unit) => unit.path === file).map((unit) => unit.id);
const show = (c, rev, file) => c.git(['cat-file', 'blob', `${rev}:${file}`]);

test('three hunks of one file in two groups: group 2 staged at its shifted range', async (t) => {
  const c = createCase(t);
  const base = numbered(40);
  seed(c, { 'f.txt': base });
  // Hunk 1 adds a line, so hunk 2's range shifts by one once group 1 is committed.
  const edits = { 5: 'five\nfive more', 20: 'twenty', 35: 'thirty-five' };
  c.writeFile('f.txt', edit(base, edits));

  const result = await commitGroups(c, (units) => {
    const [h1, h2, h3] = ids(units, 'f.txt');
    return [[h1, h3], [h2]];
  });

  assert.equal(result.json.commits.length, 2);
  assert.equal(show(c, 'HEAD~1', 'f.txt'), edit(base, { 5: edits[5], 35: edits[35] }));
  assert.equal(show(c, 'HEAD', 'f.txt'), edit(base, edits));
  assert.equal(c.git(['diff', '--numstat', 'HEAD~1', 'HEAD']), '1\t1\tf.txt\n');
});

test('a capped file (body "cap") with two hunks in two groups: each commit holds its hunk', async (t) => {
  const c = createCase(t);
  const d = numbered(40, 'd');
  seed(c, { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'src/c.js': 'c\n', 'src/d.js': d });
  c.writeFile('src/a.js', `a\n${numbered(1000, 'a')}`);
  c.writeFile('src/b.js', `b\n${numbered(1000, 'b')}`);
  c.writeFile('src/c.js', `c\n${numbered(997, 'c')}`);
  c.writeFile('src/d.js', edit(d, { 3: 'changed 3', 30: 'changed 30' }));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  assert.deepEqual(planned.json.hunks.hunks.filter((e) => e.path === 'src/d.js').map((e) => e.body), ['cap', 'cap']);
  fs.rmSync(path.join(c.repoDir, '.commit-plan'), { recursive: true, force: true });

  await commitGroups(c, (units) => {
    const last = ids(units, 'src/d.js')[1];
    return [units.map((unit) => unit.id).filter((id) => id !== last), [last]];
  });

  assert.equal(show(c, 'HEAD~1', 'src/d.js'), edit(d, { 3: 'changed 3' }));
  assert.equal(show(c, 'HEAD', 'src/d.js'), edit(d, { 3: 'changed 3', 30: 'changed 30' }));
  assert.equal(c.git(['diff', '--name-only', 'HEAD~1', 'HEAD']), 'src/d.js\n');
});

test('a trailing-whitespace hunk under apply.whitespace=error is committed as planned', async (t) => {
  const c = createCase(t);
  const base = numbered(40);
  seed(c, { 'f.txt': base });
  c.git(['config', 'apply.whitespace', 'error']);
  const edits = { 5: 'five   ', 30: 'thirty' };
  c.writeFile('f.txt', edit(base, edits));

  await commitGroups(c, (units) => ids(units, 'f.txt').map((id) => [id]));

  assert.equal(show(c, 'HEAD~1', 'f.txt'), edit(base, { 5: edits[5] }));
  assert.equal(show(c, 'HEAD', 'f.txt'), edit(base, edits));
});

// git quotes a path holding a quote, a tab or a newline in its patch header lines; the
// built patch reuses them verbatim. Windows allows none of those in a file name, so there
// the path has a leading space, inner spaces and a non-ASCII character instead.
const ODD = process.platform === 'win32' ? ' odd näme x.txt' : ' odd "näme"\tx\ny.txt';

test('a path git quotes, split into two groups, is committed through the built patch', async (t) => {
  const c = createCase(t);
  const base = numbered(40);
  seed(c, { [ODD]: base, 'plain.txt': 'p\n' });
  const edits = { 5: 'five', 30: 'thirty' };
  c.writeFile(ODD, edit(base, edits));
  c.writeFile('plain.txt', 'P\n');

  await commitGroups(c, (units) => {
    const [h1, h2] = ids(units, ODD);
    return [[h1, ...ids(units, 'plain.txt')], [h2]];
  });

  assert.equal(show(c, 'HEAD~1', ODD), edit(base, { 5: edits[5] }));
  assert.equal(show(c, 'HEAD', ODD), edit(base, edits));
  assert.equal(show(c, 'HEAD~1', 'plain.txt'), 'P\n');
});

// review-CHG-20 High-1: a `-diff` text file (resolveHiddenBinaries turns its binary unit into
// `kind: "text"` with no `fileHash`, change-set.mjs ~997-1008) must stay a whole-file unit in
// `stage`, not be mistaken for a real per-hunk `M text` unit (`hunkLevel`, ~1363): re-diffing
// it with `--text` dropped would make git call it binary again, failing the group with
// `mismatch` (exit 6 `diff-changed`, EXE-10). Its own group, beside a split plain file, so
// `commit --all` exercises both the whole-file and the hunk-patch path in the same run.
test('a hidden text file (-diff) in its own group is committed whole, not through a hunk patch', async (t) => {
  const c = createCase(t);
  const base = numbered(10);
  seed(c, { 'h.txt': base, 'p.txt': 'p\n', '.gitattributes': 'h.txt -diff\n' });
  c.writeFile('h.txt', edit(base, { 3: 'three changed' }));
  c.writeFile('p.txt', 'P\n');

  const result = await commitGroups(c, (units) => [ids(units, 'h.txt'), ids(units, 'p.txt')]);

  assert.equal(result.json.commits.length, 2);
  assert.equal(show(c, 'HEAD~1', 'h.txt'), edit(base, { 3: 'three changed' }));
  assert.equal(show(c, 'HEAD', 'p.txt'), 'P\n');
});

// CHG-07's sparse-checkout fixture (tests/plan-units-config.test.js), now committed.
test('a sparse checkout committed: out-of-cone and skip-worktree paths keep their HEAD content', async (t) => {
  const c = createCase(t);
  seed(c, { 'inside/a.txt': numbered(20), 'outside/b.txt': 'b\n', 'kept.txt': 'k\n' });
  c.git(['sparse-checkout', 'set', '--cone', 'inside']);
  assert.equal(fs.existsSync(path.join(c.repoDir, 'outside', 'b.txt')), false);
  c.git(['update-index', '--skip-worktree', 'kept.txt']);
  fs.rmSync(path.join(c.repoDir, 'kept.txt'), { force: true });
  c.writeFile('inside/a.txt', edit(numbered(20), { 2: 'two', 18: 'eighteen' }));

  await commitGroups(c, (units) => {
    assert.deepEqual(units.map((unit) => unit.path), ['inside/a.txt', 'inside/a.txt']);
    return units.map((unit) => [unit.id]);
  });

  assert.equal(show(c, 'HEAD~1', 'inside/a.txt'), edit(numbered(20), { 2: 'two' }));
  assert.equal(show(c, 'HEAD', 'inside/a.txt'), edit(numbered(20), { 2: 'two', 18: 'eighteen' }));
  assert.equal(show(c, 'HEAD', 'outside/b.txt'), 'b\n');
  assert.equal(show(c, 'HEAD', 'kept.txt'), 'k\n');
  assert.equal(c.git(['diff', '--name-only', 'HEAD~2', 'HEAD']), 'inside/a.txt\n');
});
