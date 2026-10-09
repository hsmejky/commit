'use strict';

// RUN-24 (docs/roadmap/09-runs.md, Q17, Q22, C:run-folder takeover): a takeover of a killed
// run that finds staging beyond the killed group's paths (`killedLeftover`) never commits it
// unasked. M15 `resolveMode` decides by the run's flags: interactive -> a forced `modeChoice`
// naming the killed group's paths still staged; `--no-user` -> `killed-leftover` (exit 6
// `state`, index untouched, run released); `--reword` -> goes on with a notice. Seam 1 at the
// process boundary, the kill a real SIGKILL of `commit --all` during a pre-commit hook.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');
const { killCommitInHook } = require('./helpers/kill-run.js');

let runPolicy;

beforeEach(async () => {
  runPolicy = await loadLib('run-policy');
});

const TEST_TIMEOUT = { timeout: 90_000 };
const HEADERS = ['feat: change a', 'feat: change b'];
const NO_FLAGS = { split: false, staged: false };

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// --- M15 resolveMode ----------------------------------------------------------------------

test('M15 resolveMode: killedLeftover forces a modeChoice whatever the flags and the index shape', () => {
  for (const flags of [NO_FLAGS, { split: true, staged: false }, { split: false, staged: true }]) {
    for (const indexState of [{ staged: 1, other: 0 }, { staged: 0, other: 2 }, { staged: 2, other: 3 }]) {
      const decision = runPolicy.resolveMode(flags, indexState, true, ['a.txt']);
      assert.deepEqual(decision.modeChoice, indexState);
      assert.match(decision.notice, /`a\.txt`/);
      assert.equal(decision.mode, undefined);
      assert.equal(decision.refusal, undefined);
    }
  }
});

test('M15 resolveMode: killedLeftover with noUser and no reword refuses killed-leftover naming the paths', () => {
  const decision = runPolicy.resolveMode({ ...NO_FLAGS, staged: true, noUser: true }, { staged: 2, other: 1 }, true, ['a.txt', 'b c.txt']);
  assert.equal(decision.refusal.code, 'killed-leftover');
  assert.match(decision.refusal.message, /`a\.txt`, `b c\.txt`/);
  assert.match(decision.refusal.message, /unstage them or commit by hand, then run \/commit again$/);
});

test('M15 resolveMode: killedLeftover with reword stays reword plus a notice, with or without noUser', () => {
  for (const noUser of [false, true]) {
    const decision = runPolicy.resolveMode({ ...NO_FLAGS, reword: true, noUser }, { staged: 1, other: 1 }, true, ['a.txt']);
    assert.equal(decision.mode, 'reword');
    assert.match(decision.notice, /`a\.txt`/);
  }
});

test('M15 resolveMode: killed-leftover message stays within the 900-byte refusal budget with long escaped paths', () => {
  // Six paths of escaped bytes (the reply's backslash-x form, doubled again by JSON), five shown.
  const long = (n) => `dir${n}/${'\\xE2\\x82\\xAC'.repeat(60)}/file${n}.txt`;
  const paths = [1, 2, 3, 4, 5, 6].map(long);
  const { message } = runPolicy.resolveMode({ ...NO_FLAGS, staged: true, noUser: true }, { staged: 2, other: 1 }, true, paths).refusal;
  assert.ok(Buffer.byteLength(JSON.stringify(message), 'utf8') - 2 <= 900, `${message.length} chars`);
  assert.match(message, /^a killed \/commit run left staging behind, and more was staged since: `…/);
  assert.match(message, /file1\.txt`, `…[^`]*file2\.txt`/);
  assert.match(message, / and 1 more; unstage them or commit by hand, then run \/commit again$/);
  const short = runPolicy.resolveMode({ ...NO_FLAGS, staged: true, noUser: true }, { staged: 2, other: 1 }, true, ['a.txt']).refusal.message;
  assert.doesNotMatch(short, /…/);
});

test('M15 resolveMode: killedLeftover with othersOnly words the files as staged after the kill, same mode handling and caps', () => {
  const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
  const choice = runPolicy.resolveMode(NO_FLAGS, { staged: 6, other: 0 }, true, paths, true);
  assert.deepEqual(choice.modeChoice, { staged: 6, other: 0 });
  assert.equal(choice.notice, 'files staged after the killed run: `a.txt`, `b.txt`, `c.txt`, `d.txt`, `e.txt` and 1 more');
  const reword = runPolicy.resolveMode({ ...NO_FLAGS, reword: true }, { staged: 1, other: 0 }, true, ['a.txt'], true);
  assert.equal(reword.mode, 'reword');
  assert.equal(reword.notice, 'files staged after the killed run: `a.txt`');
  const { message } = runPolicy.resolveMode({ ...NO_FLAGS, noUser: true }, { staged: 1, other: 0 }, true, ['a.txt'], true).refusal;
  assert.equal(message, 'files were staged after a killed /commit run: `a.txt`; unstage them or commit by hand, then run /commit again');
  const long = (n) => `dir${n}/${'\\xE2\\x82\\xAC'.repeat(60)}/file${n}.txt`;
  const trimmed = runPolicy.resolveMode({ ...NO_FLAGS, noUser: true }, { staged: 6, other: 0 }, true, [1, 2, 3, 4, 5, 6].map(long), true).refusal.message;
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') - 2 <= 900);
  assert.match(trimmed, /^files were staged after a killed \/commit run: `…/);
});

