'use strict';

// GRD-13: S2 ScriptCall at Seam 3 (docs/spec/modules-shared-and-guard.md S2; C:guard Script
// call and Parsing step 2 script-call exemption; Q16, Q23, Q25; stories 37, 38). `recognise`
// finds a script call in a G2 segment, `build` emits the one quoted form; G3 `classify`
// reports every segment's script call in `scriptCalls`; a caller's script calls get no guard
// output, and the ScriptCall round trip (docs/spec/testing-seams.md) holds in both shells.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');
const { createCase, runGuard } = require('./helpers/process-seam.js');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;

let recognise;
let build;
let SUBCOMMANDS;
let segments;
let isExemptScriptCall;
let classify;
let MESSAGES;
let runHook;

beforeEach(async () => {
  ({ recognise, build, SUBCOMMANDS } = await loadLib('script-call'));
  ({ segments, isExemptScriptCall } = await loadLib('shell-tokenizer'));
  ({ classify, MESSAGES } = await loadLib('command-classifier'));
  ({ runHook } = await loadLib('hook-io'));
});

const UUID = '3f9a1c2e-0000-4000-8000-000000000000';
const SHELLS = ['bash', 'powershell'];
const TOOL = { bash: 'Bash', powershell: 'PowerShell' };

// The script calls each segment of the command holds, as S2 reads them.
function callsIn(command, shell) {
  const parsed = segments(command, shell);
  assert.ok(Array.isArray(parsed), `${command} is tokenized`);
  return parsed.map((segment) => recognise(segment)).filter((call) => call !== null);
}

// A temporary Claude home, so a `plan` call is classified and writes its heartbeat rather
// than reaching the decision with a missing home (runHook's caller always injects one).
let claudeHome;
before(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-script-call-'));
});
after(() => fs.rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const heartbeatFile = () => path.join(claudeHome, 'commit-guard', 'heartbeat.json');

function hook(command, toolName, extra = {}) {
  fs.rmSync(heartbeatFile(), { force: true });
  const stdinText = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command }, cwd: '/w', ...extra });
  return runHook(stdinText, { env: {}, claudeHome, now: () => 0 });
}

// After hook(): a `plan` call wrote the heartbeat, any other subcommand none.
function assertHeartbeat(subcommand, label) {
  const written = fs.existsSync(heartbeatFile()) ? JSON.parse(fs.readFileSync(heartbeatFile(), 'utf8')) : null;
  if (subcommand === 'plan') assert.match(written ? written.command : '', /^commit\.cjs plan\b/, label);
  else assert.equal(written, null, label);
}

test('S2 is pure and imports nothing', () => {
  assertPureSource('script-call');
});

test('the subcommand list is C:guard\'s fixed list', () => {
  assert.deepEqual([...SUBCOMMANDS], ['plan', 'check', 'commit', 'release', 'infer']);
});

// C:guard Script call fixtures: quoted and unquoted, Bash and PowerShell, `& node …`,
// `node.exe` at an absolute path, `cd sub && node …`, a quoted backslash path in Bash.
const RECOGNISED = [
  ['bash', 'node "/opt/my plugins/commit/scripts/commit.cjs" plan', 'plan', []],
  ['bash', `node /opt/commit/scripts/commit.cjs check --plan ${UUID}`, 'check', ['--plan', UUID]],
  ['powershell', `node "C:/Program Files/commit/commit.cjs" commit --plan ${UUID}`, 'commit', ['--plan', UUID]],
  ['powershell', 'node C:/commit/scripts/commit.cjs release', 'release', []],
  ['powershell', `& node "C:/Users/Default User/commit/commit.cjs" check --plan ${UUID}`, 'check', ['--plan', UUID]],
  ['powershell', '& "C:\\Program Files\\nodejs\\node.exe" "C:/commit/commit.cjs" plan', 'plan', []],
  ['bash', '"/c/Program Files/nodejs/node.exe" "/c/commit/commit.cjs" plan', 'plan', []],
  ['bash', 'cd sub && node "/opt/commit/commit.cjs" plan', 'plan', []],
  ['powershell', 'cd sub && node "C:/commit/commit.cjs" plan', 'plan', []],
  ['bash', 'node "C:\\Program Files\\commit\\scripts\\commit.cjs" plan', 'plan', []],
  ['bash', 'node "/opt/commit/commit.cjs" infer', 'infer', []],
  ['powershell', 'node "C:/commit/commit.cjs" infer', 'infer', []],
  ['bash', 'node "/opt/commit/commit.cjs" plan 2>&1 > out.txt', 'plan', []],
  // The wide recogniser (C:guard Script call): `node`, `node.exe` and `commit.cjs` in any
  // case, and after a leading group or a prefix that cannot change what node runs.
  ['bash', 'NODE "/opt/commit/commit.cjs" plan', 'plan', []],
  ['powershell', 'Node.EXE "C:/commit/commit.cjs" commit', 'commit', []],
  ['powershell', '& NODE.EXE "C:/commit/commit.cjs" release', 'release', []],
  ['bash', 'node "/opt/commit/COMMIT.CJS" commit', 'commit', []],
  ['bash', '( node "/opt/commit/commit.cjs" commit )', 'commit', []],
  ['bash', '{ node "/opt/commit/commit.cjs" commit; }', 'commit', []],
  ['bash', '! node "/opt/commit/commit.cjs" commit', 'commit', []],
  ['bash', 'time node "/opt/commit/commit.cjs" commit', 'commit', []],
  ['bash', 'time -p node "/opt/commit/commit.cjs" commit', 'commit', []],
  ['bash', '! ( { node "/opt/commit/commit.cjs" release; } )', 'release', []],
  ['bash', `'&' node "/opt/commit/commit.cjs" plan`, 'plan', []],
  ['powershell', '(node "C:/commit/commit.cjs" commit)', 'commit', []],
  ['powershell', '& { node "C:/commit/commit.cjs" commit }', 'commit', []],
  ['powershell', '&{node "C:/commit/commit.cjs" release}', 'release', []],
  ['powershell', '. node "C:/commit/commit.cjs" commit', 'commit', []],
  ['powershell', '. { node "C:/commit/commit.cjs" commit }', 'commit', []],
  ['powershell', `'&' node "C:/commit/commit.cjs" plan`, 'plan', []],
];

