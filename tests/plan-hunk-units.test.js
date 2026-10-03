'use strict';

// CHG-06 (docs/roadmap/07-change-set.md): hunk-level units from the streamed patch pass.
// `plan` takes one `git diff -z --raw -p` call read as a stream (M2 `onStdout`), makes one
// unit per hunk of a modified text file, hashes each over its path, its `-`/`+` lines without
// context and an occurrence index, stores the identity key (the hash without that index) in
// the unit table, and writes one `hunks.txt` block per hunk (C:plan-hunks, Q11). Seam 1 only;
// every fixture repo is also checked against the `git diff --numstat -z` parser oracle.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`);
}

// `git diff --numstat -z HEAD`, the parser oracle: `added\tdeleted\tpath\0` per file, or
// `added\tdeleted\t\0old\0new\0` for a rename (git never quotes a `-z` path), keyed by the
// new path.
function numstat(c) {
  const result = spawnSync('git', ['diff', '--numstat', '-z', 'HEAD'], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  const tokens = result.stdout.toString('utf8').split('\0');
  const counts = {};
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    i += 1;
    if (record === '') continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    const added = Number(record.slice(0, firstTab));
    const deleted = Number(record.slice(firstTab + 1, secondTab));
    const file = record.slice(secondTab + 1);
    if (file === '') {
      const newPath = tokens[i + 1];
      counts[newPath] = { added, deleted };
      i += 2;
    } else {
      counts[file] = { added, deleted };
    }
  }
  return counts;
}

// Runs `plan` and returns its hunk index, `state.json` and `hunks.txt`, after checking the
// parser oracle on every fixture repo: per-file `plan.json` `tracked` counts equal
// `git diff --numstat -z`.
async function plan(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  const planJson = JSON.parse(read('plan.json'));
  const counts = Object.fromEntries(planJson.tracked.map(({ path: file, added, deleted }) => [file, { added, deleted }]));
  assert.deepEqual(counts, numstat(c));
  return {
    hunks: result.json.hunks.hunks,
    state: JSON.parse(read('state.json')),
    hunksTxt: read('hunks.txt'),
    planJson,
  };
}

test('two separated edits in one file are two units with their own ranges', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'f.txt': lines.join('') });
  c.writeFile('f.txt', ['one\n', ...lines.slice(1, 19), 'twenty\n'].join(''));

  const { hunks, state, planJson } = await plan(c);

  assert.deepEqual(hunks.map(({ id, path: file, status, kind, range }) => ({ id, file, status, kind, range })), [
    { id: 'h1', file: 'f.txt', status: 'M', kind: 'text', range: '-1,4 +1,4' },
    { id: 'h2', file: 'f.txt', status: 'M', kind: 'text', range: '-17,4 +17,4' },
  ]);
  assert.deepEqual(state.units.map((unit) => unit.id), ['h1', 'h2']);
  assert.notEqual(state.idMap.h1, state.idMap.h2);
  // `plan.json` `tracked` stays one entry per file.
  assert.deepEqual(planJson.tracked, [
    { path: 'f.txt', oldPath: null, status: 'M', bucket: 'code', added: 2, deleted: 2 },
  ]);
});

test('edits within -U3 of each other are one unit', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'f.txt': lines.join('') });
  const edited = [...lines];
  edited[4] = 'five\n';
  edited[10] = 'eleven\n';
  c.writeFile('f.txt', edited.join(''));

  const { hunks } = await plan(c);

  assert.deepEqual(hunks.map(({ id, range }) => ({ id, range })), [{ id: 'h1', range: '-2,13 +2,13' }]);
});

// `-U3` merges two hunks whose unchanged gap is at most 2*3 lines and splits them past it:
// the boundary is exactly 6 (merged) vs. 7 (split), pinning the default context with no
// `--inter-hunk-context` pin needed.
test('a 6-line gap between edits merges into one unit; a 7-line gap splits them', async (t) => {
  const c1 = createCase(t);
  const lines = numbered(30);
  seed(c1, { 'f.txt': lines.join('') });
  const sixGap = [...lines];
  sixGap[4] = 'five\n';
  sixGap[11] = 'twelve\n';
  c1.writeFile('f.txt', sixGap.join(''));

  const { hunks: merged } = await plan(c1);
  assert.equal(merged.length, 1, 'a 6-line gap merges');

  const c2 = createCase(t);
  seed(c2, { 'f.txt': lines.join('') });
  const sevenGap = [...lines];
  sevenGap[4] = 'five\n';
  sevenGap[12] = 'thirteen\n';
  c2.writeFile('f.txt', sevenGap.join(''));

  const { hunks: split } = await plan(c2);
  assert.equal(split.length, 2, 'a 7-line gap splits');
});

