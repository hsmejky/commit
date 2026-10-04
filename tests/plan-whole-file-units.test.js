'use strict';

// CHG-08 (docs/roadmap/07-change-set.md): whole-file units per Q11's hash table. A new,
// deleted or renamed file, a mode change (with or without content edits) and a file git
// reports as binary are each exactly one unit covering the whole file (C:plan-hunks `kind`):
// `mode` for a mode change, `binary` (path + blob IDs, `body: "none"`, no `hunks.txt` block)
// for a binary file, `text` otherwise. Seam 1 only.

const fs = require('node:fs');
const path = require('node:path');
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
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`).join('');
}

// `--split`: some fixtures stage part of their changes, a mixed index that would otherwise
// end with a `modeChoice` (RUN-13).
async function plan(c) {
  const result = await runCommit(c, ['plan', '--split']);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    json: result.json,
    hunks: result.json.hunks.hunks,
    state: JSON.parse(read('state.json')),
    hunksTxt: read('hunks.txt'),
    planJson: JSON.parse(read('plan.json')),
  };
}

// A mode change of `file`, already committed as 100644 by `seed`. `chmod +x` where the
// filesystem has an executable bit; on Windows (no executable bit, `core.fileMode` false by
// default) the mirror image: HEAD gets 100755 and, with `core.fileMode=true`, the worktree
// file reads as 100644, so git reports the same kind of `old mode`/`new mode` change.
function changeMode(c, file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(c.repoDir, file), 0o755);
    return;
  }
  c.git(['config', 'core.fileMode', 'true']);
  c.git(['update-index', '--chmod=+x', '--', file]);
  c.git(['commit', '-q', '-m', 'exec']);
}

test('chmod +x alone is one mode unit', async (t) => {
  const c = createCase(t);
  seed(c, { 'run.sh': 'echo\n', 'other.txt': 'o\n' });
  changeMode(c, 'run.sh');

  const { hunks, state, hunksTxt } = await plan(c);

  assert.deepEqual(
    hunks.map(({ id, path: file, oldPath, status, kind, body }) => ({ id, file, oldPath, status, kind, body })),
    [{ id: 'h1', file: 'run.sh', oldPath: null, status: 'M', kind: 'mode', body: 'file' }],
  );
  assert.equal(hunks[0].range, '-0,0 +0,0');
  assert.equal(hunksTxt.split('\n')[hunks[0].offset - 1], '### h1 M mode -0,0 +0,0 run.sh');
  assert.equal(state.units[0].kind, 'mode');
  assert.match(state.units[0].hash, /^[0-9a-f]{64}$/);
});

test('chmod +x plus two separated content edits is still one mode unit', async (t) => {
  const c = createCase(t);
  seed(c, { 'run.sh': numbered(30) });
  changeMode(c, 'run.sh');
  c.writeFile('run.sh', numbered(30).replace('2\n', 'two\n').replace('28\n', 'twenty-eight\n'));

  const { hunks, hunksTxt } = await plan(c);

  assert.equal(hunks.length, 1);
  const [entry] = hunks;
  assert.deepEqual([entry.path, entry.status, entry.kind, entry.body], ['run.sh', 'M', 'mode', 'file']);
  // One range enclosing both hunks; the block holds both.
  assert.equal(entry.range, '-1,30 +1,30');
  const block = hunksTxt.split('\n').slice(entry.offset - 1, entry.offset - 1 + entry.lines).join('\n');
  assert.match(block, /^### h1 M mode -1,30 \+1,30 run\.sh\n@@ -1,5 \+1,5 @@\n 1\n-2\n\+two\n/);
  assert.match(block, /\n-28\n\+twenty-eight\n/);
});

test('a deleted file, a renamed-and-edited file and a new binary are one unit each', async (t) => {
  const c = createCase(t);
  seed(c, { 'gone.txt': 'a\nb\n', 'old.txt': numbered(30) });
  fs.rmSync(path.join(c.repoDir, 'gone.txt'));
  c.git(['mv', 'old.txt', 'new.txt']);
  c.writeFile('new.txt', numbered(30).replace('2\n', 'two\n').replace('28\n', 'twenty-eight\n'));
  fs.writeFileSync(path.join(c.repoDir, 'pic.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x0a]));

  const { hunks, hunksTxt, state } = await plan(c);

  assert.deepEqual(
    hunks.map(({ path: file, oldPath, status, kind, body }) => ({ file, oldPath, status, kind, body })),
    [
      { file: 'gone.txt', oldPath: null, status: 'D', kind: 'text', body: 'file' },
      { file: 'new.txt', oldPath: 'old.txt', status: 'R', kind: 'text', body: 'file' },
      { file: 'pic.bin', oldPath: null, status: 'A', kind: 'binary', body: 'none' },
    ],
  );
  const [gone, renamed, binary] = hunks;
  assert.equal(hunksTxt.split('\n')[gone.offset - 1], '### h1 D text -1,2 +0,0 gone.txt');
  assert.equal(hunksTxt.split('\n')[renamed.offset - 1], `### h2 R text ${renamed.range} old.txt -> new.txt`);
  // A binary unit has no block: `offset`/`lines` are null and `hunks.txt` never names it.
  assert.deepEqual([binary.offset, binary.lines], [null, null]);
  assert.doesNotMatch(hunksTxt, /pic\.bin/);
  assert.deepEqual(state.units.map((unit) => unit.kind), ['text', 'text', 'binary']);
});

