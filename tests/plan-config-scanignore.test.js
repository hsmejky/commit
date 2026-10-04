'use strict';

// CFG-07 (docs/roadmap/04-config-and-attribution.md, Q6, Q10 as amended by CFG-01): M4
// reads `scanIgnore` from the repo config at HEAD only, every other repo key from the
// worktree. Unit-level coverage of `loadConfig`/`validateLayer` lives in
// tests/config.test.js; this file is Seam 1 only, through the shipped `plan` entry point.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function planJsonOf(c, result) {
  const file = path.join(c.repoDir, '.commit-plan', result.json.planId, 'plan.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRepoConfig(c, text) {
  c.writeFile('.claude/commit.json', text);
}

function commitAll(c, message) {
  c.git(['add', '-A']);
  c.git(['commit', '-q', '-m', message]);
}

function assertConfigRefusal(result) {
  assert.equal(result.exitCode, 1, detail(result));
  assert.equal(result.json.ok, false, detail(result));
  assert.equal(result.json.error.kind, 'config', detail(result));
}

test('scanIgnore added in the worktree only is effective [], and after it is committed it applies, sourced to repo@HEAD', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  commitAll(c, 'seed');
  writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }));
  c.writeFile('a.txt', 'one\nmore\n');

  const before = await runCommit(c, ['plan']);

  assert.equal(before.exitCode, 0, detail(before));
  assert.deepEqual(planJsonOf(c, before).config.values.scanIgnore, []);
  fs.rmSync(path.join(c.repoDir, '.commit-plan'), { recursive: true, force: true });

  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'config']);

  const after = await runCommit(c, ['plan']);

  assert.equal(after.exitCode, 0, detail(after));
  const planJson = planJsonOf(c, after);
  assert.deepEqual(planJson.config.values.scanIgnore, ['dist/**']);
  assert.equal(planJson.config.sources.scanIgnore, 'repo@HEAD');
  assert.deepEqual(planJson.warnings, []);
});

test('on an unborn repo scanIgnore is [] while the other worktree repo keys apply', async (t) => {
  const c = createCase(t);
  writeRepoConfig(c, JSON.stringify({ types: ['feat'], scanIgnore: ['dist/**'] }));
  c.writeFile('a.txt', 'one\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  const planJson = planJsonOf(c, result);
  assert.deepEqual(planJson.config.values.scanIgnore, []);
  assert.deepEqual(planJson.config.values.types, ['feat']);
  assert.equal(planJson.config.sources.types, 'repo');
  assert.deepEqual(planJson.warnings, []);
});

for (const pattern of ['**/*', 'src/{a,b}.js']) {
  test(`scanIgnore pattern ${pattern} at HEAD and unchanged in the worktree exits 1 config naming the pattern`, async (t) => {
    const c = createCase(t);
    writeRepoConfig(c, JSON.stringify({ scanIgnore: [pattern] }));
    c.writeFile('a.txt', 'one\n');
    commitAll(c, 'seed');
    c.writeFile('a.txt', 'one\nmore\n');

    const result = await runCommit(c, ['plan']);

    assertConfigRefusal(result);
    assert.ok(
      result.json.error.message.startsWith(
        `the repo config (.claude/commit.json) scanIgnore pattern ${JSON.stringify(pattern)} `,
      ),
      detail(result),
    );
  });
}

for (const [label, value] of [['a string', '"dist/**"'], ['an array with a non-string entry', '["dist/**", 3]']]) {
  test(`scanIgnore as ${label} at HEAD and unchanged in the worktree exits 1 config naming the key`, async (t) => {
    const c = createCase(t);
    writeRepoConfig(c, `{ "scanIgnore": ${value} }`);
    c.writeFile('a.txt', 'one\n');
    commitAll(c, 'seed');
    c.writeFile('a.txt', 'one\nmore\n');

    const result = await runCommit(c, ['plan']);

    assertConfigRefusal(result);
    assert.match(result.json.error.message, /^the repo config \(\.claude\/commit\.json\) scanIgnore must be /);
  });
}

const HEAD_ONLY_INVALID = [
  ['pattern **/*', '{ "scanIgnore": ["**/*"] }'],
  ['a pattern with braces', '{ "scanIgnore": ["src/{a,b}.js"] }'],
  ['a string', '{ "scanIgnore": "dist/**" }'],
  ['an array with a non-string entry', '{ "scanIgnore": ["dist/**", 3] }'],
  ['unparseable JSON', '{ "scanIgnore": ['],
];

for (const [label, headText] of HEAD_ONLY_INVALID) {
  test(`scanIgnore with ${label} at HEAD only (valid in the worktree) is [] with a warning naming the repo config at HEAD`, async (t) => {
    const c = createCase(t);
    writeRepoConfig(c, headText);
    c.writeFile('a.txt', 'one\n');
    commitAll(c, 'seed');
    writeRepoConfig(c, JSON.stringify({ scanIgnore: ['dist/**'] }));
    c.writeFile('a.txt', 'one\nmore\n');

    const result = await runCommit(c, ['plan']);

    assert.equal(result.exitCode, 0, detail(result));
    const planJson = planJsonOf(c, result);
    assert.deepEqual(planJson.config.values.scanIgnore, []);
    assert.equal(planJson.warnings.length, 1);
    assert.match(planJson.warnings[0], /^the repo config at HEAD \(\.claude\/commit\.json\) /);
    assert.ok(result.stderr.includes(planJson.warnings[0]), detail(result));
  });
}
