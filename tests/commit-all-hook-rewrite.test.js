'use strict';

// EXE-15 (docs/roadmap/10-commit-executor.md): hook-rewrite detection. In `split`, while a
// later group is still pending, the worktree diff's hash set right before and right after a
// group's own `git commit` call is compared (that group's own committed hashes taken out
// first). A difference records `treeChangedDuringCommit: n` in the run state (C:commit-release,
// Q18), and the next group's `unmatched` (`diff-changed`) refusal then names that group as the
// likely cause of a repo hook (lint-staged, a formatter) rewriting files, instead of the
// generic "files changed since plan" text.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const UNMATCHED_TEXT = 'files changed since plan, run /commit again';
function hookRewriteText(n) {
  return `files changed during the commit of group ${n} — a repo hook (lint-staged, a `
    + 'formatter) likely rewrote them; run /commit again';
}

// Two committed files, each modified, a `plan --split` run, and two stored groups, one per
// file, in a, b order, as `check` stores them.
async function twoGroupRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: `feat: change ${name}`,
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed };
}

function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

// `treeChangedDuringCommit` is a `state.json` field only: a `diff-changed` refusal, and a
// clean run that finishes its last group, both end the run and delete the run folder
// (docs/contracts/run-folder.md), so no CLI call that ends that way leaves anything for a
// later `readState` to find. Only a kept run (EXE-16's budget stop) can be read afterward —
// so `scheduleAfterCommits`/`runCommitAfterCommits` force one right after the `n`th group
// this call commits, before the next group's own phase (a)/(b) ever runs, purely to observe
// the field directly (review-EXE-15 M1/H1); tolerant of an unborn repo's reflog (none yet).
function reflogCount(c) {
  const result = spawnSync('git', ['reflog', 'show', '--no-color', '--format=%H', 'HEAD'], {
    cwd: c.repoDir, env: c.env, encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) return 0;
  return result.stdout.split('\n').filter(Boolean).length;
}

function scheduleAfterCommits(c, n, elapsedMs) {
  const schedulePath = path.join(c.root, 'schedule.json');
  const atLeast = reflogCount(c) + n;
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast }, elapsedMs },
  ]));
  return schedulePath;
}

function runCommitAfterCommits(c, planId, n, elapsedMs) {
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleAfterCommits(c, n, elapsedMs) },
  });
}

// A fixture `pre-commit` hook (runs during every `git commit` in the repo) that, only on its
// first invocation, rewrites `target`'s (default `b.txt`) tracked content in the worktree. A
// marker file stops it from acting again during a later commit.
function installRewriteHook(c, target = 'b.txt') {
  const marker = path.join(c.root, 'rewrite-done');
  const bPath = path.join(c.repoDir, target);
  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    `const bPath = ${JSON.stringify(bPath)};`,
    'if (!fs.existsSync(marker)) {',
    "  fs.writeFileSync(marker, '1');",
    "  fs.writeFileSync(bPath, 'b\\nrewritten-by-hook\\n');",
    '}',
    '',
  ].join('\n'));
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  const slash = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);
}

test('a pre-commit hook rewrites group 2\'s file during group 1\'s commit → group 2 refused diff-changed naming group 1 as the likely hook-rewrite cause', async (t) => {
  const { c, planId, runDir, seed } = await twoGroupRun(t);
  installRewriteHook(c);

  // M1/H1: a `diff-changed` refusal ends the run and deletes the run folder
  // (docs/contracts/run-folder.md), so the state field can only be read directly while the
  // run is kept — stop the call on an EXE-16 budget right after group 1 lands, before group
  // 2's own phase (b) ever runs.
  const stopped = await runCommitAfterCommits(c, planId, 1, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.equal(stopped.json.refusal, undefined, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2]);
  assert.equal(fs.existsSync(runDir), true, 'a budget stop keeps the run');
  // M1: the state field itself, not just the message text it drives.
  assert.equal(readState(runDir).treeChangedDuringCommit, 1);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, hookRewriteText(1), detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.deepEqual(result.json.commits, [], 'group 1 already landed on the budget-stop call');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
  assert.equal(
    fs.readFileSync(path.join(c.repoDir, 'b.txt'), 'utf8'),
    'b\nrewritten-by-hook\n',
    "the hook's rewrite is left in the worktree, never committed",
  );

  // L4 (review-EXE-15 r2): the AC's literal scenario — group 1 committed and group 2 refused
  // in the *same* reply, the flag read back from in-memory state rather than a reloaded run —
  // is only covered indirectly above (the budget-stop call reports group 1, the follow-up
  // `continue` call reports the refusal). Re-run the whole thing as a single call on a fresh
  // run to cover that literal case too.
  const { c: oneCallCase, planId: oneCallPlanId, seed: oneCallSeed } = await twoGroupRun(t);
  installRewriteHook(oneCallCase);

  const oneCall = await runCommit(oneCallCase, ['commit', '--plan', oneCallPlanId, '--all']);

  assert.equal(oneCall.exitCode, 6, detail(oneCall));
  assert.equal(oneCall.json.error.kind, 'diff-changed', detail(oneCall));
  assert.equal(oneCall.json.error.message, hookRewriteText(1), detail(oneCall));
  const oneCallShas = oneCallCase.git(['rev-list', '--reverse', `${oneCallSeed}..HEAD`]).trim().split('\n');
  assert.equal(oneCallShas.length, 1, 'only group 1 was committed');
  assert.deepEqual(
    oneCall.json.commits,
    [{ n: 1, sha: oneCallShas[0], header: 'feat: change a' }],
    "group 1 is reported in the same reply as group 2's refusal",
  );
  assert.equal(oneCall.json.failed, 2);
  assert.deepEqual(oneCall.json.remaining, [2]);
});