for (const [shell, command, subcommand, args] of RECOGNISED) {
  test(`Seam 3: ${shell} \`${command}\` is a script call to ${subcommand}`, () => {
    assert.deepEqual(callsIn(command, shell), [{ subcommand, args }]);
  });
}

const NOT_CALLS = [
  ['bash', 'echo "node commit.cjs plan"'],
  ['powershell', 'echo "node commit.cjs plan"'],
  ['bash', 'node commit.cjs foo'],
  ['powershell', 'node commit.cjs foo'],
  ['bash', 'node commit.cjs'],
  ['bash', 'node --eval x commit.cjs plan'],
  ['bash', 'node other.cjs plan'],
  ['bash', 'nodejs commit.cjs plan'],
  ['bash', 'node commit.cjs PLAN'],
  ['powershell', 'node commit.cjs Commit'],
  ['bash', 'node "/opt/commit/commit.cjs." plan'],
  // Never skipped: an assignment or a runner can change what node runs (C:guard Script call).
  ['bash', 'X=1 node "/opt/commit/commit.cjs" commit'],
  ['bash', 'NODE_OPTIONS=--require=/evil.js node "/opt/commit/commit.cjs" commit'],
  ['bash', 'env node "/opt/commit/commit.cjs" commit'],
  ['bash', 'command node "/opt/commit/commit.cjs" commit'],
  ['bash', 'exec node "/opt/commit/commit.cjs" commit'],
  // Documented gaps of the worker-only rule (C:guard Script call).
  ['bash', 'node -- "/opt/commit/commit.cjs" commit'],
  ['powershell', 'node -- "C:/commit/commit.cjs" commit'],
];

for (const [shell, command] of NOT_CALLS) {
  test(`Seam 3: ${shell} \`${command}\` is not a script call`, () => {
    assert.deepEqual(callsIn(command, shell), []);
  });
}

test('Seam 3: the script call\'s arguments end at an operator token', () => {
  assert.deepEqual(recognise(['node', '/p/commit.cjs', 'plan', '--x', { op: ')' }, 'y']), { subcommand: 'plan', args: ['--x'] });
});

test('Seam 3: classify reports every segment\'s script call, a denied command\'s included', () => {
  const chained = classify(segments('cd sub && node "/opt/commit/commit.cjs" plan', 'bash'), { shell: 'bash' });
  assert.equal(chained.decision, 'none');
  assert.deepEqual(chained.scriptCalls, [{ subcommand: 'plan', args: [] }]);
  const denied = classify(segments('node "/opt/commit/commit.cjs" plan; git commit -m x', 'bash'), { shell: 'bash' });
  assert.equal(denied.decision, 'deny');
  assert.deepEqual(denied.scriptCalls, [{ subcommand: 'plan', args: [] }]);
  const ps = classify(segments(`& node "C:/c/commit.cjs" check --plan ${UUID}`, 'powershell'), { shell: 'powershell' });
  assert.deepEqual(ps.scriptCalls, [{ subcommand: 'check', args: ['--plan', UUID] }]);
  assert.deepEqual(classify(segments('git status', 'bash'), { shell: 'bash' }).scriptCalls, []);
});

