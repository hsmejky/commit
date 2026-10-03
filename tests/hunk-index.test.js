'use strict';

// CHG-03 (docs/roadmap/07-change-set.md): M13 `renderHunks` (docs/spec/modules-m10-m13.md)
// renders snapshot units as the C:plan-hunks stdout shape plus the `hunks.txt` text, one
// `body: "file"` block per unit. Pure: it returns texts and M18 writes them through M12.
// `plan` prints `hunks` only once it has taken the lock (CHG-03b), so this is in-process.

const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { assertPureSource } = require('./helpers/assert-pure-source.js');
const { createCase } = require('./helpers/process-seam.js');

let hunkIndex;
let changeSet;

beforeEach(async () => {
  hunkIndex = await loadLib('hunk-index');
  changeSet = await loadLib('change-set');
});

const RUN_STATE = {
  runDir: 'C:/repo/.commit-plan/abc',
  mode: 'split',
  config: { values: { types: ['feat', 'fix'], maxSubjectLength: 72, scanIgnore: ['x/**'] } },
  recentSubjects: ['feat: add a thing'],
};

function unit(id, path, body, extra = {}) {
  return {
    id, path, oldPath: null, status: 'M', kind: 'text', hash: 'h', added: 1, deleted: 1,
    range: '-1 +1', body: Buffer.from(body), ...extra,
  };
}

// The block a Read with `offset`/`limit` would return for one entry.
function block(hunksTxt, entry) {
  return hunksTxt.split('\n').slice(entry.offset - 1, entry.offset - 1 + entry.lines);
}

test('renderHunks emits the C:plan-hunks shape for whole-file text units', () => {
  const units = [
    unit('h1', 'a.md', '@@ -1 +1 @@\n-x\n+y\n'),
    unit('h2', 'src/b.js', '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n', { range: '-1,3 +1,4' }),
  ];

  const { stdoutObj, hunksTxt } = hunkIndex.renderHunks(RUN_STATE, units);

  assert.deepEqual(stdoutObj, {
    version: 1,
    ok: true,
    runDir: 'C:/repo/.commit-plan/abc',
    mode: 'split',
    config: { types: ['feat', 'fix'], maxSubjectLength: 72 },
    recentSubjects: ['feat: add a thing'],
    counts: { units: 2, files: 2 },
    hunksFile: 'C:/repo/.commit-plan/abc/hunks.txt',
    hunks: [
      { id: 'h1', path: 'a.md', oldPath: null, status: 'M', kind: 'text', range: '-1 +1',
        lines: 4, offset: 1, body: 'file' },
      { id: 'h2', path: 'src/b.js', oldPath: null, status: 'M', kind: 'text', range: '-1,3 +1,4',
        lines: 7, offset: 5, body: 'file' },
    ],
    summaryOnly: [],
  });
  assert.equal(hunksTxt, [
    '### h1 M text -1 +1 a.md',
    '@@ -1 +1 @@', '-x', '+y',
    '### h2 M text -1,3 +1,4 src/b.js',
    '@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', ' three', '+four',
    '',
  ].join('\n'));
});

test('renderHunks decodes non-UTF-8 bytes lossily and keeps offsets on the ### lines', () => {
  const units = [
    unit('h1', 'l.txt', Buffer.concat([Buffer.from('@@ -1 +1 @@\n-caf'), Buffer.from([0xe9]), Buffer.from('\n+cafe\n')])),
    unit('h2', 'n.txt', '@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n'),
  ];

  const { stdoutObj, hunksTxt } = hunkIndex.renderHunks({ ...RUN_STATE, recentSubjects: undefined }, units);

  assert.deepEqual(stdoutObj.recentSubjects, []);
  assert.match(hunksTxt, /-caf\uFFFD\n/);
  for (const entry of stdoutObj.hunks) {
    const lines = block(hunksTxt, entry);
    assert.equal(lines[0], `### ${entry.id} M text -1 +1 ${entry.path}`);
    assert.equal(lines.length, entry.lines);
  }
  assert.equal(block(hunksTxt, stdoutObj.hunks[1])[3], '\\ No newline at end of file');
});

test('renderHunks over a real snapshot: h1 and h2 point at their ### blocks', async (t) => {
  const c = createCase(t);
  c.writeFile('a b/c.txt', 'old\n');
  c.writeFile('z.txt', '1\n2\n3\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a b/c.txt', 'new\n');
  c.writeFile('z.txt', '1\nTWO\n3\n');
  const units = changeSet.assignIds(await changeSet.snapshot({
    mode: 'split', storedLists: { candidates: [], stagedNew: [] },
    indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: () => 0,
  }));

  const { stdoutObj, hunksTxt } = hunkIndex.renderHunks(RUN_STATE, units);

  assert.deepEqual(stdoutObj.hunks.map((e) => [e.id, e.path, e.status, e.kind]), [
    ['h1', 'a b/c.txt', 'M', 'text'], ['h2', 'z.txt', 'M', 'text'],
  ]);
  for (const entry of stdoutObj.hunks) {
    const lines = block(hunksTxt, entry);
    assert.equal(lines[0], `### ${entry.id} M text ${entry.range} ${entry.path}`);
    assert.match(lines[1], /^@@ /);
    assert.equal(lines.length, entry.lines);
  }
});

test('hunk-index is pure', () => {
  assertPureSource('hunk-index');
});
