'use strict';

// RUN-06 (docs/roadmap/09-runs.md): what runs around step 7's `acquire` at Seam 1 — the lost
// race (`EEXIST` → `held`), the HEAD re-read after the lock is taken (`head-moved`), `plan
// --reword` taking the lock on a clean tree, and `release` ending that run.
//
// The PATH git shim cases are POSIX-only: shell-less spawn on Windows finds only `.com` and
// `.exe` files, so a script shim is never run there (roadmap KD-R21, spec KD-S35). The
// fault-preload `EEXIST` case (docs/spec/testing-seams.md) covers `held` on every platform.
// Each shim keys its action to run-folder state, not to a call count, since step 1 reads
// HEAD too: the HEAD shim fires at the first HEAD read once `.commit-plan/lock` exists, the
// lock shim at the first git call once the provisional folder exists and no lock does.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');
const { parseBaseCallerRule, parseHandbackRule } = require('./helpers/reply-contract-doc.js');

const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';
const OTHER_PLAN_ID = '11111111-1111-4111-8111-111111111111';

function seed(c, files) {
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function runDirOf(c) {
  return path.join(c.repoDir, '.commit-plan');
}

function folderNames(c) {
  return fs.readdirSync(runDirOf(c)).filter((name) => name !== 'lock').sort();
}

function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

// A `git` shim on PATH: runs `action` (shell lines) once, when `condition` (a shell test)
// first holds at a git call, then hands every call on to the real git. Every git call runs
// from the toplevel (Q9), so relative `.commit-plan` paths name the run-folder directory.
// A failing action line exits the shim with 97, so the plan sees a broken git call instead
// of the action silently not happening.
function gitShim(c, { condition, action }) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const marker = path.join(c.root, 'shim-fired');
  const git = realGit(c);
  const shim = path.join(dir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ] && ${condition}; then`,
    `  : > '${marker}'`,
    ...action(git).map((line) => `  ${line} || { echo 'git shim action failed' >&2; exit 97; }`),
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return { env: pathOverride(c, [dir, c.env.PATH]), marker };
}

// The case's fixed identity as shell assignments, for a commit a shim action makes. M2 strips
// every inherited `GIT_*` outside its keep set from the plan's git calls, the identity
// included, so the shim inherits none; git's own fallback (GECOS name, host email) fails on
// Linux CI runners, whose user has no GECOS name.
function identityAssignments(c) {
  return ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']
    .map((key) => `${key}='${c.env[key]}'`).join(' ');
}

function assertLockRefusal(result, kind) {
  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, kind);
}

// INT-05 (C:reply-and-handback `lock` row, Q22): the takeover question/answers/ifNoUser shape
// an interactive refusal of a live, readable-`planId` lock gets, plus the handback-rule
// addition to `callerRule`. `respawn` has no `mode` line for a bare `plan` call.
function assertLockHandback(result, { respawn, idle = /6\d/ }) {
  const { reply } = result.json;
  assert.equal(reply.status, 'handback');
  assert.equal(reply.handback.kind, 'lock');
  // The lock's `created` is pinned to '2026-09-26T13:58:02.000Z'. `idle` matches the
  // "last active" seconds built from the lock's mtime: the default (60-69 s, loose enough
  // for the time the call itself takes, review-INT-05 finding 3) fits `placeLock`'s
  // minute-ago backdating. The lost-race case's shim writes the lock fresh mid-run instead,
  // so its caller passes a tighter match (review-INT-05-r2 finding 1).
  assert.match(
    reply.handback.question,
    new RegExp(
      `^A /commit run started at 13:58 holds the lock, last active ${idle.source} s ago\\. `
        + 'It may still be running \\(a subagent committing in parallel\\); taking it over '
        + 'resets its index mid-commit\\. Take it over\\?$',
    ),
  );
  assert.equal(reply.handback.question, reply.text.split('\n')[0]);
  assert.deepEqual(reply.handback.answers, [
    { label: 'take over', respawn },
    { label: 'wait' },
  ]);
  assert.deepEqual(reply.handback.ifNoUser, { answer: 'wait', returnToParent: true });
  assert.equal(reply.callerRule, `${parseBaseCallerRule()} ${parseHandbackRule()}`);
}

// Writes the run lock with a fixed mtime a minute in the past: fresh (under 15 minutes) and
// whole seconds, so `touched` has one exact ISO form.
function placeLock(c, content) {
  const lock = path.join(runDirOf(c), 'lock');
  fs.writeFileSync(lock, content);
  const minuteAgo = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  fs.utimesSync(lock, minuteAgo, minuteAgo);
}

// C:cli-and-exit-codes: a `lock` error carries the holder's `planId`, `created` and
// `touched` (the lock file's mtime, ISO); both `null`s for an unreadable lock.
function assertHolderFields(result, c, { planId, created }) {
  const touched = new Date(fs.statSync(path.join(runDirOf(c), 'lock')).mtimeMs).toISOString();
  const { error } = result.json;
  assert.deepEqual(
    { planId: error.planId, created: error.created, touched: error.touched },
    { planId, created, touched },
    detail(result),
  );
}

// A trace2 `normalTarget` in a global config of its own (M2's keep-set passes
// `GIT_CONFIG_GLOBAL` through; `GIT_TRACE*` would be stripped): `commands()` lists the argv
// of every git process the call started, one `start` line each. Works from git 2.34 on all
// three OSes, unlike the PATH shims (KD-R21).
function traceGit(c) {
  const log = path.join(c.root, 'trace2.log');
  const config = path.join(c.root, 'trace.gitconfig');
  fs.writeFileSync(config, `[trace2]\n\tnormalTarget = ${log.split(path.sep).join('/')}\n`);
  return {
    env: { GIT_CONFIG_GLOBAL: config },
    commands() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter((line) => / start /.test(line));
    },
  };
}

test('plan --reword on a clean tree exits 0 and takes the lock; release then removes the lock and the folder', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });

  const planned = await runCommit(c, ['plan', '--reword']);

  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, mode } = planned.json;
  assert.equal(mode, 'reword');
  const lock = JSON.parse(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'));
  assert.equal(lock.planId, planId);
  assert.ok(fs.statSync(path.join(runDirOf(c), planId)).isDirectory());

  const released = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(released.exitCode, 0, detail(released));
  assert.equal(released.json.reply.status, 'nothing');
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false);
  assert.equal(fs.existsSync(path.join(runDirOf(c), planId)), false);
});

test('plan whose step-7 HEAD re-read finds a commit made after the lock was taken releases it and exits 6 head-moved', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  // Detached, so step 1 pushes the detached-HEAD notice (`ctx.notices`): a post-folder
  // refusal that reaches it, like this one, must still carry it in `reply.notices` (RPL-04,
  // KD-R64), not only the clean-tree `nothing` reply.
  c.git(['checkout', '-q', '--detach']);
  c.writeFile('a.txt', 'one\nmore\n');
  const shim = gitShim(c, {
    condition: '[ -e .commit-plan/lock ] && [ "$*" = "rev-parse --verify -q HEAD" ]',
    action: (git) => [`${identityAssignments(c)} '${git}' commit -q --allow-empty -m moved`],
  });

  const result = await runCommit(c, ['plan'], { env: shim.env });

  assertLockRefusal(result, 'head-moved');
  assert.equal(result.json.error.message, 'HEAD moved since plan (commit made elsewhere?), run /commit again');
  assert.ok(fs.existsSync(shim.marker), 'the shim never saw the step-7 HEAD read');
  assert.equal(c.git(['log', '-1', '--format=%s']).trim(), 'moved');

  // RPL-04: a post-folder refusal (not only the pre-folder merge/not-a-repo cases) also
  // carries a `failed` reply with the base `callerRule`, no handback, and `plan`'s notices
  // collected before the refusal.
  const { reply } = result.json;
  assert.equal(reply.status, 'failed');
  assert.equal(reply.planId, null);
  assert.equal(reply.handback, null);
  assert.equal(reply.callerRule, parseBaseCallerRule());
  assert.deepEqual(reply.notices, ['HEAD is detached: new commits will not be on any branch']);
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false);
  assert.deepEqual(folderNames(c), []);
});

test('plan that loses the lock race to a lock placed after its folder exists exits 6 lock (held), leaving that lock and folder alone', { skip: SHIM_SKIP }, async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  const placed = JSON.stringify({ planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' });
  const shim = gitShim(c, {
    // The first git call once a provisional folder exists and no lock does: the inventory's.
    condition: '[ ! -e .commit-plan/lock ] && [ -n "$(find .commit-plan -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]',
    action: () => [
      `mkdir .commit-plan/${OTHER_PLAN_ID}`,
      `printf '%s' 'kept' > .commit-plan/${OTHER_PLAN_ID}/state.json`,
      `printf '%s' '${placed}' > .commit-plan/lock`,
    ],
  });

  const result = await runCommit(c, ['plan'], { env: shim.env });

  assertLockRefusal(result, 'lock');
  assert.match(result.json.error.message, /^another \/commit run is in progress \(started 13:58, last active \d+ s ago\)$/);
  // RUN-07: a lost `acquire` carries the same holder fields as a `peek` refusal.
  assertHolderFields(result, c, { planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' });
  assert.equal(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'), placed);
  assert.equal(fs.readFileSync(path.join(runDirOf(c), OTHER_PLAN_ID, 'state.json'), 'utf8'), 'kept');
  assert.deepEqual(folderNames(c), [OTHER_PLAN_ID]);
  // INT-05: a lost race at `acquire` gets the same `lock` handback as a `peek` refusal. The
  // shim above writes the lock fresh mid-run (no backdating), so unlike the peek cases its
  // idle seconds read low, not 60-69 (review-INT-05-r2 finding 1).
  assertLockHandback(result, { respawn: `takeOver: ${OTHER_PLAN_ID}`, idle: /\d+/ });
});

test('plan whose lock link fails with EEXIST exits 6 lock and deletes its own provisional folder', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');

  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', FAULT_PRELOAD],
    env: { COMMIT_TEST_FAULT_LINK_BASENAME: 'lock=EEXIST' },
  });

  assertLockRefusal(result, 'lock');
  // No real lock was ever written (only the link call is faulted): `held`'s read finds the
  // lock gone again, naming no holder (review-RUN-06 finding 6).
  assert.equal(result.json.error.message, 'another /commit run is in progress');
  const { planId, created, touched } = result.json.error;
  assert.deepEqual({ planId, created, touched }, { planId: null, created: null, touched: null });
  assert.equal(fs.existsSync(path.join(runDirOf(c), 'lock')), false);
  assert.deepEqual(folderNames(c), []);
});

test('plan refused at peek by a fresh garbage lock exits 6 lock with the unreadable-lock text and null holder planId and created', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  // RUN-07's `peek` at step 3 catches this fresh garbage lock before any inventory work, with
  // the same text and holder fields step 7's lost race builds (RUN-06). The real `EEXIST` at
  // `acquire` itself is covered by run.test.js and the POSIX shim race above.
  fs.mkdirSync(runDirOf(c));
  placeLock(c, 'not json');

  const result = await runCommit(c, ['plan']);

  assertLockRefusal(result, 'lock');
  assert.equal(result.json.error.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
  assertHolderFields(result, c, { planId: null, created: null });
  assert.equal(result.json.reply.handback, null);
  assert.equal(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'), 'not json', 'the foreign lock is left alone');
  assert.deepEqual(folderNames(c), []);
});

// review-INT-05 finding 2: a live lock with a readable (minted-form) `planId` but a `created`
// that does not parse as a date (missing here, garbage in plan-lock-handback.test.js's sibling
// case) must read as unreadable the same way `heldMessage`'s own text does (`lockHolderClock`,
// run.mjs), not a `lock` handback with "started at NaN:NaN" — `errorFields` still carries the
// raw `planId`/`created` the lock held (C:cli-and-exit-codes).
test('plan refused at peek by a live lock with a planId but no created exits 6 lock with the unreadable-lock text and no handback', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  placeLock(c, JSON.stringify({ planId: OTHER_PLAN_ID }));

  const result = await runCommit(c, ['plan']);

  assertLockRefusal(result, 'lock');
  assert.equal(result.json.error.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
  assertHolderFields(result, c, { planId: OTHER_PLAN_ID, created: null });
  assert.equal(result.json.reply.status, 'failed');
  assert.equal(result.json.reply.handback, null);
  assert.equal(result.json.reply.callerRule, parseBaseCallerRule());
  assert.deepEqual(folderNames(c), []);
});

// RUN-07: a live lock in place before `plan` even starts refuses at step 3's `peek`, before
// any inventory work, with no race or shim needed (the lock is already there). Inventory is
// made observable with a trace2 target in the case's global config (`GIT_CONFIG_GLOBAL` is in
// M2's keep-set, while `GIT_TRACE*` would be stripped): its first git call, `ls-files
// --others`, must never run. Without the `peek`, step 7's `acquire` refuses identically but
// only after the inventory (review-RUN-07 finding 6).
test('plan refused by a live lock already in place exits 6 lock before any inventory git call, leaving that lock alone and creating nothing', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  const placed = JSON.stringify({ planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' });
  placeLock(c, placed);
  const trace = traceGit(c);

  const result = await runCommit(c, ['plan'], { env: trace.env });

  assertLockRefusal(result, 'lock');
  assert.match(result.json.error.message, /^another \/commit run is in progress \(started 13:58, last active \d+ s ago\)$/);
  assertHolderFields(result, c, { planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' });
  const started = trace.commands();
  assert.ok(started.some((line) => / rev-parse /.test(line)), `the trace records the plan's git calls:\n${started.join('\n')}`);
  // review-RUN-07-r2 finding 3: matching only the inventory's current first call
  // (`ls-files --others`) loses its power the moment the inventory starts with a different
  // one. Checked against an allow-list instead, so any CHG-05 inventory git call at all —
  // not just this one — fails the test: `probe`'s two startup calls, `readHeadState`'s
  // status call and its concurrent `inProgressState`/`commitEncoding` pair (order
  // unconstrained, both run via `Promise.all`), `createRunFolder`'s own `git-path`/
  // `isTracked` calls, and the one `git status` call `treeState` makes afterward for the
  // `failed` reply's text (INT-01: every reply, refusal included, ends with it; a single
  // cheap call, unlike CHG-05's own multi-call scan, so it is not "inventory work" either).
  // CFG-07 adds step 1's `loadConfig` read of `scanIgnore` at HEAD (`git ls-tree`, then
  // `git cat-file blob` when the file is committed).
  const PRE_INVENTORY_CALLS = [
    / --version$/,
    / ls-tree -l -z HEAD -- \.claude\/commit\.json$/,
    / cat-file blob [0-9a-f]+$/,
    / rev-parse --show-toplevel$/,
    / status --porcelain=v2 --branch --untracked-files=no --ignore-submodules=all --no-ahead-behind$/,
    / rev-parse(?: --git-path \S+)+$/,
    / config --get i18n\.commitEncoding$/,
    / ls-files -z --cached$/,
    / status --porcelain -z --untracked-files=all$/,
  ];
  for (const line of started) {
    assert.ok(
      PRE_INVENTORY_CALLS.some((allowed) => allowed.test(line)),
      `a git call ran that is not on the allow-list (a CHG-05 inventory call?):\n${line}`,
    );
  }
  assert.equal(fs.readFileSync(path.join(runDirOf(c), 'lock'), 'utf8'), placed, "the holder's lock is untouched");
  assert.deepEqual(folderNames(c), [], 'no provisional folder and no temporary index are left');
  // INT-05: a `peek` refusal of a live lock with a readable `planId`, interactive, carries
  // the `lock` handback.
  assertLockHandback(result, { respawn: `takeOver: ${OTHER_PLAN_ID}` });
});

test('plan --no-user --split refused by a live lock carries the same holder fields but no handback', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  placeLock(c, JSON.stringify({ planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' }));

  const result = await runCommit(c, ['plan', '--no-user', '--split']);

  assertLockRefusal(result, 'lock');
  assertHolderFields(result, c, { planId: OTHER_PLAN_ID, created: '2026-09-26T13:58:02.000Z' });
  assert.deepEqual(folderNames(c), []);
  // INT-05 (Q22 "A run without a user gets a plain refusal and returns it to its parent";
  // C:reply-and-handback marks the `lock` row `interactive`): `--no-user` skips the handback,
  // the same as `lintFailed`'s own `--no-user` skip — unlike `modeChoice`, which never checks
  // `--no-user` at all.
  assert.equal(result.json.reply.status, 'failed');
  assert.equal(result.json.reply.handback, null);
  assert.equal(result.json.reply.callerRule, parseBaseCallerRule());
});

// RUN-07: a fresh lock whose planId is not in the minted form also refuses at `peek`, with
// no holder planId and no handback (the unreadable-lock text, same as the garbage-content
// case above).
test('plan refused by a fresh lock with a non-UUID planId exits 6 lock with no handback', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'one\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  fs.mkdirSync(runDirOf(c));
  placeLock(c, JSON.stringify({ planId: 'not-a-uuid', created: '2026-09-26T13:58:02.000Z' }));

  const result = await runCommit(c, ['plan']);

  assertLockRefusal(result, 'lock');
  assert.equal(result.json.error.message, 'the /commit lock is unreadable (corrupt or not written by /commit)');
  // C:cli-and-exit-codes: a malformed `planId` nulls `created` too, whatever the lock says.
  assertHolderFields(result, c, { planId: null, created: null });
  assert.equal(result.json.reply.handback, null);
  assert.deepEqual(folderNames(c), []);
});
