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
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, COMMIT_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

let changeSet;
let scriptCall;
beforeEach(async () => {
  changeSet = await loadLib('change-set');
  scriptCall = await loadLib('script-call');
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const HEADER = 'feat: change both files';
const BODY = 'Some body.';
// MSG-07: the default attribution trailer this file's cases all get (none sets up a custom
// settings layer), appended as a new last paragraph since none of these bodies end in a
// footer paragraph.
const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

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
  // review-INT-02 N1: `commitGroups`' own `kept` field must not leak into direct
  // `commit --all` output (C:commit-release's output shape has no `kept`).
  assert.deepEqual(Object.keys(result.json).sort(), [
    'commits', 'error', 'failed', 'gitOutput', 'notices', 'ok', 'remaining', 'reply', 'unstaged', 'version',
  ].sort());
  // INT-09: the success path carries the `committed` reply (the failure path stays KD-R73's).
  assert.equal(result.json.reply.status, 'committed');
  assert.equal(result.json.reply.commits.length, 1);
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
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${BODY}\n\n${DEFAULT_TRAILER}\n`);
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

// EXE-11: a partially staged file is committed with its working-tree content; its staged
// version (`indexOnly`) is reported in `unstaged` with its blob, and the run is released.
test('a partially staged file is committed whole and reported in unstaged with its staged blob', async (t) => {
  const { c, planId, runDir } = await partiallyStagedRun(t);
  const stagedBlob = c.git(['rev-parse', ':a.txt']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(c.git(['show', 'HEAD:a.txt']), 'one\nstaged\nmore\n');
  assert.deepEqual(result.json.unstaged, [{ path: 'a.txt', ignored: false, blob: stagedBlob }]);
  assert.equal(fs.existsSync(runDir), false, 'the run folder is gone');
});

test('a backstop hit after staging unstages the group, commits nothing, and ends the run with exit 3 scan (EXE-13)', async (t) => {
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

  assert.equal(result.exitCode, 3, detail(result));
  assert.equal(result.json.error.kind, 'scan', detail(result));
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'no commit was made');
  assert.equal(c.git(['diff', '--cached']), '', 'the real index was reset, nothing staged');
  assert.match(c.git(['status', '--porcelain']), /^ M a\.txt\r?\n M b\.txt\r?\n?$/, 'both files are plain unstaged modifications again');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
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
    + 'Second paragraph with trailing spaces.   \n\n\n\n   \n'
    + 'Third paragraph.';
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
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${body}\n\n${DEFAULT_TRAILER}\n`);
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
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\n${body}\n\n${DEFAULT_TRAILER}\n`);
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
  assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `${HEADER}\n\nLine one.\n\n${DEFAULT_TRAILER}\n`);
});

test('matchIds: every id whose hash a current unit carries → ok; a missing hash → unmatched', () => {
  const units = [{ hash: 'h1' }, { hash: 'h2' }];

  assert.deepEqual(changeSet.matchIds({ u1: 'h1', u2: 'h2' }, units), {
    ok: true,
    units: [{ id: 'u1', hash: 'h1' }, { id: 'u2', hash: 'h2' }],
  });
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

// A fixture hook (`pre-commit` unless `hookName` says otherwise) that runs `script`
// (CommonJS source) under this Node.
function installNodeHook(c, script, hookName = 'pre-commit') {
  const scriptPath = path.join(c.root, `${hookName}-hook.js`);
  fs.writeFileSync(scriptPath, script);
  const hook = path.join(c.repoDir, '.git', 'hooks', hookName);
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
      // Mirrors commit-executor.mjs's post-commit update (EXE-07's `index-changed`
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
  // EXE-06 AC3 (review-EXE-04 Medium-1): a mid-run `lock` refusal carries the same
  // commits/failed/remaining/unstaged fields as `head-moved`'s own, not just the refusal's
  // own kind/message, now that cli.mjs forwards them generically.
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  assert.deepEqual(result.json.unstaged, []);
  assert.deepEqual(result.json.notices, []);
});

// EXE-06 (docs/roadmap/10-commit-executor.md): M3 `head()` against the run's expected HEAD
// before each group, and M3 `firstParent` of each group's own commit after it, catch a commit
// made elsewhere (manually, or by a hook) between `plan` and `commit`, or between two groups.

test('a manual commit between plan and commit → exit 6 head-moved, no commit beyond it, index untouched, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  c.git(['commit', '-q', '--allow-empty', '-m', 'manual']);
  const headAfterManual = c.git(['rev-parse', 'HEAD']).trim();
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'head-moved', detail(result));
  assert.equal(
    result.json.error.message,
    'HEAD moved since plan (commit made elsewhere?), run /commit again',
  );
  assert.equal(result.json.unstaged, null);
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.deepEqual(result.json.notices, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headAfterManual, 'no commit beyond the manual one');
  // Byte-for-byte, not `git status --porcelain` (review-EXE-06 Low-4): porcelain only shows
  // content state and would not catch a rewritten index with the same tracked-file content.
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  // review-EXE-06 Medium-1: `head-moved` ends the run per C:cli-and-exit-codes, like
  // `diff-changed`/`index-lock`, unlike the `no-groups`/`lock` refusals that keep it.
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('a post-commit hook that commits again during group 1 of three → group 1 reported with HEAD\'s SHA and a notice, group 2 refused head-moved', async (t) => {
  const { c, planId, seed, runDir } = await threeGroupRun(t);
  const marker = path.join(c.root, 'extra-commit-done');
  installNodeHook(c, [
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    `const marker = ${JSON.stringify(marker)};`,
    `const repoDir = ${JSON.stringify(c.repoDir)};`,
    // Guards against recursing into itself: the extra commit below triggers this same
    // post-commit hook again, and that second run must do nothing.
    'if (!fs.existsSync(marker)) {',
    '  fs.writeFileSync(marker, "1");',
    "  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'extra'], { cwd: repoDir });",
    '}',
    '',
  ].join('\n'), 'post-commit');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'head-moved', detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 2, "group 1's own commit plus the hook's extra one");
  assert.equal(subjectOf(c, shas[0]), THREE_HEADERS[0]);
  assert.equal(filesOf(c, shas[0]), 'a.txt\n');
  // Group 1 is reported with the SHA HEAD now holds (the hook's extra commit), not its own.
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[1], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  assert.deepEqual(result.json.notices, ['another commit was made during group 1; later groups refused']);
  // review-EXE-06 Medium-1: `head-moved` ends the run per C:cli-and-exit-codes, like
  // `diff-changed`/`index-lock`, so the lock and run folder are released here too, not kept
  // as an earlier version of this test asserted.
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('group 1 already committed at the expected HEAD, but another commit landed elsewhere before group 2 → group 2 refused head-moved by the pre-group check, run released', async (t) => {
  let group1;
  let extra;
  const { c, planId, seed, runDir } = await threeGroupRun(t, {
    edit: async (state, repo) => {
      repo.git(['commit', '-q', '-m', THREE_HEADERS[0], '--', 'a.txt']);
      group1 = repo.git(['rev-parse', 'HEAD']).trim();
      state.groups[0].committed = true;
      state.head = group1;
      state.indexFingerprint = await changeSet.indexFingerprint({ toplevel: repo.repoDir, env: repo.env });
      // Not through this run: the state file still expects `group1`, but HEAD has since
      // moved past it, so group 2's own (a) `head()` check must catch this before it ever
      // reaches `firstParent()` (that check only runs after this run's own `git commit`).
      repo.git(['commit', '-q', '--allow-empty', '-m', 'elsewhere']);
      extra = repo.git(['rev-parse', 'HEAD']).trim();
    },
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'head-moved', detail(result));
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.deepEqual(shas, [group1, extra], 'nothing of group 2 or 3 was attempted');
  assert.deepEqual(result.json.commits, [], 'this call committed nothing (group 1 was already committed before it ran)');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  assert.deepEqual(result.json.notices, []);
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('a post-commit hook that commits again during the only group → exit 0, the commit reported with HEAD\'s SHA and a notice, the run still released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  const marker = path.join(c.root, 'extra-commit-done');
  installNodeHook(c, [
    "const fs = require('node:fs');",
    "const { execFileSync } = require('node:child_process');",
    `const marker = ${JSON.stringify(marker)};`,
    `const repoDir = ${JSON.stringify(c.repoDir)};`,
    'if (!fs.existsSync(marker)) {',
    '  fs.writeFileSync(marker, "1");',
    "  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'extra'], { cwd: repoDir });",
    '}',
    '',
  ].join('\n'), 'post-commit');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(result.json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  // KD-R44: the text still says "later groups refused" although there is no later group in
  // this single-group run (a known, documented gap, not asserted away here).
  assert.deepEqual(result.json.notices, ['another commit was made during group 1; later groups refused']);
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// EXE-07 (docs/roadmap/10-commit-executor.md): M10 `indexFingerprint` against the run's
// stored fingerprint before each group, the stored one updated after each of the run's own
// commits, so only staging made outside the run trips `index-changed` (C:commit-release (a)).

const INDEX_CHANGED_TEXT = 'the index changed since plan (staged elsewhere?), run /commit again';

test('a git add of another file between plan and commit → exit 6 diff-changed (index-changed), nothing committed, that staging still in the index, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('other.txt', 'other\n');
  c.git(['add', '--', 'other.txt']);
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, INDEX_CHANGED_TEXT);
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.equal(result.json.unstaged, null, 'no group reached (c), so nothing was reset');
  assert.deepEqual(result.json.notices, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'other.txt\n', 'the outside staging is still in the index');
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  // C:cli-and-exit-codes: `diff-changed` ends the run, like `head-moved`/`index-lock`.
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('group 1 already committed before the call, then a git add from outside → the call\'s first group (2) refused index-changed by its pre-group check, groups 2 and 3 remaining', async (t) => {
  let group1;
  const { c, planId, seed, runDir } = await threeGroupRun(t, {
    edit: async (state, repo) => {
      repo.git(['commit', '-q', '-m', THREE_HEADERS[0], '--', 'a.txt']);
      group1 = repo.git(['rev-parse', 'HEAD']).trim();
      state.groups[0].committed = true;
      state.head = group1;
      state.indexFingerprint = await changeSet.indexFingerprint({ toplevel: repo.repoDir, env: repo.env });
      repo.writeFile('other.txt', 'other\n');
      repo.git(['add', '--', 'other.txt']);
    },
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, INDEX_CHANGED_TEXT);
  assert.deepEqual(c.git(['rev-list', `${seed}..HEAD`]).trim().split('\n'), [group1], 'nothing of group 2 or 3 was committed');
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'other.txt\n', 'the outside staging is still in the index');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('three groups with no outside change → all three commit: the run\'s own staging and commits never trip index-changed', async (t) => {
  const { c, planId, seed } = await threeGroupRun(t);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.commits.map((commit) => commit.n), [1, 2, 3]);
  assert.equal(c.git(['rev-list', '--count', `${seed}..HEAD`]).trim(), '3');
  assert.equal(c.git(['status', '--porcelain']), '');
});

// EXE-08 (docs/roadmap/10-commit-executor.md): M10 `indexLockExists` as the last refusal of
// phase (a), right before a group's (b)/(c) work ever touches the index (Q18, story 166).

const INDEX_LOCK_TEXT = 'another git process is running in this repo';

test('an index.lock created before the call → exit 6 index-lock, the lock file untouched, the index unchanged, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  const lockPath = path.join(c.repoDir, '.git', 'index.lock');
  fs.writeFileSync(lockPath, 'foreign lock\n');
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'index-lock', detail(result));
  assert.equal(result.json.error.message, INDEX_LOCK_TEXT);
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.equal(result.json.unstaged, null, 'no group reached (c), so nothing was reset');
  assert.deepEqual(result.json.notices, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'foreign lock\n', 'the lock file is untouched');
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  // C:cli-and-exit-codes: `index-lock` ends the run, like `head-moved`/`diff-changed`.
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('a post-commit hook of group 1 creates index.lock → group 1 kept, group 2 refused index-lock, no reset ran for group 2 (unstaged reflects only group 1\'s reset)', async (t) => {
  const { c, planId, seed, runDir } = await threeGroupRun(t);
  const lockPath = path.join(c.repoDir, '.git', 'index.lock');
  installNodeHook(c, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(lockPath)}, 'left behind\\n');`,
    '',
  ].join('\n'), 'post-commit');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'index-lock', detail(result));
  assert.equal(result.json.error.message, INDEX_LOCK_TEXT);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(subjectOf(c, shas[0]), THREE_HEADERS[0]);
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  // group 1's own (c) phase already set `indexReset`, so `unstaged` reflects that reset, not
  // a reset group 2 never ran (it was refused in phase (a), before touching the real index).
  assert.deepEqual(result.json.unstaged, []);
  // No reset ran for group 2: nothing is staged, and b.txt/c.txt are still plain unstaged
  // working-tree modifications, exactly as group 1's own reset+stage left them.
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'nothing is staged after the refusal');
  assert.match(c.git(['status', '--porcelain']), /^ M b\.txt\r?\n M c\.txt\r?\n?$/, 'groups 2 and 3 untouched, nothing staged');
  assert.equal(fs.existsSync(lockPath), true, 'the hook\'s own index.lock is left in place, not removed by this refusal');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('an outside git add plus an index.lock → diff-changed (index-changed) wins, not index-lock: the fingerprint check (ls-files, no lock taken) runs before the lock check', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('other.txt', 'other\n');
  c.git(['add', '--', 'other.txt']);
  const lockPath = path.join(c.repoDir, '.git', 'index.lock');
  fs.writeFileSync(lockPath, 'foreign lock\n');
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, INDEX_CHANGED_TEXT);
  assert.deepEqual(result.json.commits, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'foreign lock\n', 'the lock file is untouched');
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// EXE-09: phase (b), the match on the temporary index. Both refusals below leave the real
// index byte-identical and end the run (C:cli-and-exit-codes: `diff-changed` and exits 3-5
// release the lock and delete the run folder).
const UNMATCHED_TEXT = 'files changed since plan, run /commit again';

