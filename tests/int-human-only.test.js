'use strict';

// INT-16 (docs/roadmap/12-integration.md; Q10, Q16, Q17, C:confirmation-triggers, stories 89, 90,
// 149) at Seam 1: an included size-skipped file, or a change to the repo config's `scanIgnore`,
// makes the confirmation `humanOnly` in every mode (`ifNoUser` `no` plus `returnToParent`); an
// edit to another key of that file alone is no trigger.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function state(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

function unitIds(runDir, file) {
  return state(runDir).units.filter((unit) => unit.path === file).map((unit) => unit.id);
}

function writeGroups(runDir, groups, notIncluded = []) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups, notIncluded,
  }));
}

function group(header, hunks) {
  return { header, body: null, files: [], hunks, reason: header };
}

const CONFIG = '.claude/commit.json';

function configText(scanIgnore, body) {
  // One key per line, separated by padding lines of a nested object so the keys sit in
  // separate hunks.
  const pad = Array.from({ length: 12 }, (_, i) => `    "k${i}": ${i}`).join(',\n');
  return `{\n  "scanIgnore": ${JSON.stringify(scanIgnore)},\n  "x-pad": {\n${pad}\n  },\n  "body": "${body}"\n}\n`;
}

function seedConfig(c) {
  c.writeFile('a.txt', 'one\n');
  c.writeFile(CONFIG, configText(['docs/**'], 'required'));
  c.git(['add', '--', 'a.txt', CONFIG]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function assertHumanOnly(checked) {
  const { reply } = checked.json;
  assert.equal(reply.status, 'handback', detail(checked));
  assert.equal(reply.handback.kind, 'confirm');
  assert.equal(reply.handback.humanOnly, true, detail(checked));
  assert.deepEqual(reply.handback.ifNoUser, { answer: 'no', returnToParent: true });
}

test('Seam 1: an included over-1 MB file -> confirm humanOnly, ifNoUser no plus returnToParent', async (t) => {
  const c = createCase(t);
  c.writeFile('big.txt', 'seed\n');
  c.git(['add', '--', 'big.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('big.txt', 'seed\n' + 'x'.repeat(1024 * 1024 + 10) + '\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeGroups(runDir, [group('feat: grow big', unitIds(runDir, 'big.txt'))]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assertHumanOnly(checked);
  assert.deepEqual(checked.json.confirm.reasons, ['skipped file big.txt']);
});

test('an edited scanIgnore in the repo config -> humanOnly confirm', async (t) => {
  const c = createCase(t);
  seedConfig(c);
  c.writeFile(CONFIG, configText(['docs/**', 'gen/**'], 'required'));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeGroups(runDir, [group('chore: ignore gen', unitIds(runDir, CONFIG))]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assertHumanOnly(checked);
  assert.deepEqual(checked.json.confirm.reasons, [`scanIgnore change ${CONFIG}`]);
});

test('an edit to another key of the config alone -> no trigger', async (t) => {
  const c = createCase(t);
  seedConfig(c);
  c.writeFile(CONFIG, configText(['docs/**'], 'optional'));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeGroups(runDir, [group('chore: relax body', unitIds(runDir, CONFIG))]);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed', detail(checked));
  assert.equal(checked.json.confirm ?? null, null);
});

test('both keys edited, only the other key hunk included -> still humanOnly (every unit flagged)', async (t) => {
  const c = createCase(t);
  seedConfig(c);
  c.writeFile(CONFIG, configText(['docs/**', 'gen/**'], 'optional'));
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const ids = unitIds(runDir, CONFIG);
  assert.ok(ids.length >= 2, `two hunks expected: ${ids}`);
  const bodyHunk = state(runDir).units.filter((unit) => unit.path === CONFIG).at(-1).id;
  const rest = ids.filter((id) => id !== bodyHunk);
  writeGroups(
    runDir,
    [group('chore: relax body', [bodyHunk])],
    [{ path: CONFIG, hunks: rest, reason: 'later' }],
  );

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assertHumanOnly(checked);
});
