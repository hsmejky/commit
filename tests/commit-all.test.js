'use strict';

// EXE-02 (docs/roadmap/10-commit-executor.md): the M16 tracer bullet at Seam 1. A `plan
// --split` run over two modified tracked files gets one stored group written into its
// `state.json` as `check` would; `commit --plan <id> --all` then commits that group's
// whole-file units (C:commit-release): the output fields, the commit's tree and message,
// HEAD, the run released after the last group, and `unstaged: []` once `indexReset` is set.
// Plus the thin M10 `matchIds` in process. EXE-03 adds: the stored message reaches git
// exactly as approved regardless of the repo's `commit.cleanup` config or body text that
// looks like a git flag.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

let changeSet;
beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const HEADER = 'feat: change both files';
const BODY = 'Some body.';

// Two committed files, both modified, a `plan --split` run holding the lock, and one stored
// group naming every unit, as `check` stores it (PLN-01). `configure` runs on the case right
// after the seed commit, before the working-tree edit and `plan` (e.g. a repo config set for
// EXE-03's `commit.cleanup` test).
async function groupedRunWithMessage(t, { header = HEADER, body = BODY, configure } = {}) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  if (configure) configure(c);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header, body, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

async function groupedRun(t) {
  return groupedRunWithMessage(t);
}

test('one stored group of two modified files → exit 0 with one commit and the full output fields', async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(result.json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  assert.equal(result.json.error, null);
  assert.equal(result.json.gitOutput, null);
});

test("the commit's tree holds both files' working-tree content, its message is the stored one byte for byte, and HEAD is sha", async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), sha);
  assert.equal(c.git(['ls-tree', '--name-only', sha]), 'a.txt\nb.txt\n');
  assert.equal(c.git(['show', `${sha}:a.txt`]), 'one\nmore\n');
  assert.equal(c.git(['show', `${sha}:b.txt`]), 'two\nmore\n');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${BODY}\n`);
  assert.equal(c.git(['status', '--porcelain']), '', 'nothing is left uncommitted');
});

test('after the call the lock, the run folder and call.lock are gone', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the lock is gone');
  assert.equal(fs.existsSync(path.join(runDir, 'call.lock')), false, 'call.lock is gone');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
});

test('with no pre-staging, unstaged is [] (the run set indexReset), not null', async (t) => {
  const { c, planId } = await groupedRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.unstaged, []);
});

// A `preStaged` file (part of `a.txt`'s change staged, the rest left in the working tree,
// C:plan "A partially staged file appears in both lists") plus the usual two-file group.
async function partiallyStagedRun(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nstaged\n');
  c.git(['add', '--', 'a.txt']);
  c.writeFile('a.txt', 'one\nstaged\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.preStaged, ['a.txt'], 'plan recorded a.txt as pre-staged');
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: BODY, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

test('a pre-staged file refuses before any group: no commit, the real index untouched, the run kept', async (t) => {
  const { c, planId, runDir } = await partiallyStagedRun(t);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  const statusBefore = c.git(['status', '--porcelain']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'no commit was made');
  assert.equal(c.git(['status', '--porcelain']), statusBefore, 'the real index is exactly as plan left it');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), true, 'the run lock is kept');
  assert.equal(fs.existsSync(runDir), true, 'the run folder is kept');
});

test('a backstop hit after staging resets the real index before throwing, and commits nothing', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const keyBody = 'M'.repeat(48);
  c.writeFile('a.txt', `one\n-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n`);
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: HEADER, body: BODY, committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.error.kind, 'internal', detail(result));
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'no commit was made');
  assert.equal(c.git(['diff', '--cached']), '', 'the real index was reset, nothing staged');
  assert.match(c.git(['status', '--porcelain']), /^ M a\.txt\r?\n M b\.txt\r?\n?$/, 'both files are plain unstaged modifications again');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), true, 'the run lock is kept');
  assert.equal(fs.existsSync(runDir), true, 'the run folder is kept');
});

// EXE-03 (docs/roadmap/10-commit-executor.md): the message reaches git exactly as approved.
// `git commit` runs with `--cleanup=verbatim` on stdin (`-F -`), so the repo's own
// `commit.cleanup` setting cannot strip a `#` line or trailing whitespace, and a body line
// that looks like a git flag is never argv, so it changes no git behaviour.

