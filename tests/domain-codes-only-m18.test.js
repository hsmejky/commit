'use strict';

// RPL-03 AC 2: "Only M18 maps domain codes; modules below it return typed results with
// domain codes." Static check over `plugin/scripts/lib/*.mjs`: no module other than the M18
// workflow module imports `domain-codes.mjs` or names `kindForDomainCode`. `workflows.mjs`
// is the M18 workflow module (INT-01); it maps no domain code yet, so it names neither today,
// but it is the only file this allowlist ever needs to hold.
//
// Like tests/guard-static.test.js, this reads raw source text (a banned word fails even
// inside a comment, which is an acceptable false failure, not a false pass) and the checker
// runs against a small bad sample so it cannot pass vacuously.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..', 'plugin', 'scripts', 'lib');

// The M18 workflow module.
const ALLOWED_CALLERS = new Set(['workflows.mjs']);

// An actual `import`/`require` of the module, not just its name mentioned in a comment (every
// other lib module's header comment cites `domain-codes.mjs` by name, e.g. `lib/cli.mjs`'s
// "the domain code → kind side of that table is `lib/domain-codes.mjs`").
const DOMAIN_CODES_IMPORT_RE = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*domain-codes\.mjs['"]/;
const KIND_FOR_DOMAIN_CODE_RE = /\bkindForDomainCode\b/;

function problems(fileName, source) {
  const found = [];
  if (DOMAIN_CODES_IMPORT_RE.test(source)) found.push(`${fileName} imports domain-codes.mjs`);
  if (KIND_FOR_DOMAIN_CODE_RE.test(source)) found.push(`${fileName} names kindForDomainCode`);
  return found;
}

function libModules() {
  return fs.readdirSync(LIB_DIR).filter((name) => name.endsWith('.mjs'));
}

test('no lib module but the (future) M18 workflow imports domain-codes.mjs or calls kindForDomainCode', () => {
  const violations = [];
  for (const fileName of libModules()) {
    if (fileName === 'domain-codes.mjs' || ALLOWED_CALLERS.has(fileName)) continue;
    const source = fs.readFileSync(path.join(LIB_DIR, fileName), 'utf8');
    violations.push(...problems(fileName, source));
  }
  assert.deepEqual(violations, []);
});

test('the allowlist is exactly the M18 workflow module, and that file exists', () => {
  assert.deepEqual(Array.from(ALLOWED_CALLERS), ['workflows.mjs']);
  assert.ok(libModules().includes('workflows.mjs'));
});

test('the check is not vacuous: it flags an import and a bare call, but not a comment mention', () => {
  assert.deepEqual(problems('fake.mjs', "import { kindForDomainCode } from './domain-codes.mjs';"), [
    'fake.mjs imports domain-codes.mjs',
    'fake.mjs names kindForDomainCode',
  ]);
  assert.deepEqual(problems('fake.mjs', "const lib = require('./domain-codes.mjs');"), [
    'fake.mjs imports domain-codes.mjs',
  ]);
  assert.deepEqual(problems('fake.mjs', 'const kind = kindForDomainCode(code);'), [
    'fake.mjs names kindForDomainCode',
  ]);
  assert.deepEqual(problems('fake.mjs', '// see lib/domain-codes.mjs for the table'), []);
  assert.deepEqual(problems('fake.mjs', 'export function unrelated() {}'), []);
});
