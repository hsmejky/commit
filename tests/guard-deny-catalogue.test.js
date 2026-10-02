'use strict';

// GRD-05: the specific rows of the deny catalogue, each with its fixed text, and their
// precedence over the generic and bare rows, through G1 `runHook` (Seam 3) and the real hook
// process (Seam 2) (C:guard Deny messages, Precedence, Parsing step 5; Q4, Q18, Q20;
// stories 27, 28, 30, 32).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;
let SHORT_WITH_VALUE;
let LONG_WITH_VALUE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ MESSAGES, ROUTE, PERSONAL_SKILL_LINE, SHORT_WITH_VALUE, LONG_WITH_VALUE } = await loadLib('command-classifier'));
});

function hook(c, command) {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: c.root,
  });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

// The deny reason for a command, or null when it has no output.
function reasonOf(c, command) {
  const { stdout, stderr } = hook(c, command);
  assert.equal(stderr, '');
  if (stdout === '') return null;
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

// The C:guard texts, spelled out here rather than read from the module under test.
const route = 'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';
const line = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';
const amendText = `To reword the last commit: ${route} Ask it to reword. To add changes, make a new commit the same way.\n${line}`;
const squashText = `git commit --squash opens an editor. ${route}\n${line}`;
const noVerifyText = (flag) => `${flag} is not allowed. Fix the hook or signing setup instead.`;
const fixupKindText = (kind) => `--fixup=${kind}: opens an editor. Use plain --fixup=<commit>, or: ${route}\n${line}`;
const genericText = (flag) => `git commit ${flag} is not allowed here. ${route}\n${line}`;
const wrapperText = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${route}\n${line}`;
const bareText = `Direct git commit is blocked. ${route}\n${line}`;

const cases = [
  // `--amend` without `--no-edit` (story 32): the reword route, never `--amend --no-edit`.
  ['git commit --amend', amendText],
  ['git commit --amend -q', amendText],
  ['git commit -q --amend', amendText],
  ['git commit --amend --fixup=1a2b3c4', amendText],
  ['git commit --fixup=1a2b3c4 --amend', amendText],
  ['git commit --amend --all', amendText],
  ['git commit --fixup=1a2b3c4 -q --amend=x', amendText],
  // A `--no-edit` given a value is not `--no-edit`.
  ['git commit --amend --no-edit=x', amendText],
  // `--squash` in any form (story 27): `--no-edit` does not exempt it (C:guard step 5).
  ['git commit --squash=HEAD', squashText],
  ['git commit --squash HEAD', squashText],
  ['git commit --squash=HEAD --no-edit', squashText],
  ['git commit --no-edit --squash=HEAD', squashText],
  ['git commit --no-edit --squash HEAD -q', squashText],
  ['git commit --fixup=1a2b3c4 --squash=HEAD', squashText],
  ['git commit --squash', squashText],
  // `-n`, `--no-verify`, `--no-gpg-sign` (story 30, Q18): no route, no personal-skill line.
  ['git commit -n', noVerifyText('-n')],
  ['git commit --no-verify', noVerifyText('--no-verify')],
  ['git commit --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -n', noVerifyText('-n')],
  ['git commit --amend --no-edit --no-verify', noVerifyText('--no-verify')],
  ['git commit --fixup=1a2b3c4 --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -qn', noVerifyText('-n')],
  ['git commit --no-verify=x --no-edit', noVerifyText('--no-verify')],
  // A tie within one row goes to the first matching token in argv order.
  ['git commit --no-gpg-sign -n --no-edit', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -n --no-gpg-sign', noVerifyText('-n')],
  // `--fixup=amend:` / `--fixup=reword:` open an editor (story 28).
  ['git commit --fixup=amend:1a2b3c4', fixupKindText('amend')],
  ['git commit --fixup=reword:1a2b3c4', fixupKindText('reword')],
  ['git commit --fixup amend:HEAD~1', fixupKindText('amend')],
  ['git commit --fixup=reword:1a2b3c4 -q', fixupKindText('reword')],
  ['git commit -q --fixup=amend:', fixupKindText('amend')],
  // `-C`, `--reuse-message`, `-c <commit>`, `--reedit-message` take the generic row (story 28).
  ['git commit -C HEAD', genericText('-C')],
  ['git commit -CHEAD', genericText('-C')],
  ['git commit --reuse-message HEAD', genericText('--reuse-message')],
  ['git commit --reuse-message=HEAD', genericText('--reuse-message')],
  ['git commit -c HEAD', genericText('-c')],
  ['git commit -cHEAD', genericText('-c')],
  ['git commit --reedit-message HEAD', genericText('--reedit-message')],
  ['git commit --reedit-message=HEAD', genericText('--reedit-message')],
  ['git commit --no-edit -C HEAD', genericText('-C')],
  ['git commit --amend --no-edit -c HEAD', genericText('-c')],
];
for (const [command, expected] of cases) {
  test(`Seam 3: ${JSON.stringify(command)} is denied with its row's text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.equal(reasonOf(c, command), expected);
  });
}

