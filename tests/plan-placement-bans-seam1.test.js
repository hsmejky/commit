'use strict';

// PLN-04 Seam 1 (docs/roadmap/08-plan-validation.md AC1-AC5; testing-seams.md:84-85: M14 is
// tested through Seam 1): `check --plan` subprocess cases for the scan-hit placement ban, the
// left-out-hit notice's `path:line` (review-PLN-04 finding 1), the `notIncluded`
// extras (collapsed directory, hidden/gitignored staged-new, dirty submodule, non-UTF-8
// path) and the `indexOnly` notice. tests/plan-placement-bans.test.js keeps the in-process
// M14 cases as supplementary extras.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// GRD-17/Q23: no heartbeat is set up in any case below, so `plan`'s guard notice carries
// into `check`'s reply ahead of its own notices (C:check "notices"; same constant as
// tests/first-end-to-end-commit.test.js and others — not a harness artifact, real behavior).
const GUARD_NOTICE = 'Guard hook did not run: `node` missing from the hook\'s PATH, plugin hooks '
  + 'disabled, or `disableAllHooks` set. Direct `git commit` is not blocked.';

// A `ghp_` token built at run time (see tests/scanner.test.js, tests/plan-scan.test.js).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

// A file whose first and last line differ from a 30-line seed, so the working-tree diff
// holds two separate hunks (mirrors tests/plan-hunk-level.test.js' threeHunkRun).
function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`);
}

function unitsFor(runDir, filePath) {
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  return state.units.filter((unit) => unit.path === filePath).map((unit) => unit.id);
}

async function check(c, planId, runDir, plan) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'worker', ...plan }));
  return runCommit(c, ['check', '--plan', planId]);
}

// A repo with `src/b.js` committed at two lines, then a third line added holding a
// `github-token` hit (Q10: `split` scans the working-tree diff, no staging needed).
async function plannedHit(t) {
  const c = createCase(t);
  c.writeFile('src/b.js', 'one\ntwo\n');
  c.git(['add', '--', 'src/b.js']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('src/b.js', `one\ntwo\nconst token = "${githubToken('f')}";\n`);
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

test('AC1 Seam 1: a hit unit placed in a group is rejected, "has scan hit `github-token`; move it to notIncluded"', async (t) => {
  const { c, planId, runDir } = await plannedHit(t);

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: ['src/b.js'], hunks: [] }],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.errors.length, 1, detail(checked));
  assert.equal(checked.json.errors[0].group, 1);
  assert.match(checked.json.errors[0].reason, /^h\d+ has scan hit `github-token`; move it to notIncluded$/);
});

test('AC1 Seam 1: the same hit left out in notIncluded produces the notice "src/b.js:3 github-token left out"', async (t) => {
  const { c, planId, runDir } = await plannedHit(t);

  const checked = await check(c, planId, runDir, {
    groups: [],
    notIncluded: [{ path: 'src/b.js', hunks: null, reason: 'scan: github-token' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notices, [GUARD_NOTICE, 'src/b.js:3 github-token left out']);
});

// --- AC2: a collapsed untracked directory; a hidden staged-new path ----------------------

test('AC2 Seam 1: a collapsed untracked directory (>50 new files) becomes a notIncluded entry', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  // A real tracked edit alongside the collapse: an all-collapsed tree alone is "clean"
  // (nothing plannable), so `plan` would return `planId: null`/no run folder.
  c.writeFile('a.txt', 'a2\n');
  for (let i = 0; i < 51; i += 1) c.writeFile(`dist/f${i}.txt`, 'x\n');

  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: ['a.txt'], hunks: [] }],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'dist', hunks: null, reason: '51 untracked files in dist/ — add to .gitignore or commit by hand' },
  ]);
  // The group is whole-file, so `check` runs `commitAll` in-process (C:check). Pin what it
  // actually committed, so a silent change to the commit path is visible here (review-PLN-04
  // r2 Low-4): exactly one commit, of `a.txt`.
  assert.equal(checked.json.commits.length, 1, detail(checked));
  assert.equal(
    c.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim(),
    'a.txt',
  );
});

test('AC2 Seam 1: a hidden staged-new `.env.local` → "was staged but is hidden…"; unstages it with a group', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.env.local', 'SECRET=1\n');
  c.git(['add', '-f', '--', '.env.local']);
  c.writeFile('b.txt', 'b\n');
  c.git(['add', '--', 'b.txt']);

  // Zero groups covers the base (no-group) wording; the next case covers "with a group" via a
  // hunk-level group (KD-R83), which never reaches `commitAll` at all.
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;

  const checked = await check(c, planId, runDir, {
    groups: [],
    notIncluded: [{ path: 'b.txt', hunks: null, reason: 'leaving out for now' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'b.txt', hunks: null, reason: 'leaving out for now' },
    { path: '.env.local', hunks: null, reason: '.env.local was staged but is hidden — commit by hand' },
  ]);
});

// "With a group" gets the "committing this plan unstages it" suffix (hasGroups, C:check).
// The group here is hunk-level (one of a two-hunk file's two hunks), so `commitCheckedGroups`
// (workflows.mjs) returns `check`'s own validated output without ever calling `commitAll`
// (KD-R83: a hunk-level file entry skips the whole-file commit path). Retire this reliance on
// KD-R83 once INT-18 lifts it (EXE-11's `unstaged` report already covers the preStaged paths
// a whole-file commit would reset).
test('AC2 Seam 1: a hidden staged-new `.env.local`, with a group → "…; committing this plan unstages it"', async (t) => {
  const c = createCase(t);
  const lines = numbered(30);
  c.writeFile('a.txt', lines.join(''));
  c.writeFile('f.txt', lines.join(''));
  c.git(['add', '--', 'a.txt', 'f.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.env.local', 'SECRET=1\n');
  c.git(['add', '-f', '--', '.env.local']);
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[29] = 'last\n';
  c.writeFile('f.txt', edited.join(''));

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const [h1, h2] = unitsFor(runDir, 'f.txt');

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: [], hunks: [h1] }],
    notIncluded: [{ path: 'f.txt', hunks: [h2], reason: 'leaving out for now' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits, undefined, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'f.txt', hunks: [h2], reason: 'leaving out for now' },
    { path: '.env.local', hunks: null, reason: '.env.local was staged but is hidden — commit by hand; committing this plan unstages it' },
  ]);
});

// --- AC3: a gitignored staged-new unit left out, with a group and with zero groups -------

async function gitignoredStagedNewCase(t) {
  const c = createCase(t);
  // `.gitignore` and `a.txt` committed up front (not left untracked): an untracked
  // `.gitignore` would itself be one more "other change" and trip Q9's split/staged
  // mode-choice handback. `a.txt` is edited afterwards so there is a second, unrelated unit
  // to place in a group — `new.txt` is the only staged-new one, left in `notIncluded`.
  c.writeFile('a.txt', 'a\n');
  c.writeFile('.gitignore', 'new.txt\n');
  c.git(['add', '--', 'a.txt', '.gitignore']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a2\n');
  c.writeFile('new.txt', 'n\n');
  c.git(['add', '-f', '--', 'new.txt']);

  // `--split`: a staged new.txt plus an unstaged-only a.txt edit is otherwise "1 file is
  // staged, 1 other change", Q9's mode-choice handback (no planId/runDir at all) — the
  // seam under test (M14/`check`) needs split mode picked up front.
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

// Zero groups below covers the base wording; the next case covers "with a group" via a
// hunk-level group over `a.txt` itself (KD-R83), which never reaches `commitAll` at all.
test('AC3 Seam 1: ...with a group, gets the .gitignore clause', async (t) => {
  const c = createCase(t);
  const lines = numbered(30);
  c.writeFile('a.txt', lines.join(''));
  c.writeFile('.gitignore', 'new.txt\n');
  c.git(['add', '--', 'a.txt', '.gitignore']);
  c.git(['commit', '-q', '-m', 'seed']);
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[29] = 'last\n';
  c.writeFile('a.txt', edited.join(''));
  c.writeFile('new.txt', 'n\n');
  c.git(['add', '-f', '--', 'new.txt']);

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const [h1, h2] = unitsFor(runDir, 'a.txt');

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: [], hunks: [h1] }],
    notIncluded: [
      { path: 'new.txt', hunks: null, reason: 'leaving out for now' },
      { path: 'a.txt', hunks: [h2], reason: 'leaving out for now' },
    ],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits, undefined, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'new.txt', hunks: null, reason: 'leaving out for now; committing this plan unstages it and .gitignore then hides it from `git status`' },
    { path: 'a.txt', hunks: [h2], reason: 'leaving out for now' },
  ]);
});

test('AC3 Seam 1: ...with zero groups, no unstaging note on that entry at all', async (t) => {
  const { c, planId, runDir } = await gitignoredStagedNewCase(t);

  const checked = await check(c, planId, runDir, {
    groups: [],
    notIncluded: [{ path: 'new.txt', hunks: null, reason: 'leaving out for now' }, { path: 'a.txt', hunks: null, reason: 'leaving out for now' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'new.txt', hunks: null, reason: 'leaving out for now' },
    { path: 'a.txt', hunks: null, reason: 'leaving out for now' },
  ]);
});

// --- AC4: a dirty submodule; an indexOnly path --------------------------------------------

// A bare-ish source repo to add as a submodule (mirrors tests/change-set-submodules.test.js'
// `sourceRepo`/`withSubmodule`, kept local: that file exports no helpers).
function sourceRepo(c) {
  const dir = path.join(c.repoDir, '..', `${path.basename(c.repoDir)}-source`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: dir, env: c.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'inner.txt'), 'one\n');
  run(['add', '--', 'inner.txt']);
  run(['commit', '-q', '-m', 'sub seed']);
  return dir;
}

function withDirtySubmodule(c) {
  const source = sourceRepo(c);
  c.writeFile('a.txt', 'a\n');
  c.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'libs/x']);
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const inner = path.join(c.repoDir, 'libs', 'x');
  fs.writeFileSync(path.join(inner, 'build.out'), 'junk\n');
}

test('AC4 Seam 1: a dirty submodule becomes a notIncluded entry "… has uncommitted changes inside …"', async (t) => {
  const c = createCase(t);
  withDirtySubmodule(c);
  c.writeFile('b.txt', 'b\n');
  c.git(['add', '--', 'b.txt']);

  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;

  const checked = await check(c, planId, runDir, {
    groups: [],
    notIncluded: [{ path: 'b.txt', hunks: null, reason: 'leaving out for now' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'b.txt', hunks: null, reason: 'leaving out for now' },
    { path: 'libs/x', hunks: null, reason: 'libs/x has uncommitted changes inside — commit inside the submodule first' },
  ]);
});

// The `indexOnly` notice only ever fires with hasGroups (C:check "notices", "at least one
// group"), so this case needs a group. A hunk-level group over an unrelated two-hunk file
// (KD-R83) gets hasGroups without ever calling `commitAll`; the `indexOnly` path's discarded
// blob in a real commit's `unstaged` report is EXE-11's (tests/commit-all-unstaged.test.js).
test('AC4 Seam 1: an indexOnly path (staged, then edited again) is a notice naming its staged blob', async (t) => {
  const c = createCase(t);
  const lines = numbered(30);
  c.writeFile('a.txt', lines.join(''));
  c.writeFile('k.txt', 'k1\n');
  c.git(['add', '--', 'a.txt', 'k.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  // Stage an edit to `k.txt`, then revert the working tree back to HEAD's content: the index
  // now differs from both HEAD and the working tree (CHG-14's `indexOnly`), with nothing left
  // to turn into a plannable unit for `k.txt` itself.
  c.writeFile('k.txt', 'k2\n');
  c.git(['add', '--', 'k.txt']);
  c.writeFile('k.txt', 'k1\n');
  const edited = [...lines];
  edited[0] = 'first\n';
  edited[29] = 'last\n';
  c.writeFile('a.txt', edited.join(''));

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const [h1, h2] = state.units.filter((unit) => unit.path === 'a.txt').map((unit) => unit.id);
  const blob = state.indexOnly.find((entry) => entry.path === 'k.txt').blob;

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: [], hunks: [h1] }],
    notIncluded: [{ path: 'a.txt', hunks: [h2], reason: 'leaving out for now' }],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.commits, undefined, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [{ path: 'a.txt', hunks: [h2], reason: 'leaving out for now' }]);
  assert.deepEqual(checked.json.notices, [
    GUARD_NOTICE,
    `k.txt: the staged version differs from your working tree; committing this plan discards it — recover with \`git cat-file -p ${blob}\``,
  ]);
});
// --- AC5 (POSIX): a non-UTF-8 untracked path ----------------------------------------------

test('AC5 Seam 1: a non-UTF-8 untracked path becomes a notIncluded entry in its \\xNN form', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  // A real tracked edit alongside the untracked non-UTF-8 path: an untracked path alone is
  // "clean" (nothing plannable), so `plan` would return `planId: null`/no run folder (same
  // rule as AC2's collapsed-directory case above).
  c.writeFile('a.txt', 'a2\n');
  const name = Buffer.from('b\xff.js', 'latin1');
  const filePath = Buffer.concat([Buffer.from(c.repoDir + path.sep), name]);
  try {
    fs.writeFileSync(filePath, 'x\n');
  } catch {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }
  if (!fs.readdirSync(c.repoDir, { encoding: 'buffer' }).some((entry) => entry.equals(name))) {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }

  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;

  const checked = await check(c, planId, runDir, {
    groups: [{ header: 'feat: x', body: null, files: ['a.txt'], hunks: [] }],
    notIncluded: [],
  });

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.deepEqual(checked.json.notIncluded, [
    { path: 'b\\xff.js', hunks: null, reason: 'path is not UTF-8 — commit by hand' },
  ]);
});
