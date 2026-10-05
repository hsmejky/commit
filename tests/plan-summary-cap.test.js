'use strict';

// CHG-17 (docs/roadmap/07-change-set.md): summary-only files and the 3000-line body cap
// (C:summary-only-files, C:plan-hunks, Q19). M10 decides both over a snapshot's units: a
// summary-only file is one whole-file unit with its reason, its body dropped and its added
// lines kept for the scan; past the cap, every hunk of the crossing file and every later
// file keeps its own unit, range and body, marked capped. M13 renders the first as a
// `summaryOnly[]` entry (no kind, no range, no block) and the second as `body: "cap"` (no
// block). Through `plan` and `commit` (Seam 1); a capped file split by its ranges is
// tests/stage-hunk-patch.test.js (CHG-20).
// This file's own text holds no literal hit: the token is built at run time.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

// A `ghp_` token built at run time (see tests/scanner.test.js).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function numbered(count, prefix = 'keep') {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

// Replaces the 1-based lines `at` of `text` (one changed line per hunk, far enough apart).
function edit(text, at) {
  const lines = text.split('\n');
  for (const n of at) lines[n - 1] = `changed ${n}`;
  return lines.join('\n');
}

async function plan(c, args = ['plan']) {
  const result = await runCommit(c, args);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    planId: result.json.planId,
    runDir,
    index: result.json.hunks,
    planJson: JSON.parse(read('plan.json')),
    hunksTxt: read('hunks.txt'),
  };
}

test('a package-lock.json change is one summaryOnly entry (lockfile), still scanned', async (t) => {
  const c = createCase(t);
  const lock = numbered(40);
  seed(c, { 'package-lock.json': lock, 'src/a.js': 'a\n' });
  const edited = edit(lock, [3, 30]).replace('changed 30', `"token": "${githubToken('a')}",`);
  c.writeFile('package-lock.json', edited);
  c.writeFile('src/a.js', 'A\n');

  const { index, planJson, hunksTxt } = await plan(c);

  assert.deepEqual(index.hunks.map((e) => [e.path, e.body]), [['src/a.js', 'file']]);
  assert.equal(index.summaryOnly.length, 1);
  const [entry] = index.summaryOnly;
  const { id, scan, ...rest } = entry;
  assert.match(id, /^h\d+$/);
  assert.notEqual(id, index.hunks[0].id);
  assert.deepEqual(rest, { path: 'package-lock.json', reason: 'lockfile', added: 2, deleted: 2 });
  assert.deepEqual(scan, ['github-token']);
  assert.deepEqual(planJson.scan.hits, [{ path: 'package-lock.json', line: 30, pattern: 'github-token' }]);
  assert.equal(hunksTxt.includes('package-lock.json'), false);
});

// The worker's one group over every planned unit (the files the worker would write, Seam 1),
// then `commit --all`.
async function commitAll(c, { planId, runDir }, header) {
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header, body: '', committed: false }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return runCommit(c, ['commit', '--plan', planId, '--all']);
}

test('a summary-only lockfile commits as its one whole-file unit (stage verifies its hash)', async (t) => {
  const c = createCase(t);
  const lock = numbered(40);
  seed(c, { 'package-lock.json': lock });
  const edited = edit(lock, [3, 30]);
  c.writeFile('package-lock.json', edited);
  const planned = await plan(c, ['plan', '--split']);
  assert.deepEqual(planned.index.summaryOnly.map((e) => [e.path, e.reason]), [['package-lock.json', 'lockfile']]);

  const result = await commitAll(c, planned, 'chore: bump lockfile');

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['show', 'HEAD:package-lock.json']), edited);
});