test('a planned file edited after plan → exit 6 diff-changed (unmatched), nothing committed, the index untouched, the run released', async (t) => {
  const { c, planId, runDir } = await groupedRun(t);
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('a.txt', 'one\nedited after plan\n');
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT);
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.equal(result.json.unstaged, null, 'no group reached (c), so nothing was reset');
  assert.deepEqual(result.json.notices, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

// A `plan --split` run whose stored lists hold one extra untracked candidate, `new.txt`,
// besides the two modified tracked files; the stored group names only a.txt's and b.txt's
// units, so `new.txt` is a stored candidate the rebuild adds but no group commits.
async function runWithExtraCandidate(t) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.writeFile('b.txt', 'two\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  c.writeFile('new.txt', 'new\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(JSON.stringify(state.candidates).includes('new.txt'), 'new.txt is a stored candidate');
  state.groups = [{
    n: 1,
    units: state.units.filter((unit) => unit.path !== 'new.txt').map((unit) => unit.id),
    header: HEADER,
    body: BODY,
    committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir };
}

// Fixture: `plan` stored `new.txt` as a not-ignored candidate; excluding it afterwards in
// `.git/info/exclude` (no tracked change, no index change) makes the rebuild's plain
// `git add -N` (no `-f`, the stored flag says not ignored) exit non-zero on every platform.
test('a stored candidate git add -N refuses on the temporary index → exit 4 git (git-failed) with gitOutput, the index untouched, the run released', async (t) => {
  const { c, planId, runDir } = await runWithExtraCandidate(t);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '\nnew.txt\n');
  const headBefore = c.git(['rev-parse', 'HEAD']).trim();
  const indexPath = path.join(c.repoDir, '.git', 'index');
  const indexBefore = fs.readFileSync(indexPath);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'git add -N failed rebuilding the temporary index for group 1');
  assert.equal(typeof result.json.gitOutput, 'string', detail(result));
  assert.match(result.json.gitOutput, /new\.txt/, 'gitOutput holds git\'s own output');
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 1);
  assert.deepEqual(result.json.remaining, [1]);
  assert.equal(result.json.unstaged, null);
  assert.deepEqual(result.json.notices, []);
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), headBefore, 'nothing committed');
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore, 'the index is byte-identical to before the call');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), false, 'the run lock is released');
  assert.equal(fs.existsSync(runDir), false, 'the run folder is released');
});

