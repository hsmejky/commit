'use strict';

// GRD-03: the first deny, end to end (Seam 2) and through G1 `runHook` (Seam 3): Bash
// `git commit -m x` in its segment-separated forms, the documented false positives, and the
// blanket rule over every blanket seed case of either shell (C:guard Output, Parsing steps
// 1-3, Deny messages; Q3, Q8, Q24).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;

let runHook;
let mentionsCommit;
let classify;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook, mentionsCommit } = await loadLib('hook-io'));
  ({ classify, MESSAGES, ROUTE, PERSONAL_SKILL_LINE } = await loadLib('command-classifier'));
});

// The wrapper row (C:guard step 3) naming a token before `git` outside the prefix allowlist.
const wrapper = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;

function denyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

function hook(c, command, toolName = 'Bash') {
  const stdinText = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
    cwd: c.root,
  });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

test('Seam 2: Bash `git commit -m x` is denied with the routing text and the personal-skill line, exit 0', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: 'git commit -m x' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.heartbeat, null);
  assert.equal(result.stdout, denyJson(MESSAGES.bare));
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith('Direct git commit is blocked. Spawn the commit:commit-worker agent'));
  assert.ok(reason.endsWith('\nIf a personal commit skill sent you here, remove it (see the commit plugin README).'));
});

const bareDenies = [
  'git commit -m x',
  'cd x && git commit -m x',
  'a; git commit -m x',
  'a | git commit -m x',
  'a & git commit -m x',
  'a\ngit commit -m x',
  "git co''mmit -m x",
  'git commit -m "a\\"b"',
  "echo $'\\'' ; git commit -m x",
  "git $'commit' -m x",
  "git $'commit\\0x' -m x",
  "git $'commit\\x00' -m x",
  "git $'commit\\u0000' -m x",
  "git co$'m'mit -m x",
  'git com\\\nmit -m x',
  // GRD-07: an escaped newline is joined before splitting; an unterminated quote is the rest
  // of its line as one quoted token, and scanning continues on the next line.
  'git \\\ncommit -m x',
  'git \\\r\ncommit -m x',
  'git commit -m "unterminated',
  "git commit -m 'unterminated",
  'echo "x\ngit commit -m x',
  "echo 'x\ngit commit -m x",
];
for (const command of bareDenies) {
  test(`Seam 3: Bash ${JSON.stringify(command)} is denied with the bare-commit text`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual({ ...hook(c, command) }, { stdout: denyJson(MESSAGES.bare), stderr: '' });
  });
}

test('Seam 3: Bash `echo git commit` is denied by the wrapper row naming echo (documented false positive)', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual({ ...hook(c, 'echo git commit') }, { stdout: denyJson(wrapper('echo')), stderr: '' });
});

test('Seam 3: the comment form `# git commit -m x` is denied by the blanket rule', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual({ ...hook(c, '# git commit -m x') }, { stdout: denyJson(MESSAGES.blanket), stderr: '' });
});

test('Seam 3: `echo "$(date)" && git status` has no output (no `commit`, step 1)', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual({ ...hook(c, 'echo "$(date)" && git status') }, { stdout: '', stderr: '' });
});

// The blanket seed cases denied by a blanket row of their own, with its fixed text.
const ESCAPE_TEXT = 'This command mentions commit and holds a `e or `u{…} escape, which Windows PowerShell 5.1 and PowerShell 7 read differently. Keep them out of a command that mentions commit, or to commit: Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.\nIf a personal commit skill sent you here, remove it (see the commit plugin README).';
const blanketRowText = { 'p-nul-u00': ESCAPE_TEXT };

// Every blanket seed case: denied with the blanket message (or its own row) when it
// mentions `commit`, no output otherwise; never a heartbeat.
for (const s of seedCases.filter((x) => x.segments.length === 0)) {
  const toolName = s.shell === 'bash' ? 'Bash' : 'PowerShell';
  test(`Seam 3: blanket seed ${s.id} (${toolName}) → ${s.decision}`, (t) => {
    const c = createCase(t, { repo: false });
    const message = Object.hasOwn(blanketRowText, s.id) ? blanketRowText[s.id] : MESSAGES.blanket;
    const expected = s.decision === 'deny' ? denyJson(message) : '';
    assert.equal(mentionsCommit(s.command), s.decision === 'deny');
    assert.deepEqual({ ...hook(c, s.command, toolName) }, { stdout: expected, stderr: '' });
    assert.equal(fs.existsSync(path.join(c.claudeHome, 'commit-guard')), false);
  });
}

// Every tokenized `bypass` seed case (GRD-03 review): a command bash runs as `git commit`
// through a quoting, escaped-newline, carriage-return, NUL or `{name}` redirection edge is
// denied with the bare-commit message. In `b-bypass-escaped-cr` the first reading's segment
// `echo git commit -m x` comes first and is the wrapper row naming `echo` (C:guard step 3);
// the second reading's `git commit -m x` is checked on its own below.
const bypassMessage = { 'b-bypass-escaped-cr': () => wrapper('echo') };
for (const s of seedCases.filter((x) => x.topic === 'bypass' && x.segments.length > 0)) {
  test(`Seam 3: bypass seed ${s.id} → deny`, (t) => {
    const c = createCase(t, { repo: false });
    assert.equal(s.decision, 'deny');
    const message = Object.hasOwn(bypassMessage, s.id) ? bypassMessage[s.id]() : MESSAGES.bare;
    assert.deepEqual({ ...hook(c, s.command) }, { stdout: denyJson(message), stderr: '' });
  });
}

test('G3: in `b-bypass-escaped-cr` the second reading\'s segments alone are the bare-commit deny', () => {
  const seed = seedCases.find((x) => x.id === 'b-bypass-escaped-cr');
  assert.deepEqual(seed.segments[0], ['echo', 'git', 'commit', '-m', 'x']);
  assert.deepEqual(classify(seed.segments.slice(1), { shell: 'bash' }), {
    decision: 'deny',
    message: MESSAGES.bare,
    scriptCalls: [],
  });
});

test('Seam 3: the step 1 mention text drops NULs and carriage returns', () => {
  assert.equal(mentionsCommit('git com\rmit'), true);
  assert.equal(mentionsCommit('git com\u0000mit'), true);
  assert.equal(mentionsCommit('git com\\\r\nmit'), true);
});
