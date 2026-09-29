'use strict';

// GRD-02: the guard fails open on unreadable, malformed or incomplete hook input, and on any
// throw inside it, always with no stdout and exit 0; under `COMMIT_GUARD_DEBUG=1` it also
// writes exactly one stderr line holding whatever fields it knew before giving up (C:guard
// Output; docs/spec/modules-shared-and-guard.md G1; Q1, Q3).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCase, runGuard, GUARD_ENTRY } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let runHook;
let debugEnabled;
let formatDebugLine;

beforeEach(async () => {
  ({ runHook, debugEnabled, formatDebugLine } = await loadLib('hook-io'));
});

test('Seam 2: non-JSON stdin under COMMIT_GUARD_DEBUG=1 writes exactly one stderr line, still no stdout and exit 0', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { stdin: 'not json' }, { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(result.stdout, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat, null);
  const lines = result.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {});
});

test('Seam 2: non-JSON stdin without COMMIT_GUARD_DEBUG writes no stderr at all', async (t) => {
  const c = createCase(t);
  const result = await runGuard(c, { stdin: 'not json' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat, null);
});

test('Seam 2: empty stdin fails open the same way, with and without debug', async (t) => {
  const c = createCase(t);
  const plain = await runGuard(c, { stdin: '' });
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, '');
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.heartbeat, null);

  const debugged = await runGuard(c, { stdin: '' }, { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(debugged.stdout, '');
  assert.equal(debugged.exitCode, 0);
  assert.deepEqual(JSON.parse(debugged.stderr.trim()), {});
});

test('Seam 2: JSON without tool_input.command fails open, carrying agent_id into the debug line', async (t) => {
  const c = createCase(t);
  const plain = await runGuard(c, { toolName: 'Bash', extra: { agent_id: 'a1' } });
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, '');
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.heartbeat, null);

  const debugged = await runGuard(
    c,
    { toolName: 'Bash', extra: { agent_id: 'a1' } },
    { env: { COMMIT_GUARD_DEBUG: '1' } },
  );
  assert.equal(debugged.stdout, '');
  assert.equal(debugged.exitCode, 0);
  assert.equal(debugged.heartbeat, null);
  const lines = debugged.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { agent_id: 'a1' });
});

test('Seam 2: an unknown tool_name fails open even when the command mentions commit', async (t) => {
  const c = createCase(t);
  const plain = await runGuard(c, { toolName: 'Zsh', command: 'git commit -m x' });
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, '');
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.heartbeat, null);

  const debugged = await runGuard(
    c,
    { toolName: 'Zsh', command: 'git commit -m x' },
    { env: { COMMIT_GUARD_DEBUG: '1' } },
  );
  assert.equal(debugged.stdout, '');
  assert.equal(debugged.exitCode, 0);
  assert.equal(debugged.heartbeat, null);
  const lines = debugged.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {});
});

test('Seam 2: guard.cjs itself still fails open, and writes the debug line inline, when the dynamic import rejects before the library ever loads', async (t) => {
  const c = createCase(t);
  // A copy of guard.cjs with no lib/ next to it: the dynamic import of ./lib/hook-io.mjs
  // rejects before hook-io.mjs (and its own debug-line writer) ever loads, so guard.cjs's
  // own top-level catch has to write the one-line empty object itself (finding 2, review
  // GRD-02).
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-nolib-'));
  t.after(() => fs.rmSync(isolatedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const isolatedGuard = path.join(isolatedDir, 'guard.cjs');
  fs.copyFileSync(GUARD_ENTRY, isolatedGuard);

  const plain = await runGuard(
    c,
    { toolName: 'Bash', command: 'git commit -m x' },
    { script: isolatedGuard },
  );
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, '');
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.heartbeat, null);

  const debugged = await runGuard(
    c,
    { toolName: 'Bash', command: 'git commit -m x' },
    { env: { COMMIT_GUARD_DEBUG: '1' }, script: isolatedGuard },
  );
  assert.equal(debugged.stdout, '');
  assert.equal(debugged.exitCode, 0);
  assert.equal(debugged.heartbeat, null);
  assert.deepEqual(JSON.parse(debugged.stderr.trim()), {});
});

