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

const BLANKET_KINDS = new Set(['substitution', 'heredoc', 'here-string', 'comment', 'typographic-quote', 'nesting', 'size']);

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
      assert.deepEqual(segments(c.command, 'powershell'), c.segments);
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

// A `<(…)` or `>(…)` inside an extglob pattern in an argument or a redirection target runs
// (bash reads the pattern in `[[ … ]]` even with `extglob` off): found while tokenizing, it
// is the blanket kind `substitution` (fail closed; review GRD-04 round 6, finding 1).
const patternSubstitution = [
  '[[ x == @(a|>(git commit -m x)) ]]',
  'echo @(<(git commit -m x))',
  'echo @(a|<(b)) git commit',
  'echo +(a|@(b|>(c))) commit',
  'case x in @(a|>(git commit -m x))) ;; esac',
  'cat >@(>(git commit -m x))',
  'echo x\r@(<(git commit -m x))',
];
for (const command of patternSubstitution) {
  test(`Seam 3: Bash segments(${JSON.stringify(command)}) is the blanket kind substitution`, () => {
    assert.equal(blanketTrigger(command, 'bash'), null);
    assert.deepEqual(segments(command, 'bash'), { blanket: 'substitution' });
    assert.equal(segmentSpans(command, 'bash'), null);
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
  // GRD-03 review: `$$` is a pair, a `\` in `$'…'` pairs lexically, escaped newlines are
  // joined before tokenizing (not inside '…' or $'…'), `{name}` prefixes a redirection.
  ["echo $$\"a\" $$$'\\x41' $$'\\'", [['echo', '$$a', '$$A', '$$\\']]],
  ["echo $'a\\c\\\\b' $'x\\c'", [['echo', 'a\u001cb', 'x\\c']]],
  ['echo \\\\\ngit commit', [['echo', '\\'], ['git', 'commit']]],
  ["echo 'a\\\nb' $'c\\\nd' \"e\\\nf\" g\\\nh", [['echo', 'a\\\nb', 'c\\\nd', 'ef', 'gh']]],
  ['cmd 3\\\n>&\\\n1 {fd}>&- {a[i j]}<in {1x}>o x\\', [['cmd',
    { redir: '3>&1', target: null }, { redir: '{fd}>&-', target: null }, '{a[i', 'j]}',
    { redir: '<', target: 'in' }, '{1x}', { redir: '>', target: 'o' }, 'x']]],
  ['git com\u0000mit', [['git', 'commit']]],
  ['a\rb', [['ab'], ['a\rb']]],
  // GRD-04 review round 5: an extglob pattern in an argument (or a redirection target) is one
  // word up to its matching `)`, separators and quotes inside it included; in a command's
  // first word (after reserved words such as `!`, `if` or `time -p`) its `(` is still a token.
  ["xargs env -S A=@( git commit --fixup=HEAD'\\c')", [['xargs', 'env', '-S', 'A=@( git commit --fixup=HEAD\\c)'], ['git', 'commit', '--fixup=HEAD\\c']]],
  ["xargs env -S A=@(x| git commit --fixup=HEAD'\\c')", [['xargs', 'env', '-S', 'A=@(x| git commit --fixup=HEAD\\c)'], ['x'], ['git', 'commit', '--fixup=HEAD\\c']]],
  ['echo @(a;b\nc&d) x', [['echo', '@(a;b\nc&d)', 'x'], ['a'], ['b'], ['c'], ['d']]],
  ["echo !(a|+(b)|')') *(c)d \\@(e) '@'(f)", [['echo', "!(a|+(b)|))", '*(c)d', '@', { op: '(' }, 'e', { op: ')' }, '@', { op: '(' }, 'f', { op: ')' }],
    ['a'], ['+(', { op: '(' }, 'b', { op: ')' }], [')'], ['c']]],
  ['>!(z) git commit', [[{ redir: '>', target: '!(z)' }, 'git', 'commit'], ['z']]],
  ['echo @(a | git commit', [['echo', '@(', 'a'], ['git', 'commit']]],
  ["echo @(a 'b\n) c", [['echo', '@(', 'a', 'b'], [{ op: ')' }, 'c']]],
  ['if ! time -p !(git commit); then :; fi', [['if', '!', 'time', '-p', '!(', { op: '(' }, 'git', 'commit', { op: ')' }], ['then', ':'], ['fi']]],
  ['A=1 !(x) | { @(y)', [['A=1', '!(x)'], ['x'], ['{', '@(', { op: '(' }, 'y', { op: ')' }]]],
  ['case a in @(a|b)) !(c);; esac', [['case', 'a', 'in', '@(a|b)', { op: ')' }, '!(', { op: '(' }, 'c', { op: ')' }], ['a'], ['b'], ['esac']]],
  // GRD-04 review round 6: a `\` inside a pattern escapes one character and keeps the pattern
  // balanced; a quoted or escaped `<(` inside it is a plain character, no substitution.
  [String.raw`echo @(a\)|b) x`, [['echo', '@(a)|b)', 'x'], ['a)'], ['b']]],
  [String.raw`xargs env -S A=@(\x| git commit --fixup=HEAD'\c')`, [['xargs', 'env', '-S', String.raw`A=@(x| git commit --fixup=HEAD\c)`], ['x'], ['git', 'commit', String.raw`--fixup=HEAD\c`]]],
  ["echo @(a'<(b') \\>(c) x", [['echo', '@(a<(b)', '>', { op: '(' }, 'c', { op: ')' }, 'x'], ['a<(b']]],
  [String.raw`echo @(a\<(b)) x`, [['echo', '@(a<(b))', 'x'], ['a<', { op: '(' }, 'b', { op: ')' }]]],
  // `{` keeps a command's first position after `function NAME`, `coproc` and `coproc NAME`
  // only, not after an argument.
  ['function f { !(x); }', [['function', 'f', '{', '!(', { op: '(' }, 'x', { op: ')' }], ['}']]],
  ['coproc { !(x); }', [['coproc', '{', '!(', { op: '(' }, 'x', { op: ')' }], ['}']]],
  ['coproc C { !(x); }', [['coproc', 'C', '{', '!(', { op: '(' }, 'x', { op: ')' }], ['}']]],
  ['coproc !(x)', [['coproc', '!(', { op: '(' }, 'x', { op: ')' }]]],
  ['function f !(x)', [['function', 'f', '!(x)'], ['x']]],
  ['coproc git commit { !(x)', [['coproc', 'git', 'commit', '{', '!(x)'], ['x']]],
  ['xargs env -S { A=@( git commit --fixup=HEAD) }', [['xargs', 'env', '-S', '{', 'A=@( git commit --fixup=HEAD)', '}'], ['git', 'commit', '--fixup=HEAD']]],
  ['echo function f { !(x)', [['echo', 'function', 'f', '{', '!(x)'], ['x']]],
  // GRD-04 review round 7: any reserved word that opens a command keeps the first position
  // after `function NAME`, `coproc` and `coproc NAME`, so does a `--` after `time [-p]`, and
  // the word after `function` is read as a first word.
  ['time -- !(x)', [['time', '--', '!(', { op: '(' }, 'x', { op: ')' }]]],
  ['time -p -- !(x)', [['time', '-p', '--', '!(', { op: '(' }, 'x', { op: ')' }]]],
  ['time -- time -- !(x)', [['time', '--', 'time', '--', '!(', { op: '(' }, 'x', { op: ')' }]]],
  ['time -- -- !(x)', [['time', '--', '--', '!(x)'], ['x']]],
  ['function f if !(x); then :; fi', [['function', 'f', 'if', '!(', { op: '(' }, 'x', { op: ')' }], ['then', ':'], ['fi']]],
  ['function f until !(x); do :; done', [['function', 'f', 'until', '!(', { op: '(' }, 'x', { op: ')' }], ['do', ':'], ['done']]],
  ['coproc while !(x); do :; done', [['coproc', 'while', '!(', { op: '(' }, 'x', { op: ')' }], ['do', ':'], ['done']]],
  ['coproc C if !(x); then :; fi', [['coproc', 'C', 'if', '!(', { op: '(' }, 'x', { op: ')' }], ['then', ':'], ['fi']]],
  ['function !(x); \\!',[['function', '!(', { op: '(' }, 'x', { op: ')' }], ['!']]],
  ['coproc git commit if !(x)', [['coproc', 'git', 'commit', 'if', '!(x)'], ['x']]],
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

test('Seam 3: segmentSpans map joined and carriage-return readings back to the command', () => {
  const command = 'git com\\\nmit\r\n;echo \u0000a';
  const spans = segmentSpans(command, 'bash').map(([start, end]) => command.slice(start, end));
  assert.deepEqual(spans, ['git com\\\nmit', 'echo \u0000a', 'git com\\\nmit\r', 'echo \u0000a']);
});

test('Seam 3: the blanket rule sees through NULs and carriage returns', () => {
  assert.equal(blanketTrigger('$\r(x) commit', 'bash'), 'substitution');
  assert.equal(blanketTrigger('$\u0000{x} commit', 'bash'), 'substitution');
  assert.equal(blanketTrigger('<\r\\\n< commit', 'bash'), 'heredoc');
});

test('Seam 3: the blanket rule also checks the carriage-return-kept Bash reading', () => {
  // `\` then CR is an escaped CR there, not a line continuation: `<<` stays a heredoc,
  // while the CR-dropped reading sees the here-string `<<<`.
  assert.equal(blanketTrigger(": <<\\\r\n<'\n\r\ngit commit -m x\n'\n", 'bash'), 'heredoc');
  assert.equal(blanketTrigger(': <<\\\n<x commit', 'bash'), null);
});

test('Seam 3: segmentSpans of a blanket command is null', () => {
  assert.equal(segmentSpans('echo $(x) commit', 'bash'), null);
});

// GRD-06: PowerShell readings the slice names (C:guard step 2, PowerShell column).
const cut = { op: 'cut' };
const powershellTable = [
  ['git commit -m "a`"b"', [['git', 'commit', '-m', 'a"b']]],
  ['git commit`0x -m x', [['git', 'commit', cut, '-m', 'x']]],
  ['git "commit`0" --no-edit', [['git', 'commit', cut, '--no-edit']]],
  ['git commit`u{000000} --no-edit', [['git', 'commit', cut, '--no-edit']]],
  ['git co`u{6D}mit -m x', [['git', 'commit', '-m', 'x']]],
  ['echo a`tb`nc', [['echo', 'a\tb\nc']]],
  ['& git commit -m x', [['&', 'git', 'commit', '-m', 'x']]],
  ['git status & git commit -m x', [['git', 'status'], ['git', 'commit', '-m', 'x']]],
  ['(& git commit)', [[{ op: '(' }, '&', 'git', 'commit', { op: ')' }]]],
  ['!(1)', [['!', { op: '(' }, '1', { op: ')' }]]],
  ['echo a2>b x', [['echo', 'a2>b', 'x']]],
  ['git commit -m x 2>&1 *>> log.txt', [['git', 'commit', '-m', 'x', { redir: '2>&1', target: null }, { redir: '*>>', target: 'log.txt' }]]],
  ['git commit -m ‘it’’s’', [['git', 'commit', '-m', 'it’s']]],
  ['git commit -m “a„', [['git', 'commit', '-m', 'a']]],
  ['git commit -m x', [['git', 'commit', '-m', 'x']]],
  ['git commit\r-m x', [['git', 'commit'], ['-m', 'x']]],
  ['git --% "a b" c|git commit -m x', [['git', '--%', '"a', 'b"', 'c'], ['git', 'commit', '-m', 'x']]],
  ['git --% a\ngit commit', [['git', '--%', 'a'], ['git', 'commit']]],
  ['Start-Process -ArgumentList { git commit -m x }', [['Start-Process', '-ArgumentList', { op: '{' }, 'git', 'commit', '-m', 'x', { op: '}' }]]],
  ['git commit -m "x\ngit status', [['git', 'commit', '-m', 'x'], ['git', 'status']]],
  ['git commit -m x`', [['git', 'commit', '-m', 'x']]],
];
for (const [command, expected] of powershellTable) {
  test(`Seam 3: PowerShell segments(${JSON.stringify(command)})`, () => {
    assert.deepEqual(segments(command, 'powershell'), expected);
  });
}

test('Seam 3: PowerShell segmentSpans are indices in the command, the call operator included', () => {
  assert.deepEqual(segmentSpans('& git commit -m x; git `\nstatus', 'powershell'), [[0, 17], [19, 31]]);
});
