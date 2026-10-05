'use strict';

// RUN-17 (docs/roadmap/09-runs.md, C:confirmation-triggers, Q16): M15 `computeConfirm`'s pure
// decision — `check`'s `confirm` field from the per-group facts M18 resolves. Pure unit tests
// (same pattern as tests/check-lint-failures.test.js's `onLintFailure` and
// tests/run-policy-clean-tree.test.js's `planRefusal`): no git process, so they run on every
// host. Seam-1 table tests for the wired-in behavior (via `check`'s real output) follow below.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let computeConfirm;
beforeEach(async () => {
  ({ computeConfirm } = await loadLib('run-policy'));
});

const NOT_RESUMED = { resumed: false, interactive: true };

function group(fields = {}) {
  return { newFiles: [], skippedFiles: [], scanIgnoreFiles: [], ...fields };
}

test('computeConfirm: one group, no trigger → null', () => {
  assert.equal(computeConfirm('split', [group()], NOT_RESUMED), null);
  assert.equal(computeConfirm('staged', [group()], NOT_RESUMED), null);
  assert.equal(computeConfirm('reword', [group()], NOT_RESUMED), null);
});

test('computeConfirm: more than one group → "n groups", humanOnly false', () => {
  assert.deepEqual(
    computeConfirm('split', [group(), group()], NOT_RESUMED),
    { reasons: ['2 groups'], humanOnly: false },
  );
  assert.deepEqual(
    computeConfirm('split', [group(), group(), group()], NOT_RESUMED),
    { reasons: ['3 groups'], humanOnly: false },
  );
});

test('computeConfirm: a new file in split → "new file <path>", humanOnly false', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED),
    { reasons: ['new file docs/new.md'], humanOnly: false },
  );
});

test('computeConfirm: a new file is never a trigger outside split', () => {
  assert.equal(computeConfirm('staged', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED), null);
  assert.equal(computeConfirm('reword', [group({ newFiles: ['docs/new.md'] })], NOT_RESUMED), null);
});

test('computeConfirm: a skipped file → "skipped file <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ skippedFiles: ['big.bin'] })], NOT_RESUMED),
    { reasons: ['skipped file big.bin'], humanOnly: true },
  );
  assert.deepEqual(
    computeConfirm('staged', [group({ skippedFiles: ['big.bin'] })], NOT_RESUMED),
    { reasons: ['skipped file big.bin'], humanOnly: true },
  );
});

test('computeConfirm: a scanIgnore change → "scanIgnore change <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('split', [group({ scanIgnoreFiles: ['.claude/commit.json'] })], NOT_RESUMED),
    { reasons: ['scanIgnore change .claude/commit.json'], humanOnly: true },
  );
});

test('computeConfirm: resumed + interactive → "edited plan"', () => {
  assert.deepEqual(
    computeConfirm('split', [group()], { resumed: true, interactive: true }),
    { reasons: ['edited plan'], humanOnly: false },
  );
});

test('computeConfirm: resumed but not interactive → no "edited plan"', () => {
  assert.equal(computeConfirm('split', [group()], { resumed: true, interactive: false }), null);
});

test('computeConfirm: not resumed → no "edited plan" regardless of interactive', () => {
  assert.equal(computeConfirm('split', [group()], { resumed: false, interactive: true }), null);
  assert.equal(computeConfirm('split', [group()], { resumed: false, interactive: false }), null);
});

// --- Seam-1 table tests (docs/contracts/confirmation-triggers.md), via the real `check` CLI
// over a temp repo (the table-driven fixture generator paragraph, docs/spec/testing-seams.md).
// The `staged` rows are not covered here: `commitAll` throws `notBuilt('... staged ...',
// 'EXE-19')` before `check`'s real output (with `confirm`) can ever reach the caller, caught
// only as an `internal` failure by commit.cjs's top-level handler — KD-R94.

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeWorkerPlan(runDir, value) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify(value));
}

function oneGroup(files, extra = {}) {
  return { version: 1, source: 'worker', groups: [{ header: 'feat: x', body: null, files, hunks: [], ...extra }], notIncluded: [] };
}

function twoGroups(filesA, filesB) {
  return {
    version: 1, source: 'worker',
    groups: [
      { header: 'feat: a', body: null, files: filesA, hunks: [] },
      { header: 'feat: b', body: null, files: filesB, hunks: [] },
    ],
    notIncluded: [],
  };
}

async function plannedSplit(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  return { planId: result.json.planId, runDir: path.join(c.repoDir, '.commit-plan', result.json.planId) };
}

// Added lines whose total UTF-8 length is at least `bytes`, well clear of the exact 1 MB
// boundary (`MAX_ADDED_LENGTH`, plugin/scripts/lib/scanner.mjs) either way.
function bigAddedContent(bytes) {
  const lines = [];
  let rest = bytes;
  while (rest >= 1024) {
    lines.push(`${'x'.repeat(1023)}\n`);
    rest -= 1024;
  }
  if (rest > 0) lines.push(`${'y'.repeat(Math.max(rest - 1, 1))}\n`);
  return lines.join('');
}

test('Seam 1, split: one group, nothing special → confirm null', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['a.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.equal(checked.json.confirm, null);
});

test('Seam 1, split: two groups → confirm.reasons ["2 groups"], humanOnly false', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, twoGroups(['a.txt'], ['b.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['2 groups'], humanOnly: false });
});

test('Seam 1, split: an untracked new file in a group → confirm reasons "new file <path>"', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['a.txt', 'c.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['new file c.txt'], humanOnly: false });
});

test('Seam 1, split: a size-skipped file → confirm reasons "skipped file <path>", humanOnly true', async (t) => {
  const c = createCase(t);
  seed(c, { 'big.txt': 'keep\n' });
  c.writeFile('big.txt', `keep\n${bigAddedContent(1024 * 1024 + 8192)}`);
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['big.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['skipped file big.txt'], humanOnly: true });
});

test('Seam 1, split: a scanIgnore change on an included file → confirm reasons "scanIgnore change <path>", humanOnly true', async (t) => {
  const c = createCase(t);
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: [] }));
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '-A']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: ['dist/**'] }));
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['.claude/commit.json']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['scanIgnore change .claude/commit.json'], humanOnly: true });
});

test('Seam 1, staged: a new file is never a trigger (pure unit coverage; EXE-19 blocks Seam 1, KD-R94)', () => {
  assert.equal(computeConfirm('staged', [group({ newFiles: ['c.txt'] })], NOT_RESUMED), null);
});

test('Seam 1, reword: confirm is always null', async (t) => {
  const c = createCase(t);
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', 'fix: old message']);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, `stdout ${planned.stdout}\nstderr ${planned.stderr}`);
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, oneGroup([], { header: 'fix: better message' }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.equal(checked.json.confirm, null);
});

test('computeConfirm: combination ordering — groups, then new files, then skipped/scanIgnore, then edited plan', () => {
  const groups = [
    group({ newFiles: ['a.txt'], skippedFiles: ['big.bin'] }),
    group({ newFiles: ['b.txt'], scanIgnoreFiles: ['.claude/commit.json'] }),
  ];
  assert.deepEqual(
    computeConfirm('split', groups, { resumed: true, interactive: true }),
    {
      reasons: [
        '2 groups',
        'new file a.txt',
        'new file b.txt',
        'skipped file big.bin',
        'scanIgnore change .claude/commit.json',
        'edited plan',
      ],
      humanOnly: true,
    },
  );
});
