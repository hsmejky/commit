'use strict';

// CHG-18 (docs/roadmap/07-change-set.md, C:plan-hunks): `plan --hunks` keeps stdout within
// the 20 000-character budget; past it the full hunk index spills to `hunks.json` (one
// entry per line) and stdout carries `hunksIndexFile` (absolute) instead of `hunks` and
// `summaryOnly`. Seam 1, through the shipped `plan` entry point (the in-process render,
// C:plan step 8); M13's own `renderHunks` unit coverage is tests/hunk-index.test.js.

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
  seed(c, files);
  for (const name of Object.keys(files)) c.writeFile(name, `${files[name]}line two\n`);

  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  assert.ok(result.stdoutBytes <= 20000 + 500, `stdout is ${result.stdoutBytes} bytes: ${detail(result)}`);

  const hunks = result.json.hunks;
  assert.equal(hunks.hunks, undefined);
  assert.equal(hunks.summaryOnly, undefined);
  assert.equal(typeof hunks.hunksIndexFile, 'string');
  assert.ok(path.isAbsolute(hunks.hunksIndexFile), hunks.hunksIndexFile);
  assert.equal(hunks.hunksIndexFile, path.join(result.json.runDir, 'hunks.json').split(path.sep).join('/'));

  const indexText = fs.readFileSync(hunks.hunksIndexFile, 'utf8');
  const lines = indexText.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 150);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  const ids = lines.map((line) => JSON.parse(line).id);
  assert.deepEqual(ids, Array.from({ length: 150 }, (_, i) => `h${i + 1}`));

  // `plan`'s own fields, excluding `hunks` and `reply`, stay tiny whatever the index holds.
  const { hunks: _h, reply: _r, ...own } = result.json;
  assert.ok(Buffer.byteLength(JSON.stringify(own)) <= 1024, JSON.stringify(own));
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
