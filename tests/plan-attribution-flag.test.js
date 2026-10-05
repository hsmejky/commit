'use strict';

// PLN-07 (docs/roadmap/08-plan-validation.md): `check` stores a per-group `attribution`
// flag (Q20) alongside the normalised message (plan-message-lint.test.js covers that half).
// `false` whenever the run's resolved attribution trailer is `null`, regardless of mode;
// otherwise always `true` in `split`/`staged` (the worker always writes the message there),
// and in `reword` only when the worker wrote the new message (`source` is `worker`, the
// default when absent) or the old message already carried an attribution trailer
// (M6 `hadAttributionTrailer`). MSG-08 (not built yet) is the only module that reads this
// flag to decide whether `commit` actually appends the trailer; this file only covers what
// `check` stores.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');
const { Q6_DEFAULT_VALUES: DEFAULT_VALUES } = require('./helpers/q6-defaults.js');

const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const ATTRIBUTED_OLD_MESSAGE = `feat: old\n\n${DEFAULT_TRAILER}`;

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
// Direct `validatePlan` call, like the other PLN-0x unit-level cases in this file and in
// plan-staged-reword-group.test.js: `check`'s success path for a whole-file `split` plan
// chains straight into `commit --all` in the same process (INT-02), which would commit for
// real and delete the run folder before `state.json` could be read back.

test('validatePlan: attribution resolved to null stores attribution: false on every group', () => {
  const UNITS = [
    { id: 'h1', path: 'a.txt', status: 'M' },
    { id: 'h2', path: 'b.txt', status: 'M' },
  ];
  const state = { mode: 'split', units: UNITS, config: { values: DEFAULT_VALUES }, attribution: { trailer: null } };

  return (async () => {
    const { validatePlan } = await loadLib('plan-validator');
    const result = validatePlan(Buffer.from(JSON.stringify({
      groups: [
        { header: 'feat: a', body: null, files: ['a.txt'], hunks: [] },
        { header: 'feat: b', body: null, files: ['b.txt'], hunks: [] },
      ],
      notIncluded: [],
    })), state);
    assert.equal(result.ok, true);
    assert.deepEqual(result.stored.map((g) => g.attribution), [false, false]);
  })();
});

// --- AC2, reword: direct `validatePlan` over a real `plan --reword` state ------------------
//
// M16's `reword` commit execution (EXE-20) now lands for real, so a full `check` through the
// CLI would amend HEAD and delete the run folder before this flag could be read; `check`'s
// own M14 validation is mode-independent of M16, so calling it directly over the real state
// a `plan --reword` run wrote reads the stored flag without ever reaching `commit` (same
// pattern as the existing `staged`/`reword` direct cases in plan-staged-reword-group.test.js).

async function rewordState(t, oldMessage) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', oldMessage]);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const runDir = path.join(c.repoDir, '.commit-plan', planned.json.planId);
  return readState(runDir);
}

function dictatedPlan(header, body = null) {
  return Buffer.from(JSON.stringify({
    version: 1,
    source: 'user',
    groups: [{ header, body, files: [], hunks: [] }],
    notIncluded: [],
  }));
}

test('reword: source "user" and an old message without the trailer stores attribution: false', async (t) => {
  const { validatePlan } = await loadLib('plan-validator');
  const state = await rewordState(t, 'feat: old');

  const result = validatePlan(dictatedPlan('feat: new'), state);

  assert.equal(result.ok, true);
  assert.equal(result.stored[0].attribution, false);
});

test('reword: source "user" and an old message that is the worker\'s own (has the trailer) stores attribution: true', async (t) => {
  const { validatePlan } = await loadLib('plan-validator');
  const state = await rewordState(t, ATTRIBUTED_OLD_MESSAGE);

  const result = validatePlan(dictatedPlan('feat: new'), state);

  assert.equal(result.ok, true);
  assert.equal(result.stored[0].attribution, true);
});

test('reword: source "worker" (the default) stores attribution: true regardless of the old message', async (t) => {
  const { validatePlan } = await loadLib('plan-validator');
  const state = await rewordState(t, 'feat: old');

  const result = validatePlan(Buffer.from(JSON.stringify({
    groups: [{ header: 'feat: new', body: null, files: [], hunks: [] }],
    notIncluded: [],
  })), state);

  assert.equal(result.ok, true);
  assert.equal(result.stored[0].attribution, true);
});

// --- `staged`: attribution always applies when a trailer is resolved -----------------------

test('validatePlan: staged stores attribution: true when a trailer is resolved', () => {
  const UNITS = [{ id: 'h1', path: 'a.txt', status: 'M' }];
  const state = { mode: 'staged', units: UNITS, config: { values: DEFAULT_VALUES }, attribution: { trailer: DEFAULT_TRAILER } };

  return (async () => {
    const { validatePlan } = await loadLib('plan-validator');
    const out = validatePlan(Buffer.from(JSON.stringify({
      groups: [{ header: 'feat: x', body: null, files: [], hunks: [] }],
      notIncluded: [],
    })), state);
    assert.equal(out.ok, true);
    assert.equal(out.stored[0].attribution, true);
  })();
});