test('a stored candidate missing from the working tree is skipped by the rebuild → exit 0, the group committed', async (t) => {
  const { c, planId } = await runWithExtraCandidate(t);
  fs.unlinkSync(path.join(c.repoDir, 'new.txt'));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.error, null);
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(result.json.commits, [{ n: 1, sha, header: HEADER }]);
  assert.equal(filesOf(c, sha), 'a.txt\nb.txt\n');
});

// review-EXE-09 remark 5: both (b) refusals above are pinned only on group 1 of a
// single-group run. C:commit-release: "a `diff-changed` in (b) leaves the real index as it
// is, even when an earlier group … set `indexReset`." These two pin that on group 2 of a
// two-group run, after group 1 already committed and reset the real index.
async function twoGroupRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\n`);
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b']) c.writeFile(`${name}.txt`, `${name}\nmore\n`);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: THREE_HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, seed };
}

test('group 2 hits unmatched (diff-changed) after group 1 already committed → group 1 stays committed, the real index untouched by group 2, the run released', async (t) => {
  const { c, planId, seed } = await twoGroupRun(t);
  c.writeFile('b.txt', 'b\nedited after plan\n');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.error.message, UNMATCHED_TEXT);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(subjectOf(c, shas[0]), THREE_HEADERS[0]);
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
  // group 1's own (c) phase already set indexReset; group 2's (b) refusal runs before any
  // reset of its own, so `unstaged` still reflects only group 1's reset, not group 2's.
  assert.deepEqual(result.json.unstaged, []);
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'nothing staged after the refusal');
  assert.match(c.git(['status', '--porcelain']), /^ M b\.txt\r?\n?$/, 'b.txt is still a plain unstaged edit');
});

test('group 2 hits git-failed rebuilding the temporary index after group 1 already committed → group 1 stays committed, the real index untouched by group 2, the run released', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('b.txt', 'b\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('a.txt', 'a\nmore\n');
  c.writeFile('b.txt', 'b\nmore\n');
  c.writeFile('new.txt', 'new\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(JSON.stringify(state.candidates).includes('new.txt'), 'new.txt is a stored candidate');
  state.groups = ['a', 'b'].map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === `${name}.txt`).map((unit) => unit.id),
    header: THREE_HEADERS[i],
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  // new.txt is a not-ignored stored candidate throughout group 1's own rebuild (it commits
  // fine); only after group 1's `git commit` does this hook exclude it, so group 2's rebuild
  // is the first to hit the plain (no `-f`) `git add -N` failure.
  const excludePath = path.join(c.repoDir, '.git', 'info', 'exclude');
  installNodeHook(c, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(excludePath)}, '\\nnew.txt\\n');`,
    '',
  ].join('\n'), 'post-commit');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.equal(result.json.error.kind, 'git', detail(result));
  assert.equal(result.json.error.message, 'git add -N failed rebuilding the temporary index for group 2');
  assert.equal(typeof result.json.gitOutput, 'string', detail(result));
  assert.match(result.json.gitOutput, /new\.txt/, 'gitOutput holds git\'s own output');
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.equal(subjectOf(c, shas[0]), THREE_HEADERS[0]);
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2]);
  assert.deepEqual(result.json.unstaged, []);
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'nothing staged after the refusal');
});

