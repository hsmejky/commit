'use strict';

// EXE-20 (docs/roadmap/10-commit-executor.md): `commit --all` in `reword` mode —
// `git commit --amend --only --cleanup=verbatim -F -` with no match, no reset, no staging,
// no verify and no scan (C:commit-release `reword`, Q20). `index-changed` is skipped
// (Q20's spec-pass-6 amendment); `head-moved` still runs. The carried-trailer rules
// (foreign trailers survive, an old Anthropic `Co-Authored-By` is dropped) are Q20's.
// MSG-08 (docs/roadmap/03-message-grammar.md) adds the full generality: every foreign
// trailer kept verbatim and in order, and conditional attribution driven by the group's own
// stored `attribution` flag (PLN-07) rather than re-decided here. CHG-16: reword does no
// content scan, so none of this reads file contents.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// Seeds a repo with one commit (`oldMessage`), optionally after a parent commit (criterion 6:
// the non-root case), runs `plan --reword`, then overwrites the stored single group's
// header/body with the new message (bypassing the worker/`check`, same pattern as
// tests/commit-all.test.js's `groupedRunWithMessage`).
// `attribution` stands in for PLN-07's stored per-group flag (computed by `check` from the
// run's resolved trailer, the plan's `source` and `hadAttributionTrailer(oldMessage)`; not
// re-derived here since this helper bypasses `check`). Defaults to `true` so tests that don't
// care about the conditional still see the trailer, matching a worker-authored reword.
async function rewordRun(t, { oldMessage, header, body = null, stageFile, withParent = false, attribution = true } = {}) {
  const c = createCase(t);
  let parentSha = null;
  if (withParent) {
    c.writeFile('base.txt', 'base\n');
    c.git(['add', 'base.txt']);
    c.git(['commit', '-q', '-m', 'chore: base commit']);
    parentSha = c.git(['rev-parse', 'HEAD']).trim();
  }
  c.writeFile('file.txt', 'one\n');
  c.git(['add', 'file.txt']);
  c.git(['commit', '-q', '-m', oldMessage]);
  const planned = await runCommit(c, ['plan', '--reword']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  if (stageFile) {
    c.writeFile(stageFile, 'staged content\n');
    c.git(['add', '--', stageFile]);
  }
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [
    { n: 1, units: state.units.map((unit) => unit.id), header, body, committed: false, attribution },
  ];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId, runDir, state, parentSha };
}

test('reword commits the new message, keeps the same tree, and leaves a staged file staged', async (t) => {
  const { c, planId } = await rewordRun(t, {
    oldMessage: 'fix: old message', header: 'fix: better message', stageFile: 'extra.txt',
  });
  const oldSha = c.git(['rev-parse', 'HEAD']).trim();
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  assert.equal(result.json.notices.length, 0);
  const [{ sha }] = result.json.commits;
  assert.notEqual(sha, oldSha, 'a new commit replaced the old one');
  assert.equal(c.git(['rev-parse', 'HEAD^{tree}']).trim(), oldTree, 'the tree is unchanged');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.match(raw, /fix: better message/);
  // The staged file survives the reword, still staged (--only never touches the index).
  assert.equal(c.git(['status', '--porcelain']), 'A  extra.txt\n');
});

test('reword runs no scan: an unstaged worktree modification stays unstaged, untouched', async (t) => {
  const { c, planId } = await rewordRun(t, { oldMessage: 'fix: old message', header: 'fix: better message' });

  // Criterion 1 (no match, no scan): modify the tracked file in the worktree after `plan`.
  // `reword` never reads the worktree or the index, so this stays exactly as left.
  c.writeFile('file.txt', 'one\ntwo\n');

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
  assert.equal(c.git(['status', '--porcelain']), ' M file.txt\n', 'the modification is unstaged, not scanned away');
  assert.equal(fs.readFileSync(path.join(c.repoDir, 'file.txt'), 'utf8'), 'one\ntwo\n');
});

test('extra staging between plan and commit is not refused (index-changed skipped in reword)', async (t) => {
  const { c, planId } = await rewordRun(t, { oldMessage: 'fix: old', header: 'fix: new' });
  c.writeFile('untracked.txt', 'x\n');
  c.git(['add', 'untracked.txt']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.ok, true);
});

test('a manual commit made in between is refused head-moved', async (t) => {
  const { c, planId } = await rewordRun(t, { oldMessage: 'fix: old', header: 'fix: new' });
  c.git(['commit', '-q', '--allow-empty', '-m', 'someone else committed']);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'head-moved');
});