// Recognising more cannot make a command pass: every newly recognised form chained with
// `git commit` is still denied, and none of them is in the step 2 exemption form.
const WIDE_ONLY = [
  ['bash', 'NODE "/opt/commit/commit.cjs" commit'],
  ['bash', 'node "/opt/commit/COMMIT.CJS" commit'],
  ['bash', '( node "/opt/commit/commit.cjs" commit )'],
  ['bash', '! node "/opt/commit/commit.cjs" commit'],
  ['bash', 'time -p node "/opt/commit/commit.cjs" commit'],
  ['bash', `'&' node "/opt/commit/commit.cjs" commit`],
  ['powershell', 'NODE.EXE "C:/commit/commit.cjs" commit'],
  ['powershell', '(node "C:/commit/commit.cjs" commit)'],
  ['powershell', '& { node "C:/commit/commit.cjs" commit }'],
  ['powershell', '. node "C:/commit/commit.cjs" commit'],
];

for (const [shell, command] of WIDE_ONLY) {
  test(`Seam 3: ${shell} \`${command}\` is not exempt, and denied when chained with git commit`, () => {
    assert.equal(isExemptScriptCall(command, shell), false);
    for (const joint of ['; ', ' && ']) {
      const result = classify(segments(`${command}${joint}git commit -m x`, shell), { shell });
      assert.equal(result.decision, 'deny', joint);
      assert.equal(result.scriptCalls.length, 1, joint);
    }
  });
}

// S2 `build` (declared at Seam 3): an absolute forward-slash path in double quotes.
const BUILDS = [
  [{ scriptPath: '/opt/my plugins/commit/scripts/commit.cjs', subcommand: 'plan', args: [] },
    'node "/opt/my plugins/commit/scripts/commit.cjs" plan'],
  [{ scriptPath: 'C:\\Users\\Default User\\.claude\\plugins\\cache\\commit\\scripts\\commit.cjs', subcommand: 'check', args: ['--plan', UUID] },
    `node "C:/Users/Default User/.claude/plugins/cache/commit/scripts/commit.cjs" check --plan ${UUID}`],
  [{ scriptPath: 'd:\\Program Files\\commit\\commit.cjs', subcommand: 'commit', args: ['--plan', UUID] },
    `node "d:/Program Files/commit/commit.cjs" commit --plan ${UUID}`],
  [{ scriptPath: 'C:/Program Files/commit/commit.cjs', subcommand: 'release', args: ['--plan', UUID] },
    `node "C:/Program Files/commit/commit.cjs" release --plan ${UUID}`],
  [{ scriptPath: '\\\\server\\share\\commit\\commit.cjs', subcommand: 'infer', args: [] },
    'node "//server/share/commit/commit.cjs" infer'],
  [{ scriptPath: '/opt/a#b/commit.cjs', subcommand: 'plan' },
    'node "/opt/a#b/commit.cjs" plan'],
];

for (const [input, expected] of BUILDS) {
  test(`Seam 3: build emits \`${expected}\` and both shells read it back`, () => {
    const command = build(input);
    assert.equal(command, expected);
    for (const shell of SHELLS) {
      assert.ok(isExemptScriptCall(command, shell), `${shell}: in the step 2 exemption form`);
      assert.deepEqual(callsIn(command, shell), [{ subcommand: input.subcommand, args: input.args ?? [] }], shell);
      assert.deepEqual(hook(command, TOOL[shell]), { stdout: '', stderr: '' }, `${shell}: no guard output`);
      assertHeartbeat(input.subcommand, shell);
    }
  });
}

test('Seam 3: build converts no `\\` in a POSIX path (the entry point refuses that path, `env`)', () => {
  assert.equal(build({ scriptPath: '/opt/a\\b/commit.cjs', subcommand: 'plan', args: [] }), 'node "/opt/a\\b/commit.cjs" plan');
});

test('Seam 3: build refuses what has no exempt quoted form', () => {
  const ok = { scriptPath: '/opt/commit/commit.cjs', subcommand: 'plan', args: [] };
  assert.throws(() => build({ ...ok, scriptPath: 'commit/commit.cjs' }), TypeError);
  assert.throws(() => build({ ...ok, scriptPath: '/opt/commit/other.cjs' }), TypeError);
  assert.throws(() => build({ ...ok, subcommand: 'foo' }), TypeError);
  for (const arg of ['', 'a b', 'x;y', '$x', '"x"']) {
    assert.throws(() => build({ ...ok, args: [arg] }), TypeError, JSON.stringify(arg));
  }
});

