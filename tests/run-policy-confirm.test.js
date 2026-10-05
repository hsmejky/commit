'use strict';

// RUN-17 (docs/roadmap/09-runs.md, C:confirmation-triggers, Q16): M15 `computeConfirm`'s
// decision — `check`'s `confirm` field from the per-group facts M18 resolves. Per
// docs/spec/testing-seams.md:84 ("Nothing else is tested in-process. M15 as a whole
// ... [is] tested through Seam 1"), every reachable row is exercised through `check`'s real
// CLI output below. The only in-process `computeConfirm` calls left are the `staged`-mode
// pure fallbacks right after this comment: `commitAll` throws `notBuilt(..., 'EXE-19')`
// before a `staged` `check`'s real output (with `confirm`) ever reaches the caller
// (KD-R94, docs/roadmap/known-deficiencies.md), so Seam 1 cannot reach these rows yet.

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

// --- Pure fallbacks for `staged` (KD-R94): EXE-19 blocks Seam 1 for every staged row, as
// KD-R94 names, so every staged row of C:confirmation-triggers is pinned here in-process
// until EXE-19 lands and these move to Seam 1 (dropping this whole block).

test('pure fallback (KD-R94): staged — a new file is never a trigger', () => {
  assert.equal(computeConfirm('staged', [group({ newFiles: [{ path: 'c.txt', binary: false }] })], NOT_RESUMED), null);
});

test('pure fallback (KD-R94): staged — a skipped file → "skipped file <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('staged', [group({ skippedFiles: ['big.bin'] })], NOT_RESUMED),
    { reasons: ['skipped file big.bin'], humanOnly: true },
  );
});

test('pure fallback (KD-R94): staged — a scanIgnore change → "scanIgnore change <path>", humanOnly true', () => {
  assert.deepEqual(
    computeConfirm('staged', [group({ scanIgnoreFiles: ['.claude/commit.json'] })], NOT_RESUMED),
    { reasons: ['scanIgnore change .claude/commit.json'], humanOnly: true },
  );
});

test('pure fallback (KD-R94): staged — resumed + interactive → "edited plan"', () => {
  assert.deepEqual(
    computeConfirm('staged', [group()], { resumed: true, interactive: true }),
    { reasons: ['edited plan'], humanOnly: false },
  );
});

