'use strict';

// CHG-16 (docs/roadmap/07-change-set.md): `plan` runs M8 `scanUnits` over the snapshot's
// units, stores the scan map (`state.json` `scanned`, C:plan-hunks), carries `scan` per hunk
// index entry and withholds the whole body of a unit with a pattern hit (`body: "none"`, no
// `hunks.txt` block, Q10). M10 stops collecting a file's added lines at the 1 MB scan limit
// and flags every unit of that file `overScanLimit: true`, so M8 reports the path skipped
// even when each hunk alone stays under the limit. This file's own text holds no literal
// hit: tokens are built at run time.
//
// SCN-15 (docs/roadmap/05-scanner.md): the Seam 1 proof that `plan` wires this end to end —
// an untracked candidate over the 1 MB limit is reported `skipped` (not scanned) the same
// way a tracked file is, and the entry point's `osUser` derivation (FND-10's fault preload
// making `os.userInfo()` throw, with `USER` and `USERNAME` cleared) still lets `plan`
// complete with `osUser: null`: the OS-user segment check then finds nothing, while
// `local-path`'s fixed shapes (Q10) still fire. "Cleared" means set to the empty string, not
// left unset: on Windows, libuv re-inserts `USERNAME` into every spawned child regardless
// (tests/process-seam.test.js), and commit.cjs:38-44 treats an empty value the same as unset.
//
// SCN-16 (docs/roadmap/05-scanner.md): the Seam 1 proof that `plan` reads what history would
// get, not what the working tree shows on its face — an attribute-hidden text file (`-diff`
// or `binary`, CHG-11's `--text` pass, tests/change-set-attribute-hidden.test.js already
// covers the `-diff` half through `plan`) and a brand-new symlink (CHG-09, the target scanned
// as an added line) both reach `scan.hits`, and a `GIT_ATTR_SOURCE` decoy exported pointing
// at a tree with no hiding attribute does not change the result: `run`'s GIT_* hygiene
// (GIT-05) strips every inherited `GIT_*` outside the keep-set before any git call runs, so
// the decoy never reaches `check-attr` in the first place.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;

let changeSet;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

const NOW = () => Date.UTC(2026, 0, 1);
const LIMIT = 1048576;
const SKIP_REASON = 'added content over 1 MB';

// A `ghp_` token built at run time (see tests/scanner.test.js).
function githubToken(fill) {
  return 'gh' + 'p_' + fill.repeat(36);
}

