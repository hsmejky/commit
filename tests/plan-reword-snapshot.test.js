'use strict';

// CHG-15 (docs/roadmap/07-change-set.md): in `reword` mode M10 `snapshot` diffs HEAD against
// its single parent, or the empty tree for a root commit, with the same pinned options as
// `split` (Q20, C:plan-hunks: "what is diffed"). Until this slice, `plan --reword` stored an
// empty unit table (workflows.mjs `snapshotUnits`); this file asserts the real hunk index.
// IDs minted here are never staged (Q20: `reword` only rewrites the message).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

let changeSet;
beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

// Plumbing git calls (mktree/hash-object/commit-tree) build commits straight from objects,
// bypassing the index and the working tree entirely, so a non-UTF-8 path can be used in a
// tree without ever being written to disk as a file name (review-CHG-15-r2 finding 4,
// probe 1: this runs on every OS, unlike a real non-UTF-8 name on disk, which NTFS cannot
// hold).
function plumb(c, args, input) {
  const result = spawnSync('git', args, { cwd: c.repoDir, env: c.env, input });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.toString('latin1')}`);
  }
  return result.stdout.toString('utf8').trim();
}

test('plan --reword on a non-root HEAD gives a hunk index of HEAD\'s own change against its parent', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'two\n');
  c.git(['commit', '-q', '-am', 'fix: reword me']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword');
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => [entry.path, entry.status]),
    [['a.txt', 'M']],
    detail(result),
  );
  const hunksTxt = fs.readFileSync(path.join(result.json.runDir, 'hunks.txt'), 'utf8');
  assert.match(hunksTxt, /-one\n\+two/);
});

test('plan --reword on a root commit diffs against the empty tree (one A unit)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => [entry.path, entry.status]),
    [['a.txt', 'A']],
    detail(result),
  );
  const hunksTxt = fs.readFileSync(path.join(result.json.runDir, 'hunks.txt'), 'utf8');
  assert.match(hunksTxt, /\+one/);
});

test('plan --reword leaves staged changes out of the units and the real index untouched', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'one\n' });
  c.writeFile('a.txt', 'two\n');
  c.git(['commit', '-q', '-am', 'fix: reword me']);
  c.writeFile('b.txt', 'staged\n');
  c.git(['add', 'b.txt']);
  const before = c.git(['diff', '--cached']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => entry.path),
    ['a.txt'],
    detail(result),
  );
  const after = c.git(['diff', '--cached']);
  assert.equal(after, before, 'the real index changed during plan --reword');
});

// review-CHG-15 finding 4: the reword branch must run the same check-attr pass as split, so
// a `linguist-generated` file opens as a `filtered`/`generated` unit, not a plain `text` one.
test('plan --reword runs check-attr: a linguist-generated file is marked generated', async (t) => {
  const c = createCase(t);
  seed(c, { '.gitattributes': 'gen.txt linguist-generated\n', 'gen.txt': 'one\n' });
  c.writeFile('gen.txt', 'two\n');
  c.git(['commit', '-q', '-am', 'fix: reword me']);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const units = await changeSet.snapshot({
    mode: 'reword', head, root: false, toplevel: c.repoDir, env: c.env,
  });

  const unit = units.find((u) => u.path === 'gen.txt');
  assert.ok(unit, 'gen.txt unit not found');
  assert.equal(unit.generated, true, JSON.stringify(unit));
});

// review-CHG-15 finding 6: an unstaged edit and an untracked candidate must not leak into the
// reword units, same as the staged case above but through the working tree, not the index.
test('plan --reword leaves an unstaged edit and an untracked candidate out of the units', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'one\n' });
  c.writeFile('a.txt', 'two\n');
  c.git(['commit', '-q', '-am', 'fix: reword me']);
  c.writeFile('b.txt', 'unstaged\n');
  c.writeFile('c.txt', 'untracked\n');

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => entry.path),
    ['a.txt'],
    detail(result),
  );
});

// review-CHG-15 finding 6: a rename committed in HEAD must give one R unit with oldPath, same
// as `split` (change-set-units.test.js), not two text units or a dropped unit.
test('plan --reword on a HEAD that renamed a file gives one R unit with oldPath', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': 'one\ntwo\nthree\nfour\nfive\n' });
  c.git(['mv', 'old.txt', 'new.txt']);
  c.git(['commit', '-q', '-m', 'fix: reword me']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((entry) => [entry.path, entry.oldPath, entry.status]),
    [['new.txt', 'old.txt', 'R']],
    detail(result),
  );
});

// review-CHG-15 finding 1 (KD-R68): a shallow clone's boundary commit misreads as root
// (GIT-09 `rewordFacts`). The fail-safe tries the real parent instead of the empty tree, so
// it fails loudly (git's own "bad revision") instead of silently hunk-indexing the whole repo.
// review-CHG-15-r2 finding 4: diffUnits' rediff pass (CHG-12 finding 1) must also run for
// reword, not only split's own pinnedDiff, so a rename from a non-UTF-8 old path to a UTF-8
// new path is not dropped here either. Built with plumbing (no real file on disk).
test('plan --reword rediffs a rename from a non-UTF-8 old path into a plain A unit', async (t) => {
  const c = createCase(t);
  const blob = plumb(c, ['hash-object', '-w', '--stdin'], Buffer.from('one\ntwo\nthree\nfour\n'));
  const oldPath = Buffer.from('t\xe9.txt', 'latin1');
  const tree1 = plumb(
    c, ['mktree', '-z'],
    Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), oldPath, Buffer.from('\0')]),
  );
  const commit1 = plumb(c, ['commit-tree', tree1, '-m', 'seed']);
  const tree2 = plumb(c, ['mktree', '-z'], Buffer.from(`100644 blob ${blob}\tte.txt\0`));
  const commit2 = plumb(c, ['commit-tree', tree2, '-p', commit1, '-m', 'fix: reword me']);

  const units = await changeSet.snapshot({
    mode: 'reword', head: commit2, root: false, toplevel: c.repoDir, env: c.env,
  });

  assert.deepEqual(
    units.map((u) => [u.path, u.oldPath, u.status, u.added, u.deleted]),
    [['te.txt', null, 'A', 4, 0]],
  );
});

// review-CHG-15-r2 finding 4: the reword check-attr pre-pass must also classify a
// filter-attributed file as kind: "filtered" (change-set-filtered.test.js's split
// coverage), not only the linguist-generated case above.
test('plan --reword runs check-attr: a filter-attributed file opens as one filtered unit', async (t) => {
  const c = createCase(t);
  c.git(['config', 'filter.redact.clean', 'sed s/secret/REDACTED/']);
  seed(c, { '.gitattributes': 'x.dat filter=redact\n', 'x.dat': 'one\ntwo\n' });
  c.writeFile('x.dat', 'one\nsecret\n');
  c.git(['commit', '-q', '-am', 'fix: reword me']);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const units = await changeSet.snapshot({
    mode: 'reword', head, root: false, toplevel: c.repoDir, env: c.env,
  });

  const unit = units.find((u) => u.path === 'x.dat');
  assert.ok(unit, 'x.dat unit not found');
  assert.equal(unit.kind, 'filtered');
  const bodyText = unit.body.toString('utf8');
  assert.match(bodyText, /REDACTED/);
  assert.doesNotMatch(bodyText, /secret/);
});

test('plan --reword on a shallow clone\'s boundary commit fails loudly instead of using the empty tree (KD-R68)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'two\n');
  c.git(['commit', '-q', '-am', 'fix: second commit']);
  const shallowDir = path.join(c.root, 'shallow');
  c.git(['clone', '-q', '--depth', '1', '--no-local', c.repoDir, shallowDir], { cwd: c.root });
  const head = c.git(['rev-parse', 'HEAD'], { cwd: shallowDir }).trim();

  await assert.rejects(
    () => changeSet.snapshot({ mode: 'reword', head, root: true, toplevel: shallowDir, env: c.env }),
    /git diff failed/,
  );
});
