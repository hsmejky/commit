'use strict';

// PLN-07 (docs/roadmap/08-plan-validation.md): `check` stores a per-group `attribution`
// flag (Q20) alongside the normalised message (plan-message-lint.test.js covers that half).
// `false` whenever the run's resolved attribution trailer is `null`, regardless of mode;
// otherwise always `true` in `split`/`staged` (the worker always writes the message there),
// and in `reword` only when the worker wrote the new message (`source` is `worker`, the
// default when absent) or the old message already carried an attribution trailer
// (M6 `hadAttributionTrailer`). MSG-08 is the only module that reads this flag to decide
// whether `commit` actually appends the trailer; this file only covers what `check` stores.
//
// AC1 (split, below) runs through a real Seam-1 `check`. MSG-08's own tests
// (tests/commit-all-reword.test.js) now rebuild the `reword` cases at Seam 1 too, reading the
// committed message's trailer as the oracle instead of the stored flag (KD-R95, narrowed).
// The `staged` case below is Seam 1 too (INT-09, KD-R95): a size-skipped file makes `check`
// stop at a `confirm` handback with the run kept, so its stored flag is readable.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');


function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

// --- AC1: a resolved-null attribution stores `false` on every group -----------------------
//
// Real Seam 1: `attribution.commit: ""` in the user settings layer resolves the run's
// trailer to `null` (plan-attribution.test.js covers that resolution itself); a hunk-level
// worker plan (one hunk ID per group, rather than a whole `files` path) makes two groups, so
// `check` stops at the `confirm` handback ("2 groups") without committing, so the run folder is kept and `state.json`'s stored groups can be
// read back without ever committing for real (same technique as PLN-03's
// tests/plan-hunk-level.test.js).

function writeUserSettings(c, value) {
  fs.writeFileSync(path.join(c.claudeHome, 'settings.json'), JSON.stringify(value));
}

test('Seam 1: attribution resolved to null stores attribution: false on every group', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n', 'b.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: '' } });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'one\nmore\n');

  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [
      { header: 'feat: a', body: null, files: [], hunks: ['h1'] },
      { header: 'feat: b', body: null, files: [], hunks: ['h2'] },
    ],
    notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  // Nothing committed (INT-02: a hunk-level plan stops at its validated groups).
  assert.equal(checked.json.commits, undefined);
  const state = readState(runDir);
  assert.deepEqual(state.groups.map((g) => g.attribution), [false, false]);
});

// --- `staged`: attribution always applies when a trailer is resolved -----------------------

// Real Seam 1 (KD-R95, INT-09): a `staged` run with a size-skipped file gets a `confirm`
// handback, which keeps the run, so `state.json`'s stored groups can be read back.
test('Seam 1: staged stores attribution: true when a trailer is resolved', async (t) => {
  const c = createCase(t);
  seed(c, { 'big.txt': 'keep' + String.fromCharCode(10) });
  // Added lines well past the scanner's 1 MB size skip.
  c.writeFile('big.txt', 'keep' + String.fromCharCode(10) + ('y'.repeat(1023) + String.fromCharCode(10)).repeat(1100));
  c.git(['add', '--', 'big.txt']);
  const planned = await runCommit(c, ['plan', '--staged']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId } = planned.json;
  const runDir = path.join(c.repoDir, '.commit-plan', planId);
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1, source: 'worker', groups: [{ header: 'feat: x', body: null, files: ['big.txt'], hunks: [] }], notIncluded: [],
  }));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
  assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));
  assert.equal(readState(runDir).groups[0].attribution, true);
});
