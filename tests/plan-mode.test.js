'use strict';

// RUN-13 (docs/roadmap/09-runs.md): M15 `resolveMode` at `plan` step 4, with no takeover
// (`killedLeftover: false`). Flags win; `--staged` with an empty index refuses `staged-empty`
// (exit 1 `usage`); an empty or fully staged index plans `split`; a mixed index (staged
// changes plus unstaged tracked changes or candidates, counted after the hidden rule and
// before the caps) ends with a `modeChoice` carrying counts only, `planId: null` and no run
// folder (C:plan `mode`, Q9, Q16). The `modeChoice` handback's answers are INT-13's.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let runPolicy;

beforeEach(async () => {
  runPolicy = await loadLib('run-policy');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function runFolders(c) {
  const runs = path.join(c.repoDir, '.commit-plan');
  return fs.existsSync(runs) ? fs.readdirSync(runs) : [];
}

const QUESTION_TAIL = ': commit only the staged ones, or group all changes within the task?';

// Runs `plan` and asserts it planned (exit 0, the lock taken, the hunk index) in `mode`.
async function assertPlans(c, mode, flags = []) {
  const result = await runCommit(c, ['plan', ...flags]);
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, mode, detail(result));
  assert.match(result.json.planId, /^[0-9a-f-]{36}$/, detail(result));
  assert.equal(result.json.reply, null, detail(result));
  assert.notEqual(result.json.hunks, null, detail(result));
  return result;
}

// Runs `plan` and asserts its `modeChoice` ending: exit 0, `mode: null`, no `planId` or run
// folder, and the counts question as the reply's first line (no file names).
async function assertModeChoice(c, question, flags = []) {
  const result = await runCommit(c, ['plan', ...flags]);
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.equal(result.json.planId, null);
  assert.equal(result.json.runDir, null);
  assert.equal(result.json.mode, null);
  assert.equal(result.json.hunks, null);
  const { reply } = result.json;
  assert.equal(reply.status, 'handback');
  assert.equal(reply.planId, null);
  assert.equal(reply.text.split('\n')[0], question);
  assert.equal(reply.handback.kind, 'modeChoice');
  assert.equal(reply.handback.question, question);
  assert.deepEqual(runFolders(c), []);
  return result;
}

// --- M15 `resolveMode`, pure -------------------------------------------------------------

const NO_FLAGS = { split: false, staged: false };

test('M15 resolveMode: an empty or fully staged index resolves split', () => {
  assert.deepEqual(runPolicy.resolveMode(NO_FLAGS, { staged: 0, other: 0 }, false), { mode: 'split' });
  assert.deepEqual(runPolicy.resolveMode(NO_FLAGS, { staged: 0, other: 4 }, false), { mode: 'split' });
  assert.deepEqual(runPolicy.resolveMode(NO_FLAGS, { staged: 3, other: 0 }, false), { mode: 'split' });
});

test('M15 resolveMode: a mixed index with no flag is a modeChoice with counts only', () => {
  assert.deepEqual(runPolicy.resolveMode(NO_FLAGS, { staged: 3, other: 5 }, false),
    { modeChoice: { staged: 3, other: 5 } });
});

test('M15 resolveMode: a mode flag wins over a mixed index', () => {
  const mixed = { staged: 2, other: 1 };
  assert.deepEqual(runPolicy.resolveMode({ split: true, staged: false }, mixed, false), { mode: 'split' });
  assert.deepEqual(runPolicy.resolveMode({ split: false, staged: true }, mixed, false), { mode: 'staged' });
});

test('M15 resolveMode: --staged with an empty index refuses staged-empty', () => {
  const decision = runPolicy.resolveMode({ split: false, staged: true }, { staged: 0, other: 2 }, false);
  assert.deepEqual(decision, { refusal: { code: 'staged-empty', message: runPolicy.STAGED_EMPTY_MESSAGE } });
});

test('M15 resolveMode: killedLeftover is not built yet (RUN-24)', () => {
  assert.throws(() => runPolicy.resolveMode(NO_FLAGS, { staged: 1, other: 1 }, true), /RUN-24/);
});

// --- Seam 1 ------------------------------------------------------------------------------

test('every tracked change staged plans split; nothing staged plans split', async (t) => {
  const all = createCase(t);
  seed(all, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  all.writeFile('a.txt', 'a2\n');
  all.writeFile('b.txt', 'b2\n');
  all.git(['add', '--', 'a.txt', 'b.txt']);
  await assertPlans(all, 'split');

  const none = createCase(t);
  seed(none, { 'a.txt': 'a\n' });
  none.writeFile('a.txt', 'a2\n');
  none.writeFile('new.txt', 'n\n');
  await assertPlans(none, 'split');
});

test('one staged file plus one unstaged tracked edit is a modeChoice with counts only', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('b.txt', 'b2\n');

  const result = await assertModeChoice(c, `1 file is staged, 1 other change${QUESTION_TAIL}`);
  assert.doesNotMatch(result.json.reply.text.split('\n')[0], /a\.txt|b\.txt/);
});

test('the modeChoice question uses the plural for counts above one', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  c.writeFile('a.txt', 'a2\n');
  c.writeFile('b.txt', 'b2\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.writeFile('c.txt', 'c2\n');
  c.writeFile('new.txt', 'n\n');

  await assertModeChoice(c, `2 files are staged, 2 other changes${QUESTION_TAIL}`);
});

test('a fully staged index beside a large new directory is a modeChoice, counted before the caps', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  for (let i = 0; i < 60; i += 1) c.writeFile(`pkg/f${i}.txt`, `${i}\n`);

  await assertModeChoice(c, `1 file is staged, 60 other changes${QUESTION_TAIL}`);
});

test('a fully staged index beside hidden files only plans split', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('.env', 'SECRET=1\n');

  await assertPlans(c, 'split');
});

test('plan --staged with an empty index refuses staged-empty (exit 1 usage)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('a.txt', 'a2\n');

  const result = await runCommit(c, ['plan', '--staged']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'usage');
  assert.equal(result.json.error.message, runPolicy.STAGED_EMPTY_MESSAGE);
  assert.equal(result.json.reply.status, 'failed');
  assert.deepEqual(runFolders(c), []);
});

test('--split or --staged on a mixed index skips modeChoice and plans in that mode', async (t) => {
  for (const [flag, mode] of [['--split', 'split'], ['--staged', 'staged']]) {
    const c = createCase(t);
    seed(c, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    c.writeFile('a.txt', 'a2\n');
    c.git(['add', '--', 'a.txt']);
    c.writeFile('b.txt', 'b2\n');

    const result = await assertPlans(c, mode, [flag]);
    const state = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8'));
    assert.equal(state.mode, mode);
  }
});

test('core.ignorecase=true: a staged case-only git mv beside an unstaged edit is a modeChoice; --split refuses case-rename', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.ignorecase', 'true']);
  seed(c, { 'readme.txt': 'r\n', 'b.txt': 'b\n' });
  c.git(['mv', 'readme.txt', 'README.txt']);
  c.writeFile('b.txt', 'b2\n');

  // The rename is a staged deletion plus a staged addition (`--no-renames`): two files.
  await assertModeChoice(c, `2 files are staged, 1 other change${QUESTION_TAIL}`);

  const split = await runCommit(c, ['plan', '--split']);
  assert.equal(split.exitCode, 6, detail(split));
  assert.equal(split.json.error.kind, 'state');
  assert.match(split.json.error.message, /^cannot plan a staged case-only rename/);
  assert.deepEqual(runFolders(c), []);
});
