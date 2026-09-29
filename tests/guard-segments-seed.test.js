'use strict';

// PRE-03 (tokenizer spike): schema check for the hand-edited G2 segments seed
// (tests/fixtures/guard/segments-seed.json). The seed is the golden input for GRD-03; this
// test keeps its shape valid and every oracle-skip class named in it defined in C:guard's
// class table (docs/contracts/guard.md, Oracle-skip classes), with the class's shell.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(ROOT, 'tests', 'fixtures', 'guard', 'segments-seed.json');
const CONTRACT = path.join(ROOT, 'docs', 'contracts', 'guard.md');

const ORACLE_KEYS = { bash: ['bash'], powershell: ['ps51', 'ps7'] };
const ID_PREFIX = { bash: 'b', powershell: 'p' };
const OPS = new Set(['(', ')', '{', '}', 'cut']);
const HEREDOC_OPS = new Set(['<<', '<<-']);
const GIT_BASENAME = /^git(-commit)?(\.exe)?$/i;

function readSeed() {
  return JSON.parse(fs.readFileSync(SEED, 'utf8'));
}

// Parses the Oracle-skip classes table into Map<class, Set<shell>>.
function readClassTable() {
  const text = fs.readFileSync(CONTRACT, 'utf8');
  const start = text.indexOf('**Oracle-skip classes:**');
  assert.ok(start >= 0, 'C:guard has no Oracle-skip classes section');
  const classes = new Map();
  const shellsOf = { Bash: ['bash'], PowerShell: ['powershell'], both: ['bash', 'powershell'] };
  for (const line of text.slice(start).split('\n')) {
    const m = /^\| `([a-z0-9-]+)` \| (Bash|PowerShell|both) \|/.exec(line);
    if (m) classes.set(m[1], new Set(shellsOf[m[2]]));
    else if (classes.size > 0 && !line.startsWith('|')) break;
  }
  return classes;
}

function tokenProblem(token) {
  if (typeof token === 'string') return null;
  if (token === null || typeof token !== 'object') return 'not a string or object';
  const keys = Object.keys(token).sort().join(',');
  if (keys === 'op') return OPS.has(token.op) ? null : `unknown op ${token.op}`;
  if (keys === 'redir,target') {
    // A descriptor duplication such as 2>&1 has no target word.
    return typeof token.redir === 'string' && (typeof token.target === 'string' || token.target === null)
      ? null
      : 'redir must be a string and target a string or null';
  }
  if (keys === 'delim,heredoc') {
    return HEREDOC_OPS.has(token.heredoc) && typeof token.delim === 'string'
      ? null
      : 'heredoc must be << or <<- with a string delim';
  }
  return `unknown token keys ${keys}`;
}

function basename(token) {
  return token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
}

test('seed has a note and a non-empty cases array', () => {
  const seed = readSeed();
  assert.equal(typeof seed.note, 'string');
  assert.ok(Array.isArray(seed.cases) && seed.cases.length > 0);
});

test('seed file keeps its one-space JSON layout', () => {
  const raw = fs.readFileSync(SEED, 'utf8');
  assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 1)}\n`);
});

test('case ids are unique and carry their shell prefix', () => {
  const seen = new Set();
  for (const c of readSeed().cases) {
    assert.equal(typeof c.id, 'string');
    assert.ok(!seen.has(c.id), `duplicate id ${c.id}`);
    seen.add(c.id);
    assert.ok(Object.hasOwn(ID_PREFIX, c.shell), `${c.id}: unknown shell ${c.shell}`);
    assert.ok(c.id.startsWith(ID_PREFIX[c.shell]), `${c.id}: id does not start with ${ID_PREFIX[c.shell]}`);
  }
});

test('every case has the known fields with valid values', () => {
  const allowed = new Set(['id', 'shell', 'topic', 'command', 'segments', 'decision', 'oracle', 'finding']);
  for (const c of readSeed().cases) {
    for (const key of Object.keys(c)) assert.ok(allowed.has(key), `${c.id}: unknown field ${key}`);
    assert.equal(typeof c.topic, 'string', `${c.id}: topic`);
    assert.ok(typeof c.command === 'string' && c.command.length > 0, `${c.id}: command`);
    assert.ok(['deny', 'none'].includes(c.decision), `${c.id}: decision ${c.decision}`);
    if ('finding' in c) assert.match(c.finding, /^F\d+$/, `${c.id}: finding`);
  }
});

test('segments are arrays of string, op, redirection or heredoc tokens', () => {
  for (const c of readSeed().cases) {
    assert.ok(Array.isArray(c.segments), `${c.id}: segments is not an array`);
    c.segments.forEach((segment, i) => {
      assert.ok(Array.isArray(segment) && segment.length > 0, `${c.id}: segment ${i} is not a non-empty array`);
      for (const token of segment) {
        const problem = tokenProblem(token);
        assert.equal(problem, null, `${c.id}: segment ${i} token ${JSON.stringify(token)}: ${problem}`);
      }
    });
  }
});

test('a denied case has a git or git-commit token in some segment', () => {
  for (const c of readSeed().cases.filter((x) => x.decision === 'deny')) {
    const hasGit = c.segments.some((s) => s.some((t) => typeof t === 'string' && GIT_BASENAME.test(basename(t))));
    assert.ok(hasGit, `${c.id}: denied but no segment holds a git token`);
  }
});

test('oracle keys match the shell and values name classes from C:guard', () => {
  const classes = readClassTable();
  assert.ok(classes.size > 0, 'no classes parsed from C:guard');
  for (const c of readSeed().cases) {
    assert.deepEqual(Object.keys(c.oracle).sort(), ORACLE_KEYS[c.shell], `${c.id}: oracle keys`);
    for (const [key, value] of Object.entries(c.oracle)) {
      if (value === 'match') continue;
      const list = Array.isArray(value) ? value : [value];
      assert.ok(list.length > 0, `${c.id}: ${key} has an empty class list`);
      for (const name of list) {
        assert.ok(classes.has(name), `${c.id}: ${key} class ${name} is not in C:guard's class table`);
        assert.ok(classes.get(name).has(c.shell), `${c.id}: ${key} class ${name} is not for ${c.shell}`);
      }
    }
  }
});
