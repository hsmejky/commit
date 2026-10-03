'use strict';

// EXE-02 (docs/roadmap/10-commit-executor.md): the M16 tracer bullet at Seam 1. A `plan
// --split` run over two modified tracked files gets one stored group written into its
// `state.json` as `check` would; `commit --plan <id> --all` then commits that group's
// whole-file units (C:commit-release): the output fields, the commit's tree and message,
// HEAD, the run released after the last group, and `unstaged: []` once `indexReset` is set.
// Plus the thin M10 `matchIds` in process.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
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

const HEADER = 'feat: change both files';
const BODY = 'Some body.';

// Two committed files, both modified, a `plan --split` run holding the lock, and one stored
// group naming every unit, as `check` stores it (PLN-01).
async function groupedRun(t) {
  const c = createCase(t);
  // GIT-06 builds `git commit`'s own environment (the inherited identity kept); until then
  // M2 strips every `GIT_*`, so the repo carries an identity of its own.
  c.git(['config', 'user.name', 'Commit Test Author']);
  c.git(['config', 'user.email', 'author@example.com']);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: BODY, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

test('one stored group of two modified files → exit 0 with one commit and the full output fields', async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(result.json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  assert.equal(result.json.error, null);
  assert.equal(result.json.gitOutput, null);
});

test("the commit's tree holds both files' working-tree content, its message is the stored one byte for byte, and HEAD is sha", async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha);
  assert.equal(c.git(['ls-tree', '--name-only', sha]), 'a.txt\nb.txt\n');
  assert.equal(c.git(['show', `${sha}:a.txt`]), 'one\nmore\n');
  assert.equal(c.git(['show', `${sha}:b.txt`]), 'two\nmore\n');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${BODY}\n`);
  assert.equal(c.git(['status', '--porcelain']), '', 'nothing is left uncommitted');
});

test('after the call the lock, the run folder and call.lock are gone', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the lock is gone');
  assert.equal(fs.existsSync(path.join(runDir, 'call.lock')), false, 'call.lock is gone');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
});

test('with no pre-staging, unstaged is [] (the run set indexReset), not null', async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.unstaged, []);
});

test('matchIds: every id whose hash a current unit carries → ok; a missing hash → unmatched', () => {
  const units = [{ hash: 'h1' }, { hash: 'h2' }];

  assert.deepEqual(changeSet.matchIds({ u1: 'h1', u2: 'h2' }, units), { ok: true });
  assert.deepEqual(
    changeSet.matchIds({ u1: 'h1', u3: 'h3' }, units),
    { ok: false, code: 'unmatched', unmatched: ['u3'] },
  );
});