test('a binary edit is one binary unit whose hash follows the content', async (t) => {
  const hashOf = async (bytes) => {
    const c = createCase(t);
    seed(c, { 'a.txt': 'a\n' });
    fs.writeFileSync(path.join(c.repoDir, 'img.dat'), Buffer.from([0, 1, 2, 10]));
    c.git(['add', 'img.dat']);
    c.git(['commit', '-q', '-m', 'bin']);
    fs.writeFileSync(path.join(c.repoDir, 'img.dat'), bytes);
    const { hunks, state } = await plan(c);
    assert.deepEqual(hunks.map(({ path: file, status, kind, body }) => [file, status, kind, body]), [['img.dat', 'M', 'binary', 'none']]);
    return state.units[0].hash;
  };

  const first = await hashOf(Buffer.from([0, 1, 3, 10]));
  assert.equal(await hashOf(Buffer.from([0, 1, 3, 10])), first);
  assert.notEqual(await hashOf(Buffer.from([0, 1, 4, 10])), first);
});

test('the hash of a rename changes when either path changes', async (t) => {
  const hashOf = async (from, to) => {
    const c = createCase(t);
    seed(c, { [from]: numbered(10), 'keep.txt': 'k\n' });
    c.git(['mv', from, to]);
    c.writeFile(to, numbered(10).replace('5\n', 'five\n'));
    const { hunks, state } = await plan(c);
    assert.deepEqual(hunks.map(({ path: file, oldPath, status }) => [file, oldPath, status]), [[to, from, 'R']]);
    return state.units[0].hash;
  };

  const base = await hashOf('a.txt', 'b.txt');
  assert.equal(await hashOf('a.txt', 'b.txt'), base);
  assert.notEqual(await hashOf('a.txt', 'c.txt'), base);
  assert.notEqual(await hashOf('x.txt', 'b.txt'), base);
});

for (const [name, move] of [
  ['git mv a.txt .env', (c) => c.git(['mv', 'a.txt', '.env'])],
  ['mv a.txt .env && git add -N .env', (c) => {
    fs.renameSync(path.join(c.repoDir, 'a.txt'), path.join(c.repoDir, '.env'));
    c.git(['add', '-N', '.env']);
  }],
]) {
  test(`${name}: one D a.txt unit, .env in stagedExcluded, tree not clean`, async (t) => {
    const c = createCase(t);
    seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    move(c);

    const { json, hunks, planJson } = await plan(c);

    assert.notEqual(json.status, 'nothing');
    assert.deepEqual(
      hunks.map(({ path: file, oldPath, status, kind }) => [file, oldPath, status, kind]),
      [['a.txt', null, 'D', 'text']],
    );
    assert.deepEqual(planJson.stagedExcluded, [{ path: '.env', reason: 'hidden' }]);
  });
}