// A fixture `pre-commit` hook that writes `marker` and nothing else. `-n`/`--no-verify`
// reaching argv would skip it silently with no trace of its own (review-EXE-03 Medium 1), so
// its presence afterwards is the only direct witness that `-n` never got there.
function installMarkerHook(c) {
  const marker = path.join(c.root, 'pre-commit-ran');
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`);
  fs.chmodSync(hook, 0o755);
  return marker;
}

// `GIT_TRACE`'s own lines (git's argv echo, not this harness's). M2's `commitEnv` removes
// only the redirecting variables, so `git commit` alone keeps it; every other git call this
// process makes goes through `gitEnv`, which strips any `GIT_*` outside `GIT_ENV_KEEP_SET`
// (`GIT_TRACE` is not in it), so the file holds exactly one `git commit` call's trace (plus
// whatever git itself spawns from inside that call, e.g. `git maintenance run --auto`).
function readTraceLines(tracePath) {
  return fs.readFileSync(tracePath, 'utf8').split(/\r?\n/);
}

test('commit.cleanup=strip and core.commentChar=; in repo config do not strip a stored # or ; line, trailing whitespace or a blank-line run, and the call is exactly commit --cleanup=verbatim -F - with no message text in argv', async (t) => {
  const body = '# not a comment to verbatim\n\n; not a comment either\n'
    + 'Second paragraph with trailing spaces.   \n\n\n\n   ';
  const { c, planId } = await groupedRunWithMessage(t, {
    body,
    configure: (repo) => {
      repo.git(['config', 'commit.cleanup', 'strip']);
      repo.git(['config', 'core.commentChar', ';']);
    },
  });
  const marker = installMarkerHook(c);
  const trace = path.join(c.root, 'git-trace.log');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], { env: { GIT_TRACE: trace } });

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(fs.existsSync(marker), true, 'the pre-commit hook ran');
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${body}\n`);
  const lines = readTraceLines(trace);
  assert.ok(
    lines.some((line) => line.includes('built-in: git commit --cleanup=verbatim -F -')),
    `no exact built-in commit line in trace:\n${lines.join('\n')}`,
  );
  for (const needle of ['# not a comment', '; not a comment']) {
    assert.ok(
      !lines.some((line) => line.includes(needle)),
      `"${needle}" must never reach argv:\n${lines.join('\n')}`,
    );
  }
});

test('a stored body line reading --amend or -n is committed as text, changes no git behaviour, and never reaches argv', async (t) => {
  const body = 'Notes:\n--amend\n-n\nEnd.';
  const { c, planId } = await groupedRunWithMessage(t, { body });
  const marker = installMarkerHook(c);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  const trace = path.join(c.root, 'git-trace.log');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all'], { env: { GIT_TRACE: trace } });

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(fs.existsSync(marker), true, 'the pre-commit hook ran: -n did not reach argv');
  const [{ sha }] = result.json.commits;
  assert.equal(
    c.git(['rev-parse', `${sha}^`]).trim(),
    headBefore,
    'a new commit was made on top of the seed, not amended onto it',
  );
  assert.equal(c.git(['rev-list', '--count', sha]).trim(), '2', 'history has two commits, not one');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${body}\n`);
  const lines = readTraceLines(trace);
  assert.ok(
    lines.some((line) => line.includes('built-in: git commit --cleanup=verbatim -F -')),
    `no exact built-in commit line in trace:\n${lines.join('\n')}`,
  );
  for (const needle of ['--amend', 'End.']) {
    assert.ok(
      !lines.some((line) => line.includes(needle)),
      `"${needle}" must never reach argv:\n${lines.join('\n')}`,
    );
  }
});

test('a stored body ending in blank lines is committed with exactly one trailing LF, per messageOf', async (t) => {
  const body = 'Line one.\n\n\n';
  const { c, planId } = await groupedRunWithMessage(t, { body });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\nLine one.\n`);
});

test('matchIds: every id whose hash a current unit carries → ok; a missing hash → unmatched', () => {
  const units = [{ hash: 'h1' }, { hash: 'h2' }];

  assert.deepEqual(changeSet.matchIds({ u1: 'h1', u2: 'h2' }, units), { ok: true });
  assert.deepEqual(
    changeSet.matchIds({ u1: 'h1', u3: 'h3' }, units),
    { ok: false, code: 'unmatched', unmatched: ['u3'] },
  );
});
