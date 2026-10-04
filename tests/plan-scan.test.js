'use strict';

// CHG-16 (docs/roadmap/07-change-set.md): `plan` runs M8 `scanUnits` over the snapshot's
// units, stores the scan map (`state.json` `scanned`, C:plan-hunks), carries `scan` per hunk
// index entry and withholds the whole body of a unit with a pattern hit (`body: "none"`, no
// `hunks.txt` block, Q10). M10 stops collecting a file's added lines at the 1 MB scan limit
// and flags every unit of that file `overScanLimit: true`, so M8 reports the path skipped
// even when each hunk alone stays under the limit. This file's own text holds no literal
// hit: tokens are built at run time.

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

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

async function plan(c) {
  const result = await runCommit(c, ['plan']);
  assert.equal(result.exitCode, 0, detail(result));
  const runDir = path.join(c.repoDir, '.commit-plan', result.json.planId);
  const read = (name) => fs.readFileSync(path.join(runDir, name), 'utf8');
  return {
    stdout: result.stdout,
    hunks: result.json.hunks.hunks,
    state: JSON.parse(read('state.json')),
    planJson: JSON.parse(read('plan.json')),
    hunksTxt: read('hunks.txt'),
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

  const { stdout, hunks, state, planJson, hunksTxt } = await plan(c);

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
  assert.equal(hunksTxt.includes(token), false, 'hunks.txt holds the token');
  assert.equal(stdout.includes(token), false, 'stdout holds the token');
  assert.equal(JSON.stringify(planJson).includes(token), false, 'plan.json holds the token');
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

test('two ~600 KB hunks of one file, over 1 MB together: both units flagged, path skipped once, no hit', async (t) => {
  const c = createCase(t);
  const lines = numbered(20);
  seed(c, { 'data/big.txt': lines });
  const kept = lines.split('\n');
  const first = addedContent(600 * 1024, 'c');
  const second = addedContent(600 * 1024, 'd');
  c.writeFile('data/big.txt', `${kept[0]}\n${first}${kept.slice(1, 19).join('\n')}\n${second}${kept[19]}\n`);

  const units = await snapshot(c, ['data/big.txt']);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((u) => u.overScanLimit), [true, true]);

  const { hunks, state, planJson } = await plan(c);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks.map((h) => h.scan), ['skipped', 'skipped']);
  assert.deepEqual(state.scanned, { [hunks[0].id]: 'skipped', [hunks[1].id]: 'skipped' });
  assert.deepEqual(planJson.scan.skipped, [{ path: 'data/big.txt', reason: SKIP_REASON }]);
  assert.deepEqual(planJson.scan.hits, []);
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
