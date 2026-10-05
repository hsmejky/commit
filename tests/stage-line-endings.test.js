'use strict';

// CHG-22 (docs/roadmap/07-change-set.md): byte-exact commits across line-ending settings
// (Q11 pass 4 amendment, story 75). Hunk bodies, unit hashes and built patches keep git's raw
// bytes, so a Latin-1 file or CRLF content under `core.autocrlf=false` is committed byte for
// byte; under `core.autocrlf=true` or an `eol=crlf` attribute git's diff already compares the
// converted content and `git apply --cached` stages it in git's converted form, so line
// endings never cause a mismatch. Seam 1: `plan --split`, the groups written into
// `state.json` as `check` stores them, then `commit --plan <id> --all`; each commit's blob is
// read back with git as raw bytes.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// `plan --split`, then `pick(units)` → one ID list per group (stored units in file order),
// written as `check` stores them, then `commit --all`.
async function commitGroups(c, pick) {
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const statePath = path.join(planned.json.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = pick(state.units).map((units, i) => ({
    n: i + 1, units, header: `feat: group ${i + 1}`, body: '', committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const result = await runCommit(c, ['commit', '--plan', planned.json.planId, '--all']);
  assert.equal(result.exitCode, 0, detail(result));
  return result;
}

// Each of a file's two hunk units in its own group.
const splitHunks = (file) => (units) => {
  const hunks = units.filter((unit) => unit.path === file).map((unit) => unit.id);
  assert.equal(hunks.length, 2);
  return [[hunks[0]], [hunks[1]]];
};

// A committed blob as raw bytes (the case's `git` helper decodes stdout as UTF-8).
function blob(c, rev, file) {
  const result = spawnSync('git', ['cat-file', 'blob', `${rev}:${file}`], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

// 40 lines joined with `eol`, as bytes in `encoding`; `edits` replaces 1-based lines.
function lines(eol, encoding, edits = {}) {
  const text = Array.from({ length: 40 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`);
  return Buffer.from(`${text.join(eol)}${eol}`, encoding);
}

function seed(c, file, bytes) {
  c.writeFile(file, bytes);
  c.git(['add', '--', file]);
  c.git(['commit', '-q', '-m', 'seed']);
}

// Hunk 1 adds a line, so hunk 2's range shifts once group 1 is committed.
const EDITS = { 5: 'café crème\nnaïve', 30: 'señor über' };
const FIRST = { 5: EDITS[5] };

test('a Latin-1 file under core.autocrlf=false, split into two groups, is committed byte for byte', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'false']);
  seed(c, 'latin.txt', lines('\n', 'latin1'));
  const worktree = lines('\n', 'latin1', EDITS);
  c.writeFile('latin.txt', worktree);

  const result = await commitGroups(c, splitHunks('latin.txt'));

  assert.equal(result.json.commits.length, 2);
  assert.deepEqual(blob(c, 'HEAD~1', 'latin.txt'), lines('\n', 'latin1', FIRST));
  assert.deepEqual(blob(c, 'HEAD', 'latin.txt'), worktree);
  assert.equal(c.git(['status', '--porcelain']), '');
});

test('a CRLF file under core.autocrlf=false, split into two groups, is committed byte for byte', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'false']);
  seed(c, 'crlf.txt', lines('\r\n', 'utf8'));
  const edits = { 5: 'five\r\nfive more', 30: 'thirty' };
  const worktree = lines('\r\n', 'utf8', edits);
  c.writeFile('crlf.txt', worktree);

  const result = await commitGroups(c, splitHunks('crlf.txt'));

  assert.equal(result.json.commits.length, 2);
  assert.deepEqual(blob(c, 'HEAD~1', 'crlf.txt'), lines('\r\n', 'utf8', { 5: edits[5] }));
  assert.deepEqual(blob(c, 'HEAD', 'crlf.txt'), worktree);
  assert.equal(c.git(['status', '--porcelain']), '');
});

// The working tree holds CRLF; the blobs hold git's converted (LF) form.
test('CRLF content under core.autocrlf=true, split into two groups, is committed with no mismatch', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'true']);
  seed(c, 'auto.txt', lines('\r\n', 'utf8'));
  const edits = { 5: 'five\r\nfive more', 30: 'thirty' };
  c.writeFile('auto.txt', lines('\r\n', 'utf8', edits));

  const result = await commitGroups(c, splitHunks('auto.txt'));

  assert.equal(result.json.commits.length, 2);
  assert.deepEqual(blob(c, 'HEAD~1', 'auto.txt'), lines('\n', 'utf8', { 5: 'five\nfive more' }));
  assert.deepEqual(blob(c, 'HEAD', 'auto.txt'), lines('\n', 'utf8', { 5: 'five\nfive more', 30: 'thirty' }));
  assert.equal(c.git(['status', '--porcelain']), '');
});

test('a .gitattributes eol=crlf file, split into two groups, is committed with no mismatch', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'false']);
  c.writeFile('.gitattributes', 'eol.txt eol=crlf\n');
  c.git(['add', '--', '.gitattributes']);
  seed(c, 'eol.txt', lines('\r\n', 'utf8'));
  const edits = { 5: 'five\r\nfive more', 30: 'thirty' };
  c.writeFile('eol.txt', lines('\r\n', 'utf8', edits));

  const result = await commitGroups(c, splitHunks('eol.txt'));

  assert.equal(result.json.commits.length, 2);
  assert.deepEqual(blob(c, 'HEAD~2', 'eol.txt'), lines('\n', 'utf8'));
  assert.deepEqual(blob(c, 'HEAD~1', 'eol.txt'), lines('\n', 'utf8', { 5: 'five\nfive more' }));
  assert.deepEqual(blob(c, 'HEAD', 'eol.txt'), lines('\n', 'utf8', { 5: 'five\nfive more', 30: 'thirty' }));
  assert.equal(c.git(['status', '--porcelain']), '');
});

// A new file is a whole-file unit staged with `git add`, which converts it the same way.
test('a new CRLF file under core.autocrlf=true is committed with no mismatch', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'true']);
  seed(c, 'base.txt', 'base\n');
  c.writeFile('auto.txt', 'one\r\ntwo\r\n');

  const result = await commitGroups(c, (units) => [units.map((unit) => unit.id)]);

  assert.equal(result.json.commits.length, 1);
  assert.deepEqual(blob(c, 'HEAD', 'auto.txt'), Buffer.from('one\ntwo\n'));
  assert.equal(c.git(['status', '--porcelain']), '');
});

// Same, but under `core.autocrlf=false` so only the `eol=crlf` attribute (not autocrlf) is
// what converts the new file.
test('a new eol=crlf file under core.autocrlf=false is committed with no mismatch', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'false']);
  c.writeFile('.gitattributes', 'eol.txt eol=crlf\n');
  c.git(['add', '--', '.gitattributes']);
  seed(c, 'base.txt', 'base\n');
  c.writeFile('eol.txt', 'three\r\nfour\r\n');

  const result = await commitGroups(c, (units) => [units.map((unit) => unit.id)]);

  assert.equal(result.json.commits.length, 1);
  assert.deepEqual(blob(c, 'HEAD', 'eol.txt'), Buffer.from('three\nfour\n'));
  assert.equal(c.git(['status', '--porcelain']), '');
});