test('two identical hunks in one file have distinct IDs and hashes and the same identity key', async (t) => {
  const c = createCase(t);
  const block = ['a\n', 'b\n', 'c\n', 'old\n', 'd\n', 'e\n', 'f\n'];
  const filler = numbered(10);
  seed(c, { 'f.txt': [...block, ...filler, ...block].join(''), 'g.txt': block.join('') });
  const edit = (lines) => lines.map((line) => (line === 'old\n' ? 'new\n' : line));
  c.writeFile('f.txt', [...edit(block), ...filler, ...edit(block)].join(''));
  c.writeFile('g.txt', edit(block).join(''));

  const { hunks, state } = await plan(c);

  assert.deepEqual(hunks.map(({ id, path: file }) => [id, file]), [['h1', 'f.txt'], ['h2', 'f.txt'], ['h3', 'g.txt']]);
  const [h1, h2, h3] = state.units;
  assert.deepEqual(Object.keys(h1), ['id', 'hash', 'path', 'oldPath', 'status', 'kind', 'identityKey']);
  assert.notEqual(h1.hash, h2.hash);
  assert.equal(h1.identityKey, h2.identityKey);
  assert.match(h1.identityKey, /^[0-9a-f]{64}$/);
  // The path is part of the identity key: the same edit in another file is not identical.
  assert.notEqual(h3.identityKey, h1.identityKey);
  assert.deepEqual(state.idMap, { h1: h1.hash, h2: h2.hash, h3: h3.hash });
});

test('offset and lines let a Read of hunks.txt return exactly one block', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'f.txt': lines.join(''), 'g.txt': 'x\n' });
  c.writeFile('f.txt', ['one\n', ...lines.slice(1, 19), 'twenty\n'].join(''));
  c.writeFile('g.txt', 'y\n');

  const { hunks, hunksTxt } = await plan(c);

  const all = hunksTxt.split('\n');
  assert.equal(hunks.length, 3);
  for (const entry of hunks) {
    const block = all.slice(entry.offset - 1, entry.offset - 1 + entry.lines);
    assert.equal(block[0], `### ${entry.id} M text ${entry.range} ${entry.path}`);
    assert.equal(block.filter((line) => line.startsWith('### ')).length, 1);
    assert.equal(block.filter((line) => line.startsWith('@@ ')).length, 1);
    assert.equal(block[1], `@@ ${entry.range} @@`);
  }
  assert.deepEqual(hunksTxt.split('\n').slice(0, 9), [
    '### h1 M text -1,4 +1,4 f.txt', '@@ -1,4 +1,4 @@', '-1', '+one', ' 2', ' 3', ' 4',
    '### h2 M text -17,4 +17,4 f.txt', '@@ -17,4 +17,4 @@',
  ]);
});

test('the ### line shows <old> -> <new> for a rename', async (t) => {
  const c = createCase(t);
  seed(c, { 'old.txt': numbered(10).join('') });
  c.git(['mv', 'old.txt', 'new.txt']);
  c.writeFile('new.txt', ['1\n', '2\n', 'three\n', ...numbered(10).slice(3)].join(''));

  const { hunks, hunksTxt } = await plan(c);

  assert.equal(hunks.length, 1);
  const [entry] = hunks;
  assert.deepEqual([entry.path, entry.oldPath, entry.status], ['new.txt', 'old.txt', 'R']);
  assert.equal(hunksTxt.split('\n')[entry.offset - 1], `### h1 R text ${entry.range} old.txt -> new.txt`);
});

test('parser oracle: hunk-level units over several files keep the per-file counts', async (t) => {
  const c = createCase(t);
  const lines = numbered(30);
  seed(c, { 'src/a.js': lines.join(''), 'b c/d.md': 'keep\n', 'e.txt': 'x' });
  const edited = [...lines];
  edited.splice(2, 1, 'III\n', 'extra\n');
  edited.splice(20, 2);
  edited.push('tail\n');
  c.writeFile('src/a.js', edited.join(''));
  c.writeFile('b c/d.md', 'keep\nmore\n');
  c.writeFile('e.txt', 'x\n');

  const { hunks } = await plan(c);

  assert.deepEqual(hunks.map(({ id, path: file }) => [id, file]), [
    ['h1', 'b c/d.md'], ['h2', 'e.txt'], ['h3', 'src/a.js'], ['h4', 'src/a.js'], ['h5', 'src/a.js'],
  ]);
});