// EXE-16 (docs/roadmap/10-commit-executor.md): M15 `nextStep`, the last step of phase (a).
// The first group of the call always starts; a later one only while at least 480 s remain
// before the 540 s `deadline`. A stop is not a failure: exit 0, `failed: null`, a non-empty
// `remaining`, no `refusal`, the run kept, and a `continue` handback built here (`budgetStop`,
// S2 `build()`).

function reflogCount(c) {
  const out = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim();
  return out === '' ? 0 : out.split('\n').length;
}

// A schedule whose single step holds once this call's own next `git commit` has landed
// (testing-seams "group 1 commits, the clock steps to 61 s elapsed"): `atLeast` is read now,
// before launch, so it is exactly one more than the reflog already holds. Using a path
// marker written before launch instead would step the clock before group 1 ever runs,
// which happens to read the same since the first group of a call always starts regardless
// of the budget — but would not show the budget being re-read between groups.
function scheduleAfterNextCommit(c, elapsedMs) {
  const schedulePath = path.join(c.root, 'schedule.json');
  const atLeast = reflogCount(c) + 1;
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast }, elapsedMs },
  ]));
  return schedulePath;
}

function runCommitAtElapsed(c, planId, elapsedMs) {
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleAfterNextCommit(c, elapsedMs) },
  });
}

