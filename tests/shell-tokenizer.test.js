'use strict';

// GRD-03: G2 shell tokenizer at Seam 3 (docs/spec/modules-shared-and-guard.md G2; C:guard
// Parsing step 2). The step 2 script-call exemption and blanket rule for both shells, and
// the Bash tokenizer checked against the PRE-03 golden seed
// (tests/fixtures/guard/segments-seed.json) plus the `$'…'` and double-quote cases the slice
// names. The seed's cross-check against bash's own words is tests/guard-bash-oracle.test.js.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { assertPureSource } = require('./helpers/assert-pure-source');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const seedCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases;

let segments;
let blanketTrigger;
let isExemptScriptCall;
let segmentSpans;

beforeEach(async () => {
  ({ segments, blanketTrigger, isExemptScriptCall, segmentSpans } = await loadLib('shell-tokenizer'));
});

const BLANKET_KINDS = new Set(['substitution', 'heredoc', 'here-string', 'comment', 'typographic-quote']);

test('G2 is pure (no I/O, no ambient state, no imports)', () => {
  assertPureSource('shell-tokenizer');
});

// Golden fixtures: every Bash seed case tokenizes to its seed segments, and every seed case
// with no segments (oracle `blanket`) is a blanket result, in either shell.
for (const c of seedCases.filter((x) => x.shell === 'bash')) {
  test(`Seam 3: Bash golden ${c.id}: segments(${JSON.stringify(c.command)})`, () => {
    const result = segments(c.command, 'bash');
    if (c.segments.length === 0) {
      assert.ok(!Array.isArray(result), `expected a blanket result, got ${JSON.stringify(result)}`);
      assert.ok(BLANKET_KINDS.has(result.blanket), `unknown trigger kind ${result.blanket}`);
    } else {
      assert.deepEqual(result, c.segments);
    }
  });
}

for (const c of seedCases.filter((x) => x.shell === 'powershell')) {
  test(`Seam 3: PowerShell blanket rule on ${c.id}`, () => {
    const kind = blanketTrigger(c.command, 'powershell');
    if (c.segments.length === 0) {
      assert.ok(BLANKET_KINDS.has(kind), `expected a trigger kind, got ${kind}`);
      assert.deepEqual(segments(c.command, 'powershell'), { blanket: kind });
    } else {
      assert.equal(kind, null);
    }
  });
}

// The trigger kind names what the blanket rule found (debug log, C:guard Output).
const kindTable = [
  ['bash', 'echo $(git commit -m x)', 'substitution'],
  ['bash', 'echo ${x} git commit', 'substitution'],
  ['bash', 'echo `git commit -m x`', 'substitution'],
  ['bash', 'git commit --no-edit # done', 'comment'],
  ['bash', 'cat <<EOF\ngit commit -m x\nEOF', 'heredoc'],
  ['bash', 'cat <<-EOF\ngit commit\nEOF', 'heredoc'],
  ['bash', 'cat <<<<x git commit', 'heredoc'],
  ['bash', 'git “commit” -m x', 'typographic-quote'],
  ['powershell', 'git commit -m "$(Get-Date)"', 'substitution'],
  ['powershell', 'git commit --fixup @("HEAD")', 'substitution'],
  ['powershell', "@'\ngit commit -m x\n'@ | Set-Content f", 'here-string'],
  ['powershell', '<# x #> git commit', 'comment'],
];
for (const [shell, command, kind] of kindTable) {
  test(`Seam 3: ${shell} blanketTrigger(${JSON.stringify(command)}) is ${kind}`, () => {
    assert.equal(blanketTrigger(command, shell), kind);
  });
}

const noTriggerTable = [
  ['bash', 'cat <<< "git commit -m x"'],
  ['bash', 'git commit -m x'],
  ['powershell', 'git co‘’mmit -m x'],
  ['powershell', 'git commit -m `$x'],
];
for (const [shell, command] of noTriggerTable) {
  test(`Seam 3: ${shell} blanketTrigger(${JSON.stringify(command)}) is null`, () => {
    assert.equal(blanketTrigger(command, shell), null);
  });
}

test('Seam 3: escaped newlines are removed before the blanket check, regardless of quotes', () => {
  assert.equal(blanketTrigger('echo "$\\\n(git commit -m x)"', 'bash'), 'substitution');
  assert.equal(blanketTrigger('echo "<\\\n<EOF" git commit', 'bash'), 'heredoc');
  assert.equal(blanketTrigger('Write-Output "$`\n(git commit)"', 'powershell'), 'substitution');
  // Each shell removes only its own escape.
  assert.equal(blanketTrigger('echo "$`\n(x)" commit', 'bash'), 'substitution');
  assert.equal(blanketTrigger('echo "$\\\n(x)" commit', 'powershell'), null);
});

