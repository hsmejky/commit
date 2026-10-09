'use strict';

// INT-19 (docs/roadmap/12-integration.md; Q19, C:plan-hunks, C:summary-only-files, stories 65,
// 157, 158, 159) at Seam 1: a change set larger than the stdout budget spills the hunk index to
// `hunks.json`, summary-only files and files past the 3000-line body cap keep every unit ID,
// `plan --hunks` stdout stays within 20 000 characters, and every placed unit commits.

const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SMALL_FILES = 150;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function numbered(count, prefix) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

function edit(text, at) {
  const lines = text.split('\n');
  for (const n of at) lines[n - 1] = `changed ${n}`;
  return lines.join('\n');
}

// Every cap at once: a lockfile (name rule), a 1100-line file (`lines` rule), three code files
// filling the 3000-line body cap exactly, a two-hunk file sorting after them and many small
// files, so the full index is past the stdout budget.
async function buildRun(t, smallFiles) {
  const c = createCase(t);
  const z = numbered(40, 'z');
  const files = {
    'package-lock.json': '{}\n',
    'big.txt': 'big\n',
    'src/a.js': 'a\n',
    'src/b.js': 'b\n',
    'src/c.js': 'c\n',
    'src/z.js': z,
  };
  for (let i = 1; i <= smallFiles; i += 1) files[`zz/some/fairly/long/directory/path/file-${i}.txt`] = `one ${i}\n`;
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
  const after = {
    'package-lock.json': `{}\n${numbered(1500, 'lock')}`,
    'big.txt': `big\n${numbered(1100, 'big')}`,
    'src/a.js': `a\n${numbered(1000, 'a')}`,
    'src/b.js': `b\n${numbered(1000, 'b')}`,
    'src/c.js': `c\n${numbered(1000, 'c')}`,
    'src/z.js': edit(z, [3, 30]),
  };
  for (let i = 1; i <= smallFiles; i += 1) after[`zz/some/fairly/long/directory/path/file-${i}.txt`] = `one ${i}\ntwo\n`;
  for (const [name, text] of Object.entries(after)) c.writeFile(name, text);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  return { c, planned, after, seed };
}

// Tests 1 and 2 only read the full fixture: build it once, lazily (an async top-level before hook
// is not awaited on Node 22.0-22.1), and remove it after the file's last test.
const cleanups = [];
let sharedRun;
function sharedLargeRun() {
  sharedRun ??= buildRun({ after: (fn) => cleanups.push(fn) }, SMALL_FILES);
  return sharedRun;
}
after(() => {
  for (const fn of cleanups) fn();
});

function readIndex(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('Seam 1: past every cap, plan --hunks stdout stays within 20 000 characters and the index spills to hunks.json', async () => {
  const { c, planned } = await sharedLargeRun();
  const { planId } = planned.json;

  const result = await runCommit(c, ['plan', '--hunks', '--plan', planId]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.ok(result.stdout.length <= 20000, `stdout is ${result.stdout.length} characters`);
  assert.equal(result.json.hunks, undefined);
  assert.equal(result.json.summaryOnly, undefined);
  assert.ok(path.isAbsolute(result.json.hunksIndexFile), result.json.hunksIndexFile);
  const entries = readIndex(result.json.hunksIndexFile);
  assert.equal(entries.length, 6 + SMALL_FILES + 1);
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
});

test('a lockfile and a file over 1000 changed lines are stats-only whole-file units', async () => {
  const { planned } = await sharedLargeRun();
  const entries = readIndex(planned.json.hunks.hunksIndexFile);

  const summary = entries.filter((e) => e.reason !== undefined);
  assert.deepEqual(summary.map((e) => [e.path, e.reason, e.added, e.deleted]), [
    ['big.txt', 'lines', 1100, 0],
    ['package-lock.json', 'lockfile', 1500, 0],
  ]);
  const hunksTxt = fs.readFileSync(path.join(planned.json.runDir, 'hunks.txt'), 'utf8');
  assert.equal(hunksTxt.includes('package-lock.json'), false);
  assert.equal(hunksTxt.includes('big.txt'), false);
});

test('a file past the cap keeps each hunk ID, and every placed unit commits', async (t) => {
  const { c, planned, after, seed } = await buildRun(t, 0);
  const entries = [...planned.json.hunks.hunks, ...(planned.json.hunks.summaryOnly ?? [])];
  const capped = entries.filter((e) => e.body === 'cap');
  const zHunks = capped.filter((e) => e.path === 'src/z.js');
  assert.deepEqual(zHunks.map((e) => e.range), ['-1,6 +1,6', '-27,7 +27,7']);
  assert.equal(capped.length, 2);

  const ids = entries.map((e) => e.id);
  const rest = ids.filter((id) => !zHunks.some((e) => e.id === id));
  const group = (header, hunks) => ({ header, body: null, files: [], hunks, reason: header });
  fs.writeFileSync(path.join(planned.json.runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [group('feat: first z hunk', [zHunks[0].id]), group('feat: second z hunk', [zHunks[1].id]), group('chore: the rest', rest)],
    notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits.length, 3, detail(checked));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3);
  const patchOf = (sha) => c.git(['show', '--format=', '-U0', sha]).split('\n').filter((l) => /^[+-][^+-]/.test(l));
  assert.deepEqual(patchOf(shas[0]), ['-z 3', '+changed 3']);
  assert.deepEqual(patchOf(shas[1]), ['-z 30', '+changed 30']);
  for (const [name, text] of Object.entries(after)) assert.equal(c.git(['show', `HEAD:${name}`]), text, name);
  assert.equal(c.git(['status', '--porcelain']), '');
});