// EXE-22: the same as `runCommitAtElapsed`, but with `--confirmed` on the call's own `run`
// (AC2/AC3: the first group of a call with `--confirmed` clears `awaitingConfirm`, so the
// budget-stop `continue` it hands back needs none).
function runConfirmedCommitAtElapsed(c, planId, elapsedMs) {
  return runCommit(c, ['commit', '--plan', planId, '--all', '--confirmed'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleAfterNextCommit(c, elapsedMs) },
  });
}

// A schedule whose single step holds from a marker file written before launch, so the clock
// already reads `elapsedMs` from this call's very first group onward (FND-05). Needed for the
// AC5 first-group exemption itself: `scheduleAfterNextCommit` only steps the clock after this
// call's own next commit lands, so the call's first group always starts under the real (near-0)
// elapsed clock and never exercises the exemption. Here the first group starts already "at"
// `elapsedMs` — proving `nextStep` lets it through regardless of the floor.
function scheduleFromStart(c, elapsedMs) {
  const marker = path.join(c.root, 'clock-marker');
  fs.writeFileSync(marker, '');
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs }]));
  return schedulePath;
}

function runCommitAtElapsedFromStart(c, planId, elapsedMs) {
  return runCommit(c, ['commit', '--plan', planId, '--all'], {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: scheduleFromStart(c, elapsedMs) },
  });
}

