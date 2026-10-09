'use strict';

// EXE-12 (docs/roadmap/10-commit-executor.md): a non-zero `git commit` (a rejecting
// `pre-commit` hook) ends the run, never retried, `--no-verify` never passed. Seam 1:
// `plan --split`, three stored groups written into `state.json` as `check` stores them
// (mirrors tests/commit-all.test.js's `threeGroupRun`), then `commit --plan <id> --all`
// with group 2's `pre-commit` hook rejecting.
//
// AC2's second half (the `failed` reply's `text` naming the committed/failed/remaining
// groups, story 160) is not reachable here: a direct `commit --all` failure goes out
// through the plain `refusalFailure`/`commitAllFailure` path with no `reply` at all yet
// (KD-R73, docs/roadmap/known-deficiencies.md) — the same pre-existing gap KD-R106 already
// names for EXE-11's own "index untouched" text. This file asserts everything else that
// AC2 covers (the lock and run folder gone) and leaves the reply-text half to KD-R73.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const THREE_HEADERS = ['feat: change a', 'feat: change b', 'feat: change c'];

// Three committed files, each modified, a `plan --split` run, and three stored groups
// naming one file's units each, as `check` stores them (tests/commit-all.test.js's
// `threeGroupRun`, duplicated here to keep this file's own fixture self-contained).
async function threeGroupRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b', 'c']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt', 'c.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b', 'c']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b', 'c'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: THREE_HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed, lockPath: path.join(path.dirname(runDir), 'lock') };
}

// A fixture `pre-commit` hook that counts its own invocations in `counterPath` (one line
// appended per call) and rejects (control characters included in its stderr, as git sends
// them) only on the `rejectOn`th invocation, succeeding silently every other time.
function installCountingHook(c, counterPath, rejectOn) {
  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  const script = [
    "const fs = require('node:fs');",
    `const counter = ${JSON.stringify(counterPath)};`,
    "let n = 0;",
    "try { n = fs.readFileSync(counter, 'utf8').split('\\n').filter(Boolean).length; } catch {}",
    "n += 1;",
    "fs.appendFileSync(counter, n + '\\n');",
    `if (n === ${rejectOn}) {`,
    "  process.stderr.write('pre-commit: \\x1b[31meslint found 2 problems\\x1b[0m\\n');",
    "  process.exit(1);",
    "}",
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, script);
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  const slash = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);
}

test('a pre-commit hook rejecting group 2 of 3 -> exit 4, commits holds group 1, failed 2, remaining [2,3], run once not retried, gitOutput verbatim, run released', async (t) => {
  const { c, planId, seed, runDir, lockPath } = await threeGroupRun(t);
  const counterPath = path.join(c.root, 'hook-runs.log');
  installCountingHook(c, counterPath, 2);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'git commit failed for group 2');
  assert.equal(result.json.gitOutput, 'pre-commit: \x1b[31meslint found 2 problems\x1b[0m\n',
    'gitOutput carries the hook\'s control characters as sent');
  assert.equal(result.json.sha, undefined, 'HEAD never moved, so no sha is reported');
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 landed');
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  // The hook never ran for group 3 (the run stopped at group 2), and group 2's own
  // invocation never ran twice (no retry, never --no-verify): exactly 2 lines (group 1's
  // successful call, group 2's single rejected one), the second being the rejecting one.
  const runs = fs.readFileSync(counterPath, 'utf8').trim().split('\n');
  assert.deepEqual(runs, ['1', '2'], 'the hook ran once per attempted group, never retried');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), shas[0], 'nothing past group 1 committed');
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the index is unstaged back to HEAD');
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('a pre-commit hook that itself commits then exits 1 -> exit 4, sha set to the new HEAD, "committed as, but git did not exit cleanly"', async (t) => {
  const { c, planId, seed, runDir, lockPath } = await threeGroupRun(t);
  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  const slash = (p) => p.replace(/\\/g, '/');
  // Rejects only group 2 (the second pre-commit invocation), but first makes its own
  // commit of whatever is staged (the group's own real-index staging already landed by
  // the time `git commit` runs its hooks) before exiting non-zero.
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    `const counter = ${JSON.stringify(path.join(c.root, 'hook-runs.log'))};`,
    "let n = 0;",
    "try { n = fs.readFileSync(counter, 'utf8').split('\\n').filter(Boolean).length; } catch {}",
    "n += 1;",
    "fs.appendFileSync(counter, n + '\\n');",
    "if (n === 2) {",
    "  require('node:child_process').execFileSync('git', ['commit', '-q', '-m', 'hook own commit', '--no-verify'], { stdio: 'ignore' });",
    "  process.exit(1);",
    "}",
    '',
  ].join('\n'));
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.error.kind, 'git', detail(result));
  const headNow = c.git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(headNow, seed, 'the hook\'s own commit landed');
  assert.equal(result.json.sha, headNow);
  assert.equal(result.json.error.message, `committed as \`${headNow}\`, but git did not exit cleanly`);
  // Q18: "the group counts as committed in the report" — group 2 is in `commits` with the
  // new HEAD, out of `remaining`; `failed` still names it as the step whose exit ended the run.
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.commits, [
    { n: 1, sha: c.git(['rev-parse', `${headNow}^`]).trim(), header: THREE_HEADERS[0] },
    { n: 2, sha: headNow, header: THREE_HEADERS[1] },
  ]);
  assert.deepEqual(result.json.remaining, [3]);
  assert.equal(fs.existsSync(lockPath), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// EXE-12 in `reword`: a rejecting hook on `git commit --amend --only` is the same exit 4,
// not `internal`; nothing to unstage (the index is never touched), the old HEAD is kept.
test('a pre-commit hook rejecting a reword -> exit 4 git-failed, gitOutput verbatim, HEAD and staging untouched, run released', async (t) => {
  const c = createCase(t);
  const dir = path.join(c.claudeHome, 'commit-guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify({
    ts: Date.now(), cwd: c.repoDir, command: 'commit.cjs plan',
  }));
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', 'fix: old']);
  const oldSha = c.git(['rev-parse', 'HEAD']).trim();
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  c.writeFile('extra.txt', 'staged\n');
  c.git(['add', '--', 'extra.txt']);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups: [{ header: 'fix: new', body: null, files: [], hunks: [] }], notIncluded: [],
  }));
  installCountingHook(c, path.join(c.root, 'hook-runs.log'), 1);

  const result = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'git commit failed for group 1');
  assert.equal(result.json.gitOutput, 'pre-commit: \x1b[31meslint found 2 problems\x1b[0m\n');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), oldSha, 'the old commit is kept');
  assert.equal(c.git(['status', '--porcelain']), 'A  extra.txt\n', 'staging untouched');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});
