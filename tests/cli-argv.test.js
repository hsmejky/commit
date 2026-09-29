'use strict';

// RPL-02 (docs/roadmap/11-reply-and-cli.md): per-subcommand argv and flag combinations.
// Seam 1 (docs/spec/testing-seams.md): drives the shipped `plugin/scripts/commit.cjs` as a
// subprocess over a temp repo. C:cli-and-exit-codes fixes the synopsis and flag rules;
// C:run-folder fixes the `planId` form; RPL-01 (done) built the envelope tracer this slice
// builds on, RPL-03 (done) built the domain-code -> kind side of the exit table.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit, COMMIT_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

// A lock `plan` would mint (`crypto.randomUUID()` form: lowercase UUID v4).
const VALID_PLAN_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function commitPlanPath(c) {
  return path.join(c.repoDir, '.commit-plan');
}

async function assertUsageRefusal(t, argv) {
  const c = createCase(t);
  const result = await runCommit(c, argv);
  assert.equal(result.exitCode, 1, `argv ${JSON.stringify(argv)} exit code`);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'usage', `argv ${JSON.stringify(argv)} -> ${JSON.stringify(result.json)}`);
  // AC: no refused call creates `.commit-plan` or runs git.
  assert.equal(fs.existsSync(commitPlanPath(c)), false, `argv ${JSON.stringify(argv)} must not create .commit-plan`);
  return result;
}

async function assertNotUsageRefusal(t, argv) {
  const c = createCase(t);
  const result = await runCommit(c, argv);
  assert.notEqual(
    result.json.error && result.json.error.kind,
    'usage',
    `argv ${JSON.stringify(argv)} was refused usage: ${JSON.stringify(result.json)}`,
  );
  return result;
}

// --- `--dictated` without `--reword` ---

test('plan --dictated without --reword is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--dictated']);
});

// --- `--no-user` illegal combinations ---

test('plan --no-user with --staged is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--no-user', '--staged']);
});

test('plan --no-user with --take-over is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--no-user', '--split', '--take-over', VALID_PLAN_ID]);
});

test('plan --no-user without --split or --reword is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--no-user']);
});

test('plan --no-user --split is legal (not a usage refusal)', async (t) => {
  await assertNotUsageRefusal(t, ['plan', '--no-user', '--split']);
});

test('plan --no-user --reword is legal (not a usage refusal)', async (t) => {
  await assertNotUsageRefusal(t, ['plan', '--no-user', '--reword']);
});

// --- `--no-no-user` and unknown flags ---

test('plan --no-no-user is a usage refusal (no-user is a literal flag, never negated)', async (t) => {
  await assertUsageRefusal(t, ['plan', '--no-no-user']);
});

test('an unknown flag on plan is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--bogus']);
});

test('an unknown flag on infer is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['infer', '--bogus']);
});

// --- malformed `planId` ---

for (const [label, value] of [
  ['uppercase', '3FA85F64-5717-4562-B3FC-2C963F66AFA6'],
  ['path traversal', '../../etc/passwd'],
  ['absolute path', '/etc/passwd'],
  ['not a UUID at all', 'not-a-plan-id'],
]) {
  test(`check --plan with a ${label} value is a usage refusal`, async (t) => {
    await assertUsageRefusal(t, ['check', '--plan', value]);
  });
}

test('plan --take-over with a malformed planId is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--split', '--take-over', 'not-a-plan-id']);
});

// --- two mode flags together ---

test('plan --staged --split is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--staged', '--split']);
});

test('plan --reword --staged is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--reword', '--staged']);
});

test('plan --reword --split is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--reword', '--split']);
});

// --- `--plan` required ---

test('check without --plan is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['check']);
});

test('commit without --plan is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['commit', '--all']);
});

test('release without --plan is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['release']);
});

// --- `commit --plan <id>` without `--all` ---

test('commit --plan <id> without --all is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['commit', '--plan', VALID_PLAN_ID]);
});

// --- `--confirmed` only on `commit` ---

test('plan --confirmed is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--confirmed']);
});

test('check --plan <id> --confirmed is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['check', '--plan', VALID_PLAN_ID, '--confirmed']);
});

// --- `plan --hunks` requires `--plan` ---

test('plan --hunks without --plan is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--hunks']);
});

// --- every legal synopsis line parses (not refused usage) ---

const LEGAL_ARGV = [
  ['plan'],
  ['plan', '--reword'],
  ['plan', '--reword', '--dictated'],
  ['plan', '--staged'],
  ['plan', '--split'],
  ['plan', '--take-over', VALID_PLAN_ID],
  ['plan', '--split', '--take-over', VALID_PLAN_ID],
  ['plan', '--no-user', '--split'],
  ['plan', '--no-user', '--reword'],
  ['plan', '--no-user', '--reword', '--dictated'],
  ['plan', '--hunks', '--plan', VALID_PLAN_ID],
  ['check', '--plan', VALID_PLAN_ID],
  ['commit', '--plan', VALID_PLAN_ID, '--all'],
  ['commit', '--plan', VALID_PLAN_ID, '--all', '--confirmed'],
  ['release', '--plan', VALID_PLAN_ID],
  ['infer'],
];

for (const argv of LEGAL_ARGV) {
  test(`legal synopsis line ${JSON.stringify(argv)} is not refused usage`, async (t) => {
    await assertNotUsageRefusal(t, argv);
  });
}

// --- no refused call runs git either (the case's repo stays untouched) ---

test('a refused call leaves the repo without new commits or staged changes', async (t) => {
  const c = createCase(t);
  c.writeFile('tracked.txt', 'hello\n');
  c.git(['add', 'tracked.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  const before = c.git(['rev-parse', 'HEAD']).trim();
  const beforeStatus = c.git(['status', '--porcelain']);

  await runCommit(c, ['plan', '--dictated']);

  assert.equal(c.git(['rev-parse', 'HEAD']).trim(), before);
  assert.equal(c.git(['status', '--porcelain']), beforeStatus);
  assert.equal(fs.existsSync(commitPlanPath(c)), false);
});

// --- no flag or env var disables the scan (story 146) ---

test('no per-subcommand flag name mentions scanning, and the entry point reads no scan-related env var', async (t) => {
  const { SUBCOMMAND_OPTIONS } = await loadLib('cli');
  for (const [subcommand, options] of Object.entries(SUBCOMMAND_OPTIONS)) {
    for (const flag of Object.keys(options)) {
      assert.equal(
        /scan/i.test(flag),
        false,
        `subcommand ${subcommand} declares a scan-related flag --${flag}`,
      );
    }
  }
  const entrySource = fs.readFileSync(COMMIT_ENTRY, 'utf8');
  assert.equal(
    /scan/i.test(entrySource),
    false,
    'the entry point must not reference scanning at all, let alone gate it on a flag or env var',
  );
});
