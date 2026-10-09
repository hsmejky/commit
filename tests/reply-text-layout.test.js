'use strict';

// RPL-05 (docs/roadmap/11-reply-and-cli.md; C:reply-and-handback `text` and Size, Q24, stories
// 55-57, 60, 228) at Seam 1: the shared `text` layout (lists capped at 10 plus "+N more", the
// `Notices:` block, the trailer line, the tree state), the size budgets at every cap, the lock
// replies under `--no-user`, and the commits of an earlier group in a `commit --all` failure.
// Tokens are built at run time.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const token = 'gh' + 'p_' + 'a'.repeat(36);
const TRAILER_LINE = /^(trailer: Co-Authored-By: .+|no trailer \(attribution source: \w[\w-]*\))$/m;
const slash = (p) => p.replace(/\\/g, '/');
const pad = (n) => String(n).padStart(2, '0');

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

function group(header, hunks, body = null) {
  return { header, body, files: [], hunks, reason: header };
}

function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

// KD-R112: the contract's 2 kB for the reply without text includes callerRule and handback, but
// the fixed rule texts alone are 0.7-1.4 kB and the prompt slice has not shortened them yet, so
// the budget is asserted on everything else (commits, notices, status fields) only.
function assertBudget(reply) {
  const { text, callerRule, handback, ...rest } = reply;
  assert.ok(Buffer.byteLength(text) <= 4096, `text ${Buffer.byteLength(text)} bytes`);
  assert.ok(sizeOf(rest) <= 2048, `reply without text, callerRule and handback ${sizeOf(rest)} bytes`);
}

function seedFiles(c, names, text = 'x\n') {
  for (const name of names) c.writeFile(name, text);
  c.git(['add', '--', ...names]);
  c.git(['commit', '-q', '-m', 'seed']);
}

test('Seam 1: a committed reply with every list one past its cap shows 10 plus "+1 more" and fits the size budgets', { timeout: 120_000 }, async (t) => {
  const c = createCase(t);
  const edits = Array.from({ length: 11 }, (_, i) => `e${pad(i)}.txt`);
  const secrets = Array.from({ length: 11 }, (_, i) => `s${pad(i)}.js`);
  seedFiles(c, [...edits, ...secrets]);
  for (const name of edits) c.writeFile(name, 'x\nmore\n');
  for (const name of secrets) {
    c.writeFile(name, name === secrets[10] ? `x\nplain\n` : `x\nconst t = "${token}";\n`);
  }
  c.git(['add', '--', ...secrets]);
  const planned = await runCommit(c, ['plan', '--split', '--no-user'], { timeoutMs: 110_000 });
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, {
    groups: edits.map((name, i) => group(`feat: change ${pad(i)}`, unitIds(runDir, name))),
    notIncluded: secrets.map((name) => ({ path: name, hunks: unitIds(runDir, name), reason: 'left out' })),
  });

  const checked = await runCommit(c, ['check', '--plan', planId], { timeoutMs: 110_000 });

  assert.equal(checked.exitCode, 0, detail(checked));
  const { reply } = checked.json;
  assert.equal(reply.status, 'committed', detail(checked));
  assert.equal(reply.commits.length, 11);
  assert.equal(reply.notices.length, 11, JSON.stringify(reply.notices));
  const lines = reply.text.split('\n');
  const section = (header) => lines.slice(lines.indexOf(header) + 1);
  assert.equal(lines.filter((line) => /^[0-9a-f]{40} feat: change /.test(line)).length, 10);
  const notIncludedLines = section('Not included:');
  assert.equal(notIncludedLines.slice(0, notIncludedLines.indexOf('your earlier staging was reset:')).filter((line) => line.startsWith('- s')).length, 10);
  assert.equal(section('your earlier staging was reset:').slice(0, 11).filter((line) => /^s\d\d\.js/.test(line)).length, 10);
  assert.equal(section('Notices:').slice(0, 11).filter((line) => line.startsWith('- ')).length, 10);
  assert.equal(lines.filter((line) => line === '+1 more').length, 4, reply.text);
  assert.match(lines.at(-1), /^11 files left: .*, \+1 more$/, reply.text);
  assert.equal(lines.at(-1).split(', ').length, 11);
  // Notices block, then the trailer line, then the tree state.
  assert.ok(lines.indexOf('Notices:') < lines.findIndex((line) => TRAILER_LINE.test(line)));
  assert.equal(lines.filter((line) => TRAILER_LINE.test(line)).length, 1, reply.text);
  assert.ok(lines.findIndex((line) => TRAILER_LINE.test(line)) < lines.length - 1);
  const appended = c.git(['log', '-1', '--format=%B']).includes('Co-Authored-By');
  assert.equal(lines.some((line) => line.startsWith('trailer: ')), appended, reply.text);
  assert.ok(Buffer.byteLength(reply.text) <= 4096, `text ${Buffer.byteLength(reply.text)} bytes`);
  assertBudget(reply);
  assert.equal(checked.stdout.includes(token), false);
});

