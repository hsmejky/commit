'use strict';

// GRD-01 static checks over the guard's source (docs/spec/architectural-decisions.md "Code
// split", "Entry points survive an old Node", "Module type fixed by extension"; C:guard
// Output; Q1, Q3, Q15). Every check reads raw source text, comments and literals included,
// so a false failure is possible and a false pass is not. Each checker also runs against a
// small bad sample, so it cannot pass vacuously.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUARD_ENTRY } = require('./helpers/process-seam.js');

const LIB_DIR = path.join(path.dirname(GUARD_ENTRY), 'lib');

// The guard's own modules plus the two shared ones (docs/spec/modules.md): G1 hook I/O, G2
// shell tokenizer, G3 command classifier, S1 heartbeat, S2 script call.
const GUARD_MODULES = new Set([
  'hook-io.mjs',
  'shell-tokenizer.mjs',
  'command-classifier.mjs',
  'heartbeat.mjs',
  'script-call.mjs',
]);

const QUOTED = String.raw`\s*(['"])([^'"\r\n]*)\1`;

// Every module specifier a source names: `require('…')`, `import('…')`, `import '…'` and
// `… from '…'`. A `require(` or `import(` whose argument is not one quoted literal is
// reported as unreadable, since the graph could not be followed through it.
function specifiers(source) {
  const found = [];
  for (const re of [
    new RegExp(String.raw`\brequire\s*\(${QUOTED}\s*\)`, 'g'),
    new RegExp(String.raw`\bimport\s*\(${QUOTED}\s*\)`, 'g'),
    new RegExp(String.raw`\bimport${QUOTED}`, 'g'),
    new RegExp(String.raw`\bfrom${QUOTED}`, 'g'),
  ]) {
    for (const m of source.matchAll(re)) found.push(m[2]);
  }
  const calls = (source.match(/\b(?:require|import)\s*\(/g) || []).length;
  const literalCalls = [
    ...source.matchAll(new RegExp(String.raw`\b(?:require|import)\s*\(${QUOTED}\s*\)`, 'g')),
  ].length;
  return { found, unreadable: calls - literalCalls };
}

// Walks the graph from `entry`: returns the reachable files (entry included) and every
// problem found on the way (a module outside GUARD_MODULES, a bare specifier that is not a
// `node:` built-in, an unreadable call).
function guardGraph(entry, readSource = (file) => fs.readFileSync(file, 'utf8')) {
  const files = [];
  const problems = [];
  const queue = [entry];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readSource(file);
    files.push({ file, source });
    const { found, unreadable } = specifiers(source);
    if (unreadable) problems.push(`${path.basename(file)}: ${unreadable} require/import call(s) without one literal specifier`);
    for (const spec of found) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        problems.push(`${path.basename(file)}: '${spec}' is neither a node: built-in nor a guard module`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      if (path.dirname(target) !== LIB_DIR || !GUARD_MODULES.has(path.basename(target))) {
        problems.push(`${path.basename(file)}: '${spec}' is not one of G1-G3, S1, S2`);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, problems };
}

// The entry point checks the Node version first and makes its one dynamic import on the line
// right after the guard `if (<version> >= 22) {`.
function versionGuardProblems(source) {
  const read = /\bvar\s+(\w+)\s*=[^;\n]*process\.versions\.node[^;\n]*;/.exec(source);
  if (!read) return ['no `var <name> = …process.versions.node…;` version read'];
  const guarded = new RegExp(String.raw`\bif\s*\(\s*${read[1]}\s*>=\s*22\s*\)\s*\{\s*import\(`).exec(source);
  if (!guarded) return ['the dynamic import is not the first statement of `if (<version> >= 22) {`'];
  if (guarded.index < read.index) return ['the version guard comes before the version read'];
  return [];
}

// Syntax newer than Node 12 parses, plus any import besides the guarded one.
function oldNodeSyntaxProblems(source) {
  const problems = [];
  if (source.includes('?.')) problems.push('optional chaining `?.`');
  if (source.includes('??')) problems.push('nullish coalescing `??`');
  if (/\bawait\b/.test(source)) problems.push('`await` (top-level await)');
  const imports = (source.match(/\bimport\b/g) || []).length;
  if (imports !== 1) problems.push(`${imports} \`import\` keywords, expected only the guarded \`import(\``);
  return problems;
}

// The only permission decision the guard may emit is a deny.
function allowProblems(source) {
  const problems = [];
  if (/(['"`])allow\1/i.test(source)) problems.push('a quoted `allow` literal');
  for (const m of source.matchAll(/permissionDecision['"`]?\s*:\s*(['"`])(\w*)\1/g)) {
    if (m[2] !== 'deny') problems.push(`permissionDecision '${m[2]}'`);
  }
  return problems;
}

function spawnProblems(source) {
  return /child_process/.test(source) ? ['`child_process`'] : [];
}

// A synchronous read of descriptor 0 throws on Windows pipes; stdin is read as a stream.
function syncStdinProblems(source) {
  const problems = [];
  if (/\breadFileSync\s*\(\s*(?:0\b|['"]\/dev\/stdin|process\.stdin)/.test(source)) problems.push('readFileSync of stdin');
  if (/\breadSync\s*\(/.test(source)) problems.push('readSync');
  return problems;
}

function reachable() {
  const graph = guardGraph(GUARD_ENTRY);
  assert.deepEqual(graph.problems, []);
  return graph.files;
}

function assertNone(check, what) {
  for (const { file, source } of reachable()) {
    assert.deepEqual(check(source), [], `${path.basename(file)}: ${what}`);
  }
}

test('the guard entry point reaches only G1-G3, S1, S2 and node: built-ins', () => {
  const files = reachable().map(({ file }) => path.basename(file));
  assert.ok(files.includes('hook-io.mjs'), `G1 is not reached: ${files.join(', ')}`);
});

test('the import-graph check flags a module outside the guard set and a computed import', () => {
  const fake = {
    [GUARD_ENTRY]: "import('./lib/hook-io.mjs')",
    [path.join(LIB_DIR, 'hook-io.mjs')]: "import { x } from './scanner.mjs';\nimport(name);",
  };
  const { problems } = guardGraph(GUARD_ENTRY, (file) => fake[file]);
  assert.equal(problems.length, 2, problems.join('\n'));
});

test('the guard entry point checks the Node version before its dynamic import', () => {
  assert.deepEqual(versionGuardProblems(fs.readFileSync(GUARD_ENTRY, 'utf8')), []);
  assert.notDeepEqual(versionGuardProblems("import('./lib/hook-io.mjs');\nvar major = Number(process.versions.node);"), []);
  assert.notDeepEqual(versionGuardProblems("var major = Number(process.versions.node);\nimport('./lib/hook-io.mjs');"), []);
});

test('the guard entry point uses no syntax newer than Node 12 parses', () => {
  assert.deepEqual(oldNodeSyntaxProblems(fs.readFileSync(GUARD_ENTRY, 'utf8')), []);
  for (const bad of ['a?.b; import(x)', 'a ?? b; import(x)', 'await x; import(x)', 'import(x); import(y)']) {
    assert.notDeepEqual(oldNodeSyntaxProblems(bad), [], bad);
  }
});

test('no guard source can emit an allow decision', () => {
  assertNone(allowProblems, 'allow decision');
  for (const bad of ['x = "allow"', "permissionDecision: 'ask'", '"permissionDecision":"ask"']) {
    assert.notDeepEqual(allowProblems(bad), [], bad);
  }
  assert.deepEqual(allowProblems('permissionDecision: "deny"'), []);
});

test('no guard source spawns a process', () => {
  assertNone(spawnProblems, 'child_process');
  assert.notDeepEqual(spawnProblems("import { spawn } from 'node:child_process';"), []);
});

test('no guard source reads stdin synchronously', () => {
  assertNone(syncStdinProblems, 'synchronous stdin read');
  for (const bad of ['fs.readFileSync(0)', "readFileSync('/dev/stdin')", 'fs.readSync(0, buf)']) {
    assert.notDeepEqual(syncStdinProblems(bad), [], bad);
  }
});
