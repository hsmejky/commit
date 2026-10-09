'use strict';

// INT-28 (docs/roadmap/12-integration.md; Testing seams "ScriptCall round trip"; Q23, Q25;
// stories 38, 39): every `run` string M17 builds, for each handback kind, goes through G1
// `runHook` as Bash and as PowerShell and is recognised with the same subcommand and arguments;
// as `commit:commit-worker` a `commit` or `release` call is denied (Seam 2), from the main
// session it passes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit, runGuard } = require('./helpers/process-seam.js');

const PLUGIN_SCRIPTS = path.join(__dirname, '..', 'plugin', 'scripts');
const CLOCK_PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'clock-preload.mjs')).href;
const PLAN_ID = '3f9a1c00-0000-4000-8000-000000000000';
const WORKER = 'commit:commit-worker';
const HANDBACK = 'The handback is for your caller: return the reply verbatim and stop.';
const SHELLS = ['bash', 'powershell'];
const TOOL = { bash: 'Bash', powershell: 'PowerShell' };

const SCRIPT_PATHS = [
  '/opt/my plugins/plugins/cache/commit/commit/0.1.0/scripts/commit.cjs',
  'C:\\Users\\Default User\\.claude\\plugins\\cache\\commit\\commit\\0.1.0\\scripts\\commit.cjs',
  'd:\\Program Files\\commit\\scripts\\commit.cjs',
  'C:/plain/plugins/cache/commit/commit/0.1.0/scripts/commit.cjs',
];

let reply;
let recognise;
let segments;
let runHook;
beforeEach(async () => {
  ({ reply } = await loadLib('reply'));
  ({ recognise } = await loadLib('script-call'));
  ({ segments } = await loadLib('shell-tokenizer'));
  ({ runHook } = await loadLib('hook-io'));
});

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-int28-'));
after(() => fs.rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const TREE = { clean: true };

// Every `run` of the handback kinds M17 builds from facts: `confirm` and `lintFailed`.
function factRuns(scriptPath) {
  const groups = [
    { n: 1, header: 'feat: a', body: null, files: [{ path: 'a.txt' }] },
    { n: 2, header: 'fix: b', body: null, files: [{ path: 'b.txt' }] },
  ];
  const built = [
    reply({ status: 'handback', kind: 'confirm', planId: PLAN_ID, humanOnly: false, scriptPath, treeState: TREE, mode: 'split', groups }),
    reply({ status: 'handback', kind: 'lintFailed', planId: PLAN_ID, errors: [{ group: 1, reason: 'bad' }], scriptPath, treeState: TREE }),
  ];
  return built.flatMap((r) => r.handback.answers
    .filter((a) => a.run !== undefined)
    .map((a) => ({ kind: r.handback.kind, label: a.label, run: a.run })));
}

// The expectation, read from the `run` text alone: `node "<path>" <subcommand> <args...>`.
function expected(run) {
  const match = /^node "[^"]+" (commit|release)((?: \S+)*)$/.exec(run);
  assert.ok(match, run);
  return { subcommand: match[1], args: match[2].split(' ').filter(Boolean) };
}

function hook(command, tool, agentType) {
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: '/w' };
  if (agentType !== undefined) input.agent_type = agentType;
  return runHook(JSON.stringify(input), { env: {}, claudeHome, now: () => 0 });
}

function assertRoundTrip(entry) {
  const want = expected(entry.run);
  for (const shell of SHELLS) {
    const parsed = segments(entry.run, shell);
    assert.ok(Array.isArray(parsed), `${shell}: tokenized: ${entry.run}`);
    const calls = parsed.map((segment) => recognise(segment)).filter((call) => call !== null);
    assert.deepEqual(calls, [want], `${shell}: ${entry.run}`);
    assert.deepEqual(hook(entry.run, TOOL[shell]), { stdout: '', stderr: '' }, `${shell}: a caller gets no output`);
    const denied = JSON.parse(hook(entry.run, TOOL[shell], WORKER).stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny', `${shell}: worker`);
    assert.equal(denied.permissionDecisionReason, HANDBACK, shell);
  }
}

for (const scriptPath of SCRIPT_PATHS) {
  test(`Seam 3 via runHook: confirm and lintFailed runs under ${scriptPath} read back in both shells`, () => {
    const runs = factRuns(scriptPath);
    assert.deepEqual(runs.map((r) => `${r.kind}/${r.label}`), ['confirm/yes', 'confirm/no', 'lintFailed/no']);
    for (const entry of runs) assertRoundTrip(entry);
    assert.deepEqual(expected(runs[0].run), { subcommand: 'commit', args: ['--plan', PLAN_ID, '--all', '--confirmed'] });
    for (const release of runs.slice(1)) assert.deepEqual(expected(release.run), { subcommand: 'release', args: ['--plan', PLAN_ID] });
  });
}

// The `continue` handback is built by M16 under a budget stop: a real run from a copy of the
// scripts under a directory holding a space, as the plugin cache under a spaced home would.
function copyScripts(dest, from = PLUGIN_SCRIPTS) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) copyScripts(path.join(dest, entry.name), source);
    else fs.copyFileSync(source, path.join(dest, entry.name));
  }
}

