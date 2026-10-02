'use strict';

// GIT-04 (docs/roadmap/06-git-adapters.md, Q21, stories 186/211): `plan` refuses before any
// run folder exists on unmerged index entries left with no in-progress marker (such as a
// conflicted `git stash pop`), domain code `unmerged` (CLI kind `state`), read from the same
// porcelain v2 status call GIT-02/GIT-03 already make (M3 `headState`'s `u` lines); and on
// `i18n.commitEncoding` set to anything but UTF-8 (compared case-insensitively with `utf-8`
// and `utf8`), domain code `encoding` (M3 `commitEncoding`). Seam 1 only (docs/spec/testing-seams.md).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function assertStateRefusal(result) {
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.equal(typeof result.json.error.message, 'string');
  return result.json.error.message;
}

function commitFile(c, content, subject) {
  c.writeFile('file.txt', content);
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', subject]);
}

function assertNoRunFolder(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.commit-plan')), false, `.commit-plan created in ${dir}`);
}

test('plan after a conflicting stash pop (no in-progress marker) exits 6 state, resolve the conflicts first', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.writeFile('file.txt', 'b\n');
  c.git(['stash', 'push']);
  commitFile(c, 'c\n', 'conflicting change');
  try {
    c.git(['stash', 'pop']);
  } catch {
    // Conflict expected: leaves unmerged entries, no in-progress marker (not a merge).
  }
  assert.equal(fs.existsSync(path.join(c.repoDir, '.git', 'MERGE_HEAD')), false);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.equal(message, 'resolve the conflicts first');
  assertNoRunFolder(c.repoDir);
});

test('plan with i18n.commitEncoding set to utf8 goes on', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['config', 'i18n.commitEncoding', 'utf8']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

test('plan with i18n.commitEncoding set to UTF-8 goes on', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['config', 'i18n.commitEncoding', 'UTF-8']);

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});

test('plan with i18n.commitEncoding set to ISO-8859-1 exits 6 state, naming the encoding', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');
  c.git(['config', 'i18n.commitEncoding', 'ISO-8859-1']);

  const result = await runCommit(c, ['plan']);

  const message = assertStateRefusal(result);
  assert.match(message, /ISO-8859-1/);
  assertNoRunFolder(c.repoDir);
});

test('plan with no i18n.commitEncoding set goes on (unset is UTF-8 by default)', async (t) => {
  const c = createCase(t);
  commitFile(c, 'a\n', 'base');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.reply.status, 'nothing');
});