test('M15 resolveMode: killedLeftover false leaves the ordinary decision alone', () => {
  assert.deepEqual(runPolicy.resolveMode({ ...NO_FLAGS, staged: true, noUser: true }, { staged: 1, other: 1 }, false), { mode: 'staged' });
});

// --- Seam 1 -------------------------------------------------------------------------------

// Two committed files, both modified, a.txt staged (so `preStaged` is `[a.txt]`), a `plan
// --split` run and two stored groups, one file each, as in plan-takeover-repair.test.js.
async function killableRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  c.git(['add', '--', 'a.txt']);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, lockPath: path.join(path.dirname(runDir), 'lock') };
}

// A `commit --plan --all` call SIGKILLed (node alone, then the hook) while the pre-commit hook
// sleeps: group 1 (a.txt) is staged, `indexReset` is set (phase (c)). Then the user stages b.txt.
async function killInPhaseCThenStageMore(c, planId) {
  await killCommitInHook(c, ['--plan', planId, '--all']);
  c.git(['add', '--', 'b.txt']);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n');
}

function ageLock(lockPath) {
  const then = new Date(Date.now() - 20 * 60_000);
  fs.utimesSync(lockPath, then, then);
}

function assertReleased(lockPath, runDir) {
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the killed run\'s folder is gone');
  assert.deepEqual(fs.readdirSync(path.dirname(runDir)), [], 'no run folder is left');
}

test('Seam 1: kill in phase (c), user stages another file, plan --take-over --staged -> no reset, modeChoice naming the killed paths; its answers respawn without takeOver', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);

  const result = await runCommit(c, ['plan', '--staged', '--take-over', planId]);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, null, detail(result));
  const { reply } = result.json;
  assert.equal(reply.handback.kind, 'modeChoice', detail(result));
  assert.match(reply.handback.question, /^2 files are staged, 0 other changes: /);
  const notices = reply.notices.join('\n');
  assert.match(notices, new RegExp(`replaced the /commit run \`${planId}\``), notices);
  assert.match(notices, /left its group's paths staged: `a\.txt`/, notices);
  assert.doesNotMatch(notices, /b\.txt|reset the partial staging/, notices);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n', 'the index is untouched');
  assertReleased(lockPath, runDir);
  for (const answer of reply.handback.answers) {
    assert.doesNotMatch(answer.respawn, /takeOver/, answer.label);
  }
  const staged = reply.handback.answers.find((answer) => answer.label === 'staged');
  assert.equal(staged.respawn, 'mode: staged');

  const respawned = await runCommit(c, ['plan', '--staged']);
  assert.equal(respawned.exitCode, 0, detail(respawned));
  assert.equal(respawned.json.mode, 'staged', detail(respawned));
  assert.notEqual(respawned.json.planId, null);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n');
});

