'use strict';

// CHG-17 (docs/roadmap/07-change-set.md): summary-only files and the 3000-line body cap
// (C:summary-only-files, C:plan-hunks, Q19). M10 decides both over a snapshot's units: a
// summary-only file is one whole-file unit with its reason, its body dropped and its added
// lines kept for the scan; past the cap, every hunk of the crossing file and every later
// file keeps its own unit and range with its body dropped. M13 renders the first as a
// `summaryOnly[]` entry (no kind, no range, no block) and the second as `body: "cap"`.
// Through `plan` (Seam 1). This file's own text holds no literal hit: the token is built at
// run time.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let changeSet;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

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

async function plan(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
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

test('a summary-only lockfile stages and verifies as its one whole-file unit', async (t) => {
  const c = createCase(t);
  const lock = numbered(40);
  seed(c, { 'package-lock.json': lock });
  c.writeFile('package-lock.json', edit(lock, [3, 30]));
  const units = await changeSet.snapshot({
    mode: 'split', storedLists: { candidates: [], stagedNew: [] }, tracked: ['package-lock.json'],
    indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: () => 0,
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].summaryOnly, 'lockfile');
  assert.equal(units[0].body.length, 0);
  assert.deepEqual(units[0].addedLines, [{ line: 3, text: 'changed 3' }, { line: 30, text: 'changed 30' }]);
  const staged = await changeSet.stage({ units, toplevel: c.repoDir, env: c.env, now: () => 0 });
  assert.deepEqual(staged, { ok: true });
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
  const split = await changeSet.snapshot({
    mode: 'split', storedLists: { candidates: [], stagedNew: [] }, tracked: ['data/big.txt', 'data/small.txt'],
    indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: () => 0,
  });
  c.git(['add', '--', 'data']);
  const staged = await changeSet.snapshot({ mode: 'staged', toplevel: c.repoDir, env: c.env, now: () => 0 });

  for (const units of [split, staged]) {
    assert.deepEqual(units.map((unit) => [unit.path, unit.summaryOnly]), [['data/big.txt', 'size'], ['data/small.txt', undefined]]);
  }
  assert.equal(split[0].hash, staged[0].hash);
});