// C:guard step 2 script-call exemption.
const exemptTable = [
  ['bash', 'node "/opt/a#b/commit.cjs" plan', true],
  ['bash', '  node.exe "C:\\a#b\\commit.cjs" check --plan p-1:x=y  ', true],
  ['bash', 'node "/opt/x/commit.cjs" plan --summary-only', true],
  ['bash', '& node "/opt/x/commit.cjs" plan', false],
  ['powershell', '& node "C:/a#b/commit.cjs" check --plan abc', true],
  ['powershell', 'node "C:/x@(y)/commit.cjs" plan', true],
  ['bash', 'node "/opt/x/commit.cjs" frob', false],
  ['bash', 'node "-x#/commit.cjs" plan', false],
  ['bash', 'node "/opt/a!b#/commit.cjs" plan', false],
  ['bash', 'node "/opt/$x/commit.cjs" plan', false],
  ['bash', 'node "/opt/`x`/commit.cjs" plan', false],
  ['bash', 'node "/opt/“x/commit.cjs" plan', false],
  ['bash', 'node "/opt/a\tb/commit.cjs" plan', false],
  ['bash', 'node "/opt/x/commit.cjs" plan; git commit -m x', false],
  ['bash', 'node "/opt/x/commit.cjs" plan\ngit commit -m x', false],
  ['bash', 'node "/opt/x/commit.cjs" plan # note', false],
  ['bash', 'node "/opt/x/commit.cjs" plan a,b', false],
  ['bash', 'node  "/opt/x/commit.cjs" plan', false],
  ['bash', 'node "/opt/x/notcommit.cjs" plan', false],
  ['bash', 'node /opt/x/commit.cjs plan', false],
];
for (const [shell, command, exempt] of exemptTable) {
  test(`Seam 3: ${shell} isExemptScriptCall(${JSON.stringify(command)}) is ${exempt}`, () => {
    assert.equal(isExemptScriptCall(command, shell), exempt);
  });
}

test('Seam 3: an exempt script call is tokenized even with a trigger in its path', () => {
  assert.equal(blanketTrigger('node "/opt/a#b<<c/commit.cjs" plan', 'bash'), null);
  assert.deepEqual(segments('node "/opt/a#b<<c/commit.cjs" plan', 'bash'), [['node', '/opt/a#b<<c/commit.cjs', 'plan']]);
});

// Slice-named Bash readings (GRD-03).
const bashTable = [
  ['git commit -m "a\\"b"', [['git', 'commit', '-m', 'a"b']]],
  ['echo "a\\\\b\\$c\\d"', [['echo', 'a\\b$c\\d']]],
  ["echo 'a\\b'", [['echo', 'a\\b']]],
  ['echo a\\ b\\;c', [['echo', 'a b;c']]],
  ["echo $'\\'' ; git commit -m x", [['echo', "'"], ['git', 'commit', '-m', 'x']]],
  ["git $'commit' -m x", [['git', 'commit', '-m', 'x']]],
  ["git $'commit\\0x' -m x", [['git', 'commit', '-m', 'x']]],
  ["git $'commit\\x00' -m x", [['git', 'commit', '-m', 'x']]],
  ["git $'commit\\u0000' -m x", [['git', 'commit', '-m', 'x']]],
  ["git $'commit\\c@' -m x", [['git', 'commit', '-m', 'x']]],
  ["echo $'ab\\0cd'ef", [['echo', 'abef']]],
  ["echo $'\\x41\\101\\u00e9\\U0001F600\\t\\n\\a\\e\\q\\\\\\\"\\?\\cA\\c?'",
    [['echo', 'AA\u00e9\u{1F600}\t\n\u0007\u001b\\q\\"?\u0001\u007f']]],
  ["echo $'\\x' $'\\u' $'\\c'", [['echo', '\\x', '\\u', '\\c']]],
  ["echo \"$'x'\"", [['echo', "$'x'"]]],
  ['echo "a$"', [['echo', 'a$']]],
  ["echo ''", [['echo', '']]],
  ['a && b || c ; d | e & f |& g', [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]],
  ['\n\n a \n', [['a']]],
  ['cmd >> out 2>& 1 <in 3<&0 >| f <> g &>> h', [['cmd',
    { redir: '>>', target: 'out' }, { redir: '2>&1', target: null }, { redir: '<', target: 'in' },
    { redir: '3<&0', target: null }, { redir: '>|', target: 'f' }, { redir: '<>', target: 'g' },
    { redir: '&>>', target: 'h' }]]],
  ['cmd >', [['cmd', { redir: '>', target: null }]]],
  ['a2>b', [['a2', { redir: '>', target: 'b' }]]],
];
for (const [command, expected] of bashTable) {
  test(`Seam 3: Bash segments(${JSON.stringify(command)})`, () => {
    assert.deepEqual(segments(command, 'bash'), expected);
  });
}

test('Seam 3: segmentSpans gives each segment its source text span', () => {
  const command = 'cd x && git commit -m "a b" 2>&1 ;  echo y';
  const spans = segmentSpans(command, 'bash').map(([start, end]) => command.slice(start, end));
  assert.deepEqual(spans, ['cd x', 'git commit -m "a b" 2>&1', 'echo y']);
});

test('Seam 3: segmentSpans of a blanket command is null', () => {
  assert.equal(segmentSpans('echo $(x) commit', 'bash'), null);
});
