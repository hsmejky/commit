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
  // A trailing `--fixup` has no value, so it is not the plain form.
  ['git commit --fixup', '--fixup'],
  ['git commit --no-edit --fixup', '--fixup'],
  // `amend:` / `reword:` open an editor: the generic row until GRD-05's specific row.
  ['git commit --fixup=amend:1a2b3c4', '--fixup'],
  ['git commit --fixup=reword:1a2b3c4 -q', '--fixup'],
  // Attached optional values (`-S<keyid>`, `-u<mode>`) stay with their flag.
  ['git commit --no-edit -Sfoo', '-S'],
  ['git commit --no-edit -uno', '-u'],
  // `--no-edit` does not exempt `--squash` (C:guard step 5).
  ['git commit --no-edit --squash=HEAD', '--squash'],
  // An empty argument is named as `""`, not as an empty flag.
  ['git commit --no-edit ""', '""'],
  ["git commit ''", '""'],
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
  // The most common direct attempt, a scoped Conventional Commits subject, holds `(`: it gets
  // the literal-arguments text, which outranks the bare row (C:guard Precedence).
  'git commit -m "feat(x): y"',
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

// An argument-appending wrapper before `git` in the segment (`xargs`, `gxargs`, `parallel`) can
// add any option or message to an allowlisted form (`printf -- -n | xargs git commit --no-edit`
// skips the hooks), so the form is denied there (C:guard step 3, fail closed). A token before
// `git` holding a glob or brace character (`*`, `?`, `[`, `{`) may expand to a wrapper's name
// (`/usr/bin/x[a]rgs`, `xargs{,}`), so it counts as one and is named as written. Its row ranks
// just above the bare row: a form already outside the allowlist keeps its own, more specific row.
const wrapper = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;
const wrapperRow = [
  ['xargs git commit --no-edit', 'xargs'],
  ["printf '%s\n' -n | xargs git commit --no-edit", 'xargs'],
  ['xargs -0 git commit --fixup=1a2b3c4', 'xargs'],
  ['xargs git commit -q --amend --no-edit', 'xargs'],
  ['xargs nice git commit --no-edit', 'xargs'],
  ['/usr/bin/xargs git commit --no-edit', 'xargs'],
  ['XArgs.exe git commit --no-edit', 'xargs'],
  ['gxargs git commit --no-edit', 'gxargs'],
  ['parallel git commit --no-edit', 'parallel'],
  ['busybox xargs git commit --no-edit', 'xargs'],
  ['xargs git commit', 'xargs'],
  ['xargs git commit -m x', 'xargs'],
  // A glob or brace expansion in the wrapper's own name (review GRD-04 round 2).
  ['/usr/bin/x[a]rgs.exe git commit --no-edit', '/usr/bin/x[a]rgs.exe'],
  ["printf '%s\\n' \"-n -m 'feat: x'\" | /usr/bin/x[a]rgs.exe git commit --no-edit", '/usr/bin/x[a]rgs.exe'],
  ['/usr/bin/x[a]rgs git commit --no-edit', '/usr/bin/x[a]rgs'],
  ['/usr/bin/xa*s git commit --no-edit', '/usr/bin/xa*s'],
  ['x?rgs git commit --fixup=1a2b3c4', 'x?rgs'],
  ['xargs{,} git commit --no-edit', 'xargs{,}'],
  ['{xargs,} git commit --amend --no-edit', '{xargs,}'],
  ['x{a,}rgs git commit', 'x{a,}rgs'],
  // Fail closed: any such token counts, even one that cannot name a wrapper.
  ["a='*' git commit --no-edit", 'a=*'],
  ['nice -n 5 [x] git commit --no-edit', '[x]'],
];
for (const [command, name] of wrapperRow) {
  test(`Seam 3: ${JSON.stringify(command)} is denied naming the wrapper ${name}`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(wrapper(name)), stderr: '' });
  });
}

test('Seam 3: under a wrapper a form outside the allowlist keeps its own row', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, 'xargs git commit -a'), { stdout: denyJson(generic('-a')), stderr: '' });
  assert.deepEqual(hook(c, 'xargs git commit --fixup $s'), { stdout: denyJson(MESSAGES.literalArguments), stderr: '' });
});

test('Seam 3: a lone `{` (the brace-group keyword) before `git` is not a possible wrapper', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, '{ git commit --no-edit; }'), { stdout: '', stderr: '' });
  assert.deepEqual(hook(c, '{ xargs git commit --no-edit; }'), { stdout: denyJson(wrapper('xargs')), stderr: '' });
});

test('Seam 3: `find -exec git commit … {} +` is denied by the `{` of its placeholder (step 4)', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, 'find . -exec git commit --no-edit {} +'), { stdout: denyJson(MESSAGES.literalArguments), stderr: '' });
  assert.deepEqual(hook(c, 'find . -execdir git commit --no-edit -m{} ;'), { stdout: denyJson(MESSAGES.literalArguments), stderr: '' });
});

const wrapperElsewhere = [
  'git commit --no-edit | xargs echo',
  'ls | xargs echo && git commit --no-edit',
  'xargs echo; git commit --fixup=1a2b3c4',
  'git commit --no-edit; parallel echo ::: a',
  'ls *.md && git commit --no-edit',
  'git commit --fixup=1a2b3c4 | xa*s echo',
];
for (const command of wrapperElsewhere) {
  test(`Seam 3: ${JSON.stringify(command)} has no output (the wrapper is in another segment)`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: '', stderr: '' });
  });
}

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
// Each GRD-04 seed case with the message it gets (null: no output).
const GRD04_SEEDS = new Map([
  ['b-fixup-q', () => null],
  ['b-fixup-separate', () => null],
  ['b-am', () => generic('-a')],
  ['b-m-attached', () => MESSAGES.bare],
  ['b-pathspec', () => generic('--')],
  ['b-noedit-value', () => generic('--no-edit')],
  ['b-allow-empty', () => generic('--allow-empty')],
  ['b-xargs', () => wrapper('xargs')],
]);
for (const s of seedCases.filter((x) => x.shell === 'bash' && x.segments.length > 0
  && (x.decision === 'none' || GRD04_SEEDS.has(x.id)))) {
  test(`Seam 3: seed ${s.id} → ${s.decision}`, (t) => {
    const c = createCase(t, { repo: false });
    const expected = GRD04_SEEDS.has(s.id) ? GRD04_SEEDS.get(s.id)() : null;
    assert.equal(expected === null, s.decision === 'none');
    assert.deepEqual(hook(c, s.command), { stdout: expected === null ? '' : denyJson(expected), stderr: '' });
  });
}
test('the GRD-04 seed cases are all in the seed', () => {
  for (const id of GRD04_SEEDS.keys()) assert.ok(seedCases.some((x) => x.id === id), id);
});