function tokenLine(fill) {
  return `const token = "${githubToken(fill)}";\n`;
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function numbered(count, prefix = 'keep') {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

// Added lines whose content (raw bytes plus one per `\n`) totals exactly `bytes`, a token
// line first, then 1024-byte filler lines and one shorter last line.
function addedContent(bytes, fill) {
  const lines = [tokenLine(fill)];
  let rest = bytes - lines[0].length;
  while (rest >= 1024) {
    lines.push(`${'x'.repeat(1023)}\n`);
    rest -= 1024;
  }
  if (rest > 0) lines.push(`${'y'.repeat(rest - 1)}\n`);
  const text = lines.join('');
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

async function plan(c, options = {}) {
  const result = await runCommit(c, ['plan'], options);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    stdout: result.stdout,
    hunks: result.json.hunks.hunks,
    summaryOnly: result.json.hunks.summaryOnly,
    state: JSON.parse(read('state.json')),
    planJson: JSON.parse(read('plan.json')),
    hunksTxt: read('hunks.txt'),
    runDir,
  };
}

function snapshot(c, tracked) {
  return changeSet.snapshot({
    mode: 'split', storedLists: { candidates: [], stagedNew: [] }, tracked,
    indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

test('a hunk with a github-token loses its body; the file\'s other hunk keeps its block', async (t) => {
  const c = createCase(t);
  const lines = numbered(30);
  seed(c, { 'src/config.js': lines });
  const edited = lines.split('\n');
  edited[1] = 'changed two';
  edited[25] = tokenLine('a').trimEnd();
  c.writeFile('src/config.js', edited.join('\n'));
  const token = githubToken('a');

  const { stdout, hunks, state, planJson, hunksTxt, runDir } = await plan(c);

  assert.equal(hunks.length, 2);
  const [clean, hit] = hunks;
  assert.equal(clean.body, 'file');
  assert.equal(Object.hasOwn(clean, 'scan'), false);
  assert.equal(typeof clean.offset, 'number');
  assert.deepEqual(
    { scan: hit.scan, body: hit.body, offset: hit.offset, lines: hit.lines },
    { scan: ['github-token'], body: 'none', offset: null, lines: null },
  );
  assert.deepEqual(state.scanned, { [hit.id]: ['github-token'] });
  assert.deepEqual(planJson.scan, {
    hits: [{ path: 'src/config.js', line: 26, pattern: 'github-token' }],
    skipped: [],
    scanIgnoreChanged: false,
  });
  assert.match(hunksTxt, /changed two/);
  assert.equal(hunksTxt.includes(`### ${hit.id} `), false);
  assert.equal(stdout.includes(token), false, 'stdout holds the token');
  // AC1: the token is absent from every file the run folder holds, not just the fixed set
  // (hunks.txt, plan.json, state.json) — a future file such as hunks.json on budget overflow
  // is covered too. Read as bytes, not text: `git-index` is binary.
  for (const name of fs.readdirSync(runDir)) {
    const bytes = fs.readFileSync(path.join(runDir, name));
    assert.equal(bytes.includes(token), false, `${name} holds the token`);
  }
});

test('a scanIgnore\'d path keeps its body and its unit: no hit, no scanned entry', async (t) => {
  const c = createCase(t);
  seed(c, { 'README.md': 'readme\n' });
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: ['ignored/**'] }));
  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'config']);
  const token = githubToken('f');
  c.writeFile('ignored/secrets.js', `const visible = 1;\n${tokenLine('f')}`);

  const { hunks, state, planJson, hunksTxt, stdout } = await plan(c);

  const entry = hunks.find((h) => h.path === 'ignored/secrets.js');
  assert.equal(Object.hasOwn(entry, 'scan'), false);
  assert.equal(entry.body, 'file');
  assert.equal(Object.hasOwn(state.scanned, entry.id), false);
  assert.deepEqual(planJson.scan, { hits: [], skipped: [], scanIgnoreChanged: false });
  assert.match(hunksTxt, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(stdout.includes(token), false, 'stdout holds the token');
});

// AC (macOS/Windows runner, case-insensitive FS, but runs and holds on every OS): matching is
// case-sensitive at the pattern level (M7 `matches`, tests/glob-matcher.test.js:27), not a
// property of the filesystem, so a case-insensitive FS finding the same file under either
// spelling does not make `DIST/**` exempt `dist/k.txt`.
test('a scanIgnore pattern differing in case from the path does not exempt a hit', async (t) => {
  const c = createCase(t);
  seed(c, { 'README.md': 'readme\n' });
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: ['DIST/**'] }));
  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'config']);
  c.writeFile('dist/k.txt', tokenLine('k'));

  const { planJson } = await plan(c);

  assert.deepEqual(planJson.scan, {
    hits: [{ path: 'dist/k.txt', line: 1, pattern: 'github-token' }],
    skipped: [],
    scanIgnoreChanged: false,
  });
});

test('a new file with a hit loses its whole body', async (t) => {
  const c = createCase(t);
  seed(c, { 'README.md': 'readme\n' });
  c.writeFile('secrets.js', `const visible = 1;\n${tokenLine('b')}const after = 2;\n`);

  const { hunks, state, hunksTxt } = await plan(c);

  const entry = hunks.find((h) => h.path === 'secrets.js');
  assert.deepEqual(
    { scan: entry.scan, body: entry.body, offset: entry.offset, lines: entry.lines },
    { scan: ['github-token'], body: 'none', offset: null, lines: null },
  );
  assert.deepEqual(state.scanned, { [entry.id]: ['github-token'] });
  assert.equal(hunksTxt.includes('secrets.js'), false);
  assert.equal(hunksTxt.includes('const visible'), false);
  assert.equal(hunksTxt.includes(githubToken('b')), false);
});

