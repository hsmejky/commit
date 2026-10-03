'use strict';

// GRD-20: the bypass corpus, through G1 `runHook` (Seam 3). Two kinds of fixture file:
// - tests/fixtures/guard/prior-art/*.json: bypass cases borrowed from other projects' test
//   suites (docs/spec/prior-art.md), each file's header crediting the project and its
//   licence. Only the cases (data) are adapted; no code is copied (Dependency policy).
// - tests/fixtures/guard/bypass-corpus.json: the closed bypasses of story 15 and the
//   accepted gaps of Q3, as this spec words them.
// Every case either is denied with an exact C:guard deny text (`deny`) or has no output and
// names its accepted gap (`gap`), a passage of docs/spec/out-of-scope.md quoted verbatim.
// A static check reads each prior-art header's declared licence and fails unless the
// Dependency policy allows it; the checker also runs on bad headers, so it cannot pass
// vacuously.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCase } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib');

const ROOT = path.join(__dirname, '..');
const GUARD_FIXTURES = path.join(__dirname, 'fixtures', 'guard');
const PRIOR_ART_DIR = path.join(GUARD_FIXTURES, 'prior-art');
const OWN_CORPUS = path.join(GUARD_FIXTURES, 'bypass-corpus.json');
const OUT_OF_SCOPE = path.join(ROOT, 'docs', 'spec', 'out-of-scope.md');

let runHook;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
});

// C:guard's deny texts, spelled out here rather than read from the classifier's catalogue.
const ROUTE =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';
const LINE = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';
const routed = (head) => `${head} ${ROUTE}\n${LINE}`;
const TEXTS = {
  bare: () => routed('Direct git commit is blocked.'),
  wrapper: (name) => routed(`git commit run by ${name} is not allowed: it can append arguments.`),
  notHere: (token) => routed(`git commit ${token} is not allowed here.`),
  configOption: () => routed('git -c … commit is not allowed.'),
  literalSubcommand: () => routed('Write the git subcommand literally.'),
  literalArguments: () => routed("Write git's arguments literally."),
  unknownOption: () => routed("Could not parse git options before 'commit'."),
  blanket: () => routed('This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit:'),
  noVerify: (flag) => `${flag} is not allowed. Fix the hook or signing setup instead.`,
};

// A case's `deny` is a row name, or [row name, argument] for a row that names a token.
function expectedReason(deny) {
  const [row, arg] = Array.isArray(deny) ? deny : [deny];
  const text = TEXTS[row];
  if (text === undefined) throw new Error(`unknown deny row ${JSON.stringify(row)}`);
  return text(arg);
}

const squash = (s) => s.replace(/\s+/g, ' ');

// The licences the Dependency policy lets test cases be borrowed from (SPDX ids).
const ALLOWED_LICENCES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'CC-BY-4.0']);

// Problems with a prior-art fixture header; an empty list when it is acceptable.
function licenceProblems(header) {
  const problems = [];
  for (const key of ['source', 'url', 'revision', 'licence', 'credit']) {
    if (typeof header[key] !== 'string' || header[key].trim() === '') problems.push(`missing ${key}`);
  }
  if (typeof header.licence === 'string' && !ALLOWED_LICENCES.has(header.licence)) {
    problems.push(`licence ${JSON.stringify(header.licence)} is not allowed`);
  }
  if (header.licence === 'Apache-2.0' && (typeof header.notice !== 'string' || header.notice.trim() === '')) {
    problems.push('Apache-2.0 without its NOTICE');
  }
  return problems;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function priorArtFiles() {
  return fs.readdirSync(PRIOR_ART_DIR).filter((name) => name.endsWith('.json')).sort()
    .map((name) => path.join(PRIOR_ART_DIR, name));
}

function corpusFiles() {
  return [...priorArtFiles(), OWN_CORPUS];
}

function hook(c, toolName, command) {
  const stdinText = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command }, cwd: c.root });
  return runHook(stdinText, { env: {}, claudeHome: c.claudeHome, now: () => Date.UTC(2024, 0, 1) });
}

test('the licence check accepts every allowed licence and refuses the rest', () => {
  const good = { source: 's', url: 'u', revision: 'r', credit: 'c' };
  for (const licence of ALLOWED_LICENCES) {
    const header = { ...good, licence, ...(licence === 'Apache-2.0' ? { notice: 'n' } : {}) };
    assert.deepEqual(licenceProblems(header), [], licence);
  }
  assert.notDeepEqual(licenceProblems({ ...good, licence: 'GPL-3.0-only' }), []);
  assert.notDeepEqual(licenceProblems({ ...good, licence: 'MIT License (with a rider)' }), []);
  assert.notDeepEqual(licenceProblems({ ...good, licence: 'Apache-2.0' }), []);
  assert.notDeepEqual(licenceProblems(good), []);
  assert.notDeepEqual(licenceProblems({ ...good, licence: 'MIT', credit: '' }), []);
});

test('every prior-art fixture header credits its source and declares an allowed licence', () => {
  const files = priorArtFiles();
  assert.ok(files.length > 0, 'no prior-art fixture');
  for (const file of files) {
    assert.deepEqual(licenceProblems(readJson(file)), [], path.basename(file));
  }
});

test('every corpus case is well formed: a tool, a command, and exactly one of deny or gap', () => {
  const outOfScope = squash(fs.readFileSync(OUT_OF_SCOPE, 'utf8'));
  const seen = new Set();
  for (const file of corpusFiles()) {
    const { cases } = readJson(file);
    assert.ok(Array.isArray(cases) && cases.length > 0, path.basename(file));
    for (const c of cases) {
      const where = `${path.basename(file)}: ${JSON.stringify(c.command)}`;
      assert.ok(c.tool === 'Bash' || c.tool === 'PowerShell', where);
      assert.equal(typeof c.command, 'string', where);
      assert.ok(('deny' in c) !== ('gap' in c), `${where}: needs exactly one of deny, gap`);
      if ('deny' in c) expectedReason(c.deny);
      else assert.ok(outOfScope.includes(squash(c.gap)), `${where}: gap not in Out of Scope: ${c.gap}`);
      const key = `${c.tool}\0${c.command}`;
      assert.ok(!seen.has(key), `${where}: duplicate case`);
      seen.add(key);
    }
  }
});

for (const file of corpusFiles()) {
  test(`corpus ${path.relative(GUARD_FIXTURES, file).replace(/\\/g, '/')}: each case gives its C:guard verdict or names its gap`, (t) => {
    const c = createCase(t, { repo: false });
    const failures = [];
    for (const k of readJson(file).cases) {
      const { stdout, stderr } = hook(c, k.tool, k.command);
      const got = stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput;
      const want = 'deny' in k ? expectedReason(k.deny) : null;
      const ok = stderr === '' && (want === null
        ? got === null
        : got !== null && got.permissionDecision === 'deny' && got.permissionDecisionReason === want);
      if (!ok) failures.push(`${k.tool} ${JSON.stringify(k.command)}: got ${got === null ? 'no output' : JSON.stringify(got.permissionDecisionReason)}`);
    }
    assert.deepEqual(failures, []);
  });
}
