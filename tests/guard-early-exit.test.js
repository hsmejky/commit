'use strict';

// GRD-01: the guard's early exit end to end. Seam 2 spawns `plugin/scripts/guard.cjs` with
// `PreToolUse` JSON on stdin; Seam 3 calls G1 `runHook` in process with an injected Claude
// home and clock (C:guard Output and Parsing step 1; Q3, Q13).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase, runGuard } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

let readStdin;
let runHook;
let mentionsCommit;

beforeEach(async () => {
  ({ readStdin, runHook, mentionsCommit } = await loadLib('hook-io'));
});

for (const toolName of ['Bash', 'PowerShell']) {
  test(`Seam 2: ${toolName} \`ls -la\` ends with no output, exit 0 and no heartbeat`, async (t) => {
    const c = createCase(t);
    const result = await runGuard(c, { toolName, command: 'ls -la' });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.exitCode, 0);
    assert.equal(result.heartbeat, null);
  });
}

test('Seam 2: a large stdin payload delivered in several chunks is read whole', async (t) => {
  const c = createCase(t);
  // Far beyond one pipe buffer (64 KiB), so the child sees many chunks.
  const command = `ls ${'x'.repeat(4 * 1024 * 1024)}`;
  const result = await runGuard(c, { command });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat, null);
});

test('Seam 3: readStdin joins asynchronous chunks before decoding UTF-8', async () => {
  const { Readable } = require('node:stream');
  const text = JSON.stringify({ tool_input: { command: 'echo “€” ✓' } });
  const bytes = Buffer.from(text, 'utf8');
  // Cut every multi-byte character in two, one byte per chunk.
  const chunks = [...bytes].map((byte) => Buffer.from([byte]));
  const stream = new Readable({
    read() {
      setImmediate(() => this.push(chunks.length ? chunks.shift() : null));
    },
  });
  assert.equal(await readStdin(stream), text);
});

for (const toolName of ['Bash', 'PowerShell']) {
  test(`Seam 3: runHook gives Seam 2's result for ${toolName} \`ls -la\``, async (t) => {
    const c = createCase(t, { repo: false });
    const stdinText = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { command: 'ls -la' },
      cwd: c.root,
    });
    const result = await runHook(stdinText, {
      env: {},
      claudeHome: c.claudeHome,
      now: () => Date.UTC(2024, 0, 1),
    });
    assert.deepEqual({ ...result }, { stdout: '', stderr: '' });
    assert.equal(fs.existsSync(path.join(c.claudeHome, 'commit-guard')), false);
  });
}

// C:guard Parsing step 1: `commit` is looked for after removing `'`, `"`, `\`, backticks and
// the typographic quotes U+2018-U+201B and U+201C-U+201E, case-insensitively.
const mentionTable = [
  { command: 'ls -la', mentions: false },
  { command: 'git status', mentions: false },
  { command: 'git comm it', mentions: false },
  { command: 'git commit -m x', mentions: true },
  { command: 'git COMMIT -m x', mentions: true },
  { command: 'git-CoMmIt -m x', mentions: true },
  { command: "git co''mmit -m x", mentions: true },
  { command: 'git co""mmit -m x', mentions: true },
  { command: 'git com`mit -m x', mentions: true },
  { command: 'git co\\mmit -m x', mentions: true },
  { command: 'git co‘’mmit', mentions: true },
  { command: 'git co‚‛mmit', mentions: true },
  { command: 'git co“”mmit', mentions: true },
  { command: 'git co„mmit', mentions: true },
  // Escaped newlines of either shell are removed regardless of quotes, then every `$` right
  // before a quote character (C:guard Parsing step 1).
  { command: 'git com\\\nmit -m x', mentions: true },
  { command: 'git com\\\r\nmit -m x', mentions: true },
  { command: 'git com`\nmit -m x', mentions: true },
  { command: '"git com\\\nmit"', mentions: true },
  { command: "git co$'m'mit -m x", mentions: true },
  { command: 'git co$"m"mit -m x', mentions: true },
  { command: 'git co$‘m’mit -m x', mentions: true },
  { command: 'git co$mmit -m x', mentions: false },
  { command: 'git com\nmit -m x', mentions: false },
];

for (const { command, mentions } of mentionTable) {
  test(`Seam 3: mentionsCommit(${JSON.stringify(command)}) is ${mentions}`, () => {
    assert.equal(mentionsCommit(command), mentions);
  });
}
