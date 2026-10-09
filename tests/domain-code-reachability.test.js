'use strict';

// RPL-03 (docs/roadmap/11-reply-and-cli.md) built this manifest for the rows its own blockers
// reached; INT-31 (docs/roadmap/12-integration.md) extends it to every (row, producer) pair of
// docs/spec/domain-code-cli-kind.md. Each row repeats its Producer cell verbatim and splits it
// into pairs; each pair names either the Seam 1 case that reaches the row's CLI kind and exit
// code through the shipped entry point, or the gap that says why none can yet: a KD-R row of
// docs/roadmap/known-deficiencies.md or an accepted gap of docs/roadmap/README.md. A gap is
// listed here, never skipped silently, and must name a KD row or accepted gap that exists.
// The manifest is data: a new doc row, or a changed Producer, CLI kind or Exit cell, fails the
// consistency test until an entry here names its pairs again.
//
// Each Seam 1 case builds its own minimal fixture, after the test file named beside it. The
// PATH script shim cases are POSIX-only: shell-less spawn on Windows finds only `.com` and
// `.exe` files (roadmap KD-R21).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');
const { parseDomainCodeDocTable, firstColumnKey } = require('./helpers/domain-code-doc.js');

const ROADMAP = path.join(__dirname, '..', 'docs', 'roadmap');
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const FAULT_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;
const SHIM_SKIP = process.platform === 'win32'
  && 'PATH script shims are not found by shell-less spawn on Windows (KD-R21)';
const UNKNOWN_PLAN_ID = '11111111-1111-4111-8111-111111111111';

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seededCase(t, files) {
  const c = createCase(t);
  for (const [name, text] of Object.entries(files)) c.writeFile(name, text);
  c.git(['add', '--', ...Object.keys(files)]);
  c.git(['commit', '-q', '-m', 'seed']);
  return c;
}

