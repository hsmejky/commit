'use strict';

// GRD-04 review round 9: deep or long Bash input must not crash the guard or run it past its
// hook budget, since both fail open (C:guard Output). An extglob pattern read as one word in
// an argument or a redirection target whose brackets nest deeper than G2's
// `MAX_PATTERN_DEPTH` is the blanket kind 'nesting' (C:guard Parsing step 2), so the
// defense-in-depth body walk stays bounded; long flat input (many segments, many pattern
// bodies, many `git commit` pairs in one segment) is classified, not thrown on. Through G2
// `segments`, G1 `runHook` (Seam 3) and the real hook process (Seam 2). Review round 10: a
// command longer than G2's `MAX_COMMAND_LENGTH` is the blanket kind 'size', so time and
// memory stay bounded too (about 2.8 MB at full pattern depth ran the heap out, no output).
// Results only, no wall-clock asserts.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let segments;
let blanketTrigger;
let MAX_PATTERN_DEPTH;
let MAX_COMMAND_LENGTH;
let MESSAGES;
let ROUTE;
let PERSONAL_SKILL_LINE;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
  ({ segments, blanketTrigger, MAX_PATTERN_DEPTH, MAX_COMMAND_LENGTH } = await loadLib('shell-tokenizer'));
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

// `levels` nested `@(x …)` patterns around `inner`.
const nested = (levels, inner) => `${'@(x '.repeat(levels)}${inner}${')'.repeat(levels)}`;
// `MAX_PATTERN_DEPTH`, for the shapes built at load time (the lib loads in `beforeEach`).
const BOUND = 16;
// The review's repro: before the fix about 3,000 levels overflowed the stack and the guard
// gave no output, so the commit on the same line ran with its hook skipped.
const DEEP = 5000;
const deepRepro = `git commit -n --allow-empty -m b; [[ a == ${nested(DEEP, 'a')} ]]`;

test('G2: a pattern nested MAX_PATTERN_DEPTH deep is tokenized, one level more is the nesting kind', () => {
  assert.equal(MAX_PATTERN_DEPTH, BOUND);
  const atBound = segments(`echo ${nested(MAX_PATTERN_DEPTH, 'a')}`, 'bash');
  assert.ok(Array.isArray(atBound));
  assert.equal(atBound.length, MAX_PATTERN_DEPTH + 1);
  assert.deepEqual(segments(`echo ${nested(MAX_PATTERN_DEPTH + 1, 'a')}`, 'bash'), { blanket: 'nesting' });
  // Plain brackets in the pattern count; quoted and escaped ones do not.
  assert.deepEqual(segments(`echo @(${'('.repeat(MAX_PATTERN_DEPTH)}a${')'.repeat(MAX_PATTERN_DEPTH + 1)}`, 'bash'), { blanket: 'nesting' });
  assert.ok(Array.isArray(segments(`echo @("${'('.repeat(40)}" \\( '(((')`, 'bash')));
});

test('G2: a deep pattern in a redirection target and after a reserved word is the nesting kind', () => {
  assert.deepEqual(segments(`cat >${nested(DEEP, 'a')}`, 'bash'), { blanket: 'nesting' });
  assert.deepEqual(segments(`echo do ${nested(DEEP, 'git commit -m x')}`, 'bash'), { blanket: 'nesting' });
});

test(`Seam 3: ${DEEP} nested argument patterns after a commit are the nesting deny`, (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, deepRepro), { stdout: denyJson(MESSAGES.nesting), stderr: '' });
});

test('Seam 3: 20000 nested argument patterns on a later line are the nesting deny', (t) => {
  const c = createCase(t, { repo: false });
  const command = `git commit --no-edit\necho ${nested(20000, 'git commit -m x')}`;
  assert.deepEqual(hook(c, command), { stdout: denyJson(MESSAGES.nesting), stderr: '' });
});

