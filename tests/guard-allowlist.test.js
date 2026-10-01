'use strict';

// GRD-04: the Q4 allowlist and the generic deny, through G1 `runHook` (Seam 3) and the real
// hook process (Seam 2). G3 expands `commit`'s arguments (short clusters, attached values,
// `--opt=value`) and applies the allowlist; every other flag or argument is denied naming it,
// and the bare/`-m`/`-F`/`--message`/`--file` row applies only when nothing else matches
// (C:guard Parsing step 5, Precedence, Deny messages; Q4, Q21).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: c.root,
  });
  return { ...runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) }) };
}

const generic = (flag) => `git commit ${flag} is not allowed here. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

const allowed = [
  'git commit --no-edit',
  'git commit --amend --no-edit',
  'git commit --no-edit --amend',
  'git commit --no-edit -q',
  'git commit -q --no-edit',
  'git commit --no-edit --quiet',
  'git commit --quiet --amend --no-edit',
  'git commit --fixup=1a2b3c4',
  'git commit --fixup 1a2b3c4',
  'git commit --fixup=1a2b3c4 -q',
  'git commit -q --fixup=1a2b3c4',
  'git commit --quiet --fixup=HEAD~1',
  'git commit --no-edit 2>&1 >/dev/null',
  '(git commit --no-edit)',
  'cd sub && git commit --no-edit',
];
for (const command of allowed) {
  test(`Seam 3: ${JSON.stringify(command)} has no output (Q4 allowlist)`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: '', stderr: '' });
  });
}

const bareRow = [
  'git commit',
  'git commit -F msg.txt',
  'git commit --message x',
  'git commit --message=x',
  'git commit --file msg.txt',
  'git commit --file=msg.txt',
  'git commit -mfoo',
  'git commit -q',
  'git commit --no-edit -m x',
  'git commit -m x --fixup=1a2b3c4',
];
for (const command of bareRow) {
  test(`Seam 3: ${JSON.stringify(command)} is denied with the bare-commit text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(MESSAGES.bare), stderr: '' });
  });
}

const genericRow = [
  ['git commit -t tpl.txt', '-t'],
  ['git commit -a', '-a'],
  ['git commit --allow-empty', '--allow-empty'],
  ['git commit --allow-empty-message -m x', '--allow-empty-message'],
  ['git commit --no-edit src/a.js', 'src/a.js'],
  ['git commit --no-edit -- src/a.js', '--'],
  ['git commit --', '--'],
  // C:guard Precedence (D2): the generic row outranks the bare/`-m` row.
  ['git commit -am x', '-a'],
  ['git commit -m x -a', '-a'],
  ['git commit -F msg.txt --allow-empty', '--allow-empty'],
  // The form is set by the first `--no-edit` or plain `--fixup`; the other is outside it.
  ['git commit --no-edit --fixup=1a2b3c4', '--fixup'],
  ['git commit --fixup=1a2b3c4 --no-edit', '--no-edit'],
  ['git commit --fixup=1a2b3c4 --amend', '--amend'],
  ['git commit --amend', '--amend'],
  ['git commit --no-edit -qa', '-a'],
  ['git commit --no-edit --verbose', '--verbose'],
  ['git commit --no-ed', '--no-ed'],
  ['git commit --no-edit --all=x', '--all'],
  // A flag that takes no value is outside the allowlist when given one.
  ['git commit --no-edit=x', '--no-edit'],
  ['git commit --no-edit --quiet=x', '--quiet'],
  ['git commit --fixup=1a2b3c4 -q --amend=x', '--amend'],
];
for (const [command, flag] of genericRow) {
  test(`Seam 3: ${JSON.stringify(command)} is denied by the generic row naming ${flag}`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(generic(flag)), stderr: '' });
  });
}

test('Seam 3: `-am x` names `-a` in the generic text, not the bare/`-m` text', (t) => {
  const c = createCase(t, { repo: false });
  const reason = JSON.parse(hook(c, 'git commit -am x').stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith('git commit -a is not allowed here. Spawn the commit:commit-worker agent'), reason);
  assert.ok(!reason.includes('Direct git commit is blocked'));
});

test('Seam 3: `git commit --no-edit # done` is denied by the blanket rule; without the comment it is allowed', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, 'git commit --no-edit # done'), { stdout: denyJson(MESSAGES.blanket), stderr: '' });
  assert.deepEqual(hook(c, 'git commit --no-edit'), { stdout: '', stderr: '' });
});

// A commit argument the shell may turn into another word or several (C:guard step 4) is
// never allowlisted: `--fixup $s` could run `--fixup HEAD --no-verify`.
const notLiteral = [
  'git commit --fixup $s',
  'git commit --no-edit $x',
  'git commit --fixup {HEAD,--no-verify}',
  'git commit --no-edit *',
  'git commit --fixup=HEAD~[1]',
];
for (const command of notLiteral) {
  test(`Seam 3: ${JSON.stringify(command)} is denied with the literal-arguments text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(MESSAGES.literalArguments), stderr: '' });
  });
}

test('Seam 3: a second `git commit` in the same segment is classified too', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, 'git commit --no-edit; xargs git commit -a'), { stdout: denyJson(generic('-a')), stderr: '' });
});

test('Seam 2: a deny with `COMMIT_GUARD=off` and similar variables set is still denied (no env switch, Q4)', async (t) => {
  const c = createCase(t);
  const env = {
    COMMIT_GUARD: 'off',
    COMMIT_GUARD_DISABLE: '1',
    COMMIT_GUARD_OFF: '1',
    COMMIT_GUARD_ALLOW: '1',
    COMMIT_HOOK: 'off',
    DISABLE_COMMIT_GUARD: '1',
    SKIP_COMMIT_GUARD: '1',
  };
  const denied = await runGuard(c, { command: 'git commit -a' }, { env });
  assert.equal(denied.exitCode, 0);
  assert.equal(denied.stdout, denyJson(generic('-a')));
  const bare = await runGuard(c, { command: 'git commit -m x' }, { env });
  assert.equal(bare.stdout, denyJson(MESSAGES.bare));
});

test('Seam 2: `git commit --no-edit` has no output from the real hook process', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'git commit --no-edit' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// The seed corpus (tests/fixtures/guard/segments-seed.json): every tokenized Bash case with
// no decision stays without output now that the allowlist opens, and the GRD-04 flag cases
// get their decision.
const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;
const GRD04_SEEDS = new Set(['b-fixup-q', 'b-fixup-separate', 'b-am', 'b-m-attached', 'b-pathspec', 'b-noedit-value', 'b-allow-empty']);
for (const s of seedCases.filter((x) => x.shell === 'bash' && x.segments.length > 0
  && (x.decision === 'none' || GRD04_SEEDS.has(x.id)))) {
  test(`Seam 3: seed ${s.id} → ${s.decision}`, (t) => {
    const c = createCase(t, { repo: false });
    assert.equal(hook(c, s.command).stdout === '', s.decision === 'none');
  });
}
test('the GRD-04 seed cases are all in the seed', () => {
  for (const id of GRD04_SEEDS) assert.ok(seedCases.some((x) => x.id === id), id);
});