// Two modified files, a `plan --split` run holding the lock, and one stored group naming every
// unit, as `check` stores it (tests/commit-all.test.js `groupedRun`). With `extraCandidate`,
// an untracked `new.txt` is a stored candidate no group names (`runWithExtraCandidate`).
async function groupedRun(t, { extraCandidate = false, groupExtra = false } = {}) {
  const c = seededCase(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  if (extraCandidate) c.writeFile('new.txt', 'new\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{
    n: 1,
    units: state.units.filter((unit) => groupExtra || unit.path !== 'new.txt').map((unit) => unit.id),
    header: 'feat: change both files',
    body: null,
    committed: false,
  }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return { c, planId };
}

function commitAll(c, planId) {
  return runCommit(c, ['commit', '--plan', planId, '--all']);
}

function numbered(count) {
  return Array.from({ length: count }, (_, i) => `${i + 1}\n`).join('');
}

// Two separated edits in one file plus one untracked candidate, planned
// (tests/plan-hunks-resnapshot.test.js `dirtyCase`), ready for a separate `plan --hunks`.
async function hunkRun(t) {
  const c = seededCase(t, { 'a.txt': numbered(30) });
  c.writeFile('a.txt', numbered(30).replace('2\n', 'two\n').replace('28\n', 'twenty-eight\n'));
  c.writeFile('new.txt', 'fresh\n');
  const planned = await runCommit(c, ['plan']);
  assert.equal(planned.exitCode, 0, detail(planned));
  return { c, planId: planned.json.planId };
}

function planHunks(c, planId, options) {
  return runCommit(c, ['plan', '--hunks', '--plan', planId], options);
}

function realGit(c) {
  const found = spawnSync('sh', ['-c', 'command -v git'], { env: c.env, encoding: 'utf8' });
  assert.equal(found.status, 0, 'no git on the host PATH');
  return found.stdout.trim();
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

// A `git` shim on PATH (tests/plan-step7.test.js `gitShim`): runs `action` (shell lines) once,
// when `condition` (a shell test) first holds at a git call, then hands every call on to the
// real git. Every git call runs from the toplevel, so `.commit-plan` names the run folder.
function gitShim(c, { condition, action }) {
  const dir = path.join(c.root, 'shim-bin');
  fs.mkdirSync(dir);
  const marker = path.join(c.root, 'shim-fired');
  const git = realGit(c);
  writeExecutable(path.join(dir, 'git'), [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ] && ${condition}; then`,
    `  : > '${marker}'`,
    ...action(git).map((line) => `  ${line} || { echo 'git shim action failed' >&2; exit 97; }`),
    'fi',
    `exec '${git}' "$@"`,
    '',
  ].join('\n'));
  return pathOverride(c, [dir, c.env.PATH]);
}

// M2 strips every inherited `GIT_*` from the plan's git calls, so a commit the shim makes sets
// the case's fixed identity inline.
function identityAssignments(c) {
  return ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']
    .map((key) => `${key}='${c.env[key]}'`).join(' ');
}

// An `ssh-ed25519` public-key line whose 32 key bytes are all `fill`
// (tests/plan-signing-agent.test.js).
function ed25519Line(fill, comment) {
  const sshString = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  };
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, fill))]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

// Each entry is one doc row in table order: `row` names it (compared by `firstColumnKey`),
// `producers` is its Producer cell verbatim, `kind`/`exitCode` its CLI kind and exit (`kind:
// null` for the success row). Each pair is `{ producer, seam1Case, skip?, message? }` or
// `{ producer, gap: { kd?, accepted? } }`.
const ROWS = [
  {
    row: 'bad argv or flag combination, malformed planId',
    producers: 'M1',
    kind: 'usage',
    exitCode: 1,
    pairs: [{
      producer: 'M1',
      // No subcommand at all (also tests/commit-entry.test.js).
      seam1Case: (t) => runCommit(createCase(t), []),
    }],
  },
  {
    row: 'unconfirmed',
    producers: 'M16',
    kind: 'usage',
    exitCode: 1,
    pairs: [{
      producer: 'M16',
      message: /confirm/,
      // EXE-22: a run left in `confirm` by a real `check --plan` over a worker plan naming a
      // new file (tests/commit-open.test.js) refuses a bare `commit --all`.
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('a.txt', 'one\nmore\n');
        c.writeFile('new.txt', 'new\n');
        const planned = await runCommit(c, ['plan']);
        assert.equal(planned.exitCode, 0, detail(planned));
        const { planId, runDir } = planned.json;
        fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
          version: 1,
          source: 'worker',
          groups: [{ header: 'feat: x', body: null, files: ['a.txt', 'new.txt'], hunks: [] }],
          notIncluded: [],
        }));
        const checked = await runCommit(c, ['check', '--plan', planId]);
        assert.equal(checked.json.reply.handback.kind, 'confirm', detail(checked));
        return runCommit(c, ['commit', '--plan', planId, '--all']);
      },
    }],
  },
  {
    row: 'staged-empty',
    producers: 'M15 `resolveMode` via M18',
    kind: 'usage',
    exitCode: 1,
    pairs: [{
      producer: 'M15 resolveMode via M18',
      // RUN-13: `plan --staged` with an empty index (tests/plan-mode.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'a\n' });
        c.writeFile('a.txt', 'a2\n');
        return runCommit(c, ['plan', '--staged']);
      },
    }],
  },
  {
    row: 'already-committed',
    producers: 'M15 `checkGate`',
    kind: 'usage',
    exitCode: 1,
    pairs: [{
      producer: 'M15 checkGate',
      // RUN-19: `check` once a stored group is committed. A group marked committed by hand
      // stands in for a budget stop (EXE-16) having committed it
      // (tests/check-already-committed.test.js builds the real budget-stop case).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('a.txt', 'two\n');
        const planned = await runCommit(c, ['plan']);
        const { planId, runDir } = planned.json;
        const statePath = path.join(runDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.groups = [{
          n: 1, units: state.units.map((unit) => unit.id), header: 'feat: change a', body: null, committed: true,
        }];
        fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        return runCommit(c, ['check', '--plan', planId]);
      },
    }],
  },
  {
    row: 'no-groups',
    producers: 'M16',
    kind: 'usage',
    exitCode: 1,
    pairs: [{
      producer: 'M16',
      message: /no groups/,
      // EXE-05: `commit --all` on a `plan --split` run before `check` stored any group
      // (tests/commit-open.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('a.txt', 'two\n');
        const planned = await runCommit(c, ['plan', '--split']);
        return commitAll(c, planned.json.planId);
      },
    }],
  },
  {
    row: 'config',
    producers: 'M4, M7',
    kind: 'config',
    exitCode: 1,
    pairs: [
      {
        producer: 'M4',
        // CFG-02: unparseable JSON in the repo config layer (tests/plan-pre-folder-refusals.test.js).
        async seam1Case(t) {
          const c = createCase(t);
          c.writeFile('.claude/commit.json', '{ "types": [');
          return runCommit(c, ['plan']);
        },
      },
      {
        producer: 'M7',
        message: /scanIgnore pattern/,
        // A `scanIgnore` glob M7 cannot compile, committed at HEAD
        // (tests/plan-config-scanignore.test.js).
        async seam1Case(t) {
          const c = seededCase(t, { '.claude/commit.json': '{ "scanIgnore": ["src/{a,b}.js"] }', 'a.txt': 'one\n' });
          c.writeFile('a.txt', 'one\nmore\n');
          return runCommit(c, ['plan']);
        },
      },
    ],
  },
  {
    row: 'env (install path, M3)',
    producers: 'entry point, M3',
    kind: 'env',
    exitCode: 1,
    pairs: [
      // The entry point's own refusals: an install path with a shell-special character
      // (tests/handback-commands.test.js); a Node below 22 stays an accepted gap (REL-04).
      {
        producer: 'entry point',
        async seam1Case(t) {
          const c = createCase(t);
          const dest = path.join(c.root, 'in$stall');
          fs.cpSync(path.join(__dirname, '..', 'plugin', 'scripts'), dest, { recursive: true });
          return runCommit(c, ['plan'], { script: path.join(dest, 'commit.cjs') });
        },
      },
      {
        producer: 'M3',
        // GIT-01: no git on PATH (tests/plan-pre-folder-refusals.test.js).
        async seam1Case(t) {
          const c = createCase(t);
          const emptyBin = path.join(c.root, 'empty-bin');
          fs.mkdirSync(emptyBin);
          return runCommit(c, ['plan'], { env: pathOverride(c, [emptyBin]) });
        },
      },
    ],
  },
  {
    row: 'not-a-repo, bare, in-progress, unmerged, unborn, merge, encoding',
    producers: 'M3 via M15',
    kind: 'state',
    exitCode: 6,
    pairs: [{
      producer: 'M3 via M15',
      // GIT-01: `plan` outside any repository (tests/plan-pre-folder-refusals.test.js).
      async seam1Case(t) {
        const c = createCase(t, { repo: false });
        return runCommit(c, ['plan'], { cwd: c.root });
      },
    }],
  },
  {
    row: 'run-folder',
    producers: 'M12',
    kind: 'state',
    exitCode: 6,
    pairs: [{
      producer: 'M12',
      message: /`\.commit-plan` is tracked or not a plain directory/,
      // RUN-05: `.commit-plan` is a plain file (tests/plan-run-folder.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        fs.writeFileSync(path.join(c.repoDir, '.commit-plan'), 'mine\n');
        return runCommit(c, ['plan']);
      },
    }],
  },
  {
    row: 'killed-leftover',
    producers: 'M15 `resolveMode` via M18',
    kind: 'state',
    exitCode: 6,
    pairs: [{
      producer: 'M15 resolveMode via M18',
      message: /^a killed \/commit run left staging behind, and more was staged since: `a\.txt`; /,
      // RUN-24: a killed run's staging plus another staged file, an aged lock, `--no-user`
      // (tests/plan-killed-leftover.test.js drives the real SIGKILL).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
        c.writeFile('a.txt', 'one\nmore\n');
        c.writeFile('b.txt', 'two\nmore\n');
        c.git(['add', '--', 'a.txt']);
        const planned = await runCommit(c, ['plan', '--split']);
        assert.equal(planned.exitCode, 0, detail(planned));
        const statePath = path.join(planned.json.runDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.groups = [{
          n: 1, units: state.units.filter((unit) => unit.path === 'a.txt').map((unit) => unit.id),
          header: 'feat: change a', body: null, committed: false,
        }];
        state.indexReset = true;
        fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        c.git(['add', '--', 'b.txt']);
        const lockPath = path.join(path.dirname(planned.json.runDir), 'lock');
        const then = new Date(Date.now() - 20 * 60_000);
        fs.utimesSync(lockPath, then, then);
        return runCommit(c, ['plan', '--split', '--no-user']);
      },
    }],
  },
  {
    row: 'case-rename',
    producers: 'M10 `unplannableCaseRenames` via M18',
    kind: 'state',
    exitCode: 6,
    pairs: [{
      producer: 'M10 unplannableCaseRenames via M18',
      // CHG-07: a staged case-only `git mv` with `core.ignorecase=true`
      // (tests/plan-units-config.test.js).
      async seam1Case(t) {
        const c = createCase(t);
        c.git(['config', 'core.ignorecase', 'true']);
        c.writeFile('readme.txt', 'r\n');
        c.git(['add', '--', 'readme.txt']);
        c.git(['commit', '-q', '-m', 'seed']);
        c.git(['mv', 'readme.txt', 'README.txt']);
        return runCommit(c, ['plan']);
      },
    }],
  },
  {
    row: 'signing-locked',
    producers: 'M11 via M15',
    kind: 'signing',
    exitCode: 6,
    pairs: [{
      producer: 'M11 via M15',
      skip: SHIM_SKIP,
      // GIT-12: SSH signing with a literal key that the `ssh-add` beside git's `ssh-keygen`
      // does not list (tests/plan-signing-agent.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'README.md': 'hello\n' });
        c.writeFile('README.md', 'changed\n');
        c.git(['config', 'commit.gpgsign', 'true']);
        c.git(['config', 'gpg.format', 'ssh']);
        c.git(['config', 'user.signingKey', `key::${ed25519Line(7, 'fixture@example')}`]);
        const dir = path.join(c.root, 'ssh-shim');
        fs.mkdirSync(dir);
        writeExecutable(path.join(dir, 'ssh-keygen'), '#!/bin/sh\nexit 99\n');
        writeExecutable(path.join(dir, 'ssh-add'),
          `#!/bin/sh\n[ "$1" = "-L" ] || exit 64\necho '${ed25519Line(9, 'other@example')}'\n`);
        return runCommit(c, ['plan'], { env: pathOverride(c, [dir, c.env.PATH]) });
      },
    }],
  },
  {
    row: 'pushed',
    producers: 'M3 via M15',
    kind: 'pushed',
    exitCode: 6,
    pairs: [{
      producer: 'M3 via M15',
      // GIT-09: `plan --reword` on a HEAD a remote-tracking ref points at
      // (tests/plan-reword-facts.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        return runCommit(c, ['plan', '--reword']);
      },
    }],
  },
  {
    row: 'staged-hit',
    producers: 'M15',
    kind: 'staged-hit',
    exitCode: 6,
    pairs: [{
      producer: 'M15',
      // CHG-14: `plan --staged` with a force-added hidden `.env` (tests/plan-staged.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'a\n' });
        c.writeFile('.env', 'SECRET=1\n');
        c.git(['add', '-f', '--', '.env']);
        c.writeFile('a.txt', 'a2\n');
        return runCommit(c, ['plan', '--staged']);
      },
    }],
  },
  {
    row: 'held, taken-over, ended, busy',
    producers: 'M12',
    kind: 'lock',
    exitCode: 6,
    pairs: [{
      producer: 'M12',
      message: /already ended/,
      // RUN-04: `commit --plan X --all` with no lock at all (tests/commit-open.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        return commitAll(c, UNKNOWN_PLAN_ID);
      },
    }],
  },
  {
    row: 'index-locked',
    producers: 'M10 via M16; M10 via M18 (`plan` step 3 takeover repair)',
    kind: 'index-lock',
    exitCode: 6,
    pairs: [
      {
        producer: 'M10 via M16',
        // EXE-08: an `index.lock` created before the call (tests/commit-all.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          fs.writeFileSync(path.join(c.repoDir, '.git', 'index.lock'), 'foreign lock\n');
          return commitAll(c, planId);
        },
      },
      {
        producer: 'M10 via M18',
        // RUN-25: a foreign `index.lock` blocks a takeover's repair (tests/plan-takeover-chain.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          const runDir = path.join(c.repoDir, '.commit-plan');
          const statePath = path.join(runDir, planId, 'state.json');
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          state.indexReset = true;
          fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
          c.git(['add', '--', 'a.txt', 'b.txt']);
          const then = new Date(Date.now() - 20 * 60_000);
          fs.utimesSync(path.join(runDir, 'lock'), then, then);
          fs.writeFileSync(path.join(c.repoDir, '.git', 'index.lock'), 'foreign lock\n');
          return runCommit(c, ['plan', '--split']);
        },
      },
    ],
  },
  {
    // `unmatched` reaches both producers; `mismatch` (phase (c), staged differs from the
    // group) has its own M16 case in tests/commit-all-stage-failed.test.js (EXE-10).
    row: 'unmatched, mismatch',
    producers: 'M10 via `plan --hunks` and M16',
    kind: 'diff-changed',
    exitCode: 6,
    pairs: [
      {
        producer: 'M10 via plan --hunks',
        message: /^files changed since plan/,
        // CHG-19 AC1: a file edited between plan and a separate plan --hunks
        // (tests/plan-hunks-resnapshot.test.js).
        async seam1Case(t) {
          const { c, planId } = await hunkRun(t);
          c.writeFile('a.txt', numbered(30).replace('2\n', 'TWO\n').replace('28\n', 'twenty-eight\n'));
          return planHunks(c, planId);
        },
      },
      {
        producer: 'M16',
        message: /^files changed since plan/,
        // EXE-09: a planned file edited after plan (tests/commit-all.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          c.writeFile('a.txt', 'one\nedited after plan\n');
          return commitAll(c, planId);
        },
      },
    ],
  },
  {
    row: 'index-changed',
    producers: 'M18 `plan` step 7; M16 before each group',
    kind: 'diff-changed',
    exitCode: 6,
    pairs: [
      {
        producer: 'M18 plan step 7',
        skip: SHIM_SKIP,
        message: /^the index changed since plan/,
        // CHG-04: an outside `git add` lands between step 4's fingerprint and step 7's re-read,
        // fired by the shim at the first `ls-files --stage` once the lock exists (the step-7
        // fingerprint; tests/plan-step7.test.js's head-moved case keys on the HEAD re-read).
        async seam1Case(t) {
          const c = seededCase(t, { 'a.txt': 'one\n' });
          c.writeFile('a.txt', 'one\nmore\n');
          const env = gitShim(c, {
            condition: '[ -e .commit-plan/lock ] && [ "$1" = "ls-files" ] && [ "$2" = "--stage" ]',
            action: (git) => ["printf 'other\\n' > other.txt", `'${git}' add -- other.txt`],
          });
          return runCommit(c, ['plan'], { env });
        },
      },
      {
        producer: 'M16',
        message: /^the index changed since plan/,
        // EXE-07: a `git add` of another file between plan and commit (tests/commit-all.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          c.writeFile('other.txt', 'other\n');
          c.git(['add', '--', 'other.txt']);
          return commitAll(c, planId);
        },
      },
    ],
  },
  {
    row: 'head-moved',
    producers: 'M3 via `plan` (after `acquire`), `plan --hunks` and M16',
    kind: 'head-moved',
    exitCode: 6,
    pairs: [
      {
        producer: 'M3 via plan after acquire',
        skip: SHIM_SKIP,
        // RUN-06: a commit made once the lock is held, at the step-7 HEAD re-read
        // (tests/plan-step7.test.js).
        async seam1Case(t) {
          const c = seededCase(t, { 'a.txt': 'one\n' });
          c.writeFile('a.txt', 'one\nmore\n');
          const env = gitShim(c, {
            condition: '[ -e .commit-plan/lock ] && [ "$*" = "rev-parse --verify -q HEAD" ]',
            action: (git) => [`${identityAssignments(c)} '${git}' commit -q --allow-empty -m moved`],
          });
          return runCommit(c, ['plan'], { env });
        },
      },
      {
        producer: 'plan --hunks',
        // CHG-19 AC2: a manual commit between plan and a separate plan --hunks
        // (tests/plan-hunks-resnapshot.test.js).
        async seam1Case(t) {
          const { c, planId } = await hunkRun(t);
          c.git(['commit', '-q', '-a', '-m', 'by hand']);
          return planHunks(c, planId);
        },
      },
      {
        producer: 'M16',
        // EXE-06: a manual commit between plan and commit (tests/commit-all.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          c.git(['commit', '-q', '--allow-empty', '-m', 'manual']);
          return commitAll(c, planId);
        },
      },
    ],
  },
  {
    row: 'lint',
    producers: 'M14',
    kind: 'lint',
    exitCode: 2,
    pairs: [{
      producer: 'M14',
      // PLN-01: `check` on a run whose folder holds no `plan.groups.json`.
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('a.txt', 'two\n');
        const planned = await runCommit(c, ['plan']);
        return runCommit(c, ['check', '--plan', planned.json.planId]);
      },
    }],
  },
  {
    row: 'backstop-hit',
    producers: 'M8 via M16',
    kind: 'scan',
    exitCode: 3,
    pairs: [{
      producer: 'M8 via M16',
      message: /^the scan before committing group 1 found a possible secret/,
      // EXE-13: a stored group holding a `ghp_` token (built at run time) that `plan`'s
      // recorded scan map no longer names (tests/commit-all-backstop.test.js).
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('key.js', `const token = "${'gh' + 'p_' + 'q'.repeat(36)}";\n`);
        const planned = await runCommit(c, ['plan', '--split']);
        assert.equal(planned.exitCode, 0, detail(planned));
        const statePath = path.join(planned.json.runDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header: 'feat: add key', body: null, committed: false }];
        state.scanned = {};
        fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        return commitAll(c, planned.json.planId);
      },
    }],
  },
  {
    row: 'git-failed',
    producers: 'M16, M10 via M18 and M16',
    kind: 'git',
    exitCode: 4,
    pairs: [
      {
        producer: 'M16',
        message: /^git commit failed for group 1$/,
        // EXE-12: group 1's own `git commit` rejected by a `pre-commit` hook
        // (tests/commit-all-git-failed.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
          fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
          fs.chmodSync(hook, 0o755);
          return commitAll(c, planId);
        },
      },
      {
        producer: 'M10 via M18',
        message: /git add failed/,
        // CHG-19: a stored candidate ignored since plan makes the separate plan --hunks call's
        // `git add -N` fail (tests/plan-hunks-resnapshot.test.js).
        async seam1Case(t) {
          const { c, planId } = await hunkRun(t);
          fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '\nnew.txt\n');
          return planHunks(c, planId);
        },
      },
      {
        producer: 'M10 via M16',
        message: /git add -N failed/,
        // EXE-09: the same on `commit`'s phase (b) rebuild (tests/commit-all.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t, { extraCandidate: true });
          fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '\nnew.txt\n');
          return commitAll(c, planId);
        },
      },
    ],
  },
  {
    row: 'stage-failed',
    producers: 'M10 via M16',
    kind: 'git',
    exitCode: 4,
    pairs: [{
      producer: 'M10 via M16',
      message: /^staging failed for group 1/,
      // EXE-10: `core.safecrlf=true` set after plan makes phase (c)'s `git add` of the
      // whole-file `new.txt` die (tests/commit-all-stage-failed.test.js).
      async seam1Case(t) {
        const { c, planId } = await groupedRun(t, { extraCandidate: true, groupExtra: true });
        c.git(['config', 'core.autocrlf', 'true']);
        c.git(['config', 'core.safecrlf', 'true']);
        return commitAll(c, planId);
      },
    }],
  },
  {
    row: 'timed-out',
    producers: 'M2 via M16 and M18',
    kind: 'timeout',
    exitCode: 5,
    pairs: [
      {
        producer: 'M2 via M16',
        message: /^git commit did not finish in 9 min/,
        // EXE-17: the clock reads 535 s from the first group, so a sleeping `pre-commit` hook
        // outlives `git commit`'s 5 s budget (tests/commit-all-timeout.test.js).
        async seam1Case(t) {
          const { c, planId } = await groupedRun(t);
          const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
          fs.writeFileSync(hook, '#!/bin/sh\nexec sleep 120\n');
          fs.chmodSync(hook, 0o755);
          const marker = path.join(c.root, 'clock-marker');
          fs.writeFileSync(marker, '');
          const schedulePath = path.join(c.root, 'schedule.json');
          fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: marker }, elapsedMs: 535_000 }]));
          return runCommit(c, ['commit', '--plan', planId, '--all'], {
            nodeArgs: ['--import', CLOCK_PRELOAD],
            env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
          });
        },
      },
      {
        producer: 'M2 via M18',
        // CHG-19 AC5: a separate plan --hunks call whose own clock crosses 540 s once its
        // `call.lock` exists (tests/plan-hunks-resnapshot.test.js).
        async seam1Case(t) {
          const { c, planId } = await hunkRun(t);
          const schedulePath = path.join(c.root, 'schedule.json');
          const callLock = path.join(c.repoDir, '.commit-plan', planId, 'call.lock');
          fs.writeFileSync(schedulePath, JSON.stringify([{ event: { type: 'path', path: callLock }, elapsedMs: 541_000 }]));
          return planHunks(c, planId, {
            nodeArgs: ['--import', CLOCK_PRELOAD],
            env: { COMMIT_TEST_CLOCK_SCHEDULE: schedulePath },
          });
        },
      },
    ],
  },
  {
    // INT-31 AC2: the EXE-01 item 3 case (tests/commit-all-timeout.test.js "the state.json
    // write failing after git commit landed"). A `staged` run's `commit --all` writes no
    // state.json before `git commit`, so the FND-10 preload failing the state.json rename with
    // EIO first hits the write after the commit landed. Producer "any" is wider: a `plan`
    // throw reaches the same kind and exit (tests/plan-lock.test.js, tests/run-file-in-use.test.js).
    row: 'unexpected throw -> internal',
    producers: 'any',
    kind: 'internal',
    exitCode: 1,
    pairs: [{
      producer: 'any',
      message: /^committed as `[0-9a-f]{40}`, but the script failed$/,
      async seam1Case(t) {
        const c = seededCase(t, { 'a.txt': 'one\n' });
        c.writeFile('a.txt', 'one\nmore\n');
        c.git(['add', '--', 'a.txt']);
        const planned = await runCommit(c, ['plan', '--staged']);
        assert.equal(planned.exitCode, 0, detail(planned));
        const statePath = path.join(planned.json.runDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        state.groups = [{
          n: 1, units: state.units.map((unit) => unit.id), header: 'feat: staged change', body: null, committed: false,
        }];
        fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
        const result = await runCommit(c, ['commit', '--plan', planned.json.planId, '--all'], {
          nodeArgs: ['--import', FAULT_PRELOAD],
          env: { COMMIT_TEST_FAULT_RENAME_BASENAME: 'state.json' },
        });
        // Run by the harness after its exit-code check, so a missing JSON reports detail().
        result.afterExit = () => {
          assert.equal(result.json.sha, c.git(['rev-parse', 'HEAD']).trim(), detail(result));
          assert.equal(fs.existsSync(path.join(path.dirname(planned.json.runDir), 'lock')), false, 'the run lock is released');
          assert.equal(fs.existsSync(planned.json.runDir), false, 'the run folder is released');
        };
        return result;
      },
    }],
  },
  {
    row: 'clean tree (nothing)',
    producers: 'M15 `planRefusal`',
    kind: null,
    exitCode: 0,
    pairs: [{
      producer: 'M15 planRefusal',
      // RUN-15: `plan` on a freshly committed tree (tests/plan-walking-skeleton.test.js).
      seam1Case: (t) => runCommit(seededCase(t, { 'a.txt': 'one\n' }), ['plan']),
    }],
  },
];

