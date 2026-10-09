'use strict';

// EXE-11 (docs/roadmap/10-commit-executor.md): the `unstaged` report (Q18, C:commit-release
// `unstaged`). M10 `unstagedAfterReset(preStaged, indexOnly)` fills `unstaged` on every
// `commit --all` output once the state file has `indexReset`: the pre-staged paths still
// differing from HEAD (`blob: null`) and every `indexOnly` path with its index blob; `ignored`
// marks one `git status` no longer shows. Seam 1: `plan --split`, groups written into
// `state.json` as `check` stores them, then `commit --plan <id> --all`.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with `a.txt` and `b.txt` committed and both modified; `prepare` runs before `plan`
// (the pre-staging under test). Each name in `groups` is one group of that file's units.
async function plannedRun(t, { prepare, groups = ['a.txt'] }) {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('b.txt', 'b\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const seed = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('a.txt', 'a\nmore\n');
  c.writeFile('b.txt', 'b\nmore\n');
  prepare(c);
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = groups.map((name, i) => ({
    n: i + 1,
    units: state.units.filter((unit) => unit.path === name).map((unit) => unit.id),
    header: `feat: group ${i + 1}`,
    body: null,
    committed: false,
  }));
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, seed };
}

const commitAll = (c, planId, options) => runCommit(c, ['commit', '--plan', planId, '--all'], options);

test('a pre-staged file outside the planned groups is listed with blob null after a successful run', async (t) => {
  const { c, planId } = await plannedRun(t, {
    prepare: (repo) => {
      repo.writeFile('new.txt', 'new\n');
      repo.git(['add', '--', 'new.txt']);
    },
  });

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.unstaged, [{ path: 'new.txt', ignored: false, blob: null }]);
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'the reset unstaged new.txt');
});

test('an index-only version is listed with its blob, and git cat-file -p <blob> returns the discarded content', async (t) => {
  const { c, planId } = await plannedRun(t, {
    prepare: (repo) => {
      // Staged, then the working file changed back to HEAD's content.
      repo.writeFile('b.txt', 'b\nstaged\n');
      repo.git(['add', '--', 'b.txt']);
      repo.writeFile('b.txt', 'b\n');
    },
  });

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.unstaged.length, 1, detail(result));
  const [entry] = result.json.unstaged;
  assert.equal(entry.path, 'b.txt');
  assert.equal(entry.ignored, false);
  assert.match(entry.blob, /^[0-9a-f]{40,64}$/);
  assert.equal(c.git(['cat-file', '-p', entry.blob]), 'b\nstaged\n');
});

test('a pre-staged ignored path that git status no longer shows → ignored: true', async (t) => {
  const { c, planId } = await plannedRun(t, {
    prepare: (repo) => {
      repo.writeFile('.git/info/exclude', 'build/\n');
      repo.writeFile('build/out.js', 'out\n');
      repo.git(['add', '-f', '--', 'build/out.js']);
    },
  });

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.unstaged, [{ path: 'build/out.js', ignored: true, blob: null }]);
  assert.equal(c.git(['status', '--porcelain', '--', 'build']), '', 'git status no longer shows it');
});

test('a refusal before any group reached (c) → unstaged null, the pre-staging left in place', async (t) => {
  const { c, planId } = await plannedRun(t, {
    prepare: (repo) => {
      repo.writeFile('new.txt', 'new\n');
      repo.git(['add', '--', 'new.txt']);
    },
  });
  c.writeFile('a.txt', 'a\nedited after plan\n');

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(result.json.unstaged, null);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'new.txt\n', 'the index is untouched');
});

test('group 1 sets indexReset, group 2 refuses diff-changed in (b) → the index left as is, unstaged from group 1 listed', async (t) => {
  const { c, planId, seed } = await plannedRun(t, {
    groups: ['a.txt', 'b.txt'],
    prepare: (repo) => {
      repo.writeFile('new.txt', 'new\n');
      repo.git(['add', '--', 'new.txt']);
    },
  });
  c.writeFile('b.txt', 'b\nedited after plan\n');

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'diff-changed', detail(result));
  assert.equal(c.git(['rev-list', '--count', `${seed}..HEAD`]).trim(), '1', 'only group 1 committed');
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.unstaged, [{ path: 'new.txt', ignored: false, blob: null }]);
  assert.equal(c.git(['diff', '--cached', '--name-only']), '', 'group 2 left the index as group 1 did');
});

test('a budget stop after a group that set indexReset → the continue output carries unstaged as an array', async (t) => {
  const { c, planId } = await plannedRun(t, {
    groups: ['a.txt', 'b.txt'],
    prepare: (repo) => {
      repo.writeFile('new.txt', 'new\n');
      repo.git(['add', '--', 'new.txt']);
    },
  });
  const reflog = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim().split('\n').length;
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast: reflog + 1 }, elapsedMs: 61_000 },
  ]));

  const result = await commitAll(c, planId, {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.remaining, [2], detail(result));
  assert.equal((result.json.handback ?? result.json.reply?.handback)?.kind, 'continue');
  assert.deepEqual(result.json.unstaged, [{ path: 'new.txt', ignored: false, blob: null }]);
});

test('a budget stop with nothing pre-staged → unstaged is [], never null', async (t) => {
  const { c, planId } = await plannedRun(t, { groups: ['a.txt', 'b.txt'], prepare: () => {} });
  const reflog = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim().split('\n').length;
  const schedulePath = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify([
    { event: { type: 'reflogCount', repo: c.repoDir, atLeast: reflog + 1 }, elapsedMs: 61_000 },
  ]));

  const result = await commitAll(c, planId, {
    nodeArgs: ['--import', CLOCK_PRELOAD],
    env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
  });

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.remaining, [2], detail(result));
  assert.deepEqual(result.json.unstaged, []);
});