test('61 s elapsed after group 1 stops the call: exit 0, commits [1], remaining [2, 3], run kept, a `continue` handback', async (t) => {
  const { c, planId, runDir, seed } = await threeGroupRun(t);

  const result = await runCommitAtElapsed(c, planId, 61_000);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true, detail(result));
  assert.equal(result.json.refusal, undefined);
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, [2, 3]);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
  assert.equal(fs.existsSync(runDir), true, 'the run is kept, not released');
  assert.equal(fs.existsSync(path.join(path.dirname(runDir), 'lock')), true, 'the lock is kept');

  // AC6: the `continue` handback (C:reply-and-handback), built with S2 `build()`.
  const { handback } = result.json.reply;
  assert.equal(handback.kind, 'continue');
  assert.equal(handback.question, null);
  assert.equal(handback.answers.length, 1);
  assert.equal(handback.answers[0].label, 'continue');
  assert.equal(handback.answers[0].run, scriptCall.build({
    scriptPath: COMMIT_ENTRY, subcommand: 'commit', args: ['--plan', planId, '--all'],
  }), 'same commit --plan <id> --all, no --confirmed');
  assert.equal(handback.answers[0].timeoutMs, 600_000);
  assert.deepEqual(handback.ifNoUser, { answer: 'continue' });
});