test('two groups and no hook, group 2 edited after plan → the generic text, not the hook-rewrite variant (treeChangedDuringCommit never set)', async (t) => {
  const { c, planId, runDir, seed } = await twoGroupRun(t);
  c.writeFile('b.txt', 'b\nedited after plan\n');

  // M1: observed while the run is kept (a budget stop after group 1, EXE-16) — the
  // `diff-changed` refusal below would otherwise delete the run folder first.
  const stopped = await runCommitAfterCommits(c, planId, 1, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2]);
  assert.equal(fs.existsSync(runDir), true, 'a budget stop keeps the run');
  // M1: assert the state field directly, not only the generic message text.
  assert.equal('treeChangedDuringCommit' in readState(runDir), false);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT, detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
});

// M1: the branch that clears `treeChangedDuringCommit` once a later group's own commit
// causes no further change (commit-executor.mjs, right after the hook-rewrite `if` block).
// Four tracked files: group 1 = a, group 2 = c, group 3 = b; d is a leftover tracked change
// claimed by no group. The hook rewrites d (never b) during group 1's own commit, which
// sets `treeChangedDuringCommit: 1`; group 2 (c) then commits with nothing else changing,
// which must clear it; b is edited again, independently of any hook, right after `plan`. If
// the flag were not cleared, group 3's `unmatched` refusal over b would wrongly use the
// hook-rewrite text and blame group 1, although b's change has nothing to do with the hook.
test('a later group\'s own clean commit clears treeChangedDuringCommit, so a later, unrelated mismatch gets the generic text', async (t) => {
  const c = createCase(t);
  for (const name of ['a', 'b', 'c', 'd']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt', 'c.txt', 'd.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b', 'c', 'd']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const unitsOf = (name) => state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id);
  state.groups = [
    { n: 1, units: unitsOf('a'), header: 'feat: change a', body: null, committed: false },
    { n: 2, units: unitsOf('c'), header: 'feat: change c', body: null, committed: false },
    { n: 3, units: unitsOf('b'), header: 'feat: change b', body: null, committed: false },
  ];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  installRewriteHook(c, 'd.txt'); // rewrites d.txt, never claimed by any group
  c.writeFile('b.txt', 'b\nedited after plan\n'); // independent of the hook

  // M1: observed while the run is kept (a budget stop after group 2, EXE-16) — right before
  // group 3's own phase (b) would otherwise run and, via an `unmatched` refusal, delete the
  // run folder.
  const stopped = await runCommitAfterCommits(c, planId, 2, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [3]);
  assert.equal(fs.existsSync(runDir), true, 'a budget stop keeps the run');
  assert.equal('treeChangedDuringCommit' in readState(runDir), false);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT, detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 2, 'groups 1 and 2 were committed, group 3 refused');
  assert.equal(result.json.failed, 3);
  assert.deepEqual(result.json.remaining, [3]);
});

// H1 (review-EXE-15): the after-commit diagnosis snapshot must pass `unborn: false` (HEAD
// always exists once this group's own `git commit` has landed), never `state.head === null`
// (the SHA expected *before* the commit, still `null` on a run that started unborn). Passing
// the latter made the temporary index start empty on an unborn multi-group run, so every
// candidate re-added as a new-file unit and the diagnosis could never match, false-flagging
// `treeChangedDuringCommit` on every such run, hook or not. Repro: an unborn repo, two
// untracked files, one group per file, group 2's file edited after `plan`, no hook at all.
test('an unborn multi-group run with no hook still gets the generic text, not a false hook-rewrite flag', async (t) => {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: `feat: add ${name}`,
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  c.writeFile('b.txt', 'b\nedited after plan\n');

  // H1/M1: observed while the run is kept (a budget stop after group 1, EXE-16) — the
  // `diff-changed` refusal below would otherwise delete the run folder first. This is the
  // direct check that the unborn repo's first commit never false-flags the field.
  const stopped = await runCommitAfterCommits(c, planId, 1, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2]);
  assert.equal(fs.existsSync(runDir), true, 'a budget stop keeps the run');
  assert.equal('treeChangedDuringCommit' in readState(runDir), false);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT, detail(result));
  const shas = c.git(['rev-list', '--reverse', 'HEAD']).trim().split('\n');
  assert.equal(shas.length, 1, "only group 1 (the repo's first-ever commit) landed");
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
});