// The characters the step 2 exemption keeps out of the quoted path (C:guard step 2): a
// double quote of either shell, `$`, a backtick, `!` and every control character.
const PATH_REFUSED = new Set(['"', '\u201C', '\u201D', '\u201E', '$', '`', '!', '\u007F']);
for (let code = 0; code < 0x20; code += 1) PATH_REFUSED.add(String.fromCharCode(code));

test('Seam 3: build refuses every path character outside the exemption form', () => {
  for (const char of ['"', '\u201C', '$', '`', '!', '\n', '\r', '\t', '\u0000', '\u007F']) {
    for (const scriptPath of [`/opt/a${char}b/commit.cjs`, `C:\\a${char}b\\commit.cjs`]) {
      assert.throws(() => build({ scriptPath, subcommand: 'plan' }), TypeError, JSON.stringify(scriptPath));
    }
  }
  // A `"` would otherwise end the quoted path and append commands that G3 lets through.
  assert.throws(() => build({ scriptPath: '/opt/a" ; touch x ; "/commit.cjs', subcommand: 'plan' }), TypeError);
});

test('Seam 3: across a character sweep, build either throws or is exempt and read back in both shells', () => {
  const sweep = [];
  for (let code = 0; code < 0x80; code += 1) sweep.push(String.fromCharCode(code));
  sweep.push('\u00A0', '\u0085', '\u2018', '\u2019', '\u201A', '\u201B', '\u201C', '\u201D', '\u201E', '\u2028', '\uFEFF', '\u00E9');
  for (const char of sweep) {
    for (const scriptPath of [`/opt/a${char}b/commit.cjs`, `C:\\a${char}b\\commit.cjs`]) {
      const label = JSON.stringify(scriptPath);
      if (PATH_REFUSED.has(char)) {
        assert.throws(() => build({ scriptPath, subcommand: 'plan', args: ['--x'] }), TypeError, label);
        continue;
      }
      const command = build({ scriptPath, subcommand: 'plan', args: ['--x'] });
      for (const shell of SHELLS) {
        assert.ok(isExemptScriptCall(command, shell), `${shell}: ${label} in the exemption form`);
        assert.deepEqual(callsIn(command, shell), [{ subcommand: 'plan', args: ['--x'] }], `${shell}: ${label}`);
      }
    }
  }
});

// The exemption seed: its four `decision: none` cases named by GRD-13 are recognised script
// calls with no output; the rest are blanket-denied.
const EXEMPT_NONE = ['b-exempt-hash', 'b-exempt-typographic', 'p-exempt-hash', 'p-exempt-atparen'];
const EXEMPT_DENIED = ['b-exempt-appended', 'b-exempt-newline', 'b-exempt-comment', 'b-exempt-bang', 'p-exempt-appended', 'p-exempt-dollar'];
const seedCase = (id) => seedCases.find((c) => c.id === id);

for (const id of EXEMPT_NONE) {
  test(`Seam 3: exemption seed ${id} is a recognised script call with no output`, () => {
    const c = seedCase(id);
    assert.equal(c.decision, 'none');
    assert.ok(isExemptScriptCall(c.command, c.shell));
    const calls = callsIn(c.command, c.shell);
    assert.equal(calls.length, 1);
    assert.deepEqual(hook(c.command, TOOL[c.shell]), { stdout: '', stderr: '' });
    assertHeartbeat(calls[0].subcommand, id);
  });
}

for (const id of EXEMPT_DENIED) {
  test(`Seam 3: exemption seed ${id} is blanket-denied`, () => {
    const c = seedCase(id);
    assert.equal(c.decision, 'deny');
    const parsed = segments(c.command, c.shell);
    assert.ok(!Array.isArray(parsed), 'not tokenized');
    const result = classify(parsed, { shell: c.shell });
    assert.equal(result.decision, 'deny');
    assert.deepEqual(result.scriptCalls, []);
    const reason = JSON.parse(hook(c.command, TOOL[c.shell]).stdout).hookSpecificOutput.permissionDecisionReason;
    assert.equal(result.message, MESSAGES.blanket);
    assert.equal(reason, MESSAGES.blanket);
  });
}

// Story 38: a caller's script calls produce no guard output outside the worker.
for (const subcommand of ['plan', 'check', 'commit', 'release']) {
  for (const shell of SHELLS) {
    test(`Seam 2: a caller's ${shell} \`${subcommand}\` script call gets no guard output`, async (t) => {
      const c = createCase(t);
      const command = build({ scriptPath: '/opt/commit/scripts/commit.cjs', subcommand, args: subcommand === 'plan' ? [] : ['--plan', UUID] });
      const result = await runGuard(c, { command, toolName: TOOL[shell] });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
  }
}
