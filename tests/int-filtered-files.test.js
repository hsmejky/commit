'use strict';

// INT-20 (docs/roadmap/12-integration.md, Q11 "First slice" widenings, stories 72 and 144):
// a file under a clean filter is planned, scanned and committed in its cleaned form, end to
// end through `plan` -> `check` at Seam 1. The LFS case runs only when `git-lfs` is on the
// runner and is skipped otherwise, never faked.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

// A `ghp_` token built at run time (see tests/plan-scan.test.js).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function writeWorkerPlan(runDir, groups) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: groups.map(({ header, files }) => ({ header, body: null, files, hunks: [], reason: 'test' })),
    notIncluded: [],
  }));
}

function blob(c, spec) {
  const result = spawnSync('git', ['cat-file', 'blob', spec], { cwd: c.repoDir, env: c.env });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout.toString('utf8');
}

test('a sed clean filter: the committed blob is the cleaned content, a secret the filter removes is not a hit', async (t) => {
  const c = createCase(t);
  c.git(['config', 'filter.redact.clean', `sed s/${githubToken('a')}/REDACTED/`]);
  c.writeFile('.gitattributes', 'x.dat filter=redact\n');
  c.writeFile('x.dat', 'one\ntwo\n');
  c.git(['add', '--', '.gitattributes', 'x.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  // The working copy holds a token; the clean filter replaces it, so the cleaned form is clean.
  c.writeFile('x.dat', `one\ntwo\n${githubToken('a')}\n`);

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const unit = planned.json.hunks.hunks.find((h) => h.path === 'x.dat');
  assert.equal(unit.body, 'file');
  assert.equal(unit.kind, 'filtered');
  const { planId, runDir } = planned.json;
  const planJson = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
  assert.deepEqual(planJson.scan.hits, []);
  const hunksTxt = fs.readFileSync(path.join(runDir, 'hunks.txt'), 'utf8');
  assert.match(hunksTxt, /\+REDACTED/, 'the listing shows the cleaned line');
  assert.ok(!hunksTxt.includes(githubToken('a')), 'the listing never shows the uncleaned token');

  writeWorkerPlan(runDir, [{ header: 'feat: update x', files: ['x.dat'] }]);
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed', detail(checked));
  const [sha] = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(blob(c, `${sha}:x.dat`), 'one\ntwo\nREDACTED\n');
});

test('story 144: a secret that only the cleaned form carries is a scan hit', async (t) => {
  const c = createCase(t);
  c.git(['config', 'filter.expand.clean', `sed s/MARK/${githubToken('b')}/`]);
  c.writeFile('.gitattributes', 'y.dat filter=expand\n');
  c.writeFile('y.dat', 'one\n');
  c.git(['add', '--', '.gitattributes', 'y.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('y.dat', 'one\nMARK\n');

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const planJson = JSON.parse(fs.readFileSync(path.join(planned.json.runDir, 'plan.json'), 'utf8'));
  assert.deepEqual(planJson.scan.hits.map((h) => [h.path, h.pattern]), [['y.dat', 'github-token']]);
});

const lfsAvailable = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8' }).status === 0;
const requireLfs = process.env.COMMIT_REQUIRE_LFS === '1';

test('git-lfs: the staged diff matches the planned hash and the object lands under .git/lfs/objects', { skip: lfsAvailable || requireLfs ? false : 'git-lfs not on the runner' }, async (t) => {
  if (!lfsAvailable) {
    assert.fail('COMMIT_REQUIRE_LFS=1 is set but git-lfs is not installed (FND-03)');
  }
  const c = createCase(t);
  c.git(['lfs', 'install', '--local']);
  c.writeFile('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  c.writeFile('big.bin', 'v1 content\n');
  c.git(['add', '--', '.gitattributes', 'big.bin']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('big.bin', 'v2 content\n');

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, [{ header: 'feat: update big', files: ['big.bin'] }]);
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.status, 'committed', detail(checked));

  const [sha] = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  const pointer = blob(c, `${sha}:big.bin`);
  assert.match(pointer, /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 11\n$/);
  const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)[1];
  const object = path.join(c.repoDir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  assert.equal(fs.readFileSync(object, 'utf8'), 'v2 content\n');
});
