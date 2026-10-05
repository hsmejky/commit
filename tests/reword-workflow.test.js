'use strict';

// INT-24 (docs/roadmap/12-integration.md): the reword workflow end to end through Seam 1 —
// `plan --reword` (or `plan --reword --dictated`, which skips the hunk index) → the worker's
// `plan.groups.json` → `check`, which amends at once (Q20, C:commit-release `reword`,
// C:worker-plan "dictated reword", stories 175-181). The per-row refusal details are
// GIT-09's (tests/plan-reword-facts.test.js) and the carried-trailer rules MSG-08's
// (tests/commit-all-reword.test.js); here each refusal row runs once more with `--dictated`,
// whose path skips the hunk step.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A fresh guard heartbeat (C:guard "Heartbeat", Q23) so the guard notice never joins
// `notices`.
function freshHeartbeat(c) {
  const dir = path.join(c.claudeHome, 'commit-guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({
    ts: Date.now(), cwd: c.repoDir, command: 'commit.cjs plan',
  }));
}

function commitFile(c, name, content, message) {
  c.writeFile(name, content);
  c.git(['add', '--', name]);
  c.git(['commit', '-q', '-m', message]);
}

function writeGroups(runDir, source, header, body) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source, groups: [{ header, body, files: [], hunks: [] }], notIncluded: [],
  }));
}

function readLock(c) {
  return JSON.parse(fs.readFileSync(path.join(c.repoDir, '.commit-plan', 'lock'), 'utf8'));
}

function messageOf(c, sha) {
  const raw = c.git(['cat-file', 'commit', sha]);
  return raw.slice(raw.indexOf('\n\n') + 2);
}

function assertNoRunFolder(c) {
  const dir = path.join(c.repoDir, '.commit-plan');
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(entries.filter((e) => e !== '.gitignore'), [], 'no run folder and no lock');
}

// Criterion 1 (story 175): a clean tree is no `nothing` for a reword — the lock is taken and
// the hunk index comes back; `check` then amends the message only.
test('Seam 1: plan --reword on a clean tree takes the lock; check amends only the message', async (t) => {
  const c = createCase(t);
  freshHeartbeat(c);
  commitFile(c, 'file.txt', 'one\n', 'fix: old message');
  const oldSha = c.git(['rev-parse', 'HEAD']).trim();
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  const planned = await runCommit(c, ['plan', '--reword']);

  assert.equal(planned.exitCode, 0, detail(planned));
  assert.equal(planned.json.mode, 'reword');
  assert.equal(planned.json.reply, null);
  assert.notEqual(planned.json.hunks, null, 'a worker-written reword gets the hunk index');
  assert.equal(readLock(c).planId, planned.json.planId, 'the lock is held for this run');

  writeGroups(planned.json.runDir, 'worker', 'fix: better message', null);
  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const [{ sha }] = checked.json.commits;
  assert.notEqual(sha, oldSha);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha);
  assert.equal(c.git(['rev-parse', 'HEAD^{tree}']).trim(), oldTree, 'the tree is unchanged');
  assert.equal(messageOf(c, sha), 'fix: better message\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  assert.equal(c.git(['status', '--porcelain']), '', 'the tree stays clean');
  assertNoRunFolder(c);
});

// Criterion 1 (story 175): changes staged before `plan --reword` stay staged and out of the
// amended commit.
test('Seam 1: changes staged before plan --reword stay staged and are not committed', async (t) => {
  const c = createCase(t);
  freshHeartbeat(c);
  commitFile(c, 'file.txt', 'one\n', 'fix: old message');
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();
  c.writeFile('file.txt', 'one\ntwo\n');
  c.writeFile('new.txt', 'new\n');
  c.git(['add', '--', 'file.txt', 'new.txt']);
  const stagedBefore = c.git(['diff', '--cached', '--binary']);

  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  writeGroups(planned.json.runDir, 'worker', 'fix: better message', null);
  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(c.git(['rev-parse', 'HEAD^{tree}']).trim(), oldTree, 'no staged change entered the commit');
  assert.equal(c.git(['diff', '--cached', '--binary']), stagedBefore, 'the index is byte-identical');
  assert.equal(c.git(['status', '--porcelain']), 'M  file.txt\nA  new.txt\n');
});

