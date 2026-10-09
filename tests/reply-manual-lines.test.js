'use strict';

// RPL-07 (docs/roadmap/11-reply-and-cli.md; C:reply-and-handback `text`, C:scan-patterns, Q10,
// stories 140, 141) at Seam 1: the two manual lines for a unit left out on a scan hit, and a
// `lintFailed` text that quotes the rejected message with every scan-hit span redacted.
// Tokens are built at run time.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const token = 'gh' + 'p_' + 'a'.repeat(36);
const mixed = 'gh' + 'p_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function unitIds(runDir, file) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return state.units.filter((unit) => unit.path === file).map((unit) => unit.id);
}

function writeWorkerPlan(runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
}

async function leftOut(t, names) {
  const c = createCase(t);
  for (const name of names) c.writeFile(name, 'x\n');
  c.git(['add', '--', ...names]);
  c.git(['commit', '-q', '-m', 'seed']);
  for (const name of names) c.writeFile(name, `x\nconst t = "${token}";\n`);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, {
    groups: [],
    notIncluded: names.map((name) => ({ path: name, hunks: unitIds(runDir, name), reason: 'left out' })),
  });
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  return checked;
}

test('Seam 1: a bare path gets two unquoted lines, a path with a space single quotes, a quote only "commit by hand"', { timeout: 120_000 }, async (t) => {
  const names = ['plain.js', 'with space.js', "it's.js", 'curly’.js'];
  const checked = await leftOut(t, names);

  const lines = checked.json.reply.text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('!git')).length, 4, checked.json.reply.text);
  const at = lines.indexOf('!git --literal-pathspecs add -- plain.js');
  assert.ok(at >= 0, checked.json.reply.text);
  assert.equal(lines[at + 1], '!git commit -m "<message>"');
  const quoted = lines.indexOf("!git --literal-pathspecs add -- 'with space.js'");
  assert.ok(quoted >= 0, checked.json.reply.text);
  assert.equal(lines[quoted + 1], '!git commit -m "<message>"');
  for (const name of ["it's.js", 'curly’.js']) {
    const entry = lines.findIndex((line) => line.includes(name) && line.includes('left out'));
    assert.ok(entry >= 0, checked.json.reply.text);
    assert.match(lines[entry + 1], /commit by hand/);
    assert.equal(lines.some((line) => line.startsWith('!git') && line.includes(name)), false);
  }
  assert.equal(lines.some((line) => line.includes('&&')), false);
  assert.equal(checked.stdout.includes(token), false);
});

test('Seam 1: a lintFailed message with a generic-secret span around a github-token span shows one [generic-secret]', { timeout: 120_000 }, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'x\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'x\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const header = `fix: set GITHUB_TOKEN = ${mixed} now`;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'user',
    groups: [{ header, body: null, files: [], hunks: unitIds(runDir, 'a.txt'), reason: 'dictated' }],
    notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  const { reply } = checked.json;
  assert.equal(reply.handback.kind, 'lintFailed', detail(checked));
  assert.equal(reply.text.split('[generic-secret]').length - 1, 1, reply.text);
  assert.match(reply.text, /fix: set \[generic-secret\] now/);
  assert.equal(reply.text.includes(mixed.slice(0, 10)), false, reply.text);
  assert.equal(reply.text.includes(mixed.slice(-10)), false, reply.text);
  assert.equal(JSON.stringify(reply).includes(mixed.slice(4, 20)), false);
});

// Review-RPL-07 finding 1: the final committed reply of check -> confirm -> commit --confirmed
// still names the hit unit left out, with its manual lines (rebuilt from the stored run).
test('Seam 1: a confirmed commit reply keeps the Not included entry and its manual lines', { timeout: 180_000 }, async (t) => {
  const c = createCase(t);
  const files = { 'a.txt': 'one\n', 'b.txt': 'two\n', 'hit.js': 'x\n', '.claude/commit.json': '{ "body": "optional" }\n' };
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.writeFile('hit.js', `x\nconst t = "${token}";\n`);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, {
    groups: [
      { header: 'feat: change a', body: null, files: [], hunks: unitIds(runDir, 'a.txt') },
      { header: 'fix: change b', body: null, files: [], hunks: unitIds(runDir, 'b.txt') },
    ],
    notIncluded: [{ path: 'hit.js', hunks: unitIds(runDir, 'hit.js'), reason: 'left out' }],
  });
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));

  const done = await runCommit(c, ['commit', '--plan', planId, '--all', '--confirmed']);

  assert.equal(done.exitCode, 0, detail(done));
  const { text } = done.json.reply;
  assert.match(text, /Not included:\n- hit\.js/, text);
  const lines = text.split('\n');
  const at = lines.indexOf('!git --literal-pathspecs add -- hit.js');
  assert.ok(at >= 0, text);
  assert.equal(lines[at + 1], '!git commit -m "<message>"');
  assert.equal(done.stdout.includes(token), false);
});