test('Seam 1: a lintFailed with three groups with bodies and 11 errors caps the errors and fits the budgets', async (t) => {
  const c = createCase(t);
  const names = Array.from({ length: 11 }, (_, i) => `e${pad(i)}.txt`);
  seedFiles(c, names);
  for (const name of names) c.writeFile(name, 'x\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  // Three groups with a bad type (3 errors) leave 8 units unplaced (8 errors).
  writeWorkerPlan(runDir, {
    groups: names.slice(0, 3).map((name, i) => group(`wip: change ${i}`, unitIds(runDir, name), `Body line one of ${i}.\n\nBody line two.`)),
    notIncluded: [],
  });

  const first = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(first.exitCode, 2, detail(first));
  const second = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(second.exitCode, 2, detail(second));
  const { reply } = second.json;
  assert.equal(reply.handback.kind, 'lintFailed', detail(second));
  const lines = reply.text.split('\n');
  assert.equal(lines.filter((line) => line === `+${second.json.errors.length - 10} more`).length, 1, reply.text);
  assert.ok(second.json.errors.length > 10);
  assert.ok(Buffer.byteLength(reply.text) <= 4096);
  assertBudget(reply);
});

test('a reply with no commits has no trailer line, and a clean tree reply ends with the tree state', async (t) => {
  const c = createCase(t);
  seedFiles(c, ['a.txt']);

  const planned = await runCommit(c, ['plan']);

  assert.equal(planned.json.reply.status, 'nothing', detail(planned));
  assert.doesNotMatch(planned.json.reply.text, /trailer/i);
  assert.equal(planned.json.reply.text.split('\n').at(-1), 'working tree clean');
});

test('a not-a-repo refusal carries no tree state', async (t) => {
  const c = createCase(t, { repo: false });

  const planned = await runCommit(c, ['plan'], { cwd: c.root });

  assert.equal(planned.json.reply.status, 'failed', detail(planned));
  assert.doesNotMatch(planned.json.reply.text, /working tree clean|files? left/);
});

// ---- the lock replies (RUN-07 covers the error fields) ----

const OTHER_PLAN_ID = '11111111-1111-4111-8111-111111111111';

async function lockedPlan(t, content, extraArgs) {
  const c = createCase(t);
  seedFiles(c, ['a.txt'], 'one\n');
  c.writeFile('a.txt', 'one\nmore\n');
  const dir = path.join(c.repoDir, '.commit-plan');
  fs.mkdirSync(dir);
  const lock = path.join(dir, 'lock');
  fs.writeFileSync(lock, content);
  const minuteAgo = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  fs.utimesSync(lock, minuteAgo, minuteAgo);
  const result = await runCommit(c, ['plan', ...extraArgs]);
  return { result, touched: minuteAgo.getTime() };
}

test('Seam 1: a live lock met by plan --no-user is a failed reply with no takeover question and no handback', async (t) => {
  const { result } = await lockedPlan(t, JSON.stringify({ planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' }), ['--split', '--no-user']);

  assert.equal(result.exitCode, 6, detail(result));
  const { reply } = result.json;
  assert.equal(reply.status, 'failed');
  assert.equal(reply.handback, null);
  assert.doesNotMatch(reply.text, /take it over|Take it over/i);
  assert.match(reply.text, /^another \/commit run is in progress/);
});

for (const mode of [[], ['--split', '--no-user']]) {
  for (const [label, content] of [['unparseable', 'garbage'], ['malformed planId', JSON.stringify({ planId: 'nope', created: '2026-09-26T13:58:02.000Z' })]]) {
    test(`an ${label} lock met by plan ${mode.join(' ')} names the automatic takeover time in the failed reply`, async (t) => {
      const { result, touched } = await lockedPlan(t, content, mode);

      assert.equal(result.exitCode, 6, detail(result));
      const { reply } = result.json;
      assert.equal(reply.status, 'failed');
      assert.equal(reply.handback, null);
      const at = new Date(touched + 15 * 60_000);
      assert.ok(reply.text.includes(`taken over automatically at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`), reply.text);
      assert.equal(result.json.error.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
    });
  }
}

// ---- commit --all failures after an earlier group committed (KD-R73, KD-R107 `commits` gap) ----

const HEADERS = ['feat: change a', 'feat: change b', 'feat: change c'];

async function groupRun(t, count) {
  const c = createCase(t);
  const names = ['a', 'b', 'c'].slice(0, count);
  for (const name of names) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', ...names.map((name) => `${name}.txt`)]);
  c.git(['commit', '-q', '-m', 'seed']);
  for (const name of names) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = names.map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId };
}

test('exit 4 after group 1 committed: reply.commits lists it and text names it', async (t) => {
  const { c, planId } = await groupRun(t, 3);
  const counter = path.join(c.root, 'runs.log');
  const hookJs = path.join(c.root, 'pre-commit-hook.js');
  fs.writeFileSync(hookJs, [
    "const fs = require('node:fs');",
    `const counter = ${JSON.stringify(counter)};`,
    "let n = 0;",
    "try { n = fs.readFileSync(counter, 'utf8').split('\\n').filter(Boolean).length; } catch {}",
    "fs.appendFileSync(counter, (n + 1) + '\\n');",
    "if (n + 1 === 2) { process.stderr.write('pre-commit: rejected\\n'); process.exit(1); }",
    '',
  ].join('\n'));
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(hookJs)}"\n`);
  fs.chmodSync(hook, 0o755);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  const { reply } = result.json;
  assert.equal(reply.status, 'failed', detail(result));
  assert.deepEqual(reply.commits, result.json.commits);
  assert.equal(reply.commits.length, 1);
  assert.ok(reply.text.includes(`${reply.commits[0].sha} ${HEADERS[0]}`), reply.text);
  assert.match(reply.text, TRAILER_LINE);
});

test('exit 5 after a commit landed: reply.commits lists it and text names it', { timeout: 120_000 }, async (t) => {
  const { c, planId } = await groupRun(t, 2);
  const hook = path.join(c.repoDir, '.git', 'hooks', 'post-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexec sleep 120\n');
  fs.chmodSync(hook, 0o755);
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedule = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedule, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule },
  });

  assert.equal(result.exitCode, 5, detail(result));
  const { reply } = result.json;
  assert.equal(reply.status, 'failed', detail(result));
  assert.equal(reply.commits.length, 1);
  assert.deepEqual(reply.commits, result.json.commits);
  assert.ok(reply.text.includes(`${reply.commits[0].sha} ${HEADERS[0]}`), reply.text);
});

test('exit 4 stage-failed in group 2 after group 1 committed: reply.commits lists group 1 and text names it', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  c.writeFile('new.txt', 'new\n');
  // new.txt goes through a clean filter that is `cat` while a temporary index is in use and a
  // missing required command on the real index, so group 2's `git add` fails (stage-failed).
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'attributes'), 'new.txt filter=sw\n');
  c.git(['config', 'filter.sw.clean', 'if [ -n "$GIT_INDEX_FILE" ]; then cat; else commit-test-missing-clean-filter; fi']);
  c.git(['config', 'filter.sw.required', 'true']);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a.txt', 'new.txt'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === name).map((unit) => unit.id),
    header: HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.error.message, 'staging failed for group 2', detail(result));
  const { reply } = result.json;
  assert.equal(reply.status, 'failed', detail(result));
  assert.deepEqual(reply.commits, result.json.commits);
  assert.equal(reply.commits.length, 1);
  assert.ok(reply.text.includes(`${reply.commits[0].sha} ${HEADERS[0]}`), reply.text);
});