test('Seam 3: a carriage-return command with a body at the depth bound is classified', (t) => {
  const c = createCase(t, { repo: false });
  const command = `git commit -m b\r\necho ${nested(MAX_PATTERN_DEPTH, 'a;'.repeat(2000))}`;
  assert.deepEqual(hook(c, command), { stdout: denyJson(MESSAGES.bare), stderr: '' });
});

test('Seam 3: a body at the depth bound is still classified as a command', (t) => {
  const c = createCase(t, { repo: false });
  const command = `echo ${nested(MAX_PATTERN_DEPTH - 1, '@(git commit -a)')}`;
  const generic = `git commit -a is not allowed here. ${ROUTE}\n${PERSONAL_SKILL_LINE}`;
  assert.deepEqual(hook(c, command), { stdout: denyJson(generic), stderr: '' });
});

// Long flat input, each just under `MAX_COMMAND_LENGTH`: before the fix a `push(...)` of
// this many segments threw a RangeError (no output), and every `git commit` pair in one
// segment rescanned the segment from its start (quadratic).
const flat = [
  ['many segments', `${'a;'.repeat(130000)}git commit -m x`],
  ['many pattern bodies in one segment', `echo ${'@(a) '.repeat(52000)}; git commit -m x`],
  ['many separators in one body', `echo @(${'a;'.repeat(130000)}) ; git commit -m x`],
  ['many patterns at the depth bound', `${`echo ${nested(BOUND, 'a')};`.repeat(3000)}git commit -m x`],
  ['many allowed commits in one segment', `cat ${'<(git commit --no-edit) '.repeat(10400)}; git commit -m x`],
];
test('the flat shapes fit under the size cap', () => {
  for (const [name, command] of flat) assert.ok(command.length <= MAX_COMMAND_LENGTH, `${name}: ${command.length}`);
});
for (const [name, command] of flat) {
  test(`Seam 3: ${name} (${command.length} characters) gets the bare deny`, (t) => {
    const c = createCase(t, { repo: false });
    assert.deepEqual(hook(c, command), { stdout: denyJson(MESSAGES.bare), stderr: '' });
  });
}

test(`Seam 2: ${DEEP} nested argument patterns are denied by the real hook process`, async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: deepRepro });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, denyJson(MESSAGES.nesting));
});

// The review's round-10 repro: a carriage return, then 16 nested patterns around a long body.
const sizeRepro = `git commit -n -m b\r\necho ${nested(BOUND, 'a;'.repeat(1400000))}`;

test('G2: a command at MAX_COMMAND_LENGTH is read, one character more is the size kind', () => {
  assert.equal(MAX_COMMAND_LENGTH, 256 * 1024);
  const base = 'git commit -m x';
  const atCap = base + ' '.repeat(MAX_COMMAND_LENGTH - base.length);
  assert.deepEqual(segments(atCap, 'bash'), [['git', 'commit', '-m', 'x']]);
  assert.deepEqual(segments(`${atCap} `, 'bash'), { blanket: 'size' });
  assert.equal(blanketTrigger(`${atCap} `, 'powershell'), 'size');
  // The exempt script-call form gets no exception.
  const exempt = `node "/opt/x/commit.cjs" plan${' --x'.repeat(MAX_COMMAND_LENGTH / 4)}`;
  assert.equal(blanketTrigger(exempt, 'bash'), 'size');
});

test(`Seam 3: the round-10 repro (${sizeRepro.length} characters) is the size deny`, (t) => {
  const c = createCase(t, { repo: false });
  assert.ok(sizeRepro.length > 2.8e6);
  assert.deepEqual(hook(c, sizeRepro), { stdout: denyJson(MESSAGES.size), stderr: '' });
});

test('Seam 3: a long command that does not mention commit still exits early', (t) => {
  const c = createCase(t, { repo: false });
  assert.deepEqual(hook(c, `echo ${'a'.repeat(MAX_COMMAND_LENGTH)}`), { stdout: '', stderr: '' });
});

test('Seam 2: the round-10 repro is denied by the real hook process', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { command: sizeRepro });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, denyJson(MESSAGES.size));
});