test('Seam 1: paths with U+201A and U+201B get only "commit by hand"', { timeout: 120_000 }, async (t) => {
  const names = ['low‚.js', 'rev‛.js'];
  const checked = await leftOut(t, names);
  const lines = checked.json.reply.text.split('\n');
  assert.equal(lines.some((line) => line.startsWith('!git')), false, checked.json.reply.text);
  for (const name of names) {
    const entry = lines.findIndex((line) => line.includes(name) && line.includes('left out'));
    assert.ok(entry >= 0, checked.json.reply.text);
    assert.match(lines[entry + 1], /commit by hand/);
  }
});

const { pathToFileURL } = require('node:url');
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

function reflogCount(c) {
  const out = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim();
  return out === '' ? 0 : out.split('\n').length;
}

// A direct `check` (no confirm: `--no-user`) that commits group 1 and stops on the clock, with
// `hit.js` left out on a scan hit; returns the case, the plan ID and the stopped check.
async function stoppedDirectCheck(t) {
  const c = createCase(t);
  const files = { 'a.txt': 'one\n', 'b.txt': 'two\n', 'hit.js': 'x\n', '.claude/commit.json': '{ "body": "optional" }\n' };
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.writeFile('hit.js', `x\nconst t = "${token}";\n`);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, {
    groups: [
      { header: 'feat: change a', body: null, files: [], hunks: unitIds(runDir, 'a.txt') },
      { header: 'fix: change b', body: null, files: [], hunks: unitIds(runDir, 'b.txt') },
    ],
    notIncluded: [{ path: 'hit.js', hunks: unitIds(runDir, 'hit.js'), reason: 'left out' }],
  });
  const schedule = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedule, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast: reflogCount(c) + 1 }, elapsedMs: 61_000 },
  ]));
  const checked = await runCommit(c, ['check', '--plan', planId], {
    nodeArgs: ['--import', CLOCK_PRELOAD], env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule },
  });
  return { c, planId, runDir, checked };
}

// Review-RPL-07 re-review item 3: every reply of a run that left a unit out names it, whether
// `check` committed directly or a confirmed `commit` did.
test('Seam 1: a direct check that stops on the budget and its continue call both keep the Not included entry', { timeout: 180_000 }, async (t) => {
  const { c, planId, checked } = await stoppedDirectCheck(t);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'continue', detail(checked));
  assert.match(checked.json.reply.text, /Not included:\n- hit\.js/, checked.json.reply.text);

  const next = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(next.exitCode, 0, detail(next));
  const { text } = next.json.reply;
  assert.match(text, /Not included:\n- hit\.js/, text);
  assert.ok(text.split('\n').includes('!git --literal-pathspecs add -- hit.js'), text);
  assert.equal(next.stdout.includes(token), false);
});

// Review-RPL-07 re-review item 1: a later `check` clears what an earlier one stored.
test('Seam 1: a second check clears the stored Not included entries of the first', { timeout: 180_000 }, async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.writeFile('hit.js', 'x\n');
  c.git(['add', '--', 'a.txt', 'b.txt', 'hit.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.writeFile('hit.js', `x\nconst t = "${token}";\n`);
  const planned = await runCommit(c, ['plan']);
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, {
    groups: [
      { header: 'feat: change a', body: null, files: [], hunks: unitIds(runDir, 'a.txt') },
      { header: 'fix: change b', body: null, files: [], hunks: unitIds(runDir, 'b.txt') },
    ],
    notIncluded: [{ path: 'hit.js', hunks: unitIds(runDir, 'hit.js'), reason: 'left out' }],
  });
  const first = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(first.json.reply.handback.kind, 'confirm', detail(first));
  const statePath = path.join(runDir, 'state.json');
  assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).notIncluded.length > 0);

  writeWorkerPlan(runDir, { groups: [], notIncluded: [] });
  const second = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(second.exitCode, 2, detail(second));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const field of ['groups', 'awaitingConfirm', 'notIncluded', 'scanLeftOut']) {
    assert.equal(field in state, false, field);
  }
});

// Review-RPL-07 re-review item 2: one path named twice in `notIncluded` (once per hunk ID)
// still gets one entry and one pair of manual lines.
test('Seam 1: a path left out hunk by hunk gets its manual lines once', { timeout: 120_000 }, async (t) => {
  const c = createCase(t);
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  c.writeFile('hit.js', `${body}\n`);
  c.git(['add', '--', 'hit.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  const lines = body.split('\n');
  lines[2] = `const t = "${token}";`;
  lines[35] = `const u = "${token}";`;
  c.writeFile('hit.js', `${lines.join('\n')}\n`);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const sliced = await runCommit(c, ['plan', '--hunks', '--plan', planId]);
  assert.equal(sliced.exitCode, 0, detail(sliced));
  const ids = unitIds(runDir, 'hit.js');
  assert.equal(ids.length, 2, ids.join());
  writeWorkerPlan(runDir, {
    groups: [],
    notIncluded: ids.map((id) => ({ path: 'hit.js', hunks: [id], reason: 'left out' })),
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const out = checked.json.reply.text.split('\n');
  assert.equal(out.filter((line) => line === '!git --literal-pathspecs add -- hit.js').length, 1, checked.json.reply.text);
});
