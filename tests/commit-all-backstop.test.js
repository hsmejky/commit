'use strict';

// EXE-13 (docs/roadmap/10-commit-executor.md): the backstop before each `split` commit. M10
// `writeTree` records the index's tree, then M8 `scanUnits` runs over `treeDiffUnits(expected
// HEAD, recorded tree)` with the `scanIgnore` matchers recompiled from the patterns `plan`
// stored (not HEAD's, CFG-01 item 1) and the entry point's `osUser`. A hit → exit 3 `scan`
// with `hits`, the group unstaged, the run released (C:commit-release, C:cli-and-exit-codes).
// Seam 1: `plan --split`, groups written into `state.json` as `check` stores them, then
// `commit --plan <id> --all`. Every secret here is built at run time (no literal in this
// source; the repo's own `scanIgnore` covers only tests/fixtures/**).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const EXECUTOR = path.join(__dirname, '..', 'plugin', 'scripts', 'lib', 'commit-executor.mjs');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A `ghp_` token built at run time (see tests/plan-scan.test.js).
function tokenLine() {
  return `const token = "${'gh' + 'p_' + 'q'.repeat(36)}";\n`;
}

const REPO_CONFIG = path.join('.claude', 'commit.json');

// A seed commit of `files` (unless `unborn`), then `edit(c)`, `plan --split`, and the stored
// groups `groupsOf(units)` returns (each `{ paths, header }`), with `plan`'s own scan map
// cleared: the state is edited after `plan`, so no stored record says the secret was seen.
async function plannedRun(t, { files = { 'README.md': 'readme\n' }, unborn = false, edit, groupsOf, planOptions } = {}) {
  const c = createCase(t);
  if (!unborn) {
    for (const [file, content] of Object.entries(files)) c.writeFile(file, content);
    c.git(['add', '--', ...Object.keys(files)]);
    c.git(['commit', '-q', '-m', 'seed']);
  }
  edit(c);
  const planned = await runCommit(c, ['plan', '--split'], planOptions);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const idsOf = (paths) => state.units.filter((unit) => paths.includes(unit.path)).map((unit) => unit.id);
  state.groups = groupsOf(state.units).map(({ paths, header }, i) => (
    { n: i + 1, units: idsOf(paths), header, body: null, committed: false }));
  state.scanned = {};
  state.scanLines = {};
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, state };
}

// Every branch tip (the one branch here), `''` while HEAD is unborn.
function headOf(c) {
  return c.git(['for-each-ref', '--format=%(objectname)', 'refs/heads']).trim();
}

// The assertions every backstop refusal of the run's only (or first pending) group shares.
function assertRefusedAndReleased(c, result, { headBefore, runDir, failed = 1, remaining = [1], commits = 0 }) {
  assert.equal(result.exitCode, 3, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'scan', detail(result));
  assert.equal(result.json.error.message, `the scan before committing group ${failed} found a possible secret`);
  assert.equal(result.json.commits.length, commits);
  assert.equal(result.json.failed, failed);
  assert.deepEqual(result.json.remaining, remaining);
  assert.deepEqual(result.json.unstaged, [], 'the group reached (c), so unstaged is present');
  assert.equal(headOf(c), headBefore, 'nothing committed by the refused group');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the group is unstaged');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
}

test('EXE-13 AC1/AC6: a secret in the stored group that plan did not record → exit 3 scan, hits name the file, nothing committed, unstaged present, the run released', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, {
    edit: (c) => c.writeFile('src/key.js', tokenLine()),
    groupsOf: () => [{ paths: ['src/key.js'], header: 'feat: add key' }],
  });
  const headBefore = headOf(c);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertRefusedAndReleased(c, result, { headBefore, runDir });
  assert.deepEqual(result.json.hits, [{ path: 'src/key.js', line: 1, pattern: 'github-token' }]);
  assert.equal(c.git(['ls-files', '--', 'src/key.js']), '', 'src/key.js is not left in the index');
});