for (const entry of ROWS) {
  for (const pair of entry.pairs) {
    if (pair.gap !== undefined) continue;
    const outcome = entry.kind === null ? 'success "nothing"' : entry.kind;
    test(`row "${entry.row}" via ${pair.producer}: Seam 1 reaches exit ${entry.exitCode} ${outcome}`, { skip: pair.skip ?? false }, async (t) => {
      const result = await pair.seam1Case(t);
      assert.equal(result.exitCode, entry.exitCode, detail(result));
      result.afterExit?.();
      if (entry.kind === null) {
        assert.equal(result.json.ok, true, detail(result));
        assert.equal(result.json.reply.status, 'nothing', detail(result));
      } else {
        assert.equal(result.json.error.kind, entry.kind, detail(result));
        if (pair.message) assert.match(result.json.error.message, pair.message, detail(result));
      }
    });
  }
}

function acceptedGapsText() {
  const readme = fs.readFileSync(path.join(ROADMAP, 'README.md'), 'utf8');
  return readme.split('## Accepted gaps')[1].split('\n## ')[0];
}

// Every disagreement between the doc's table and the manifest, as text; [] when they agree.
// Not hard-coded: the doc is the oracle for the row count and, per row (in table order), what
// it names, its Producer cell and its CLI kind and exit. A manifest label may carry a shorter
// or different aside than the doc row, so names compare on `firstColumnKey`, and a label
// naming more than the doc's key passes when it starts with that key.
function manifestProblems(docTable, rows) {
  const problems = [];
  if (rows.length !== docTable.length) problems.push(`${docTable.length} doc rows, ${rows.length} manifest rows`);
  const kdText = fs.readFileSync(path.join(ROADMAP, 'known-deficiencies.md'), 'utf8');
  const accepted = acceptedGapsText();
  docTable.forEach((doc, i) => {
    const entry = rows[i];
    if (entry === undefined) {
      problems.push(`doc row ${JSON.stringify(doc.code)} has no manifest entry`);
      return;
    }
    const docKey = firstColumnKey(doc.code);
    const manifestKey = firstColumnKey(entry.row);
    // A manifest key naming more than the doc's key passes only when the doc's key is a whole
    // leading name, not merely a prefix (e.g. "head" must not match a doc key "head-moved").
    const manifestExtra = manifestKey.slice(docKey.length);
    const keyMatches = manifestKey === docKey
      || (manifestKey.startsWith(docKey) && /^[,\s]/.test(manifestExtra));
    if (!keyMatches) {
      problems.push(`ROWS[${i}] ${JSON.stringify(entry.row)} does not match doc row ${JSON.stringify(doc.code)}`);
    }
    if (entry.producers !== doc.producer) {
      problems.push(`ROWS[${i}] producers ${JSON.stringify(entry.producers)} vs doc ${JSON.stringify(doc.producer)}`);
    }
    const docKind = doc.kind.startsWith('none') ? null : doc.kind.replace(/`/g, '');
    if (entry.kind !== docKind || String(entry.exitCode) !== doc.exit) {
      problems.push(`ROWS[${i}] ${entry.kind} ${entry.exitCode} vs doc ${doc.kind} ${doc.exit}`);
    }
    if (entry.pairs.length === 0) problems.push(`ROWS[${i}] names no (row, producer) pair`);
    // The Producer cell lists its producers separated by "; ", ", " or " and "; the pair count
    // must track it so dropping a pair (without also removing its producer from the cell) fails.
    const producerSegments = entry.producers.split(/\s*;\s*|\s*,\s*|\s+and\s+/).filter(Boolean);
    if (entry.pairs.length !== producerSegments.length) {
      problems.push(`ROWS[${i}] has ${entry.pairs.length} pair(s) but producers ${JSON.stringify(entry.producers)} splits into ${producerSegments.length}`);
    }
    for (const pair of entry.pairs) {
      const label = `ROWS[${i}] via ${pair.producer}`;
      if (pair.gap === undefined) {
        if (typeof pair.seam1Case !== 'function') problems.push(`${label} has neither a Seam 1 case nor a gap`);
        continue;
      }
      const { kd, accepted: acceptedText } = pair.gap;
      if (kd === undefined && acceptedText === undefined) problems.push(`${label} names an empty gap`);
      if (kd !== undefined && !kdText.includes(`**${kd}.**`)) problems.push(`${label} cites ${kd}, not in known-deficiencies.md`);
      if (acceptedText !== undefined && !accepted.includes(acceptedText)) {
        problems.push(`${label} cites an accepted gap not in docs/roadmap/README.md`);
      }
    }
  });
  return problems;
}

test('every (row, producer) pair of docs/spec/domain-code-cli-kind.md has a Seam 1 case or a cited gap', () => {
  assert.deepEqual(manifestProblems(parseDomainCodeDocTable(), ROWS), []);
});

test('a table whose header is not "Domain code | Producer | CLI kind | Exit" throws', () => {
  const content = [
    '| Producer | Domain code | CLI kind | Exit |',
    '| --- | --- | --- | --- |',
    '| `foo` | M1 | `usage` | 1 |',
  ].join('\n');
  assert.throws(() => parseDomainCodeDocTable(content), /header is/);
});

test('a table row that does not split into four cells throws', () => {
  const content = [
    '| Domain code | Producer | CLI kind | Exit | extra |',
    '| --- | --- | --- | --- | --- |',
    '| `foo` | M1 | `usage` | 1 | extra |',
  ].join('\n');
  assert.throws(() => parseDomainCodeDocTable(content), /has 5 cells, not 4/);
});

test('a doc row added without a manifest entry fails the check', () => {
  const docTable = parseDomainCodeDocTable();
  const added = [...docTable, { code: '`new-code`', producer: 'M16', kind: '`usage`', exit: '1' }];
  assert.ok(manifestProblems(added, ROWS).includes('doc row "`new-code`" has no manifest entry'));
});

test('a changed Producer cell or a gap citing no KD row fails the check', () => {
  const docTable = parseDomainCodeDocTable();
  const changed = docTable.map((row, i) => (i === 0 ? { ...row, producer: 'M1, M99' } : row));
  assert.deepEqual(
    manifestProblems(changed, ROWS),
    [`ROWS[0] producers ${JSON.stringify(ROWS[0].producers)} vs doc ${JSON.stringify('M1, M99')}`],
  );
  const stale = ROWS.map((entry, i) => (i === 1 ? { ...entry, pairs: [{ producer: 'M16', gap: { kd: 'KD-R0' } }] } : entry));
  assert.deepEqual(manifestProblems(docTable, stale), ['ROWS[1] via M16 cites KD-R0, not in known-deficiencies.md']);
});

test('a dropped pair, with the Producer cell left unchanged, fails the check', () => {
  const docTable = parseDomainCodeDocTable();
  const configIndex = ROWS.findIndex((entry) => entry.row === 'config');
  assert.equal(ROWS[configIndex].pairs.length, 2, 'fixture assumption: the config row names two pairs');
  const dropped = ROWS.map((entry, i) => (i === configIndex ? { ...entry, pairs: [entry.pairs[0]] } : entry));
  assert.deepEqual(
    manifestProblems(docTable, dropped),
    [`ROWS[${configIndex}] has 1 pair(s) but producers ${JSON.stringify(ROWS[configIndex].producers)} splits into 2`],
  );
});