test('Seam 3: the amend text routes rewording to the worker and never suggests `--amend --no-edit`', (t) => {
  const c = createCase(t, { repo: false });
  const reason = reasonOf(c, 'git commit --amend');
  assert.ok(reason.startsWith('To reword the last commit: Spawn the commit:commit-worker agent'), reason);
  assert.ok(reason.includes('Ask it to reword. To add changes, make a new commit the same way.'));
  assert.ok(!reason.includes('--no-edit'));
  assert.ok(!reason.includes('--amend'));
});

// Stands for MESSAGES.literalArguments, read once the module is loaded.
const MESSAGES_LITERAL = Symbol('literalArguments');

// C:guard Precedence (D2): the full row order, each pair below matching both rows. The more
// specific row wins; the bare/`-m`/`-F`/`--message`/`--file` row applies only when nothing
// else matches.
const precedence = [
  // --amend over --squash, -n, the fixup kinds, the generic row, the wrapper and the bare row.
  ['git commit --amend -m x', amendText],
  ['git commit -m x --amend', amendText],
  ['git commit --amend -F msg.txt', amendText],
  ['git commit --amend --message=x', amendText],
  ['git commit --squash=HEAD --amend', amendText],
  ['git commit -n --amend', amendText],
  ['git commit --fixup=amend:HEAD --amend', amendText],
  ['git commit -a --amend', amendText],
  ['xargs git commit --amend', amendText],
  // --squash over -n, the fixup kinds, the generic row, the wrapper and the bare row.
  ['git commit --squash -m x', squashText],
  ['git commit -m x --squash=HEAD', squashText],
  ['git commit -n --squash=HEAD', squashText],
  ['git commit --fixup=reword:HEAD --squash=HEAD', squashText],
  ['git commit -a --squash=HEAD', squashText],
  ['xargs git commit --squash=HEAD --no-edit', squashText],
  // -n / --no-verify / --no-gpg-sign over the fixup kinds, the generic row, the wrapper and
  // the bare row.
  ['git commit -n -m x', noVerifyText('-n')],
  ['git commit -nm x', noVerifyText('-n')],
  ['git commit -m x -n', noVerifyText('-n')],
  ['git commit -an', noVerifyText('-n')],
  ['git commit --fixup=amend:HEAD --no-verify', noVerifyText('--no-verify')],
  ['git commit -a --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['xargs git commit --no-edit -n', noVerifyText('-n')],
  // The fixup kinds over the generic row, the wrapper and the bare row.
  ['git commit --fixup=amend:HEAD -m x', fixupKindText('amend')],
  ['git commit -a --fixup=reword:HEAD', fixupKindText('reword')],
  ['git commit --no-edit --fixup=reword:HEAD', fixupKindText('reword')],
  ['xargs git commit --fixup=amend:HEAD', fixupKindText('amend')],
  // The generic row over the wrapper and the bare row; the wrapper over the bare row.
  ['git commit -C HEAD -m x', genericText('-C')],
  ['xargs git commit -c HEAD', genericText('-c')],
  ['xargs git commit -m x', wrapperText('xargs')],
  ['git commit -m x', bareText],
  // A value is never read as a flag of a higher row: git takes it as the option's value.
  ['git commit -C -n', genericText('-C')],
  ['git commit --reuse-message -n', genericText('--reuse-message')],
  ['git commit --reedit-message --amend', genericText('--reedit-message')],
  ['git commit --author -n --no-edit', genericText('--author')],
  ['git commit --trailer --squash=HEAD --no-edit', genericText('--trailer')],
  ['git commit --date -n', genericText('--date')],
  ['git commit --template --amend', genericText('--template')],
  ['git commit --cleanup -n', genericText('--cleanup')],
  ['git commit --pathspec-from-file --amend', genericText('--pathspec-from-file')],
  ['git commit --unified -n', genericText('--unified')],
  ['git commit --inter-hunk-context --amend', genericText('--inter-hunk-context')],
  ['git commit -U -n', genericText('-U')],
  // `--squash` itself outranks `-n`/`--amend`, so its value is never read as either, even
  // when the value spells a higher-row flag.
  ['git commit --squash --amend', squashText],
  ['git commit -m --amend', bareText],
  ['git commit --message --no-verify', bareText],
  // An abbreviation git accepts is not expanded (C:guard step 5): the generic row names it
  // exactly as written, never the row of the option it abbreviates.
  ['git commit --amen', genericText('--amen')],
  ['git commit --no-veri', genericText('--no-veri')],
  // ... and the literal-arguments row outranks every row of commit's arguments.
  ['git commit --amend -m "feat(x): y"', MESSAGES_LITERAL],
];
for (const [command, expected] of precedence) {
  test(`Seam 3: precedence: ${JSON.stringify(command)} is denied on the higher row`, (t) => {
    const c = createCase(t, { repo: false });
    const want = expected === MESSAGES_LITERAL ? MESSAGES.literalArguments : expected;
    assert.equal(reasonOf(c, command), want);
  });
}

test('Seam 3: precedence: `--amend -m x`, `-n -m x` and `--squash -m x` never give the bare text', (t) => {
  const c = createCase(t, { repo: false });
  for (const command of ['git commit --amend -m x', 'git commit -n -m x', 'git commit --squash -m x']) {
    assert.ok(!reasonOf(c, command).includes('Direct git commit is blocked'), command);
  }
});

test('Seam 3: fail-closed: no value-taking option other than --fixup stays allowed beside --no-edit --amend or --fixup=x', (t) => {
  const c = createCase(t, { repo: false });
  const options = [
    ...[...SHORT_WITH_VALUE].map((letter) => `-${letter}`),
    ...LONG_WITH_VALUE,
  ].filter((flag) => flag !== '--fixup');
  for (const flag of options) {
    for (const neighbours of ['--no-edit --amend', '--fixup=x']) {
      const command = `git commit ${neighbours} ${flag} v`;
      assert.notEqual(reasonOf(c, command), null, command);
    }
  }
});

// One command per row reachable from a Bash command (the literal-subcommand, unknown global
// option and `-c`/`--config-env` rows come with GRD-11 and GRD-12).
const everyRow = [
  'git commit -m x',
  'git commit --amend',
  'git commit --squash=HEAD',
  'git commit -n',
  'git commit --no-verify',
  'git commit --no-gpg-sign',
  'git commit --fixup=amend:HEAD',
  'git commit --fixup=reword:HEAD',
  'git commit -a',
  'git commit -C HEAD',
  'xargs git commit --no-edit',
  'git commit --fixup $s',
  'echo "$(date)"; git commit',
];

test('Seam 3: every message holding the route ends with the personal-skill line; the others do not', (t) => {
  const c = createCase(t, { repo: false });
  const seen = new Set();
  for (const command of everyRow) {
    const reason = reasonOf(c, command);
    assert.notEqual(reason, null, command);
    seen.add(reason);
    if (reason.includes(ROUTE)) assert.ok(reason.endsWith(`\n${PERSONAL_SKILL_LINE}`), command);
    else assert.ok(!reason.includes(PERSONAL_SKILL_LINE), command);
  }
  for (const message of Object.values(MESSAGES)) {
    assert.ok(message.includes(ROUTE), 'every fixed catalogue text holds the route');
    assert.ok(message.endsWith(`\n${PERSONAL_SKILL_LINE}`));
  }
  // The -n row is the one row without the route.
  assert.ok(!reasonOf(c, 'git commit -n').includes(ROUTE));
  assert.equal(seen.size, everyRow.length, 'each command gets a text of its own');
});

test('Seam 3: no specific row names `/commit`', (t) => {
  const c = createCase(t, { repo: false });
  for (const command of everyRow) assert.ok(!reasonOf(c, command).includes('/commit'), command);
});

test('Seam 2: the real hook denies `--amend -m x` with the amend text and `-n` with its own, exit 0', async (t) => {
  const c = createCase(t);
  for (const [command, expected] of [['git commit --amend -m x', amendText], ['git commit -n -m x', noVerifyText('-n')]]) {
    const result = await runGuard(c, { command });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.heartbeat, null);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, expected);
  }
});
