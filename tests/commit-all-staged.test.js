'use strict';

// EXE-19 (docs/roadmap/10-commit-executor.md): `staged` mode commits the index as it is. M10
// `verifyIndex` replaces phases (b) and (c): no reset, no staging, any difference from the
// stored hash map → exit 6 with the index left as it is (`unstaged: null`). Seam 1:
// `plan --staged`, the one group written into `state.json` as `check` stores it (every stored
// unit), then `commit --plan <id> --all`.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const lines = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');

// A `secret` built at run time (see tests/commit-all-backstop.test.js).
function tokenLine() {
  return `const token = "${'gh' + 'p_' + 'q'.repeat(36)}";\n`;
}

// Seeds `files`, runs `edit(c)` (staging included), `plan --staged`, then stores one group
// holding every unit. `tamperState(state)` edits the stored state before the group is written.
async function stagedRun(t, { files = { 'a.txt': lines(60) }, edit, tamperState } = {}) {
  const c = createCase(t);
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
  edit(c);
  const planned = await runCommit(c, ['plan', '--staged']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: 'feat: staged change', body: null, committed: false,
  }];
  tamperState?.(state, c);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

test('EXE-19 AC1: a partly staged file → the commit holds the staged version, the unstaged edit stays', async (t) => {
  const { c, planId } = await stagedRun(t, {
    edit: (c) => {
      c.writeFile('a.txt', lines(60).replace('line 1\n', 'staged 1\n'));
      c.git(['add', '--', 'a.txt']);
      c.writeFile('a.txt', lines(60).replace('line 1\n', 'staged 1\n').replace('line 60\n', 'unstaged 60\n'));
    },
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.commits.length, 1);
  assert.equal(c.git(['cat-file', 'blob', 'HEAD:a.txt']), lines(60).replace('line 1\n', 'staged 1\n'));
  assert.match(c.git(['show', '-s', '--format=%s', 'HEAD']), /^feat: staged change/);
  assert.equal(c.git(['diff', '--name-only']), 'a.txt\n', 'the unstaged edit is still in the working tree');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'nothing left staged');
  assert.equal(result.json.unstaged, null, 'staged never resets the index');
});

test('EXE-19 AC2: a hunk staged after plan → exit 6, the index unchanged, unstaged null', async (t) => {
  const { c, planId } = await stagedRun(t, {
    edit: (c) => {
      c.writeFile('a.txt', lines(60).replace('line 1\n', 'staged 1\n'));
      c.git(['add', '--', 'a.txt']);
    },
  });
  const head = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('a.txt', lines(60).replace('line 1\n', 'staged 1\n').replace('line 60\n', 'later 60\n'));
  c.git(['add', '--', 'a.txt']);
  const indexBefore = c.git(['ls-files', '--stage']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.unstaged, null);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
  assert.equal(c.git(['ls-files', '--stage']), indexBefore, 'the index is left as it is');
});

test('EXE-19 AC2: verifyIndex itself refuses a differing index hash set (fingerprint check bypassed) → exit 6, index unchanged', async (t) => {
  const { c, planId } = await stagedRun(t, {
    edit: (c) => {
      c.writeFile('a.txt', lines(60).replace('line 1\n', 'staged 1\n'));
      c.git(['add', '--', 'a.txt']);
    },
    tamperState: (state) => { state.units[0].hash = '0'.repeat(64); },
  });
  const head = c.git(['rev-parse', 'HEAD']).trim();
  const indexBefore = c.git(['ls-files', '--stage']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.unstaged, null);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(c.git(['ls-files', '--stage']), indexBefore);
});

test('EXE-19 AC3: a staged 60-file new directory is committed as the index holds it', async (t) => {
  const { c, planId } = await stagedRun(t, {
    files: { 'a.txt': 'a\n' },
    edit: (c) => {
      for (let i = 0; i < 60; i++) c.writeFile(`newdir/f${String(i).padStart(2, '0')}.txt`, `file ${i}\n`);
      c.git(['add', '--', 'newdir']);
    },
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.commits.length, 1);
  const tracked = c.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'newdir']).trim().split('\n');
  assert.equal(tracked.length, 60);
  assert.equal(c.git(['status', '--porcelain']), '');
});

test('EXE-19 AC4: the backstop runs in staged too → exit 3 scan, nothing committed, index left as it is', async (t) => {
  const { c, planId } = await stagedRun(t, {
    files: { 'README.md': 'readme\n', '.claude/commit.json': '{ "scanIgnore": ["vendor/**"] }\n' },
    edit: (c) => {
      c.writeFile('vendor/key.js', tokenLine());
      c.git(['add', '--', 'vendor/key.js']);
    },
    // The state is edited after `plan`, so no stored pattern covers the path any more.
    tamperState: (state) => { state.config.values.scanIgnore = []; },
  });
  const head = c.git(['rev-parse', 'HEAD']).trim();
  const indexBefore = c.git(['ls-files', '--stage']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 3, detail(result));
  assert.equal(result.json.error.kind, 'scan');
  assert.deepEqual(result.json.hits, [{ path: 'vendor/key.js', line: 1, pattern: 'github-token' }]);
  assert.equal(result.json.unstaged, null);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head);
  assert.equal(c.git(['ls-files', '--stage']), indexBefore, 'staged never unstages');
});