test('EXE-13 AC2: the same secret in a path the stored scanIgnore covers → committed', async (t) => {
  const { c, planId } = await plannedRun(t, {
    files: { 'README.md': 'readme\n', [REPO_CONFIG]: '{ "scanIgnore": ["vendor/**"] }\n' },
    edit: (c) => c.writeFile('vendor/key.js', tokenLine()),
    groupsOf: () => [{ paths: ['vendor/key.js'], header: 'feat: add vendored key' }],
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.commits.length, 1);
  assert.equal(c.git(['log', '-1', '--format=%s']).trim(), 'feat: add vendored key');
});

test('EXE-13 AC2: a path only a scanIgnore pattern committed by an earlier group of the run covers → still exit 3 (the stored patterns, not HEAD)', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, {
    files: { 'README.md': 'readme\n', [REPO_CONFIG]: '{}\n' },
    edit: (c) => {
      c.writeFile(REPO_CONFIG, '{ "scanIgnore": ["vendor/**"] }\n');
      c.writeFile('vendor/key.js', tokenLine());
    },
    groupsOf: () => [
      { paths: [REPO_CONFIG.split(path.sep).join('/')], header: 'chore: ignore vendor in the scan' },
      { paths: ['vendor/key.js'], header: 'feat: add vendored key' },
    ],
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertRefusedAndReleased(c, result, { headBefore: headOf(c), runDir, failed: 2, remaining: [2], commits: 1 });
  assert.equal(c.git(['log', '-1', '--format=%s']).trim(), 'chore: ignore vendor in the scan',
    'group 1 is committed and kept');
  assert.deepEqual(result.json.hits, [{ path: 'vendor/key.js', line: 1, pattern: 'github-token' }]);
});

test('EXE-13 AC3: a text file hidden by -diff in .gitattributes holding the secret → still exit 3', async (t) => {
  const { c, planId, runDir } = await plannedRun(t, {
    files: { 'README.md': 'readme\n', '.gitattributes': 'hidden.txt -diff\n', 'hidden.txt': 'one\n' },
    edit: (c) => c.writeFile('hidden.txt', `one\n${tokenLine()}`),
    groupsOf: () => [{ paths: ['hidden.txt'], header: 'feat: extend hidden' }],
  });
  const headBefore = headOf(c);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertRefusedAndReleased(c, result, { headBefore, runDir });
  assert.deepEqual(result.json.hits, [{ path: 'hidden.txt', line: 2, pattern: 'github-token' }]);
});

test('EXE-13 AC4: unborn HEAD → the backstop diffs against the empty tree (a clean file commits, a secret refuses)', async (t) => {
  const clean = await plannedRun(t, {
    unborn: true,
    edit: (c) => c.writeFile('README.md', 'readme\n'),
    groupsOf: () => [{ paths: ['README.md'], header: 'docs: add readme' }],
  });
  const ok = await runCommit(clean.c, ['commit', '--plan', clean.planId, '--all']);
  assert.equal(ok.exitCode, 0, detail(ok));
  assert.equal(clean.c.git(['log', '--format=%s']).trim(), 'docs: add readme');

  const { c, planId, runDir } = await plannedRun(t, {
    unborn: true,
    edit: (c) => {
      c.writeFile('README.md', 'readme\n');
      c.writeFile('src/key.js', tokenLine());
    },
    groupsOf: () => [{ paths: ['README.md', 'src/key.js'], header: 'feat: start' }],
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assertRefusedAndReleased(c, result, { headBefore: '', runDir });
  assert.deepEqual(result.json.hits, [{ path: 'src/key.js', line: 1, pattern: 'github-token' }]);
});

test('EXE-13 AC5 (static): commitAll takes { now, osUser } and passes osUser to the backstop\'s scanUnits, never into the state', () => {
  const source = fs.readFileSync(EXECUTOR, 'utf8');
  assert.match(source, /@param \{\{ now: \(\) => number, osUser: string \| null,/,
    'commitAll\'s documented options take now and osUser');
  assert.match(source, /async function commitGroups\(run, state, \{ now, osUser,/,
    'the per-group loop destructures osUser from commitAll\'s options');
  const backstop = source.match(/scanUnits\(await treeDiffUnits\([^;]*;/g) ?? [];
  assert.equal(backstop.length, 1, 'one backstop scanUnits call');
  assert.match(backstop[0], /\bosUser\b/, 'the backstop passes osUser to scanUnits');
  assert.doesNotMatch(source, /state\.osUser|osUser:\s*osUser\s*}\s*\)\s*;?\s*\n\s*writeState/,
    'osUser is never written into the run state');
});

test('EXE-13 AC5: the backstop scans with the OS user (its path segment hits), and no run-folder file holds the OS user name', async (t) => {
  const name = 'zz9plural';
  const env = { COMMIT_TEST_FAULT_USERINFO: '1', USER: '', USERNAME: name };
  const options = { nodeArgs: ['--import', PRELOAD], env };
  // A run whose content never names the OS user: nothing in its run folder may either.
  const plain = await plannedRun(t, {
    edit: (c) => c.writeFile('src/a.js', 'const a = 1;\n'),
    groupsOf: () => [{ paths: ['src/a.js'], header: 'feat: add a' }],
    planOptions: options,
  });
  const files = fs.readdirSync(plain.runDir, { recursive: true })
    .filter((file) => fs.statSync(path.join(plain.runDir, file)).isFile());
  assert.ok(files.includes('state.json'), 'the run folder holds state.json');
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(plain.runDir, file)).includes(name), false,
      `${file} holds no OS user name`);
  }

  const { c, planId, runDir } = await plannedRun(t, {
    edit: (c) => c.writeFile('src/paths.js', `const other = "data/${name}/export.csv";\n`),
    groupsOf: () => [{ paths: ['src/paths.js'], header: 'feat: add paths' }],
    planOptions: options,
  });
  const headBefore = headOf(c);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], options);

  assertRefusedAndReleased(c, result, { headBefore, runDir });
  assert.deepEqual(result.json.hits, [{ path: 'src/paths.js', line: 1, pattern: 'local-path' }]);
});