// H2 (review-EXE-15): roadmap AC3 ("the last group → the worktree-hash git calls are not
// spawned before or after `git commit`") had no test. A regression that ran the after-commit
// diagnosis for the last group too (an extra full rebuild + diff per run) would pass every
// other EXE-15 case silently. Observed through the PATH-independent spawn-record preload:
// every git call against the run's own temporary index (`GIT_INDEX_FILE` holding `git-index`)
// is logged with its position relative to each `git commit` spawn.
test('AC3: no snapshot git calls on the temporary index follow the last group\'s own commit (a non-last group still gets them)', async (t) => {
  const { c, planId } = await twoGroupRun(t);
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 0, detail(result));
  const gitCalls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.file === 'git');
  const commitIndexes = gitCalls
    .map((e, i) => (e.args[0] === 'commit' ? i : -1))
    .filter((i) => i !== -1);
  assert.equal(commitIndexes.length, 2, JSON.stringify(gitCalls));
  const [afterGroup1, afterGroup2] = commitIndexes;
  const onTempIndex = (e) => Boolean(
    e.gitEnv && e.gitEnv.GIT_INDEX_FILE && e.gitEnv.GIT_INDEX_FILE.includes('git-index'),
  );
  const betweenGroups = gitCalls.slice(afterGroup1 + 1, afterGroup2).filter(onTempIndex);
  const afterLastGroup = gitCalls.slice(afterGroup2 + 1).filter(onTempIndex);
  // L5 (review-EXE-15 r2): `betweenGroups` also holds group 2's own phase-(b) match, so a
  // plain `length > 0` would hold even with group 1's after-commit diagnosis removed. Each
  // `snapshot()` call rebuilds the temporary index with exactly one `git reset -q -- .`
  // (change-set.mjs buildTemporaryIndex) before any diff/check-attr call on it, so counting
  // those is a count of snapshot *rounds*: group 1's after-commit diagnosis and group 2's own
  // phase-(b) match, two rounds, never collapsing into one even if either were dropped.
  const resetRounds = (calls) => calls.filter((e) => e.args[0] === 'reset');
  assert.equal(
    resetRounds(betweenGroups).length,
    2,
    "group 1's after-commit diagnosis snapshot and group 2's own phase-(b) snapshot each "
      + `rebuild the temporary index once: ${JSON.stringify(betweenGroups)}`,
  );
  assert.deepEqual(afterLastGroup, [], 'the last group spawns no snapshot git calls after its own commit');
});

// review-CHG-20 Medium-2 (KD-S84): `ownHashes` (commit-executor.mjs ~460-462) is the group's
// own hashes, from `groupUnits` matched in the current snapshot — not derived from
// whole-file units alone, which would miss a hunk-level group's hash entirely. One file,
// two hunks in two groups, the first hunk adding a line so hunk 2's range shifts once group
// 1 lands: without the fix, group 1's own (correctly excluded) hash would still look like an
// unexplained diff and set `treeChangedDuringCommit` on a clean run with no repo hook at all.
async function oneFileTwoHunkRun(t) {
  const c = createCase(t);
  const base = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
  c.writeFile('f.txt', base);
  c.git(['add', 'f.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const lines = base.split('\n');
  lines[1] = 'two\ntwo-more';
  lines[14] = 'fifteen';
  c.writeFile('f.txt', lines.join('\n'));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ids = state.units.filter((unit) => unit.path === 'f.txt').map((unit) => unit.id);
  assert.equal(ids.length, 2, `expected two hunks of f.txt, got ${JSON.stringify(state.units)}`);
  state.groups = ids.map((id, i) => ({
    n: i + 1, units: [id], header: `feat: hunk ${i + 1}`, body: null, committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

test("KD-S84: a file's own first hunk shifting its second hunk's range is not mistaken for a hook rewrite", async (t) => {
  const { c, planId, runDir } = await oneFileTwoHunkRun(t);

  const stopped = await runCommitAfterCommits(c, planId, 1, 61_000);
  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.equal(stopped.json.refusal, undefined, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2]);
  assert.equal(fs.existsSync(runDir), true, 'a budget stop keeps the run');
  assert.equal('treeChangedDuringCommit' in readState(runDir), false);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.commits.length, 1, detail(result));
});
