'use strict';

// GIT-01 (docs/roadmap/06-git-adapters.md): the architecture rule "M2 is the only spawner"
// (docs/spec/modules-m1-m9.md M2, docs/spec/architectural-decisions.md "Asynchronous process
// adapter"; the guard spawns nothing). A static check over every shipped source file under
// `plugin/` except M2 (`lib/process-adapter.mjs`): none names `child_process`, nor calls
// `spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync` or `fork` as a
// function. A method call on another object (`regex.exec(line)`) is not a process spawn and
// is allowed; a bare `exec(` or `spawn(` is not. Raw source text, comments included, so a
// false failure is possible and a false pass is not; the checker also runs against a bad
// sample so it cannot pass vacuously.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.join(__dirname, '..', 'plugin');
const M2 = path.join('scripts', 'lib', 'process-adapter.mjs');
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

const BANNED = [
  [/child_process/, 'child_process'],
  [/(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/, 'a process-spawning call'],
];

function problems(label, source) {
  const found = [];
  for (const [pattern, what] of BANNED) {
    if (pattern.test(source)) found.push(`${label} names ${what}`);
  }
  return found;
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

test('no plugin source file outside M2 spawns a process', () => {
  const files = sourceFiles(PLUGIN_DIR);
  assert.ok(files.some((f) => path.relative(PLUGIN_DIR, f) === M2), 'M2 itself is found');
  assert.ok(files.length > 1);
  const violations = [];
  for (const file of files) {
    const rel = path.relative(PLUGIN_DIR, file);
    if (rel === M2) continue;
    violations.push(...problems(rel.split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
  }
  assert.deepEqual(violations, []);
});

test('the check is not vacuous: it flags imports and bare calls, not method calls', () => {
  assert.deepEqual(problems('a', "import { spawn } from 'node:child_process';"), ['a names child_process']);
  assert.deepEqual(problems('a', "const cp = require('child_process');"), ['a names child_process']);
  for (const call of ['spawn(', 'spawnSync (', 'execFile(', 'execFileSync(', 'exec(', 'execSync(', 'fork(']) {
    assert.deepEqual(problems('a', `const x = ${call}'git');`), ['a names a process-spawning call'], call);
  }
  assert.deepEqual(problems('a', 'const m = regex.exec(line);'), []);
  assert.deepEqual(problems('a', '// it spawns only through M2'), []);
});