test('a `continue` call (a plain re-run of `commit --all` on the same plan) commits groups 2 and 3 and releases', async (t) => {
  const { c, planId, runDir, seed } = await threeGroupRun(t);
  const stopped = await runCommitAtElapsed(c, planId, 61_000);
  assert.deepEqual(stopped.json.remaining, [2, 3], detail(stopped));

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3, 'groups 2 and 3 committed on top of group 1');
  assert.deepEqual(result.json.commits, [
    { n: 2, sha: shas[1], header: THREE_HEADERS[1] },
    { n: 3, sha: shas[2], header: THREE_HEADERS[2] },
  ]);
  assert.equal(fs.existsSync(runDir), false, 'released after the last group');
});

// Medium (review-EXE-16): the first group *of this call* always starts, never only group
// `n === 1` — the `continue` call's own first group is 2, not 1, and still must start
// however little budget is left, with the budget check then applying to group 3.
test('a `continue` call resuming at group 2 still starts it at 539 s elapsed: commits [2], remaining [3], run kept', async (t) => {
  const { c, planId, runDir, seed } = await threeGroupRun(t);
  const stopped = await runCommitAtElapsed(c, planId, 61_000);
  assert.deepEqual(stopped.json.remaining, [2, 3], detail(stopped));

  const result = await runCommitAtElapsedFromStart(c, planId, 539_000);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, [3]);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 2, 'groups 1 and 2 are committed; group 3 stopped on budget');
  assert.deepEqual(result.json.commits, [{ n: 2, sha: shas[1], header: THREE_HEADERS[1] }]);
  assert.equal(fs.existsSync(runDir), true, 'the run is kept, not released');
});

test('at exactly 60 s elapsed (480 s left) group 2 starts: all three groups commit', async (t) => {
  const { c, planId, seed } = await threeGroupRun(t);

  const result = await runCommitAtElapsed(c, planId, 60_000);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, []);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3);
  assert.deepEqual(result.json.commits, THREE_HEADERS.map((header, i) => ({ n: i + 1, sha: shas[i], header })));
});

test('a budget stop after group 1, then a manual `git add` before the `continue` call: group 1 kept, group 2 refused index-changed', async (t) => {
  const { c, planId, seed } = await threeGroupRun(t);
  const stopped = await runCommitAtElapsed(c, planId, 61_000);
  assert.deepEqual(stopped.json.remaining, [2, 3], detail(stopped));
  c.writeFile('extra.txt', 'extra\n');
  c.git(['add', '--', 'extra.txt']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.deepEqual(result.json.commits, []);
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.remaining, [2, 3]);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 is committed, from before the budget stop');
});

test('the first group of the call starts even at 539 s elapsed, but group 2 then stops on budget', async (t) => {
  const { c, planId, seed } = await threeGroupRun(t);

  const result = await runCommitAtElapsedFromStart(c, planId, 539_000);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.failed, null);
  assert.deepEqual(result.json.remaining, [2, 3]);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 1, 'only group 1 was committed');
  assert.deepEqual(result.json.commits, [{ n: 1, sha: shas[0], header: THREE_HEADERS[0] }]);
});

