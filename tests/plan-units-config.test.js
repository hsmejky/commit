'use strict';

// CHG-07 (docs/roadmap/07-change-set.md): units are independent of the user's diff config,
// the working directory and path characters (Q11 pinned options, story 74); sparse-checkout
// / `skip-worktree` entries need no code of their own (docs/spec/other-repo-configurations.md,
// Q11 pass 9); a staged case-only `git mv` is one `R` unit on a case-sensitive filesystem
// and refused on a case-insensitive one (Q11, CHG-07 decision). Seam 1 only: each case runs
// `plan` and reads the hunk index and `state.json`, or its refusal.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`);
}

// Runs `plan` (from `cwd`, the repo by default) and returns its JSON reply, the hunk index,
// `state.json` and `plan.json`.
async function plan(c, cwd) {
  const result = await runCommit(c, ['plan'], cwd === undefined ? {} : { cwd });
  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    json: result.json,
    hunks: result.json.hunks.hunks,
    state: JSON.parse(read('state.json')),
    planJson: JSON.parse(read('plan.json')),
  };
}

// What a unit is: its path, kind, range and hash (the plan ID and run folder differ per run).
function units({ hunks, state }) {
  const hashes = Object.fromEntries(state.units.map((unit) => [unit.id, unit.hash]));
  return hunks.map(({ id, path: file, oldPath, status, kind, range }) => ({
    id, file, oldPath, status, kind, range, hash: hashes[id],
  }));
}

// Two edits 9 lines apart in `src/a.txt` (two units under `-U3`, one under
// `diff.interHunkContext=10`), one edit in `top.txt` outside `src/`, and a submodule-free
// tree, so every pinned option has something to change.
function fixture(c) {
  const lines = numbered(30);
  seed(c, { 'src/a.txt': lines.join(''), 'top.txt': 'top\n', 'data.bin.txt': 'x\n' });
  const edited = [...lines];
  edited[4] = 'five\n';
  edited[16] = 'seventeen\n';
  c.writeFile('src/a.txt', edited.join(''));
  c.writeFile('top.txt', 'TOP\n');
  c.writeFile('data.bin.txt', 'y\n');
}

test('user diff config and a subfolder working directory leave the units unchanged', async (t) => {
  const plain = createCase(t);
  fixture(plain);
  const baseline = units(await plan(plain));
  assert.deepEqual(baseline.map(({ file, range }) => [file, range]), [
    ['data.bin.txt', '-1 +1'], ['src/a.txt', '-2,7 +2,7'], ['src/a.txt', '-14,7 +14,7'], ['top.txt', '-1 +1'],
  ]);

  const c = createCase(t);
  fixture(c);
  // An external diff driver both as `diff.external` and through an attribute, and a
  // textconv on the same attribute: each would rewrite the patch text if not disabled.
  const driver = 'node -e "process.stdout.write(String.fromCharCode(66,79,79,77))"';
  for (const [key, value] of [
    ['diff.relative', 'true'], ['diff.interHunkContext', '10'], ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always'],
    ['diff.autoRefreshIndex', 'false'], ['diff.submodule', 'log'], ['diff.context', '10'],
    ['diff.algorithm', 'patience'], ['diff.indentHeuristic', 'false'], ['diff.renames', 'false'],
    ['diff.suppressBlankEmpty', 'true'], ['core.quotePath', 'true'],
    ['diff.external', driver], ['diff.boom.command', driver], ['diff.boom.textconv', 'node -e "0"'],
  ]) {
    c.git(['config', key, value]);
  }
  fs.writeFileSync(path.join(c.repoDir, '.git', 'info', 'attributes'), '*.txt diff=boom\n');

  // `diff.relative=true` with `plan` run from `src/`: `top.txt` outside it is still listed.
  assert.deepEqual(units(await plan(c, path.join(c.repoDir, 'src'))), baseline);
});

test('paths with brackets, a space and a quote are units with the literal path', async (t) => {
  const c = createCase(t);
  // Modified tracked files and untracked new ones (these go through `git add -N`, where
  // `[id]` would be a glob without literal pathspecs). `"` is not a valid file-name
  // character on Windows, so the double-quoted path is checked elsewhere only.
  seed(c, { '[id].tsx': 'a\n', 'i.tsx': 'i\n', 'with space.txt': 'b\n', "it's.txt": 'c\n' });
  for (const name of ['[id].tsx', 'with space.txt', "it's.txt"]) c.writeFile(name, 'changed\n');
  c.writeFile('new/[slug].tsx', 'n\n');
  const doubleQuote = process.platform !== 'win32';
  if (doubleQuote) c.writeFile('say "hi".txt', 'q\n');

  const { hunks } = await plan(c);

  assert.deepEqual(hunks.map(({ path: file, status }) => [file, status]), [
    ['[id].tsx', 'M'], ["it's.txt", 'M'], ['new/[slug].tsx', 'A'],
    ...(doubleQuote ? [['say "hi".txt', 'A']] : []), ['with space.txt', 'M'],
  ]);
});