test('Seam 1: the split answer of a forced modeChoice from plan --take-over --staged respawns mode: split alone', TEST_TIMEOUT, async (t) => {
  const { c, planId } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);

  const result = await runCommit(c, ['plan', '--staged', '--take-over', planId]);

  assert.equal(result.exitCode, 0, detail(result));
  const split = result.json.reply.handback.answers.find((answer) => answer.label === 'split');
  assert.equal(split.respawn, 'mode: split', 'one mode, the answer replaces the refused call\'s flag, and no takeOver');
  const respawned = await runCommit(c, ['plan', '--split']);
  assert.equal(respawned.exitCode, 0, detail(respawned));
  assert.equal(respawned.json.mode, 'split', detail(respawned));
});

test('Seam 1: an automatic stale takeover with killedLeftover, interactive -> the forced modeChoice carries the takeover, killedLeftover and unstaged notices', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.handback.kind, 'modeChoice', detail(result));
  const notices = result.json.reply.notices.join('\n');
  assert.match(notices, new RegExp(`took over the stale /commit run \`${planId}\``), notices);
  assert.match(notices, /left its group's paths staged: `a\.txt`/, notices);
  assert.match(notices, /the killed run's reset had unstaged: a\.txt/, notices);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n');
  assertReleased(lockPath, runDir);
});

test('Seam 1: an automatic takeover under --split --no-user -> exit 6 state killed-leftover naming the paths, index unchanged, lock and folder gone', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--split', '--no-user']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'state', detail(result));
  assert.match(result.json.error.message, /^a killed \/commit run left staging behind, and more was staged since: `a\.txt`; unstage them or commit by hand, then run \/commit again$/);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n', 'the index is unchanged');
  assertReleased(lockPath, runDir);
  assert.match(result.json.reply.notices.join('\n'), new RegExp(`took over the stale /commit run \`${planId}\``));
});

test('Seam 1: the same under plain --reword (interactive) -> the run goes on with a notice, no modeChoice', TEST_TIMEOUT, async (t) => {
  const { c, planId, lockPath } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword', detail(result));
  assert.notEqual(result.json.planId, null);
  assert.equal(result.json.reply?.handback, undefined, detail(result));
  const state = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8'));
  assert.match(state.notices.join('\n'), /left its group's paths staged: `a\.txt`/);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n', 'reword never touches the index');
});

test('Seam 1: the same under --reword -> the run goes on with a notice naming the paths', TEST_TIMEOUT, async (t) => {
  const { c, planId, lockPath } = await killableRun(t);
  await killInPhaseCThenStageMore(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--reword', '--no-user']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword', detail(result));
  assert.notEqual(result.json.planId, null);
  const state = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8'));
  assert.match(state.notices.join('\n'), /left its group's paths staged: `a\.txt`/);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'a.txt\nb.txt\n', 'reword never touches the index');
});

// None of the killed group's paths is staged any more, another file is: killedLeftover still,
// worded as files staged after the kill, not as the killed run's leftovers.
async function killThenSwapStaging(c, planId) {
  await killCommitInHook(c, ['--plan', planId, '--all']);
  c.git(['reset', '-q', '--', 'a.txt']);
  c.git(['add', '--', 'b.txt']);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'b.txt\n');
}

test('Seam 1: none of the killed group staged, another file is, interactive -> modeChoice with the "staged after the killed run" notice', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killThenSwapStaging(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--split']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.handback.kind, 'modeChoice', detail(result));
  const notices = result.json.reply.notices.join('\n');
  assert.match(notices, /files staged after the killed run: `b\.txt`/, notices);
  assert.doesNotMatch(notices, /left its group's paths staged/, notices);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'b.txt\n', 'the index is untouched');
  assertReleased(lockPath, runDir);
});

test('Seam 1: none of the killed group staged, another file is, --no-user -> killed-leftover refusal with the separate wording', TEST_TIMEOUT, async (t) => {
  const { c, planId, runDir, lockPath } = await killableRun(t);
  await killThenSwapStaging(c, planId);
  ageLock(lockPath);

  const result = await runCommit(c, ['plan', '--split', '--no-user']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'state', detail(result));
  assert.match(result.json.error.message, /^files were staged after a killed \/commit run: `b\.txt`; unstage them or commit by hand, then run \/commit again$/);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'b.txt\n', 'the index is unchanged');
  assertReleased(lockPath, runDir);
});
