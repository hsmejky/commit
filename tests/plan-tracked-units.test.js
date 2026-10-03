'use strict';

// CHG-03 (docs/roadmap/07-change-set.md): Seam 1 for the wiring of steps 4-5. `plan` on a
// modified tracked file runs M10 `inventory` and `snapshot`: exactly one pinned
// `git diff -z --raw -p HEAD` call with no pathspec (Q11). Storing the units is CHG-03b's
// (step 7), so the call then ends `internal` and leaves no run folder (C:run-folder: a
// folder with no lock is discarded). The units themselves are asserted in-process in
// `change-set-units.test.js` and `hunk-index.test.js` (KD-R1).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

// Q11's pinned list, spelled out here independently of M10.
const PINNED_DIFF_CALL = [
  '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false',
  '-c', 'diff.autoRefreshIndex=true', 'diff',
  '--no-ext-diff', '--no-color', '--no-textconv', '--no-relative', '-U3',
  '--inter-hunk-context=0', '--indent-heuristic', '-M', '--diff-algorithm=myers',
  '--ignore-submodules=dirty', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/',
  '-z', '--raw', '-p', 'HEAD',
];

test('plan on modified tracked files runs one pinned diff with no pathspec and keeps the run', async (t) => {
  const c = createCase(t);
  c.writeFile('a b/c.txt', 'old\n');
  c.writeFile('src/b.js', 'one\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a b/c.txt', 'new\n');
  c.writeFile('src/b.js', 'two\n');
  const log = path.join(c.root, 'spawns.jsonl');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { COMMIT_TEST_SPAWN_LOG: log },
  });

  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 0, detail);
  // CHG-03b: past step 7 the run is kept; every path comes raw from the raw pass (KD-R1).
  assert.deepEqual(result.json.hunks.hunks.map((entry) => entry.path), ['a b/c.txt', 'src/b.js'], detail);

  const entries = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const diffCalls = entries.filter((e) => Array.isArray(e.args) && e.args.includes('diff'));
  assert.deepEqual(diffCalls.map((e) => [e.file, e.args]), [['git', PINNED_DIFF_CALL]], JSON.stringify(diffCalls));
});

test('plan on an untracked file is not built yet and leaves no run folder', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('new.txt', 'n\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 1, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(result.json.error.kind, 'internal');
  assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), []);
});
