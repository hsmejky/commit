'use strict';

// INT-15 (docs/roadmap/12-integration.md; Q10, C:scan-patterns, C:plan-hunks,
// C:reply-and-handback, stories 96, 135-141) at Seam 1: a unit with a scan hit stays out of the
// commit, is named in the reply by pattern ID and location only, a hit alone is no confirmation
// trigger, and a token in the commit message fails lint. Tokens are built at run time.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const token = 'gh' + 'p_' + 'a'.repeat(36);

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function group(header, hunks) {
  return { header, body: null, files: [], hunks, reason: header };
}

function unitId(runDir, file) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return state.units.find((unit) => unit.path === file).id;
}

async function hitRun(t, extraArgs = []) {
  const c = createCase(t);
  c.writeFile('ok.txt', 'one\n');
  c.writeFile('secret.js', 'x\n');
  c.git(['add', '--', 'ok.txt', 'secret.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('ok.txt', 'one\ntwo\n');
  c.writeFile('secret.js', `x\nconst t = "${token}";\n`);
  const planned = await runCommit(c, ['plan', '--split', ...extraArgs]);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planned, planId, runDir };
}

function write(runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
}

test('Seam 1: a hit unit is committed around, named by pattern ID and path:line, the value never appears', async (t) => {
  const { c, planned, planId, runDir } = await hitRun(t, ['--no-user']);
  assert.equal(planned.stdout.includes(token), false);
  assert.equal(planned.stderr.includes(token), false);
  const hit = planned.json.hunks.hunks.find((h) => h.path === 'secret.js');
  assert.equal(hit.body, 'none');
  assert.deepEqual(hit.scan, ['github-token']);
  const planJson = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
  assert.deepEqual(planJson.scan.hits.map((h) => [h.path, h.pattern]), [['secret.js', 'github-token']]);
  assert.equal(fs.existsSync(runDir), true);
  for (const name of fs.readdirSync(runDir)) {
    assert.equal(fs.readFileSync(path.join(runDir, name)).includes(token), false, name);
  }
  write(runDir, {
    groups: [group('feat: add two', [unitId(runDir, 'ok.txt')])],
    notIncluded: [{ path: 'secret.js', hunks: [unitId(runDir, 'secret.js')], reason: 'scan hit' }],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits.length, 1, detail(checked));
  assert.ok(checked.json.reply.notices.includes('secret.js:2 github-token left out'), detail(checked));
  assert.equal(checked.stdout.includes(token), false);
  assert.equal(c.git(['show', '--format=', '--name-only', 'HEAD']).trim(), 'ok.txt');
  assert.equal(c.git(['status', '--porcelain']).trim(), 'M secret.js');
});

test('story 96: a hit alone is not a confirmation trigger', async (t) => {
  const { c, planId, runDir } = await hitRun(t);
  write(runDir, {
    groups: [group('feat: add two', [unitId(runDir, 'ok.txt')])],
    notIncluded: [{ path: 'secret.js', hunks: [unitId(runDir, 'secret.js')], reason: 'scan hit' }],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback?.kind, undefined, detail(checked));
  assert.equal(checked.json.commits.length, 1, detail(checked));
});

test('a commit message containing a token → exit 2 lint naming the pattern ID, no value echoed', async (t) => {
  const { c, planId, runDir } = await hitRun(t, ['--no-user']);
  write(runDir, {
    groups: [group(`feat: add ${token}`, [unitId(runDir, 'ok.txt')])],
    notIncluded: [{ path: 'secret.js', hunks: [unitId(runDir, 'secret.js')], reason: 'scan hit' }],
  });

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.error.kind, 'lint', detail(checked));
  assert.match(checked.stdout, /github-token/);
  assert.equal(checked.stdout.includes(token), false);
  assert.equal(checked.stderr.includes(token), false);
});
