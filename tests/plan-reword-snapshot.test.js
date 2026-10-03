'use strict';

// CHG-15 (docs/roadmap/07-change-set.md): in `reword` mode M10 `snapshot` diffs HEAD against
// its single parent, or the empty tree for a root commit, with the same pinned options as
// `split` (Q20, C:plan-hunks: "what is diffed"). Until this slice, `plan --reword` stored an
// empty unit table (workflows.mjs `snapshotUnits`); this file asserts the real hunk index.
// IDs minted here are never staged (Q20: `reword` only rewrites the message).

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