// A staged case-only rename (CHG-07 decision, 2026-10-03; Q11). git sets `core.ignorecase`
// at `init` by probing the filesystem. On a case-insensitive one (Windows, macOS) the old
// path still exists for `lstat`, so the worktree diff against the temporary index never
// reports its deletion, and with `core.ignorecase=true` `git add -N` of the new path matches
// the old entry: the rename would give no unit at all. `plan` refuses instead (exit 6
// `state`, `case-rename`), naming each rename; on a case-sensitive filesystem with
// `core.ignorecase=false` it is one `R` unit.
const CASE_INSENSITIVE_FS = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-case-'));
  try {
    fs.writeFileSync(path.join(probe, 'a'), '');
    return fs.existsSync(path.join(probe, 'A'));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

function caseRenames(c, names) {
  seed(c, Object.fromEntries(names.map((name) => [name, `${name}\n`])));
  for (const name of names) c.git(['mv', name, name.toUpperCase()]);
}

async function assertCaseRenameRefusal(c, expected) {
  const result = await runCommit(c, ['plan']);
  const detail = `stdout ${result.stdout}\nstderr ${result.stderr}`;
  assert.equal(result.exitCode, 6, detail);
  assert.equal(result.json.ok, false, detail);
  assert.equal(result.json.error.kind, 'state', detail);
  assert.equal(result.json.error.message, 'cannot plan a staged case-only rename on a '
    + `case-insensitive filesystem or with core.ignorecase=true: ${expected}; commit the `
    + 'rename by hand, then run /commit again');
  // The provisional run folder is gone (an outcome that takes no lock).
  const runs = path.join(c.repoDir, '.commit-plan');
  assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], []);
}

test('a staged case-only git mv with core.ignorecase=true refuses, naming the rename', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.ignorecase', 'true']);
  caseRenames(c, ['readme.txt']);

  await assertCaseRenameRefusal(c, 'readme.txt → README.TXT');
});

test('the case-rename refusal names the first five renames and counts the rest', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.ignorecase', 'true']);
  caseRenames(c, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']);

  await assertCaseRenameRefusal(c, 'a.txt → A.TXT, b.txt → B.TXT, c.txt → C.TXT, '
    + 'd.txt → D.TXT, e.txt → E.TXT and 2 more');
});

test('a staged case-only git mv on a case-insensitive filesystem refuses even with core.ignorecase=false', {
  skip: !CASE_INSENSITIVE_FS && 'needs a case-insensitive filesystem',
}, async (t) => {
  const c = createCase(t);
  caseRenames(c, ['readme.txt']);
  c.git(['config', 'core.ignorecase', 'false']);

  await assertCaseRenameRefusal(c, 'readme.txt → README.TXT');
});

test('a staged case-only git mv on a case-sensitive filesystem is one R unit', {
  skip: CASE_INSENSITIVE_FS && 'needs a case-sensitive filesystem',
}, async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.ignorecase', 'false']);
  seed(c, { 'readme.txt': 'r\n' });
  c.git(['mv', 'readme.txt', 'README.txt']);

  const { hunks } = await plan(c);

  assert.deepEqual(hunks.map(({ path: file, oldPath, status }) => ({ file, oldPath, status })), [
    { file: 'README.txt', oldPath: 'readme.txt', status: 'R' },
  ]);
});

test('sparse-checkout and skip-worktree paths are never units', async (t) => {
  const c = createCase(t);
  seed(c, { 'inside/a.txt': 'a\n', 'outside/b.txt': 'b\n', 'kept.txt': 'k\n' });
  c.git(['sparse-checkout', 'set', '--cone', 'inside']);
  assert.equal(fs.existsSync(path.join(c.repoDir, 'outside', 'b.txt')), false);
  c.git(['update-index', '--skip-worktree', 'kept.txt']);
  fs.rmSync(path.join(c.repoDir, 'kept.txt'));
  c.writeFile('inside/a.txt', 'A\n');

  const { json, hunks, planJson } = await plan(c);

  assert.deepEqual(hunks.map(({ path: file, status }) => [file, status]), [['inside/a.txt', 'M']]);
  // Neither path is anywhere in the plan (the `notIncluded` half is asserted at commit time,
  // CHG-20).
  const text = JSON.stringify([json, planJson]);
  assert.doesNotMatch(text, /outside\/b\.txt/);
  assert.doesNotMatch(text, /kept\.txt/);
});