test('rewording a root commit keeps it a root commit with the new message, same tree', async (t) => {
  const { c, planId } = await rewordRun(t, { oldMessage: 'feat: first', header: 'feat: renamed first' });
  const oldTree = c.git(['rev-parse', 'HEAD^{tree}']).trim();

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.notices.length, 0, 'no "another commit was made" notice on a root reword');
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', `${sha}^{tree}`]).trim(), oldTree, 'the tree is unchanged');
  assert.equal(c.git(['rev-list', '--parents', '-n', '1', sha]).trim(), sha, 'still a root commit (no parent)');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.match(raw, /feat: renamed first/);
});

// Criterion 6 (EXE-06/EXE-20): the non-root case. The first-parent check must compare the
// amended HEAD's first parent against the *expected* HEAD's own first parent, not against the
// expected HEAD itself — a regression to `expectedParent = null` would still pass the root-only
// tests above.
test('rewording a non-root commit keeps its own parent, with no "another commit" notice', async (t) => {
  const { c, planId, parentSha } = await rewordRun(t, {
    oldMessage: 'fix: old message', header: 'fix: better message', withParent: true,
  });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.notices.length, 0, 'no "another commit was made" notice on a non-root reword');
  const [{ sha }] = result.json.commits;
  assert.equal(c.git(['rev-parse', `${sha}^`]).trim(), parentSha, 'the reword kept its own parent');
  const raw = c.git(['cat-file', 'commit', sha]);
  assert.match(raw, /fix: better message/);
});

test('a foreign trailer in the old message survives; the old Anthropic Co-Authored-By is dropped', async (t) => {
  const oldMessage = 'fix: old\n\nSigned-off-by: A <a@b.example>\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message' });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(
    message,
    'fix: new message\n\nSigned-off-by: A <a@b.example>\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  );
  // Exactly one Co-Authored-By line: the old one was dropped, the current one appended once.
  assert.equal((message.match(/Co-Authored-By:/g) || []).length, 1);
});

// MSG-08 criterion 1: every foreign trailer survives, verbatim, in its original order, and
// lands after the new message's own footer paragraph (`Closes #9`).
test('every foreign trailer is kept verbatim and in order, after the new message\'s own footer', async (t) => {
  const oldMessage = 'fix: old\n\nSigned-off-by: A <a@b>\nChange-Id: I1\nCo-Authored-By: Human <human@example.com>\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message', body: 'Closes #9' });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(
    message,
    'fix: new message\n\nCloses #9\nSigned-off-by: A <a@b>\nChange-Id: I1\n' +
      'Co-Authored-By: Human <human@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  );
});

// MSG-08 criterion 2: an allowed token (`Refs`) in the old footer is not carried (the new
// message owns it); the old noreply `Co-Authored-By` is dropped, and since it was present,
// the resolved attribution is appended once, after the (empty) carried trailers.
test('an old Refs trailer is not carried; attribution is appended once since the old noreply trailer was present', async (t) => {
  const oldMessage = 'fix: old\n\nRefs: x\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message', attribution: true });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(message, 'fix: new message\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
});

// MSG-08 criterion 3: a dictated reword (`source: "user"`) of an old message with no noreply
// trailer gets no attribution trailer — the executor reads the stored `attribution` flag
// (PLN-07) rather than deciding this itself.
test('a dictated reword with no old attribution trailer gets no attribution trailer', async (t) => {
  const oldMessage = 'fix: old\n\nSome body text.\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message', attribution: false });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(message, 'fix: new message\n');
});

// MSG-08 criterion 3 (worker side): the same old message, but the stored flag is `true`
// (worker-authored text) — the attribution trailer is appended.
test('the same reword with a worker-authored message gets the attribution trailer', async (t) => {
  const oldMessage = 'fix: old\n\nSome body text.\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message', attribution: true });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(message, 'fix: new message\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
});

// MSG-08 criterion 4: the old message's last paragraph is body, not a footer paragraph (an
// earlier paragraph merely looking footer-shaped does not count) — nothing is carried.
test('an old message whose last paragraph is body carries nothing', async (t) => {
  const oldMessage = 'fix: old\n\nSigned-off-by: A <a@b>\n\nA trailing body paragraph, not a footer.\n';
  const { c, planId } = await rewordRun(t, { oldMessage, header: 'fix: new message', attribution: true });

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 0, detail(result));
  const [{ sha }] = result.json.commits;
  const raw = c.git(['cat-file', 'commit', sha]);
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  assert.equal(message, 'fix: new message\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  assert.doesNotMatch(message, /Signed-off-by/);
});