// AC1's report text through a real route: `check --plan`'s in-process `commit --all` puts
// `unstaged` in the `committed` reply's `text` after the commit lines (Q18), one line per
// entry: a plain pre-staged path, an index-only one with its blob, a force-added ignored one.
test('check commits the plan → the committed reply says "your earlier staging was reset:" and lists each unstaged path', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.writeFile('b.txt', 'b\n');
  c.git(['add', '--', 'a.txt', 'b.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  c.writeFile('new.txt', 'new\n');
  c.git(['add', '--', 'new.txt']);
  // Staged, then the working file changed back to HEAD's content: index-only.
  c.writeFile('b.txt', 'b\nstaged\n');
  c.git(['add', '--', 'b.txt']);
  c.writeFile('b.txt', 'b\n');
  c.writeFile('.git/info/exclude', 'build/\n');
  c.writeFile('build/out.js', 'out\n');
  c.git(['add', '-f', '--', 'build/out.js']);
  const planned = await runCommit(c, ['plan', '--split', '--no-user']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header: 'feat: change a', body: null, files: ['a.txt'], hunks: [], reason: 'test' }],
    notIncluded: [
      { path: 'new.txt', hunks: null, reason: 'leaving out for now' },
      { path: 'build/out.js', hunks: null, reason: 'leaving out for now' },
    ],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  const { json } = checked;
  const blob = json.unstaged.find((entry) => entry.path === 'b.txt')?.blob;
  assert.match(String(blob), /^[0-9a-f]{40,64}$/, detail(checked));
  const sha = c.git(['rev-parse', 'HEAD']).trim();
  assert.equal(json.reply.status, 'committed');
  const expected = {
    'b.txt': `b.txt: staged version discarded, recover with \`git cat-file -p ${blob}\``,
    'build/out.js': 'build/out.js is no longer shown by `git status`',
    'new.txt': 'new.txt',
  };
  assert.deepEqual(json.unstaged.map((entry) => entry.path).sort(), Object.keys(expected));
  // The lines after these are the tree state's.
  const textLines = json.reply.text.split('\n');
  assert.equal(textLines[0], `${sha} feat: change a`);
  const resetAt = textLines.indexOf('your earlier staging was reset:');
  assert.deepEqual(textLines.slice(resetAt, resetAt + 4), [
    'your earlier staging was reset:',
    ...json.unstaged.map((entry) => expected[entry.path]),
  ]);
  assert.equal(c.git(['cat-file', '-p', blob]), 'b\nstaged\n');
});

// review-EXE-11 finding 2: the index a stray reset would lose. Group 1's post-commit hook stages
// `extra.txt`, so after group 1's commit the index differs from HEAD (the run re-reads its
// fingerprint after its own `git commit`); group 2's (b) refusal must leave that alone.
// AC6's "(a) refusal" arm needs a phase (a) refusal after group 1 that leaves the index
// differing from HEAD at Seam 1; none is reachable (KD-R106's note), so (b) is the tested arm.
test('group 2 refuses in (b) → an index that differs from HEAD stays exactly as it is', async (t) => {
  const { c, planId } = await plannedRun(t, { groups: ['a.txt', 'b.txt'], prepare: () => {} });
  const hook = path.join(c.repoDir, '.git', 'hooks', 'post-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho extra > extra.txt\ngit add -- extra.txt\n');
  fs.chmodSync(hook, 0o755);
  c.writeFile('b.txt', 'b\nedited after plan\n');

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.failed, 2);
  assert.deepEqual(result.json.unstaged, []);
  assert.equal(c.git(['diff', '--cached', '--name-only']), 'extra.txt\n', 'the hook-staged file survived');
});

// Whether `dir`'s filesystem keeps a name with a non-UTF-8 byte exactly as written.
function holdsNonUtf8Names(dir) {
  const name = Buffer.from('probe-\xff', 'latin1');
  const full = Buffer.concat([Buffer.from(dir + path.sep), name]);
  try {
    fs.writeFileSync(full, '');
  } catch {
    return false;
  }
  const held = fs.readdirSync(dir, { encoding: 'buffer' }).some((entry) => entry.equals(name));
  fs.rmSync(full);
  return held;
}

// review-EXE-11 finding 4: `plan` stores a non-UTF-8 pre-staged path in its `\xNN` form
// (C:plan), and `unstagedAfterReset` matches it against the `\xNN` form of what `git status` lists.
test('a pre-staged path that is not valid UTF-8 is matched and listed in its backslash-x form', async (t) => {
  const { c, planId } = await plannedRun(t, {
    prepare: (repo) => {
      if (!holdsNonUtf8Names(repo.repoDir)) return;
      fs.mkdirSync(path.join(repo.repoDir, 'd'));
      fs.writeFileSync(Buffer.concat([Buffer.from(`${repo.repoDir}${path.sep}d${path.sep}`), Buffer.from('s\xe9.txt', 'latin1')]), 'x\n');
      repo.git(['add', '--', 'd']);
    },
  });
  if (!holdsNonUtf8Names(c.repoDir)) {
    t.skip('the filesystem cannot hold a file name that is not valid UTF-8');
    return;
  }

  const result = await commitAll(c, planId);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(result.json.unstaged, [{ path: 'd/s\\xe9.txt', ignored: false, blob: null }]);
});