// KD-R104 (INT-10): the same three files and groups as `threeGroupRun`, but the stored groups
// and `awaitingConfirm` come from a real `check --plan` over a worker plan (RUN-18's route):
// three groups in an interactive run, so `check` keeps the run and hands back `confirm`.
// Nothing in the state is forged.
async function threeGroupConfirmRun(t) {
  const c = createCase(t);
  for (const name of ['a', 'b', 'c']) c.writeFile(`${name}.txt`, `${name}
`);
  c.git(['add', '--', 'a.txt', 'b.txt', 'c.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  for (const name of ['a', 'b', 'c']) c.writeFile(`${name}.txt`, `${name}
more
`);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: ['a', 'b', 'c'].map((name, i) => ({
      header: THREE_HEADERS[i], body: null, files: [`${name}.txt`], hunks: [],
    })),
    notIncluded: [],
  }));
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(state.awaitingConfirm, true, 'check stored awaitingConfirm');
  assert.equal(state.groups.length, 3);
  return { c, planId, runDir, seed, checked };
}

// EXE-22 AC2/AC3 (docs/roadmap/10-commit-executor.md): a run left in `confirm`
// (`state.awaitingConfirm`) with `--confirmed` on the first group's call commits normally
// and clears `awaitingConfirm` right away; a budget stop after that confirmed group 1 hands
// back a `continue` whose `run` carries no `--confirmed` (C:commit-release), and that bare
// `commit --all` still succeeds because `awaitingConfirm` is already gone.
test('--confirmed on a run left in confirm commits group 1 and clears awaitingConfirm; after a budget stop the continue run (no --confirmed) commits the rest', async (t) => {
  const { c, planId, runDir, seed } = await threeGroupConfirmRun(t);

  const stopped = await runConfirmedCommitAtElapsed(c, planId, 61_000);

  assert.equal(stopped.exitCode, 0, detail(stopped));
  assert.equal(stopped.json.refusal, undefined, detail(stopped));
  assert.deepEqual(stopped.json.remaining, [2, 3], detail(stopped));
  const shas1 = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas1.length, 1, 'only group 1 was committed');
  assert.deepEqual(stopped.json.commits, [{ n: 1, sha: shas1[0], header: THREE_HEADERS[0] }]);
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.awaitingConfirm, undefined, 'awaitingConfirm was cleared on the first group');
  // AC6 continue handback: same as EXE-16's, no --confirmed appended to its run.
  assert.equal(stopped.json.reply.handback.answers[0].run, scriptCall.build({
    scriptPath: COMMIT_ENTRY, subcommand: 'commit', args: ['--plan', planId, '--all'],
  }), 'the continue run carries no --confirmed');

  // The `continue` call is a bare `commit --all`, with no --confirmed, and still succeeds.
  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.refusal, undefined, detail(result));
  assert.deepEqual(result.json.remaining, []);
  const shas = c.git(['rev-list', '--reverse', `${seed}..HEAD`]).trim().split('\n');
  assert.equal(shas.length, 3, 'groups 2 and 3 committed on top of group 1');
  assert.equal(fs.existsSync(runDir), false, 'released after the last group');
});

// KD-R104 (INT-10), C:commit-release phase (a): `unconfirmed` is checked ahead of `no-groups`.
// `check` never stores `awaitingConfirm` with zero groups, so the state is tampered with
// (Q16's `Edit(**/.commit-plan/**)` gap) after a real confirm handback.
test('awaitingConfirm with zero stored groups: commit --all refuses unconfirmed; with --confirmed, no-groups', async (t) => {
  const { c, planId, runDir } = await threeGroupConfirmRun(t);
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}
`);
  const head = c.git(['rev-parse', 'HEAD']).trim();

  const bare = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(bare.exitCode, 1, detail(bare));
  assert.equal(bare.json.error.kind, 'usage', detail(bare));
  assert.match(bare.json.error.message, /confirm/i, 'unconfirmed, not no-groups');
  assert.equal(fs.existsSync(runDir), true, 'the run is kept');

  const confirmed = await runCommit(c, ['commit', '--plan', planId, '--all', '--confirmed']);

  assert.equal(confirmed.exitCode, 1, detail(confirmed));
  assert.equal(confirmed.json.error.kind, 'usage', detail(confirmed));
  assert.doesNotMatch(confirmed.json.error.message, /confirm/i, 'no-groups, not unconfirmed');
  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), head, 'nothing committed');
});
