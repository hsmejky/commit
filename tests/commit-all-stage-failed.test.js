'use strict';

// EXE-10 (docs/roadmap/10-commit-executor.md): failures in phase (c), after the run's own
// `git reset -q -- .` (C:commit-release (c)). A non-zero `git apply --cached` or `git add` →
// exit 4 `git` (`stage-failed`) with git's output in `gitOutput`; a verify mismatch → exit 6
// `diff-changed`. Both run M10 `unstage`, carry `unstaged`, and end the run (the lock and the
// run folder go). Seam 1: `plan --split`, one group written into `state.json` as `check`
// stores it, then `commit --plan <id> --all`.
//
// Every group here holds a hunk unit of the tracked `a.txt` (staged first, by `git apply
// --cached`) and the whole-file untracked `new.txt` (staged after it, by `git add`), so the
// index holds `a.txt`'s hunk when `git add` fails or the verify refuses: an index equal to
// HEAD afterwards shows the unstage ran, not just that nothing was ever staged.
//
// Fixture technique for the two cases that must fail only in (c), not in `plan` or (b): a
// clean filter keyed on `GIT_INDEX_FILE`. `plan`'s snapshot and (b)'s match run on the
// run's temporary index (M2 sets `GIT_INDEX_FILE`, git passes it to the filter), (c) on the
// real index (M2 strips it), so the filter can behave one way while the run matches and
// another once it stages. A required filter that is missing from the start fails `plan`'s
// own diff already (git dies there too), so the missing-filter case is a filter whose
// command is missing only when (c) runs it.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const HEADER = 'feat: add new file';

// A seed commit of a 3-line `a.txt`, its middle line edited, an untracked `new.txt`, then
// `configure(c)` (repo config or attributes that must be in place before `plan`), `plan
// --split`, and one stored group naming every unit.
async function groupedRun(t, { configure } = {}) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\ntwo\nthree\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nTWO\nthree\n');
  c.writeFile('new.txt', 'new\n');
  if (configure) configure(c);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(state.units.some((unit) => unit.path === 'a.txt' && unit.kind === 'text' && unit.status === 'M'),
    'a.txt is a hunk unit, staged by git apply --cached');
  assert.ok(state.units.some((unit) => unit.path === 'new.txt'), 'new.txt is a unit, staged by git add');
  state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: null, committed: false }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

// `new.txt` through a clean filter `sw`: `cat` while a temporary index is in use, `onReal`
// on the real index.
function switchFilter(onReal, { required = false } = {}) {
  return (c) => {
    fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'attributes'), 'new.txt filter=sw\n');
    c.git(['config', 'filter.sw.clean', `if [ -n "$GIT_INDEX_FILE" ]; then cat; else ${onReal}; fi`]);
    if (required) c.git(['config', 'filter.sw.required', 'true']);
  };
}

// The assertions every phase (c) failure shares: nothing committed, the group failed, the
// index unstaged back to HEAD, `unstaged` present (EXE-11 fills it; `[]` with no pre-staged
// path), and the run released.
function assertUnstagedAndReleased(c, result, { headBefore, runDir }) {
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.deepEqual(result.json.unstaged, [], 'the group reached (c), so unstaged is present');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the index is unstaged back to HEAD');
  assert.equal(c.git(['ls-files', '--', 'new.txt']), '', 'new.txt is not left in the index');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
}

test('core.safecrlf=true rejects git add after the reset → exit 4 git (stage-failed) with git\'s output verbatim, the index unstaged, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  // Set after `plan`: a diff only warns about the round trip (git demotes the check there),
  // `git add` dies on it.
  c.git(['config', 'core.autocrlf', 'true']);
  c.git(['config', 'core.safecrlf', 'true']);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'staging failed for group 1');
  assert.equal(result.json.gitOutput, 'fatal: LF would be replaced by CRLF in new.txt\n');
  assert.deepEqual(result.json.notices, []);
  assertUnstagedAndReleased(c, result, { headBefore, runDir });
});

test('a required clean filter whose command is missing when git add runs → exit 4 git (stage-failed), the index unstaged, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t, {
    configure: switchFilter('commit-test-missing-clean-filter', { required: true }),
  });
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'staging failed for group 1');
  // The shell's own "not found" line differs by platform; git's closing line does not.
  assert.match(result.json.gitOutput, /fatal: new\.txt: clean filter 'sw' failed\n$/);
  assertUnstagedAndReleased(c, result, { headBefore, runDir });
});

test('a verify mismatch (new.txt staged with other content than (b) matched) → exit 6 diff-changed, the index unstaged, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t, { configure: switchFilter('sed s/new/changed/') });
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, 'files changed while staging group 1, run /commit again');
  assert.equal(result.json.gitOutput, null);
  assertUnstagedAndReleased(c, result, { headBefore, runDir });
});
