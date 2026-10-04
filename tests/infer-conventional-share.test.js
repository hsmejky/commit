'use strict';

// INF-02 (docs/roadmap/14-infer-and-commit-config.md): a commit counts as Conventional
// Commits only when its header matches M6's header grammar (`WIP:`/`Update:` do not, since
// M6's header regex requires a lowercase type); `ccShare` is taken over all non-merge
// commits read (at most 200, merges excluded by M3's `git log --no-merges`); under 50% the
// outcome is `not-conventional` (`proposal: null`), at 50% or more it is `proposal`. Seam 1
// through the shipped entry point, plus M19's own pure checks and a static import check.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createCase, fastImportLinear, runCommit } = require('./helpers/process-seam.js');
const { loadLib, libPath } = require('./helpers/load-lib.js');

let infer;
beforeEach(async () => {
  ({ infer } = await loadLib('history-inference'));
});

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.version, 1, detail(result));
  assert.equal(result.json.ok, true, detail(result));
}

// Commits one by one; fine for small counts (the 20-commit case below). Larger histories use
// `fast-import` instead (one spawn), matching tests/plan-reword-facts.test.js's M3 test.
function commitMessages(c, messages) {
  messages.forEach((message, i) => {
    c.writeFile('file.txt', `${i}\n`);
    c.git(['add', 'file.txt']);
    c.git(['commit', '-q', '-m', message]);
  });
}

test('Seam 1: WIP: and Update: headers do not count; a 20-commit 50% share is a proposal, not too-few-commits', async (t) => {
  const c = createCase(t);
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(`feat: change ${i}`);
  for (let i = 0; i < 5; i += 1) messages.push(`WIP: change ${i}`);
  for (let i = 0; i < 5; i += 1) messages.push(`Update: change ${i}`);
  commitMessages(c, messages);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 20, detail(result));
  assert.equal(result.json.ccShare, 0.5, detail(result));
  assert.equal(result.json.nonConventional, 10, detail(result));
  assert.equal(result.json.outcome, 'proposal', detail(result));
  assert.notEqual(result.json.proposal, null, detail(result));
  assert.notEqual(result.json.configJson, null, detail(result));
});

test('Seam 1: a 49% Conventional Commits share is not-conventional with proposal null', async (t) => {
  const c = createCase(t);
  fastImportLinear(c, 100, (i) => (i <= 49 ? `feat: change ${i}\n` : `WIP: change ${i}\n`));

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 100, detail(result));
  assert.equal(result.json.ccShare, 0.49, detail(result));
  assert.equal(result.json.nonConventional, 51, detail(result));
  assert.equal(result.json.outcome, 'not-conventional', detail(result));
  assert.equal(result.json.proposal, null, detail(result));
  assert.equal(result.json.wouldFail, null, detail(result));
  assert.equal(result.json.droppedTypes, null, detail(result));
  assert.equal(result.json.configJson, null, detail(result));
});

test('Seam 1: merge commits are not read; 230 non-merge commits read is capped at 200', async (t) => {
  const c = createCase(t);
  // 229 linear conventional commits, then a side branch commit and a merge on top: 230
  // non-merge commits plus the merge itself. If the merge's own message ("Merge branch
  // side", which does not match the header grammar) were read, ccShare would drop below 1;
  // if it were not capped at 200, commitCount would be 231.
  fastImportLinear(c, 229, (i) => `feat: change ${i}\n`);
  c.git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  c.writeFile('side.txt', 'x\n');
  c.git(['add', 'side.txt']);
  c.git(['commit', '-q', '-m', 'feat: side']);
  c.git(['checkout', '-q', 'main']);
  c.git(['merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side']);

  const result = await runCommit(c, ['infer']);

  assertOk(result);
  assert.equal(result.json.commitCount, 200, detail(result));
  assert.equal(result.json.ccShare, 1, detail(result));
  assert.equal(result.json.outcome, 'proposal', detail(result));
  assert.notEqual(result.json.proposal, null, detail(result));
});

test('M19 infer: 49% is not-conventional, 50% is a proposal (pure)', () => {
  const below = infer([
    ...Array.from({ length: 49 }, (_, i) => `feat: change ${i}`),
    ...Array.from({ length: 51 }, (_, i) => `WIP: change ${i}`),
  ]);
  assert.equal(below.outcome, 'not-conventional');
  assert.equal(below.ccShare, 0.49);
  assert.equal(below.proposal, null);
  assert.equal(below.wouldFail, null);
  assert.equal(below.droppedTypes, null);

  const atThreshold = infer([
    ...Array.from({ length: 50 }, (_, i) => `feat: change ${i}`),
    ...Array.from({ length: 25 }, (_, i) => `WIP: change ${i}`),
    ...Array.from({ length: 25 }, (_, i) => `Update: change ${i}`),
  ]);
  assert.equal(atThreshold.outcome, 'proposal');
  assert.equal(atThreshold.ccShare, 0.5);
  assert.notEqual(atThreshold.proposal, null);
  // INF-06: wouldFail is no longer null once there is a proposal; all 50 Conventional
  // Commits messages here are lint-clean under the proposed (default-shaped) config.
  assert.equal(atThreshold.wouldFail, 0);
});

test('M19 infer: a 20-commit history at 50% is a proposal, not too-few-commits', () => {
  const output = infer([
    ...Array.from({ length: 10 }, (_, i) => `feat: change ${i}`),
    ...Array.from({ length: 10 }, (_, i) => `WIP: change ${i}`),
  ]);
  assert.equal(output.commitCount, 20);
  assert.equal(output.outcome, 'proposal');
  assert.notEqual(output.proposal, null);
});

test('M19 history-inference imports parse from M6 (no duplicate header grammar)', () => {
  const source = fs.readFileSync(libPath('history-inference'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m);
  assert.notEqual(
    importMatch,
    null,
    'history-inference.mjs must import from ./message-grammar.mjs',
  );
  assert.match(
    importMatch[1],
    /\bparse\b/,
    'the message-grammar.mjs import must include parse, not redefine the header grammar',
  );
  // Not vacuous: a module that only mentions "parse" without importing it from M6 fails.
  assert.doesNotMatch(
    'function parse(message) { return /^[a-z]+: /.test(message); }',
    /^import\s*\{([^}]*)\bparse\b([^}]*)\}\s*from\s*['"]\.\/message-grammar\.mjs['"];?\s*$/m,
  );
});