// Code files of 1000, 1000 and `third` added lines, then a two-hunk `src/d.js` (2 changed
// lines per hunk) and, optionally, `src/e.js` with one added line.
function capCase(t, { third, withE, lockLines = 0 }) {
  const c = createCase(t);
  const d = numbered(40, 'd');
  const files = { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'src/c.js': 'c\n', 'src/d.js': d, 'src/e.js': 'e\n' };
  if (lockLines > 0) files['package-lock.json'] = '{}\n';
  seed(c, files);
  c.writeFile('src/a.js', `a\n${numbered(1000, 'a')}`);
  c.writeFile('src/b.js', `b\n${numbered(1000, 'b')}`);
  c.writeFile('src/c.js', `c\n${numbered(third, 'c')}`);
  c.writeFile('src/d.js', edit(d, [3, 30]));
  if (withE) c.writeFile('src/e.js', 'e\nE\n');
  if (lockLines > 0) c.writeFile('package-lock.json', `{}\n${numbered(lockLines, 'lock')}`);
  return c;
}

test('the cap skips a summary-only lockfile sorting first: 3000 code lines stay under it', async (t) => {
  const c = capCase(t, { third: 996, withE: false, lockLines: 2000 });

  const { index } = await plan(c);

  assert.deepEqual(index.summaryOnly.map((e) => [e.path, e.reason, e.added]), [['package-lock.json', 'lockfile', 2000]]);
  assert.deepEqual(index.hunks.map((e) => [e.path, e.body]), [
    ['src/a.js', 'file'], ['src/b.js', 'file'], ['src/c.js', 'file'], ['src/d.js', 'file'], ['src/d.js', 'file'],
  ]);
});

test('3001 cumulative changed lines: the crossing file and every later file get body "cap"', async (t) => {
  const c = capCase(t, { third: 997, withE: true });

  const { index, hunksTxt } = await plan(c);

  assert.deepEqual(index.summaryOnly, []);
  const [a, b, cc, d1, d2, e] = index.hunks;
  assert.equal(index.hunks.length, 6);
  for (const entry of [a, b, cc]) assert.equal(entry.body, 'file');
  assert.deepEqual(new Set(index.hunks.map((entry) => entry.id)).size, 6);
  assert.deepEqual([d1, d2, e].map(({ id, ...rest }) => rest), [
    {
      path: 'src/d.js', oldPath: null, status: 'M', kind: 'text', range: '-1,6 +1,6',
      lines: null, offset: null, body: 'cap', added: 1, deleted: 1,
    },
    {
      path: 'src/d.js', oldPath: null, status: 'M', kind: 'text', range: '-27,7 +27,7',
      lines: null, offset: null, body: 'cap', added: 1, deleted: 1,
    },
    {
      path: 'src/e.js', oldPath: null, status: 'M', kind: 'text', range: '-1 +1,2',
      lines: null, offset: null, body: 'cap', added: 1, deleted: 0,
    },
  ]);
  assert.equal(hunksTxt.includes('src/d.js'), false);
  assert.equal(hunksTxt.includes('src/e.js'), false);
});

test('exactly 3000 cumulative changed lines: no file is capped', async (t) => {
  const c = capCase(t, { third: 996, withE: false });

  const { index } = await plan(c);

  assert.deepEqual(index.hunks.map((e) => [e.path, e.body]), [
    ['src/a.js', 'file'], ['src/b.js', 'file'], ['src/c.js', 'file'], ['src/d.js', 'file'], ['src/d.js', 'file'],
  ]);
});

test('a file over 256 KB with one changed line is summary-only (size), worktree and blob side', async (t) => {
  const c = createCase(t);
  const big = `${'z'.repeat(1023)}\n`.repeat(300);
  seed(c, { 'data/big.txt': `top\n${big}`, 'data/small.txt': 'top\n' });
  c.writeFile('data/big.txt', `TOP\n${big}`);
  c.writeFile('data/small.txt', 'TOP\n');
  const split = await plan(c, ['plan', '--split']);
  fs.rmSync(path.join(c.repoDir, '.commit-plan'), { recursive: true, force: true });
  c.git(['add', '--', 'data']);
  const staged = await plan(c, ['plan', '--staged']);

  for (const { index } of [split, staged]) {
    assert.deepEqual(index.summaryOnly.map((e) => [e.path, e.reason]), [['data/big.txt', 'size']]);
    assert.deepEqual(index.hunks.map((e) => [e.path, e.body]), [['data/small.txt', 'file']]);
  }
});

