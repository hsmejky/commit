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

// --- malformed `planId`, across every subcommand that takes one (RPL-02 review finding 4:
// only `check --plan` was covered, and neither a wrong version nor variant nibble was) ---

const MALFORMED_PLAN_IDS = [
  ['uppercase', '3FA85F64-5717-4562-B3FC-2C963F66AFA6'],
  ['path traversal', '../../etc/passwd'],
  ['absolute path', '/etc/passwd'],
  ['not a UUID at all', 'not-a-plan-id'],
  // Well-formed except the version nibble is not `4` (choice 1 of the review's "implementer's
  // choices"; the strict pattern must reject this, not just anything that merely looks like a
  // UUID).
  ['wrong version nibble', '3fa85f64-5717-1562-b3fc-2c963f66afa6'],
  // Well-formed except the variant nibble is outside `8`-`b`.
  ['wrong variant nibble', '3fa85f64-5717-4562-c3fc-2c963f66afa6'],
];

const PLAN_ID_ARGV_BUILDERS = [
  ['check --plan', (id) => ['check', '--plan', id]],
  ['commit --plan --all', (id) => ['commit', '--plan', id, '--all']],
  ['release --plan', (id) => ['release', '--plan', id]],
  ['plan --hunks --plan', (id) => ['plan', '--hunks', '--plan', id]],
];

for (const [subLabel, buildArgv] of PLAN_ID_ARGV_BUILDERS) {
  for (const [label, value] of MALFORMED_PLAN_IDS) {
    test(`${subLabel} with a ${label} planId is a usage refusal`, async (t) => {
      await assertUsageRefusal(t, buildArgv(value));
    });
  }
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

// --- `--hunks` is a separate synopsis form from the mint form, and `--plan` belongs only to
// it (RPL-02 review finding 1: these two forms were not kept apart) ---

test('plan --plan <id> without --hunks is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--plan', VALID_PLAN_ID]);
});

test('plan --hunks --plan <id> --reword --dictated is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--hunks', '--plan', VALID_PLAN_ID, '--reword', '--dictated']);
});

test('plan --hunks with --take-over is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--hunks', '--plan', VALID_PLAN_ID, '--take-over', VALID_PLAN_ID]);
});

test('plan --hunks --split --no-user is a usage refusal', async (t) => {
  await assertUsageRefusal(t, ['plan', '--hunks', '--plan', VALID_PLAN_ID, '--split', '--no-user']);
});

// --- legal synopsis lines: Seam 1 smoke only ---
//
// The full synopsis is checked in bulk at Seam 3 (tests/cli.test.js) directly against the
// pure `parseArgv` export, not by spawning a subprocess for every line: a subprocess check
// depends on repo or index state the argv rules themselves never need, and is a fragile
// oracle for it (e.g. `plan --staged` on an empty index becomes a runtime `staged-empty`
// once M18 routes it, which is also a `usage` kind — RPL-02 review finding 2). These two
// cases only confirm the subprocess plumbing itself does not misroute a legal argv.

test('legal synopsis line ["plan"] is not refused usage (Seam 1 smoke)', async (t) => {
  await assertNotUsageRefusal(t, ['plan']);
});

test(
  'legal synopsis line ["commit","--plan",id,"--all","--confirmed"] is not refused usage (Seam 1 smoke)',
  async (t) => {
    await assertNotUsageRefusal(t, ['commit', '--plan', VALID_PLAN_ID, '--all', '--confirmed']);
  },
);

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

test('no per-subcommand flag name mentions scanning', async (t) => {
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
});

// RPL-02 review finding 3: the old check only grepped `commit.cjs`, but `commit.cjs` passes
// all of `process.env` into `main` (as `env.env`), so a lib module could read an env var
// unseen; and a bare `/scan/i` grep over a whole file false-fails on any future comment that
// merely mentions scanning. This greps `plugin/scripts/lib/*.mjs` and `commit.cjs` (the only
// place holding all of `process.env`; `guard.cjs` is a separate entry point, out of scope
// here) for every `env.<NAME>`, `env['<NAME>']`, `process.env.<NAME>` and
// `process.env['<NAME>']` read, and asserts each one against an allowlist: an addition here
// (a scan-gating var among them) now has to touch this list, not slip in unseen.
const ENV_READ_ALLOWLIST = new Set([
  'COMMIT_GUARD_DEBUG', // hook-io.mjs: guard debug output to stderr only, not scan-related.
  'USER', 'USERNAME', // commit.cjs: OS username fallback when os.userInfo() fails.
  'CLAUDE_CONFIG_DIR', // commit.cjs: the injected Claude home.
  'CLAUDE_PROJECT_DIR', // commit.cjs: the injected project directory (Q5, PRE-11).
  'cwd', // cli.mjs: `main`'s `env` param is the injected environment (Q9), not
         // `process.env`; `env.cwd` reads the injected cwd, not scan-related.
]);

// Excludes a dotted identifier chain (`process.env`) or a quote (a `.env`/`.env.example`
// filename string) immediately before `env`, so only a bare `env` or `process.env`
// identifier reference counts, never a string literal that happens to contain "env".
const BARE_ENV_DOT = /(?<![.\w])env\.(\w+)/g;
const BARE_ENV_BRACKET = /(?<![.\w])env\[(['"])(\w+)\1\]/g;
const PROCESS_ENV_DOT = /process\.env\.(\w+)/g;
const PROCESS_ENV_BRACKET = /process\.env\[(['"])(\w+)\1\]/g;

function envReadsIn(source) {
  const found = new Set();
  for (const m of source.matchAll(BARE_ENV_DOT)) found.add(m[1]);
  for (const m of source.matchAll(BARE_ENV_BRACKET)) found.add(m[2]);
  for (const m of source.matchAll(PROCESS_ENV_DOT)) found.add(m[1]);
  for (const m of source.matchAll(PROCESS_ENV_BRACKET)) found.add(m[2]);
  return found;
}

test('every env var read in plugin/scripts/lib/*.mjs and commit.cjs is on the allowlist', () => {
  const libDir = path.join(path.dirname(COMMIT_ENTRY), 'lib');
  const files = fs.readdirSync(libDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join(libDir, name));
  files.push(COMMIT_ENTRY);

  for (const file of files) {
    const found = envReadsIn(fs.readFileSync(file, 'utf8'));
    for (const name of found) {
      assert.equal(
        ENV_READ_ALLOWLIST.has(name),
        true,
        `${path.basename(file)} reads env var ${name}, which is not on the allowlist`,
      );
    }
  }
});