// CHG-17: a file with over 1 MB of added content is always summary-only too (over 1000 lines
// or 256 KB), so its two hunk units fold into one whole-file unit, which still carries the
// flag the per-file limit set across both hunks.
test('two ~600 KB hunks of one file, over 1 MB together: the folded unit is flagged, path skipped once, no hit', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'data/big.txt': lines });
  const kept = lines.split('\n');
  const first = addedContent(600 * 1024, 'c');
  const second = addedContent(600 * 1024, 'd');
  c.writeFile('data/big.txt', `${kept[0]}\n${first}${kept.slice(1, 19).join('\n')}\n${second}${kept[19]}\n`);

  const units = await snapshot(c, ['data/big.txt']);
  assert.deepEqual(units.map((u) => [u.summaryOnly, u.overScanLimit, u.addedLines.length]), [['lines', true, 0]]);

  const { hunks, summaryOnly, state, planJson } = await plan(c);
  assert.deepEqual(hunks, []);
  assert.deepEqual(summaryOnly.map((h) => [h.reason, h.scan]), [['lines', 'skipped']]);
  assert.deepEqual(state.scanned, { [summaryOnly[0].id]: 'skipped' });
  assert.deepEqual(planJson.scan.skipped, [{ path: 'data/big.txt', reason: SKIP_REASON }]);
  assert.deepEqual(planJson.scan.hits, []);
});

