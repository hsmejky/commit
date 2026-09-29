'use strict';

// RUN-01 (docs/roadmap/09-runs.md): M12's deletion guard and planId form. Every folder or
// file the script deletes is resolved and checked to lie strictly inside
// `<toplevel>/.commit-plan/` (no `..`, not absolute, not the directory itself), and every
// `planId` it reads must be the minted lowercase UUID v4 form (C:run-folder, story 206).

const crypto = require('node:crypto');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');

let run;
beforeEach(async () => {
  run = await loadLib('run');
});

const RUN_DIR = path.resolve('some', 'repo', '.commit-plan');

test('insideRunDir resolves a minted planId and a file under it inside the run-folder directory', () => {
  const planId = crypto.randomUUID();
  assert.equal(run.insideRunDir(RUN_DIR, planId), path.join(RUN_DIR, planId));
  assert.equal(run.insideRunDir(RUN_DIR, 'lock'), path.join(RUN_DIR, 'lock'));
  assert.equal(run.insideRunDir(RUN_DIR, `${planId}/call.lock`), path.join(RUN_DIR, planId, 'call.lock'));
});

const REFUSED_NAMES = [
  ['empty', ''],
  ['the directory itself', '.'],
  ['a name resolving to the directory itself', 'a/..'],
  ['a parent traversal', '..'],
  ['a traversal out', '../victim'],
  ['a nested traversal out', 'a/../../victim'],
  ['a backslash traversal', '..\\victim'],
  ['a POSIX absolute path', '/etc/passwd'],
  ['a Windows drive path', 'C:\\Windows'],
  ['a Windows drive-relative path', 'C:victim'],
  ['a UNC path', '\\\\server\\share'],
  ['a NUL byte', 'a\0b'],
];

for (const [label, name] of REFUSED_NAMES) {
  test(`insideRunDir refuses ${label}`, () => {
    assert.throws(() => run.insideRunDir(RUN_DIR, name), /outside the run-folder directory/);
  });
}

test('insideRunDir refuses a non-string name', () => {
  assert.throws(() => run.insideRunDir(RUN_DIR, undefined), /outside the run-folder directory/);
  assert.throws(() => run.insideRunDir(RUN_DIR, 42), /outside the run-folder directory/);
});

test('isValidPlanId accepts randomUUID output and refuses every other form', () => {
  for (let i = 0; i < 20; i += 1) assert.equal(run.isValidPlanId(crypto.randomUUID()), true);
  const planId = crypto.randomUUID();
  for (const value of [planId.toUpperCase(), `${planId}/..`, `../${planId}`, '', null, 7, planId.slice(1)]) {
    assert.equal(run.isValidPlanId(value), false, JSON.stringify(value));
  }
});
