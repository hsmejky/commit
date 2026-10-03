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

// EXE-04 (docs/roadmap/10-commit-executor.md): several groups in order, one process. Phase
// (a) runs again before each group (M12 `touch`, the expected HEAD advanced to the previous
// group's SHA), and the release comes only after the last group (C:commit-release, Q18, Q22).

const THREE_HEADERS = ['feat: change a', 'fix: change b', 'docs: change c'];

// Three committed files, each modified, a `plan --split` run, and three stored groups, one
// per file in a, b, c order, as `check` stores them. `edit(state, c)` may change the stored
// state (and the repo) before the state is written back.
async function threeGroupRun(t, { edit } = {}) {
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
  if (edit) await edit(state, c);
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed, lockPath: path.join(path.dirname(runDir), 'lock') };
}

// A fixture `pre-commit` hook that runs `script` (CommonJS source) under this Node.
function installNodeHook(c, script) {
  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  fs.writeFileSync(scriptPath, script);
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  const slash = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);
}

function subjectOf(c, sha) {
  return c.git(['log', '-1', '--format=%s', sha]).trim();
}

function filesOf(c, sha) {
  return c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
}

test('three stored groups → three commits in group order, each parent the previous one, n 1-3', async (t) => {
  const { c, planId, seed, runDir } = await threeGroupRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3);
  assert.deepEqual(
    result.json.commits,
    shas.map((sha, i) => ({ n: i + 1, sha, header: THREE_HEADERS[i] })),
  );
  assert.deepEqual(shas.map((sha) => c.git(['rev-parse', `${sha}^`]).trim()), [seed, shas[0], shas[1]]);
  assert.deepEqual(shas.map((sha) => subjectOf(c, sha)), THREE_HEADERS);
  assert.deepEqual(shas.map((sha) => filesOf(c, sha)), ['a.txt\n', 'b.txt\n', 'c.txt\n']);
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  assert.equal(fs.existsSync(runDir), false, 'released after the last group');
});

test('the lock mtime is refreshed before each group (a pre-commit hook records it, then backdates it)', async (t) => {
  const { c, planId, lockPath } = await threeGroupRun(t);
  const log = path.join(c.root, 'lock-mtimes.log');
  const old = new Date(Date.UTC(2001, 0, 1));
  installNodeHook(c, [
    "const fs = require('node:fs');",
    `const lock = ${JSON.stringify(lockPath)};`,
    `fs.appendFileSync(${JSON.stringify(log)}, fs.statSync(lock).mtimeMs + '\\n');`,
    `const old = new Date(${old.getTime()});`,
    'fs.utimesSync(lock, old, old);',
    '',
  ].join('\n'));
  fs.utimesSync(lockPath, old, old);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const mtimes = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number);
  assert.equal(mtimes.length, 3, 'the hook ran once per group');
  for (const [i, mtime] of mtimes.entries()) {
    assert.ok(mtime > old.getTime(), `group ${i + 1} saw a refreshed lock (mtime ${mtime})`);
  }
});

test('group 1 already committed with the expected HEAD at its SHA → the call commits groups 2 and 3 only', async (t) => {
  let group1;
  const { c, planId, seed } = await threeGroupRun(t, {
    edit: async (state, repo) => {
      repo.git(['commit', '-q', '-m', THREE_HEADERS[0], '--', 'a.txt']);
      group1 = repo.git(['rev-parse', 'HEAD']).trim();
      state.groups[0].committed = true;
      state.head = group1;
      // Mirrors commit-executor.mjs's post-commit update (EXE-07's future `index-changed`
      // check reads this field): without it, the fixture's own `git commit` above leaves the
      // stored fingerprint stale relative to the index it just committed.
      state.indexFingerprint = await changeSet.indexFingerprint({ toplevel: repo.repoDir, env: repo.env });
    },
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3);
  assert.equal(shas[0], group1);
  assert.deepEqual(result.json.commits, [
    { n: 2, sha: shas[1], header: THREE_HEADERS[1] },
    { n: 3, sha: shas[2], header: THREE_HEADERS[2] },
  ]);
  assert.equal(c.git(['rev-parse', `${shas[1]}^`]).trim(), group1);
  assert.deepEqual(shas.slice(1).map((sha) => filesOf(c, sha)), ['b.txt\n', 'c.txt\n']);
  assert.equal(c.git(['status', '--porcelain']), '');
});

test("group 1's pre-commit hook rewrites the lock to another planId → group 1 kept, group 2's touch refuses taken-over", async (t) => {
  const { c, planId, seed, runDir, lockPath } = await threeGroupRun(t);
  const other = '0b7d6a4e-3f1c-4c2a-9e5d-7a8b9c0d1e2f';
  installNodeHook(c, [
    "const fs = require('node:fs');",
    `const lock = ${JSON.stringify(lockPath)};`,
    'const content = JSON.parse(fs.readFileSync(lock, \'utf8\'));',
    `fs.writeFileSync(lock, JSON.stringify({ ...content, planId: ${JSON.stringify(other)} }));`,
    '',
  ].join('\n'));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'lock', detail(result));
  assert.match(result.json.error.message, /this run was taken over by another \/commit/);
  const shas = c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(subjectOf(c, shas[0]), THREE_HEADERS[0]);
  assert.equal(filesOf(c, shas[0]), 'a.txt\n');
  assert.match(c.git(['status', '--porcelain']), /^ M b\.txt\r?\n M c\.txt\r?\n?$/, 'groups 2 and 3 untouched, nothing staged');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).planId, other, "the other run's lock is left alone");
  assert.equal(fs.existsSync(runDir), true, 'the run folder is not released');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.groups.map((group) => group.committed), [true, false, false]);
  assert.equal(state.head, shas[0]);
});