test('Seam 3: debugEnabled is true only for the exact value "1"', () => {
  assert.equal(debugEnabled({ COMMIT_GUARD_DEBUG: '1' }), true);
  assert.equal(debugEnabled({ COMMIT_GUARD_DEBUG: 'true' }), false);
  assert.equal(debugEnabled({}), false);
  assert.equal(debugEnabled(undefined), false);
});

test('Seam 3: formatDebugLine emits one JSON line', () => {
  assert.equal(formatDebugLine({ agent_id: 'a1' }), '{"agent_id":"a1"}\n');
  assert.equal(formatDebugLine({}), '{}\n');
});

// Seam 3: the same contract, in process, so the fixture set does not need a child process
// per case (docs/spec/testing-seams.md).
const malformedInputs = [
  { label: 'non-JSON stdin', stdin: 'not json', expectAgentId: false },
  { label: 'empty stdin', stdin: '', expectAgentId: false },
  {
    label: 'JSON without tool_input.command',
    stdin: JSON.stringify({ tool_name: 'Bash', agent_id: 'a2', tool_input: {} }),
    expectAgentId: true,
  },
  {
    label: 'an unknown tool_name',
    stdin: JSON.stringify({ tool_name: 'Zsh', tool_input: { command: 'git commit -m x' } }),
    expectAgentId: false,
  },
  {
    label: 'tool_input absent',
    stdin: JSON.stringify({ tool_name: 'Bash', agent_id: 'a2' }),
    expectAgentId: true,
  },
  {
    label: 'tool_input.command is a number',
    stdin: JSON.stringify({ tool_name: 'Bash', agent_id: 'a2', tool_input: { command: 42 } }),
    expectAgentId: true,
  },
  {
    label: 'tool_input.command is null',
    stdin: JSON.stringify({ tool_name: 'Bash', agent_id: 'a2', tool_input: { command: null } }),
    expectAgentId: true,
  },
  {
    label: 'agent_id is not a string (dropped, not carried into the debug line)',
    stdin: JSON.stringify({ tool_name: 'Bash', agent_id: 123, tool_input: {} }),
    expectAgentId: false,
  },
  {
    label: 'the JSON payload is null',
    stdin: 'null',
    expectAgentId: false,
  },
];

for (const { label, stdin, expectAgentId } of malformedInputs) {
  test(`Seam 3: runHook fails open on ${label} without debug`, () => {
    assert.deepEqual({ ...runHook(stdin, { env: {} }) }, { stdout: '', stderr: '' });
  });

  test(`Seam 3: runHook logs one debug line on ${label}`, () => {
    const result = runHook(stdin, { env: { COMMIT_GUARD_DEBUG: '1' } });
    assert.equal(result.stdout, '');
    const lines = result.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const fields = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(fields), expectAgentId ? ['agent_id'] : []);
    if (expectAgentId) assert.equal(fields.agent_id, 'a2');
  });
}

test('Seam 3: a JSON payload that is not an object (e.g. a bare number) fails open without throwing', () => {
  const result = runHook('42', { env: { COMMIT_GUARD_DEBUG: '1' } });
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr.trim()), {});
});

test('Seam 3: main() fails open with an empty debug line when reading stdin itself throws', async () => {
  const { main } = await loadLib('hook-io');
  const { Readable } = require('node:stream');
  const stdin = new Readable({
    read() {
      this.destroy(new Error('boom'));
    },
  });
  const chunks = [];
  const errChunks = [];
  const stdout = { write: (c) => chunks.push(c) };
  const stderr = { write: (c) => errChunks.push(c) };
  await main({
    stdin, stdout, stderr, env: { COMMIT_GUARD_DEBUG: '1' }, claudeHome: '/x', now: () => 0,
  });
  assert.equal(chunks.join(''), '');
  assert.deepEqual(JSON.parse(errChunks.join('').trim()), {});
});