test('pure fallback (KD-R94): staged — resumed but not interactive → no "edited plan"', () => {
  assert.equal(computeConfirm('staged', [group()], { resumed: true, interactive: false }), null);
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

test('Seam 1, split: an untracked new binary file in a group → confirm reasons "new binary file <path>"', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('logo.png', Buffer.from([0, 1, 2, 0, 3, 4]));
  const { planId, runDir } = await plannedSplit(c);
  writeWorkerPlan(runDir, oneGroup(['a.txt', 'logo.png']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['new binary file logo.png'], humanOnly: false });
});

test('Seam 1, split: a staged-added (status A) new file in a group → confirm reasons "new file <path>"', async (t) => {
  const c = createCase(t);
  const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}\n`);
  seed(c, { 'a.txt': lines.join('') });
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[29] = 'last\n';
  c.writeFile('a.txt', edited.join(''));
  c.writeFile('staged-new.txt', 'three\n');
  c.git(['add', '--', 'staged-new.txt']);
  // A staged-new file plus an unstaged-only edit is otherwise Q9's mode-choice handback (1
  // file staged, 1 other change): `--split` picks split mode up front (same reason as
  // tests/plan-placement-bans-seam1.test.js's AC3 fixture).
  const result = await runCommit(c, ['plan', '--split']);
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const { planId } = result.json;
  const runDir = path.join(c.repoDir, '.commit-plan', planId);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const [h1, h2] = state.units.filter((unit) => unit.path === 'a.txt').map((unit) => unit.id);
  const [newId] = state.units.filter((unit) => unit.path === 'staged-new.txt').map((unit) => unit.id);
  // A hunk-level group (KD-R83) never reaches `commitAll`, so this fixture's preStaged
  // `staged-new.txt` never hits EXE-11 ("the unstaged report for pre-staged paths is not
  // built yet", confirmed by direct repro of the whole-file form of this same fixture). A
  // plan never mixes `files` and `hunks` paths, so `staged-new.txt` is named by its own unit
  // ID too (PLN-03).
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [{ header: 'feat: a', body: null, files: [], hunks: [h1, newId] }],
    notIncluded: [{ path: 'a.txt', hunks: [h2], reason: 'leaving out for now' }],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['new file staged-new.txt'], humanOnly: false });
});

test('Seam 1, split: three groups → confirm.reasons ["3 groups"], humanOnly false', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.writeFile('c.txt', 'three\nmore\n');
  const { planId, runDir } = await plannedSplit(c);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [
      { header: 'feat: a', body: null, files: ['a.txt'], hunks: [] },
      { header: 'feat: b', body: null, files: ['b.txt'], hunks: [] },
      { header: 'feat: c', body: null, files: ['c.txt'], hunks: [] },
    ],
    notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['3 groups'], humanOnly: false });
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

test('Seam 1, split: reasons accumulate in order and humanOnly is true when reasons mix (C:check)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'big.txt': 'keep\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('c.txt', 'three\n');
  c.writeFile('big.txt', `keep\n${bigAddedContent(1024 * 1024 + 8192)}`);
  const { planId, runDir } = await plannedSplit(c);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [
      { header: 'feat: a', body: null, files: ['a.txt', 'c.txt'], hunks: [] },
      { header: 'chore: big', body: null, files: ['big.txt'], hunks: [] },
    ],
    notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  // C:check (docs/contracts/check.md:45): groups, then new files, then skipped/scanIgnore —
  // the non-human "new file" reason does not reset humanOnly once the skipped-file reason
  // (human-only) joins it, so a single mixed trigger set is still humanOnly: true.
  assert.deepEqual(checked.json.confirm, {
    reasons: ['2 groups', 'new file c.txt', 'skipped file big.txt'],
    humanOnly: true,
  });
});

test('Seam 1, reword: confirm is null when not resumed', async (t) => {
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

test('Seam 1, split: resumed + interactive → confirm reasons "edited plan" (any mode, C:confirmation-triggers)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const { planId, runDir } = await plannedSplit(c);
  const hunksResult = await runCommit(c, ['plan', '--hunks', '--plan', planId]);
  assert.equal(hunksResult.exitCode, 0, `stdout ${hunksResult.stdout}\nstderr ${hunksResult.stderr}`);
  writeWorkerPlan(runDir, oneGroup(['a.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.deepEqual(checked.json.confirm, { reasons: ['edited plan'], humanOnly: false });
});

test('Seam 1, split --no-user: resumed but not interactive → confirm null', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const result = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const { planId } = result.json;
  const runDir = path.join(c.repoDir, '.commit-plan', planId);
  const hunksResult = await runCommit(c, ['plan', '--hunks', '--plan', planId]);
  assert.equal(hunksResult.exitCode, 0, `stdout ${hunksResult.stdout}\nstderr ${hunksResult.stderr}`);
  writeWorkerPlan(runDir, oneGroup(['a.txt']));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.equal(checked.json.confirm, null);
});

test('Seam 1, split: a scan-hit left out in notIncluded gives no confirmation (a hit is never a trigger)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.js': 'one\ntwo\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.js', `one\ntwo\nconst token = "${'gh' + 'p_' + 'f'.repeat(36)}";\n`);
  const { planId, runDir } = await plannedSplit(c);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [{ header: 'feat: a', body: null, files: ['a.txt'], hunks: [] }],
    notIncluded: [{ path: 'b.js', hunks: null, reason: 'scan: github-token' }],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.equal(checked.json.confirm, null);
  // Confirms the fixture is a real scan hit (and not a stale token pattern silently matching
  // nothing), per C:check's `notices`.
  assert.ok(checked.json.notices.includes('b.js:3 github-token left out'), `notices ${JSON.stringify(checked.json.notices)}`);
});

test('Seam 1, split: a size-skipped file left out in notIncluded gives no confirmation (only an included skipped file triggers)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'big.txt': 'keep\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('big.txt', `keep\n${bigAddedContent(1024 * 1024 + 8192)}`);
  const { planId, runDir } = await plannedSplit(c);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker',
    groups: [{ header: 'feat: a', body: null, files: ['a.txt'], hunks: [] }],
    notIncluded: [{ path: 'big.txt', hunks: null, reason: 'leaving out for now' }],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, `stdout ${checked.stdout}\nstderr ${checked.stderr}`);
  assert.equal(checked.json.confirm, null);
});
