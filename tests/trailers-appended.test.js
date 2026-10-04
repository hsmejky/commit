'use strict';

// MSG-07 (docs/roadmap/03-message-grammar.md, C:message-grammar "Trailers"): M6
// `appendTrailers`, wired into M16's `messageOf` (commit-executor.mjs), adds the run's
// stored attribution trailer after `check`'s lint, into the message's own footer paragraph
// when it ends in one, otherwise as a new last paragraph. Seam 1 only (the slice's own
// testing note): through `plan` and `check --plan` on the shipped entry point, like
// tests/first-end-to-end-commit.test.js (INT-02) and tests/plan-attribution.test.js (CFG-08/
// CFG-09).

const fs = require('node:fs');
const path = require('node:path');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function writeUserSettings(c, value) {
  fs.writeFileSync(path.join(c.claudeHome, 'settings.json'), JSON.stringify(value));
}

function writeWorkerPlan(runDir, header, body, files) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header, body, files, hunks: [], reason: 'test' }],
    notIncluded: [],
  }));
}

// The commit message read raw from the commit object, everything after the first blank line,
// so a trailer or a rewritten header would show.
function rawMessage(c, rev) {
  const object = c.git(['cat-file', 'commit', rev]);
  return object.slice(object.indexOf('\n\n') + 2);
}

async function planAndCheck(t, { body = null, files = ['a.txt'], configure } = {}) {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  if (configure) configure(c);
  c.writeFile('a.txt', 'one\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  writeWorkerPlan(runDir, 'feat: change a', body, files);
  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  const [{ sha }] = checked.json.commits;
  return { c, checked, sha };
}

test('AC1: a header-only message commits as header, blank line, the default trailer', async (t) => {
  const { c, sha } = await planAndCheck(t, { body: null });

  assert.equal(rawMessage(c, sha), `feat: change a\n\n${DEFAULT_TRAILER}\n`);
});

test('AC2: a message ending in a footer paragraph (Closes #12) gets the trailer appended to that paragraph, no blank line', async (t) => {
  const { c, sha } = await planAndCheck(t, { body: 'Closes #12' });

  assert.equal(rawMessage(c, sha), `feat: change a\n\nCloses #12\n${DEFAULT_TRAILER}\n`);
});

test('AC3: a message ending in a body paragraph gets the trailer as a new paragraph', async (t) => {
  const { c, sha } = await planAndCheck(t, {
    body: 'Some prose that is not a footer.',
    // Tracked (committed), not left untracked: an extra untracked file would trip the "new
    // files" confirmation trigger (C:confirmation-triggers) and `check` would stop at a
    // `confirm` handback instead of committing.
    configure: (repo) => {
      repo.writeFile('.claude/commit.json', JSON.stringify({ body: 'optional' }));
      repo.git(['add', '--', '.claude/commit.json']);
      repo.git(['commit', '-q', '-m', 'allow a body']);
    },
  });

  assert.equal(rawMessage(c, sha), `feat: change a\n\nSome prose that is not a footer.\n\n${DEFAULT_TRAILER}\n`);
});

test('AC4: attribution resolved to null (includeCoAuthoredBy: false) commits the lint-approved message byte for byte', async (t) => {
  const { c, sha } = await planAndCheck(t, {
    body: null,
    configure: (repo) => writeUserSettings(repo, { includeCoAuthoredBy: false }),
  });

  assert.equal(rawMessage(c, sha), 'feat: change a\n');
});

test('AC6: the committed message has LF line ends and exactly one trailing LF', async (t) => {
  const { c, sha } = await planAndCheck(t, { body: 'Closes #12' });

  const raw = rawMessage(c, sha);
  assert.equal(raw.includes('\r'), false);
  assert.match(raw, /[^\n]\n$/, 'exactly one trailing LF, no trailing blank line');
});

test('AC7: a user\'s attribution.commit edited between plan and check still commits the trailer plan stored', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: Old <old@x>' } });
  c.writeFile('a.txt', 'one\nmore\n');

  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;

  // Edited mid-run: `check` must read the trailer `plan` stored in state.json, never
  // re-resolve it (C:run-folder "never re-read ... the Claude settings").
  writeUserSettings(c, { attribution: { commit: 'Co-Authored-By: New <new@x>' } });
  writeWorkerPlan(runDir, 'feat: change a', null, ['a.txt']);

  const checked = await runCommit(c, ['check', '--plan', planId]);
  assert.equal(checked.exitCode, 0, detail(checked));
  const [{ sha }] = checked.json.commits;
  assert.equal(rawMessage(c, sha), 'feat: change a\n\nCo-Authored-By: Old <old@x>\n');
});
