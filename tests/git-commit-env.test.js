'use strict';

// GIT-06 (docs/roadmap/06-git-adapters.md): M2's `git commit` environment (docs/spec/
// modules-m1-m9.md M2, Q9, story 147). `git commit` removes only the redirecting variables
// (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, the `GIT_CONFIG_COUNT`
// family, `GIT_CONFIG_PARAMETERS`, `GIT_ATTR_SOURCE`, `GIT_OBJECT_DIRECTORY`,
// `GIT_ALTERNATE_OBJECT_DIRECTORIES`), sets neither `GIT_LITERAL_PATHSPECS` nor the config
// pins, and keeps every other variable for the user's hooks. Seam 1: `plan --split`, one
// stored group, then `commit --plan <id> --all` through the entry point.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

const HEADER = 'feat: change one file';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A second repo with one commit: the decoy `GIT_DIR`, `GIT_INDEX_FILE` and object store.
function decoyRepo(c) {
  const dir = path.join(c.root, 'decoy');
  fs.mkdirSync(dir);
  c.git(['init', '-q', '-b', 'main', '.'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'decoy.txt'), 'decoy\n');
  c.git(['add', '.'], { cwd: dir });
  c.git(['commit', '-q', '-m', 'decoy'], { cwd: dir });
  return { dir, gitDir: path.join(dir, '.git'), head: c.git(['rev-parse', 'HEAD'], { cwd: dir }).trim() };
}

// The repo has no identity of its own: `git commit` gets it only from the case's exported
// `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. A pre-commit hook writes its environment to `envFile`.
// `plan --split` runs with `env`, and one stored group names every unit, as `check` stores it.
async function hookedRun(t, env) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  const envFile = path.join(c.root, 'hook-env.txt');
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nenv > "${envFile.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(hook, 0o755);
  const planned = await runCommit(c, ['plan', '--split'], { env });
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: null, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, envFile };
}

// `NAME=value` lines of `env`'s output; a value spanning lines keeps only its first line.
function hookEnv(envFile) {
  const out = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

test('a pre-commit hook sees GIT_AUTHOR_NAME and a custom GIT_FOO, no GIT_LITERAL_PATHSPECS or pins, not the decoy index', async (t) => {
  const setup = createCase(t);
  const decoy = decoyRepo(setup);
  const decoyIndex = path.join(decoy.gitDir, 'index');
  const env = { GIT_FOO: 'kept for hooks', GIT_DIR: decoy.gitDir, GIT_INDEX_FILE: decoyIndex };
  const { c, planId, envFile } = await hookedRun(t, env);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], { env });

  assert.equal(result.exitCode, 0, detail(result));
  const seen = hookEnv(envFile);
  assert.equal(seen.GIT_AUTHOR_NAME, c.env.GIT_AUTHOR_NAME);
  assert.equal(seen.GIT_FOO, 'kept for hooks');
  assert.equal(seen.GIT_LITERAL_PATHSPECS, undefined);
  assert.equal(seen.GIT_CONFIG_COUNT, undefined);
  // git itself hands a pre-commit hook `GIT_INDEX_FILE` (the index it commits), so a negative
  // regex on the decoy's path is not enough (review-GIT-06 finding L2): assert positively that
  // the value resolves inside the real repo's own `.git`, not merely that it skips "decoy".
  const gitDirPrefix = path.join(c.repoDir, '.git') + path.sep;
  assert.ok(seen.GIT_INDEX_FILE, 'git must export GIT_INDEX_FILE to a pre-commit hook');
  assert.ok(
    path.resolve(c.repoDir, seen.GIT_INDEX_FILE).startsWith(gitDirPrefix),
    path.resolve(c.repoDir, seen.GIT_INDEX_FILE),
  );
  assert.ok(!/[\\/]decoy[\\/]/.test(seen.GIT_DIR ?? ''), seen.GIT_DIR);
});

test('the commit lands in the real repo despite a decoy GIT_DIR, with the exported identity', async (t) => {
  const setup = createCase(t);
  const decoy = decoyRepo(setup);
  const env = { GIT_DIR: decoy.gitDir, GIT_WORK_TREE: decoy.dir };
  const { c, planId } = await hookedRun(t, env);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], { env });

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha);
  assert.equal(c.git(['show', `${sha}:a.txt`]), 'one\nmore\n');
  assert.equal(c.git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', sha]),
    `${c.env.GIT_AUTHOR_NAME} <${c.env.GIT_AUTHOR_EMAIL}>|`
    + `${c.env.GIT_COMMITTER_NAME} <${c.env.GIT_COMMITTER_EMAIL}>\n`);
  assert.equal(setup.git(['rev-parse', 'HEAD'], { cwd: decoy.dir }).trim(), decoy.head, 'the decoy repo is untouched');
});

test('the git commit spawn removes exactly the redirecting GIT_* variables and keeps the rest', async (t) => {
  const setup = createCase(t);
  const decoy = decoyRepo(setup);
  const exported = {
    GIT_DIR: decoy.gitDir,
    GIT_WORK_TREE: decoy.dir,
    GIT_INDEX_FILE: path.join(decoy.gitDir, 'index'),
    GIT_COMMON_DIR: decoy.gitDir,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(decoy.dir, 'hooks'),
    GIT_CONFIG_PARAMETERS: "'core.hookspath'='decoy'",
    GIT_ATTR_SOURCE: 'HEAD',
    GIT_OBJECT_DIRECTORY: path.join(decoy.gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy.gitDir, 'objects'),
    GIT_FOO: 'kept',
    GIT_NAMESPACE: 'kept-namespace',
  };
  const { c, planId } = await hookedRun(t, exported);
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { ...exported, COMMIT_TEST_SPAWN_LOG: log },
  });

  assert.equal(result.exitCode, 0, detail(result));
  const commits = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.api === 'spawn' && e.file === 'git' && e.args[0] === 'commit');
  assert.equal(commits.length, 1, JSON.stringify(commits));
  const kept = Object.fromEntries(Object.entries(c.env).filter(([key]) => key.startsWith('GIT_')));
  assert.deepEqual(commits[0].gitEnv, { ...kept, GIT_FOO: 'kept', GIT_NAMESPACE: 'kept-namespace' });
});

// None of readOnly/history/index applies to commit mode (it is never a staging call, never
// a history read, and no commit caller uses an alternate index), so a caller that sets any
// of them alongside `commit` almost certainly meant a different, non-commit call. `run`
// throws synchronously rather than silently ignore them (review-GIT-06 finding L3).
let processAdapter;
beforeEach(async () => {
  processAdapter = await loadLib('process-adapter');
});

test('run: commit combined with readOnly, history or index throws synchronously', async (t) => {
  const c = createCase(t);
  const base = { cwd: c.repoDir, env: c.env, commit: true };

  assert.throws(() => processAdapter.run('git', ['commit', '-q', '-m', 'x'], { ...base, readOnly: true }),
    /commit cannot be combined/);
  assert.throws(() => processAdapter.run('git', ['commit', '-q', '-m', 'x'], { ...base, history: true }),
    /commit cannot be combined/);
  assert.throws(() => processAdapter.run('git', ['commit', '-q', '-m', 'x'], { ...base, index: path.join(c.root, 'alt.index') }),
    /commit cannot be combined/);
});