// Criterion 2 (story 178): `--dictated` skips the hunk step — `reply` and `hunks` are both
// null (C:plan), the lock is held and no hunk index is written; a `source: "user"` plan is
// committed exactly as given, its body split at the first blank line (C:worker-plan).
test('Seam 1: plan --reword --dictated has no hunk index; check commits the dictated text as given', async (t) => {
  const c = createCase(t);
  freshHeartbeat(c);
  // The default `body: "forbidden"` would refuse the dictated body (a `lintFailed` handback,
  // story 178's other half); this repo allows one.
  commitFile(c, '.claude/commit.json', '{ "body": "optional" }\n', 'fix: old message');
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  const planned = await runCommit(c, ['plan', '--reword', '--dictated']);

  assert.equal(planned.exitCode, 0, detail(planned));
  assert.equal(planned.json.mode, 'reword');
  assert.equal(planned.json.reply, null);
  assert.equal(planned.json.hunks, null);
  assert.equal(readLock(c).planId, planned.json.planId, 'the lock is held for this run');
  const files = fs.readdirSync(planned.json.runDir);
  assert.equal(files.includes('hunks.txt'), false, 'no hunk index written');
  assert.equal(files.includes('hunks.json'), false);

  writeGroups(planned.json.runDir, 'user', 'fix: parse empty input', 'Keep my words.\nExactly  as typed.');
  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  // Criterion 4 (story 181): a first (not resumed) reword never confirms.
  assert.equal(checked.json.confirm, null);
  const [{ sha }] = checked.json.commits;
  assert.equal(messageOf(c, sha), 'fix: parse empty input\n\nKeep my words.\nExactly  as typed.\n');
  assert.equal(c.git(['rev-parse', 'HEAD^{tree}']).trim(), oldTree);
  assertNoRunFolder(c);
});

// Criterion 3 (stories 176, 177): a root commit rewords through the dictated path too, and
// stays a root commit.
test('Seam 1: a dictated reword of a root commit keeps it a root commit', async (t) => {
  const c = createCase(t);
  freshHeartbeat(c);
  commitFile(c, 'file.txt', 'one\n', 'feat: first');
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  const planned = await runCommit(c, ['plan', '--reword', '--dictated']);
  assert.equal(planned.exitCode, 0, detail(planned));
  writeGroups(planned.json.runDir, 'user', 'feat: renamed first', null);
  const checked = await runCommit(c, ['check', '--plan', planned.json.planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const [{ sha }] = checked.json.commits;
  assert.equal(c.git(['rev-list', '--parents', '-n', '1', sha]).trim(), sha, 'no parent');
  assert.equal(c.git(['rev-parse', `${sha}^{tree}`]).trim(), oldTree);
  assert.equal(messageOf(c, sha), 'feat: renamed first\n');
  // KD-R89's reword half (C:check `newFiles`): the root commit added file.txt, so its unit is
  // `new: true`, yet `reword` forces `newFiles` to `[]`, since nothing new is committed.
  const [group] = checked.json.groups;
  assert.deepEqual(group.files.map((f) => [f.path, f.status, f.new]), [['file.txt', 'A', true]]);
  assert.deepEqual(group.newFiles, []);
});

// Criterion 3 (story 176): each reword refusal row also refuses on the dictated path, before
// any run folder or lock exists.
const REFUSALS = [
  { name: 'unborn HEAD', kind: 'state', setup: () => {} },
  {
    name: 'merge-commit HEAD',
    kind: 'state',
    setup: (c) => {
      commitFile(c, 'a.txt', 'one\n', 'seed');
      c.git(['checkout', '-q', '-b', 'side']);
      c.git(['commit', '-q', '--allow-empty', '-m', 'feat: side work']);
      c.git(['checkout', '-q', 'main']);
      c.git(['commit', '-q', '--allow-empty', '-m', 'feat: main work']);
      c.git(['merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side']);
    },
  },
  {
    name: 'pushed HEAD',
    kind: 'pushed',
    setup: (c) => {
      commitFile(c, 'a.txt', 'one\n', 'seed');
      c.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    },
  },
];

for (const { name, kind, setup } of REFUSALS) {
  for (const argv of [['plan', '--reword'], ['plan', '--reword', '--dictated']]) {
    test(`Seam 1: ${argv.join(' ')} on a ${name} exits 6 ${kind} with no run folder`, async (t) => {
      const c = createCase(t);
      setup(c);

      const result = await runCommit(c, argv);

      assert.equal(result.exitCode, 6, detail(result));
      assert.equal(result.json.ok, false);
      assert.equal(result.json.error.kind, kind);
      assertNoRunFolder(c);
    });
  }
}