test('Seam 3 via runHook: a real continue handback run under a path with a space reads back in both shells', async (t) => {
  const c = createCase(t);
  const dest = path.join(c.root, 'my plugins', 'scripts');
  copyScripts(dest);
  const script = path.join(dest, 'commit.cjs');
  for (const [name, text] of Object.entries({ 'a.txt': 'one\n', 'b.txt': 'two\n', '.claude/commit.json': '{ "body": "optional" }\n' })) {
    c.writeFile(name, text);
  }
  c.git(['add', '--', 'a.txt', 'b.txt', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  c.writeFile('b.txt', 'two\nmore\n');
  const planned = await runCommit(c, ['plan'], { script });
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  const { planId, runDir } = planned.json;
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const [a, b] = ['a.txt', 'b.txt'].map((name) => state.units.filter((unit) => unit.path === name).map((u) => u.id));
  state.groups = [
    { n: 1, units: a, header: 'feat: change a', body: null, committed: false },
    { n: 2, units: b, header: 'fix: change b', body: null, committed: false },
  ];
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  const reflog = c.git(['reflog', 'show', '--no-color', '--format=%H', 'HEAD']).trim().split('\n').length;
  const schedule = path.join(c.root, 'schedule.json');
  fs.writeFileSync(schedule, JSON.stringify([{ event: { type: 'reflogCount', repo: c.repoDir, atLeast: reflog + 1 }, elapsedMs: 61_000 }]));
  const stopped = await runCommit(c, ['commit', '--plan', planId, '--all'], {
    script, nodeArgs: ['--import', CLOCK_PRELOAD], env: { COMMIT_TEST_CLOCK_SCHEDULE: schedule },
  });
  assert.equal(stopped.exitCode, 0, stopped.stdout + stopped.stderr);
  const { handback } = stopped.json.reply;
  assert.equal(handback.kind, 'continue');
  const { run } = handback.answers[0];
  assert.ok(run.includes('my plugins'), run);
  assertRoundTrip({ kind: 'continue', label: 'continue', run });
  for (const tool of Object.values(TOOL)) {
    const denied = await runGuard(c, { command: run, toolName: tool, agentType: WORKER });
    assert.equal(denied.exitCode, 0);
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny', tool);
    assert.equal(output.permissionDecisionReason, HANDBACK, tool);
    const passed = await runGuard(c, { command: run, toolName: tool });
    assert.equal(passed.stdout, '', tool);
    assert.equal(passed.stderr, '', tool);
  }
  assert.deepEqual(expected(run), { subcommand: 'commit', args: ['--plan', planId, '--all'] });
});

// Seam 2 through the guard process: the same calls, with and without the worker's agent_type,
// under a Windows path with a space and a POSIX path, plus the real `continue` run.
for (const tool of Object.values(TOOL)) {
  for (const scriptPath of [SCRIPT_PATHS[0], SCRIPT_PATHS[1]]) {
    for (const [kind, label] of [['confirm', 'yes'], ['confirm', 'no'], ['lintFailed', 'no']]) {
      test(`Seam 2 ${tool}: ${kind}/${label} run under ${scriptPath} is denied for ${WORKER}, silent otherwise`, async (t) => {
        const c = createCase(t);
        const entry = factRuns(scriptPath).find((r) => r.kind === kind && r.label === label);
        const denied = await runGuard(c, { command: entry.run, toolName: tool, agentType: WORKER });
        assert.equal(denied.exitCode, 0);
        const output = JSON.parse(denied.stdout).hookSpecificOutput;
        assert.equal(output.permissionDecision, 'deny');
        assert.equal(output.permissionDecisionReason, HANDBACK);
        const passed = await runGuard(c, { command: entry.run, toolName: tool });
        assert.equal(passed.exitCode, 0);
        assert.equal(passed.stdout, '');
        assert.equal(passed.stderr, '');
      });
    }
  }
}
