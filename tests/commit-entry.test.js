'use strict';

// RPL-01 (docs/roadmap/11-reply-and-cli.md): the commit entry point and the envelope tracer,
// Seam 1 (docs/spec/testing-seams.md). The shipped `plugin/scripts/commit.cjs` is driven as a
// subprocess over a temp repo; C:cli-and-exit-codes fixes the envelope and exit codes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { COMMIT_ENTRY, createCase, runCommit } = require('./helpers/process-seam.js');

// A `--require` preload that makes the spawned node report an old version, the only way to
// reach the Node check on a supported Node.
function writeOldNodePreload(c, version) {
  const preload = path.join(c.root, 'old-node.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', "
    + `{ value: ${JSON.stringify(version)} });\n`);
  return preload;
}

// Copies the shipped entry point into the case, next to a stub `lib/cli.mjs` with the given
// source, so a case can observe whether and how the entry point loads the library.
function installEntryWithStubLib(c, stubSource) {
  const dir = path.join(c.root, 'scripts');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const entry = path.join(dir, 'commit.cjs');
  fs.copyFileSync(COMMIT_ENTRY, entry);
  fs.writeFileSync(path.join(dir, 'lib', 'cli.mjs'), stubSource);
  return { entry, marker: path.join(dir, 'lib', 'imported') };
}

// A stub M1 that leaves a marker file when it is imported and answers `ok`.
const MARKING_STUB = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(new URL('./imported', import.meta.url), '');",
  'export async function main() {',
  '  return { stdoutJson: { version: 1, ok: true }, exitCode: 0 };',
  '}',
  '',
].join('\n');

test('no subcommand is a usage refusal: exit 1, one JSON object', async (t) => {
  const c = createCase(t);
  const result = await runCommit(c, []);
  assert.equal(result.exitCode, 1);
  assert.equal(result.json.version, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'usage');
  assert.equal(typeof result.json.error.message, 'string');
});

for (const argv of [['foo'], ['PLAN'], ['--help'], ['--plan', 'plan'], ['']]) {
  test(`unknown subcommand ${JSON.stringify(argv)} is a usage refusal`, async (t) => {
    const c = createCase(t);
    const result = await runCommit(c, argv);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(Object.keys(result.json).sort(), ['error', 'ok', 'version']);
    assert.equal(result.json.version, 1);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.kind, 'usage');
  });
}

test('stdout holds the one JSON object and nothing else', async (t) => {
  const c = createCase(t);
  const result = await runCommit(c, ['foo']);
  assert.equal(result.stdout, `${JSON.stringify(result.json)}\n`);
});

test('the entry point never reads stdin: an open stdin pipe does not hold it', async (t) => {
  const c = createCase(t);
  const child = spawn(process.execPath, [COMMIT_ENTRY], {
    cwd: c.repoDir,
    env: c.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stdin.on('error', () => {});
  // stdin is left open for the whole call; a read would block until the timeout below.
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('commit.cjs waited on an open stdin pipe'));
    }, 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  child.stdin.destroy();
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(Buffer.concat(stdout).toString('utf8')).error.kind, 'usage');
});

test('an old Node gets the env refusal: exit 1, one JSON object', async (t) => {
  const c = createCase(t);
  const preload = writeOldNodePreload(c, '20.18.0');
  const result = await runCommit(c, ['plan'], { nodeArgs: ['--require', preload] });
  assert.equal(result.exitCode, 1);
  assert.equal(result.json.version, 1);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.kind, 'env');
  assert.match(result.json.error.message, /20\.18\.0/);
});

test('the Node check refuses before any library import', async (t) => {
  const c = createCase(t);
  const { entry, marker } = installEntryWithStubLib(c, MARKING_STUB);
  const preload = writeOldNodePreload(c, '12.22.12');
  const result = await runCommit(c, ['plan'], { script: entry, nodeArgs: ['--require', preload] });
  assert.equal(result.json.error.kind, 'env');
  assert.equal(fs.existsSync(marker), false, 'the library was imported');
});

test('on a supported Node the entry point loads the library and prints what M1 returns', async (t) => {
  const c = createCase(t);
  const { entry, marker } = installEntryWithStubLib(c, MARKING_STUB);
  const result = await runCommit(c, ['plan'], { script: entry });
  assert.deepEqual(result.json, { version: 1, ok: true });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(marker), true);
});

test('an unexpected throw is internal on stdout, with the debug output on stderr only', async (t) => {
  const c = createCase(t);
  const { entry } = installEntryWithStubLib(c, [
    'export async function main() {',
    "  throw new Error('stub failure');",
    '}',
    '',
  ].join('\n'));
  const result = await runCommit(c, ['plan'], { script: entry });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'ok', 'version']);
  assert.equal(result.json.error.kind, 'internal');
  assert.match(result.stderr, /stub failure/);
  // The stack (a frame in the stub) is debug output: on stderr, never on stdout.
  assert.match(result.stderr, /\bat .*cli\.mjs:2/);
  assert.equal(/cli\.mjs:2/.test(result.stdout), false);
});

test('M1 receives argv after the script path and the injected environment', async (t) => {
  const c = createCase(t);
  const { entry } = installEntryWithStubLib(c, [
    'export async function main(argv, env) {',
    '  return {',
    '    stdoutJson: { version: 1, ok: true, argv, keys: Object.keys(env).sort(),',
    '      claudeHome: env.claudeHome, osHome: env.osHome, scriptPath: env.scriptPath,',
    "      nowType: typeof env.now(), osUserType: typeof env.osUser },",
    '    exitCode: 0,',
    '  };',
    '}',
    '',
  ].join('\n'));
  const result = await runCommit(c, ['plan', '--split'], { script: entry });
  assert.deepEqual(result.json.argv, ['plan', '--split']);
  assert.deepEqual(result.json.keys, ['claudeHome', 'env', 'now', 'osHome', 'osUser', 'scriptPath']);
  assert.equal(result.json.claudeHome, c.claudeHome);
  assert.equal(result.json.osHome, c.osHome);
  assert.equal(result.json.scriptPath, entry);
  assert.equal(result.json.nowType, 'number');
  assert.equal(result.json.osUserType, 'string');
});

test('without CLAUDE_CONFIG_DIR the Claude home is .claude in the OS home', async (t) => {
  const c = createCase(t, { claudeConfigDir: false });
  const { entry } = installEntryWithStubLib(c, [
    'export async function main(argv, env) {',
    '  return { stdoutJson: { version: 1, ok: true, claudeHome: env.claudeHome }, exitCode: 0 };',
    '}',
    '',
  ].join('\n'));
  const result = await runCommit(c, ['plan'], { script: entry });
  assert.equal(result.json.claudeHome, path.join(c.osHome, '.claude'));
});
