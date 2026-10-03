'use strict';

// CHG-10 (docs/roadmap/07-change-set.md): one `check-attr --stdin -z` call querying `filter`
// and `linguist-generated` together (Q11). A path with a `filter` attribute becomes a
// whole-file `filtered` unit, hashed and scanned in its cleaned form (`body: "none"` when
// that cleaned diff is binary, C:plan-hunks); `linguist-generated` is carried on every unit
// as `generated` (wiring it into `plan`'s `summaryOnly` output is CHG-17's job, not this
// slice's). `snapshot`'s `tracked` paths are required (review-CHG-10 finding 2: the
// executor's re-snapshot once passed none, so a filtered file never matched `plan`'s unit).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let changeSet;
let hunkIndex;
let pathClassifier;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
  hunkIndex = await loadLib('hunk-index');
  pathClassifier = await loadLib('path-classifier');
});

const NOW = () => Date.UTC(2026, 0, 1);

const RUN_STATE = {
  runDir: 'C:/repo/.commit-plan/abc',
  mode: 'split',
  config: { values: { types: ['feat', 'fix'], maxSubjectLength: 72, scanIgnore: [] } },
  recentSubjects: [],
};

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function snapshot(c, { tracked = [], candidates = [], stagedNew = [] } = {}) {
  return changeSet.snapshot({
    mode: 'split', storedLists: { candidates, stagedNew }, tracked, indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

// A `sed`-based clean filter named `redact` (`secret` -> `REDACTED`), wired to
// `x.dat filter=redact` in `.gitattributes`.
function redactFilter(c) {
  c.git(['config', 'filter.redact.clean', 'sed s/secret/REDACTED/']);
  c.writeFile('.gitattributes', 'x.dat filter=redact\n');
}

test('a filter-attributed modified file is one filtered unit whose body is the cleaned diff', async (t) => {
  const c = createCase(t);
  c.writeFile('x.dat', 'one\ntwo\n');
  c.git(['add', 'x.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  redactFilter(c);
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.dat', 'one\nsecret\n');

  const units = await snapshot(c, { tracked: ['x.dat'] });
  assert.equal(units.length, 1);
  const [unit] = units;
  assert.equal(unit.path, 'x.dat');
  assert.equal(unit.status, 'M');
  assert.equal(unit.kind, 'filtered');
  const bodyText = unit.body.toString('utf8');
  assert.match(bodyText, /REDACTED/);
  assert.doesNotMatch(bodyText, /secret/);

  // Q11: the hash is a plain sha256 hex digest, stable across repeated snapshots (same
  // formula as a plain text/mode/binary whole-file unit; CHG-10 only changes the label).
  assert.match(unit.hash, /^[0-9a-f]{64}$/);
  const again = await snapshot(c, { tracked: ['x.dat'] });
  assert.equal(again[0].hash, unit.hash);
  assert.equal(unit.identityKey, unit.hash);
});

test('linguist-generated is carried as generated on every resulting unit; an unmarked file defaults to false', async (t) => {
  const c = createCase(t);
  c.writeFile('gen.txt', 'one\n');
  c.writeFile('other.txt', 'a\n');
  c.git(['add', 'gen.txt', 'other.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.gitattributes', 'gen.txt linguist-generated\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('gen.txt', 'one\ntwo\n');
  c.writeFile('other.txt', 'a\nb\n');

  const units = await snapshot(c, { tracked: ['gen.txt', 'other.txt'] });
  const gen = units.find((u) => u.path === 'gen.txt');
  const other = units.find((u) => u.path === 'other.txt');
  assert.ok(gen, 'gen.txt unit missing');
  assert.ok(other, 'other.txt unit missing');
  assert.equal(gen.generated, true);
  assert.equal(other.generated, false);
});

test('a decoy GIT_ATTR_SOURCE does not stop check-attr from reading the real .gitattributes (GIT-05)', async (t) => {
  const c = createCase(t);
  c.writeFile('x.dat', 'one\ntwo\n');
  c.git(['add', 'x.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  // The seed commit's tree has no .gitattributes at all, so a GIT_ATTR_SOURCE pointing at it
  // would, if honoured, see x.dat as unfiltered.
  const seedHead = c.git(['rev-parse', 'HEAD']).trim();
  redactFilter(c);
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.dat', 'one\nsecret\n');

  const units = await changeSet.snapshot({
    mode: 'split',
    storedLists: { candidates: [], stagedNew: [] },
    tracked: ['x.dat'],
    indexPath: path.join(c.root, 'git-index'),
    unborn: false,
    toplevel: c.repoDir,
    env: { ...c.env, GIT_ATTR_SOURCE: seedHead },
    now: NOW,
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'filtered');
  assert.match(units[0].body.toString('utf8'), /REDACTED/);
});

test('renderHunks gives a filtered unit whose cleaned form is binary no block (CHG-10, C:plan-hunks body none)', () => {
  const binaryFiltered = {
    id: 'h1', path: 'x.dat', oldPath: null, status: 'M', kind: 'filtered', hash: 'h',
    added: 0, deleted: 0, range: '-0,0 +0,0', body: Buffer.alloc(0), generated: false, binary: true,
  };
  const text = {
    id: 'h2', path: 'a.md', oldPath: null, status: 'M', kind: 'text', hash: 'h',
    added: 1, deleted: 1, range: '-1 +1', body: Buffer.from('@@ -1 +1 @@\n-x\n+y\n'), generated: false,
  };

  const { stdoutObj, hunksTxt } = hunkIndex.renderHunks(RUN_STATE, [binaryFiltered, text]);

  assert.deepEqual(stdoutObj.hunks[0], {
    id: 'h1', path: 'x.dat', oldPath: null, status: 'M', kind: 'filtered', range: '-0,0 +0,0',
    lines: null, offset: null, body: 'none',
  });
  assert.equal(stdoutObj.hunks[1].offset, 1);
  assert.equal(hunksTxt, '### h2 M text -1 +1 a.md\n@@ -1 +1 @@\n-x\n+y\n');
});

// Confirms the Q11 hash formula directly: a filtered M-status unit hashes like a plain
// text/mode/binary whole-file unit (status, path, then only its `-`/`+` lines), not like
// the per-hunk text path.
test('a filtered unit hashes the whole-file way: status, path, then its -/+ lines', async (t) => {
  const c = createCase(t);
  c.writeFile('x.dat', 'same\nold\n');
  c.git(['add', 'x.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  redactFilter(c);
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.dat', 'same\nnew\n');

  const [unit] = await snapshot(c, { tracked: ['x.dat'] });
  assert.equal(unit.kind, 'filtered');
  assert.equal(unit.hash, sha256('M\0x.dat\0-old\n+new\n'));
});

// review-CHG-10 finding 2: `plan` and the executor's re-snapshot must give a modified
// tracked filtered file the same unit, or `matchIds` refuses it and the file can never be
// committed.
test('plan then commit of a modified tracked filtered file → committed in its cleaned form', async (t) => {
  const c = createCase(t);
  c.writeFile('x.dat', 'one\n');
  c.git(['add', 'x.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  redactFilter(c);
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.dat', 'one\nsecret\n');

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, planned.stderr);
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1, units: state.units.map((unit) => unit.id), header: 'fix: redact x', body: '', committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  assert.equal(c.git(['show', 'HEAD:x.dat']), 'one\nREDACTED\n');
});

test('snapshot without its tracked paths throws instead of skipping their attributes', async (t) => {
  const c = createCase(t);
  await assert.rejects(
    changeSet.snapshot({
      mode: 'split', storedLists: { candidates: [], stagedNew: [] }, indexPath: path.join(c.root, 'git-index'),
      unborn: false, toplevel: c.repoDir, env: c.env, now: NOW,
    }),
    /tracked paths/,
  );
});

// review-CHG-10 finding 3: `=true` is the form GitHub's docs show; Linguist reads it like
// the bare form.
test('linguist-generated=true is carried as generated, like the bare form', async (t) => {
  const c = createCase(t);
  c.writeFile('y.txt', 'one\n');
  c.git(['add', 'y.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.gitattributes', 'y.txt linguist-generated=true\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('y.txt', 'one\ntwo\n');

  const [unit] = await snapshot(c, { tracked: ['y.txt'] });
  assert.equal(unit.path, 'y.txt');
  assert.equal(unit.generated, true);
});

// review-CHG-10 finding 5: the unit's `generated` feeds M9 `summaryOnly` as its stat.
test('a linguist-generated unit gives summaryOnly reason generated', async (t) => {
  const c = createCase(t);
  c.writeFile('gen.txt', 'one\n');
  c.git(['add', 'gen.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.gitattributes', 'gen.txt linguist-generated\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('gen.txt', 'one\ntwo\n');

  const [unit] = await snapshot(c, { tracked: ['gen.txt'] });
  const stats = { added: unit.added, deleted: unit.deleted, generated: unit.generated, size: 8 };
  assert.equal(pathClassifier.summaryOnly(unit.path, stats), 'generated');
});

// review-CHG-10 finding 7: a clean filter emitting a NUL byte makes the cleaned diff binary.
test('a filtered file whose cleaned form is binary → empty body, hashed by its blob IDs', async (t) => {
  const c = createCase(t);
  c.writeFile('x.bin', 'one\n');
  c.git(['add', 'x.bin']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'filter.nul.clean', "printf 'a\\000b'"]);
  c.writeFile('.gitattributes', 'x.bin filter=nul\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('x.bin', 'two\n');
  const oldBlob = c.git(['rev-parse', 'HEAD:x.bin']).trim();
  const newBlob = c.git(['hash-object', 'x.bin']).trim();

  const [unit] = await snapshot(c, { tracked: ['x.bin'] });
  assert.equal(unit.kind, 'filtered');
  assert.equal(unit.binary, true);
  assert.equal(unit.body.length, 0);
  assert.equal(unit.hash, sha256(`M\0x.bin\0blob ${oldBlob} ${newBlob}\0`));
});

// review-CHG-10 finding 7: an untracked candidate with a filter attribute.
test('a new filtered candidate is one filtered A unit over its cleaned content', async (t) => {
  const c = createCase(t);
  c.writeFile('seed.txt', 'seed\n');
  redactFilter(c);
  c.git(['add', 'seed.txt', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('x.dat', 'secret\n');

  const [unit] = await snapshot(c, { candidates: ['x.dat'] });
  assert.equal(unit.path, 'x.dat');
  assert.equal(unit.status, 'A');
  assert.equal(unit.kind, 'filtered');
  assert.equal(unit.hash, sha256('A\0x.dat\0+REDACTED\n'));
});

// review-CHG-10 finding 6: a path an argv or line-mode call would misread (a leading dash,
// a space) still gets its attribute, so the paths reach check-attr NUL-separated on stdin.
test('a path with a leading dash and a space is still found filtered (paths on stdin, -z)', async (t) => {
  const c = createCase(t);
  c.writeFile('-x y.dat', 'one\n');
  c.git(['add', '--', '-x y.dat']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.git(['config', 'filter.redact.clean', 'sed s/secret/REDACTED/']);
  c.writeFile('.gitattributes', '-x*.dat filter=redact\n');
  c.git(['add', '.gitattributes']);
  c.git(['commit', '-q', '-m', 'attr']);
  c.writeFile('-x y.dat', 'one\nsecret\n');

  const [unit] = await snapshot(c, { tracked: ['-x y.dat'] });
  assert.equal(unit.path, '-x y.dat');
  assert.equal(unit.kind, 'filtered');
});

// review-CHG-10 finding 9: only a binary cleaned form drops the block; an empty filtered
// new file still gets one, like the same text unit.
test('renderHunks gives an empty, non-binary filtered unit a block', () => {
  const empty = {
    id: 'h1', path: 'e.dat', oldPath: null, status: 'A', kind: 'filtered', hash: 'h',
    added: 0, deleted: 0, range: '-0,0 +0,0', body: Buffer.alloc(0), generated: false, binary: false,
  };

  const { stdoutObj } = hunkIndex.renderHunks(RUN_STATE, [empty]);

  assert.notEqual(stdoutObj.hunks[0].body, 'none');
});