// review-CHG-17 Medium 1: `snapshot` (split) sizes a worktree file off disk, so `stage`'s
// verify must too: with `eol=crlf` the disk copy (CRLF) is over 256 KB while the staged blob
// (LF) is under it, and a verify sizing the blob hashed the file per hunk → `mismatch`.
test('eol=crlf file over 256 KB on disk, under it as a blob: summary-only and commits', async (t) => {
  const c = createCase(t);
  const lines = Array.from({ length: 12800 }, () => 'x'.repeat(19));
  const crlf = (rows) => `${rows.join('\r\n')}\r\n`;
  c.writeFile('.gitattributes', 'data.txt text eol=crlf\n');
  c.writeFile('data.txt', crlf(lines));
  c.git(['add', '--', '.gitattributes', 'data.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  assert.equal(Number(c.git(['cat-file', '-s', 'HEAD:data.txt']).trim()), 256000);
  lines[5] = 'y'.repeat(19);
  c.writeFile('data.txt', crlf(lines));
  assert.equal(fs.statSync(path.join(c.repoDir, 'data.txt')).size, 268800);

  const planned = await plan(c, ['plan', '--split']);
  assert.deepEqual(planned.index.summaryOnly.map((e) => [e.path, e.reason]), [['data.txt', 'size']]);
  const result = await commitAll(c, planned, 'fix: change data row');

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['show', 'HEAD:data.txt']), `${lines.join('\n')}\n`);
});

// KD-R87 (CHG-17 criterion 4): M10 reads the `size` rule's sizes in a `git diff --raw` pass
// before the patch pass, so the reader decides summary-only per file as each section closes
// and drops that file's body there, never after the stream. Retained memory has no seam
// (KD-R87); what is observable is the order and count of the git calls: the size pass, then
// one `cat-file --batch-check` for every blob the size rule needs (none for a lockfile,
// none off disk), then the patch pass, with the same summary-only output as before.
test('the size rule is read before the patch pass: size pass, one cat-file, then the patch', async (t) => {
  const c = createCase(t);
  const big = `${'z'.repeat(1023)}\n`.repeat(300);
  seed(c, { 'big.txt': `top\n${big}`, 'package-lock.json': '{}\n', 'small.txt': 'top\n' });
  c.writeFile('big.txt', `TOP\n${big}`);
  c.writeFile('package-lock.json', '{ }\n');
  c.writeFile('small.txt', 'TOP\n');
  c.git(['add', '--', '.']);

  const calls = async (argv) => {
    const log = path.join(c.root, `spawns-${argv[1]}.jsonl`);
    const result = await runCommit(c, argv, {
      nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
      env: { COMMIT_TEST_SPAWN_LOG: log },
    });
    assert.equal(result.exitCode, 0, detail(result));
    fs.rmSync(path.join(c.repoDir, '.commit-plan'), { recursive: true, force: true });
    const kinds = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((e) => Array.isArray(e.args) && e.args[0] !== 'check-attr')
      .map((e) => {
        if (e.args.includes('cat-file')) return 'cat-file';
        if (!e.args.includes('diff') || !e.args.includes('--raw')) return null;
        return e.args.includes('-p') ? 'patch' : 'raw';
      })
      .filter((kind) => kind !== null);
    return { result, kinds };
  };

  const staged = await calls(['plan', '--staged']);
  // The staged snapshot (blob side), then the unstaged-changes read (off disk, no cat-file).
  assert.deepEqual(staged.kinds, ['raw', 'cat-file', 'patch', 'raw', 'patch']);
  const split = await calls(['plan', '--split']);
  assert.deepEqual(split.kinds, ['raw', 'patch']);
  for (const { result } of [staged, split]) {
    assert.deepEqual(
      result.json.hunks.summaryOnly.map((e) => [e.path, e.reason]),
      [['big.txt', 'size'], ['package-lock.json', 'lockfile']],
      detail(result),
    );
    assert.deepEqual(result.json.hunks.hunks.map((e) => [e.path, e.body]), [['small.txt', 'file']]);
  }
});
