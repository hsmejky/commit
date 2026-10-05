'use strict';

// CHG-18 (docs/roadmap/07-change-set.md, C:plan-hunks): `plan --hunks` keeps stdout within
// the 20 000-character budget; past it the full hunk index spills to `hunks.json` (one
// entry per line) and stdout carries `hunksIndexFile` (absolute) instead of `hunks` and
// `summaryOnly`. Seam 1, through both call sites that render the index: the mint `plan`
// entry point (the in-process render, C:plan step 8) and the separate `plan --hunks --plan
// <planId>` resnapshot (CHG-19, `workflows.mjs` `resnapshotUnits`). M13's own `renderHunks`
// unit coverage is tests/hunk-index.test.js.

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

test('a diff large enough to cross the budget spills the full index to hunks.json', async (t) => {
  const c = createCase(t);
  const files = {};
  for (let i = 1; i <= 150; i += 1) {
    files[`src/some/fairly/long/directory/path/file-${i}.txt`] = `line one ${i}\n`;
  }
  // M1 fix: a lockfile (summary-only by name, C:summary-only-files rule 1) in the same
  // spilled index, so the spill's `hunks.json` is covered for a `summaryOnly` entry too
  // (previously only an in-process, stretched-seam `renderHunks` case covered this).
  files['package-lock.json'] = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
  seed(c, files);
  for (const name of Object.keys(files)) c.writeFile(name, `${files[name]}line two\n`);

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));

  const hunks = result.json.hunks;
  // L1 fix: assert the real budget on the `hunks` object itself; `plan`'s own envelope is
  // capped separately below (the AC is about `plan --hunks`, not the whole process stdout).
  assert.ok(JSON.stringify(hunks).length <= 20000, `hunks is ${JSON.stringify(hunks).length} characters`);
  assert.equal(hunks.hunks, undefined);
  assert.equal(hunks.summaryOnly, undefined);
  assert.equal(typeof hunks.hunksIndexFile, 'string');
  assert.ok(path.isAbsolute(hunks.hunksIndexFile), hunks.hunksIndexFile);
  assert.equal(hunks.hunksIndexFile, path.join(result.json.runDir, 'hunks.json').split(path.sep).join('/'));

  const indexText = fs.readFileSync(hunks.hunksIndexFile, 'utf8');
  const lines = indexText.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 151);
  const parsed = lines.map((line) => JSON.parse(line));
  const ids = parsed.map((e) => e.id);
  assert.deepEqual(ids, Array.from({ length: 151 }, (_, i) => `h${i + 1}`));

  // The lockfile's entry keeps its `summaryOnly` shape (reason, added/deleted, no
  // kind/range/body) through the spill, interleaved in the same ID-ordered list.
  const lockEntry = parsed.find((e) => e.path === 'package-lock.json');
  assert.ok(lockEntry, `no package-lock.json entry: ${indexText}`);
  assert.deepEqual(Object.keys(lockEntry).sort(), ['added', 'deleted', 'id', 'path', 'reason']);
  assert.equal(lockEntry.reason, 'lockfile');

  // `plan`'s own fields, excluding `hunks` and `reply`, stay tiny whatever the index holds.
  const { hunks: _h, reply: _r, ...own } = result.json;
  assert.ok(Buffer.byteLength(JSON.stringify(own)) <= 1024, JSON.stringify(own));
});

// M2 fix: the separate `plan --hunks --plan <planId>` call (CHG-19, `workflows.mjs`
// `resnapshotUnits`) re-renders the index from a fresh snapshot and must spill past the
// budget too — a second call site CHG-18 left untested. Deleting its `hunks.json` write
// (`workflows.mjs`, the `resnapshotUnits` call to `writeRunFile`) breaks this test and no
// other (verified by mutation, then reverted; no production change here).
test('the separate `plan --hunks --plan <planId>` call also spills to hunks.json', async (t) => {
  const c = createCase(t);
  const files = {};
  for (let i = 1; i <= 150; i += 1) {
    files[`src/some/fairly/long/directory/path/file-${i}.txt`] = `line one ${i}\n`;
  }
  seed(c, files);
  for (const name of Object.keys(files)) c.writeFile(name, `${files[name]}line two\n`);

  const minted = await runCommit(c, ['plan']);
  assert.equal(minted.exitCode, 0, detail(minted));
  assert.equal(typeof minted.json.hunks.hunksIndexFile, 'string', detail(minted));
  // The mint call already wrote `hunks.json` at the same path: remove it so this test can
  // only pass if the separate call's own write (not a leftover from the mint call) put it
  // back.
  fs.unlinkSync(minted.json.hunks.hunksIndexFile);

  // `plan --hunks --plan <planId>`'s own output is the C:plan-hunks shape directly (not
  // nested under a `hunks` key, unlike the mint `plan` call above).
  const result = await runCommit(c, ['plan', '--hunks', '--plan', minted.json.planId]);
  assert.equal(result.exitCode, 0, detail(result));

  assert.ok(JSON.stringify(result.json).length <= 20000, `stdout is ${JSON.stringify(result.json).length} characters`);
  assert.equal(result.json.hunks, undefined);
  assert.equal(result.json.summaryOnly, undefined);
  assert.equal(typeof result.json.hunksIndexFile, 'string');
  assert.ok(path.isAbsolute(result.json.hunksIndexFile), result.json.hunksIndexFile);

  const indexText = fs.readFileSync(result.json.hunksIndexFile, 'utf8');
  const lines = indexText.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 150);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('a small diff stays under budget: hunks and summaryOnly inline, no hunksIndexFile', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'old\n' });
  c.writeFile('a.txt', 'new\n');

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));

  const hunks = result.json.hunks;
  assert.ok(Array.isArray(hunks.hunks));
  assert.ok(Array.isArray(hunks.summaryOnly));
  assert.equal(hunks.hunksIndexFile, undefined);
  assert.equal(fs.existsSync(path.join(result.json.runDir, 'hunks.json')), false);
});