test('plan --reword runs no content scan (Q20): HEAD\'s own token stays, no hits, no scanned entry', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  const token = githubToken('g');
  c.writeFile('a.txt', `${tokenLine('g')}`);
  c.git(['commit', '-q', '-am', 'fix: reword me']);

  const result = await runCommit(c, ['plan', '--reword']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.mode, 'reword');
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const planJson = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
  const hunksTxt = fs.readFileSync(path.join(runDir, 'hunks.txt'), 'utf8');
  assert.deepEqual(planJson.scan, { hits: [], skipped: [], scanIgnoreChanged: false });
  assert.deepEqual(state.scanned, {});
  assert.match(hunksTxt, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('added content of exactly 1,048,576 bytes is scanned; one byte more is flagged and skipped', async (t) => {
  for (const [bytes, flagged] of [[LIMIT, false], [LIMIT + 1, true]]) {
    await t.test(`${bytes} bytes`, async (st) => {
      const c = createCase(st);
      seed(c, { 'edge.txt': 'seed\n' });
      c.writeFile('edge.txt', `seed\n${addedContent(bytes, 'e')}`);

      const units = await snapshot(c, ['edge.txt']);
      assert.equal(units.length, 1);
      assert.equal(units[0].overScanLimit === true, flagged);
      if (!flagged) assert.equal(units[0].addedLines.length, units[0].added);

      const { planJson } = await plan(c);
      if (flagged) {
        assert.deepEqual(planJson.scan.skipped, [{ path: 'edge.txt', reason: SKIP_REASON }]);
        assert.deepEqual(planJson.scan.hits, []);
      } else {
        assert.deepEqual(planJson.scan.skipped, []);
        assert.deepEqual(planJson.scan.hits, [{ path: 'edge.txt', line: 2, pattern: 'github-token' }]);
      }
    });
  }
});

// SCN-15 AC2: a 2 MB untracked candidate is reported skipped, not scanned — the same rule a
// tracked file gets (the two tests above), proved here through a brand-new, never-added
// file (C:plan `scan.skipped`). Unlike a pattern hit, a skipped file "may be included"
// (Q10's table), so it still reaches the index (CHG-17: as a `size` summary-only entry, so
// without a block); only `scan.hits` and `scan.skipped` themselves never carry a matched value.
test('a 2 MB untracked candidate is reported skipped, not scanned', async (t) => {
  const c = createCase(t);
  seed(c, { 'README.md': 'readme\n' });
  c.writeFile('new/big-secret.txt', addedContent(2 * 1024 * 1024, 'h'));

  const { summaryOnly, state, planJson } = await plan(c);

  assert.deepEqual(planJson.scan.skipped, [{ path: 'new/big-secret.txt', reason: SKIP_REASON }]);
  assert.deepEqual(planJson.scan.hits, []);
  const entry = summaryOnly.find((h) => h.path === 'new/big-secret.txt');
  assert.equal(entry.scan, 'skipped');
  assert.equal(state.scanned[entry.id], 'skipped');
});

// SCN-15 AC3: the fault preload (FND-10) makes `os.userInfo()` throw. On Windows, libuv
// re-inserts `USERNAME` into every spawned child regardless of the harness's own env
// (tests/process-seam.test.js), so reaching the entry point's fallback chain with no usable
// `USER`/`USERNAME` requires passing both as the empty string: commit.cjs:38-44 treats `''`
// the same as unset (`||` falls through). With that, `plan` still completes (it does not
// throw or refuse `internal`), `local-path`'s fixed shapes (independent of `osUser`) still
// fire, and the OS-user segment rule (which only ever fires when `osUserSegment` is
// non-null) finds nothing. A second, control run sets `USERNAME` to a real-looking name and
// expects a second hit on the line whose path segment matches it, proving the segment rule
// is live and that `osUser: null` (not some other non-matching value) is what silenced it on
// the first run.
test('SCN-15: osUser null (fault, USER/USERNAME cleared) skips the OS-user-segment hit; a USERNAME control proves the segment rule fires', async (t) => {
  // Built at run time, not a literal, so this file holds no fixed-shape local-path text of
  // its own (see tests/scanner.test.js's same trick) — the privacy guard scans test sources.
  const fixedPathLiteral = 'C:' + '\\Users\\charlie\\notes.txt';
  const paths = [
    `const fixed = "${fixedPathLiteral}";`,
    'const other = "data/zz9plural/export.csv";',
    '',
  ].join('\n');

  const nullCase = createCase(t);
  seed(nullCase, { 'README.md': 'readme\n' });
  nullCase.writeFile('src/paths.js', paths);
  const nullRun = await plan(nullCase, {
    nodeArgs: ['--import', PRELOAD],
    env: { COMMIT_TEST_FAULT_USERINFO: '1', USER: '', USERNAME: '' },
  });
  assert.deepEqual(nullRun.planJson.scan.hits, [
    { path: 'src/paths.js', line: 1, pattern: 'local-path' },
  ]);

  const controlCase = createCase(t);
  seed(controlCase, { 'README.md': 'readme\n' });
  controlCase.writeFile('src/paths.js', paths);
  const controlRun = await plan(controlCase, {
    nodeArgs: ['--import', PRELOAD],
    env: { COMMIT_TEST_FAULT_USERINFO: '1', USERNAME: 'zz9plural' },
  });
  assert.deepEqual(controlRun.planJson.scan.hits, [
    { path: 'src/paths.js', line: 1, pattern: 'local-path' },
    { path: 'src/paths.js', line: 2, pattern: 'local-path' },
  ]);
});

const NO_SYMLINKS = process.platform === 'win32' && 'no symlinks without privileges';

// SCN-16 AC1 (second half): the `-diff` half already reaches `plan`'s scan in
// tests/change-set-attribute-hidden.test.js; this is the `binary`-attributed half. (The
// macro also unsets `diff`, so this exercises change-set.mjs's `diff`-unset hiding branch
// alongside the `binary`-set one; review-SCN-16 Low finding: the `binary`-set branch alone
// has no reachable unit test — `x.bin binary diff` resolves to `diff: set`, and `x.bin binary
// !diff` to `diff: unspecified`, both verified live with `git check-attr`, and in either case
// git's own main diff pass never renders the no-NUL content as binary, so the hiding branch
// never runs; a real NUL byte would make the independent content resniff in
// `resolveHiddenBinaries` keep it binary regardless of the attribute flag. No standalone test
// is added for that line; it is redundant by construction given the `diff`-unset check above.)
test('plan: a secret added to a binary-attributed text file is found by the scan', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('.gitattributes', 'x.bin binary\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.bin', `one\n${tokenLine('m')}`);

  const { hunks, planJson } = await plan(c);

  const entry = hunks.find((h) => h.path === 'x.bin');
  assert.equal(entry.kind, 'text');
  assert.equal(entry.body, 'none');
  assert.deepEqual(planJson.scan.hits, [{ path: 'x.bin', line: 2, pattern: 'github-token' }]);
});

// SCN-16 AC2: a brand-new symlink is picked up as an untracked candidate (no `git add`
// needed, same as a plain new file above) and its target is scanned as one added line
// (Q11), so a home-path target is a `local-path` hit on that unit. Skipped on every
// Windows run (no symlink privilege without one); proven on the ubuntu and macOS CI jobs
// and the git-2.34 container instead — confirm green there before closing this AC.
test('plan: a new symlink whose target is a home path hits local-path', { skip: NO_SYMLINKS }, async (t) => {
  const c = createCase(t);
  seed(c, { 'README.md': 'readme\n' });
  // Built at run time (split across a concatenation), so this file holds no fixed-shape
  // local-path text of its own (see tests/scanner.test.js's same trick) — the privacy guard
  // scans test sources.
  const homeTarget = '/Users/' + 'charlie/secret.txt';
  fs.symlinkSync(homeTarget, path.join(c.repoDir, 'link'));

  const { hunks, planJson } = await plan(c);

  const entry = hunks.find((h) => h.path === 'link');
  assert.equal(entry.kind, 'symlink');
  assert.deepEqual(planJson.scan.hits, [{ path: 'link', line: 1, pattern: 'local-path' }]);
});

// SCN-16 AC3: a GIT_ATTR_SOURCE decoy exported pointing at the seed commit, whose tree has
// no .gitattributes at all, must not stop the hidden file from being recognised and read as
// text: `run`'s GIT_* hygiene (GIT-05) strips every inherited `GIT_*` outside the keep-set
// before any git call runs, so the decoy never reaches `check-attr` in the first place
// (mirrors the `filter` decoy of tests/change-set-filtered.test.js's GIT-05, for the
// `diff`/`binary` hiding attributes instead). A second, secret-free `-diff` file (`y.bin`)
// pins the hiding itself rather than just the secret's own body suppression: any hunk with a
// scan hit loses its body regardless, so that alone cannot tell an honored decoy from a
// stripped one (review-SCN-16 High finding) — the plain file is what flips from `body: 'none'`
// to `body: 'file'` if the decoy were honored. On the git-2.34 CI job `GIT_ATTR_SOURCE` does
// not exist (git >= 2.40), so this test is a no-op there. A kept `GIT_CONFIG_GLOBAL` file's
// `attr.tree` (git >= 2.42) is another attribute-source decoy that is not stripped, but every
// call including `git commit` honors it consistently, so no scan miss is expected from it.
test('plan: a GIT_ATTR_SOURCE decoy pointing at an attribute-free tree does not change the hidden-file hit', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.writeFile('y.bin', 'one\n');
  c.git(['add', 'x.bin', 'y.bin']);
  c.git(['commit', '-q', '-m', 'seed']);
  const noAttrHead = c.git(['rev-parse', 'HEAD']).trim();
  c.writeFile('.gitattributes', 'x.bin -diff\ny.bin -diff\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.bin', `one\n${tokenLine('q')}`);
  c.writeFile('y.bin', 'one\ntwo\n');

  const { hunks, planJson } = await plan(c, { env: { GIT_ATTR_SOURCE: noAttrHead } });

  const secretEntry = hunks.find((h) => h.path === 'x.bin');
  assert.equal(secretEntry.kind, 'text');
  assert.equal(secretEntry.body, 'none');
  const plainEntry = hunks.find((h) => h.path === 'y.bin');
  assert.equal(plainEntry.kind, 'text');
  assert.equal(plainEntry.body, 'none');
  assert.deepEqual(planJson.scan.hits, [{ path: 'x.bin', line: 2, pattern: 'github-token' }]);
});
