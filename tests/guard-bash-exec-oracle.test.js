'use strict';

// GRD-03 review: an execution oracle for the guard's Bash reading. Every Bash seed case is
// run by bash itself, with `git` a stub function that logs its arguments, `PATH` an empty
// directory and no repository reachable. Assertion A: whenever bash calls git with arguments
// A, and the guard denies the plain command `git 'A1' 'A2' …`, the guard denies the case too
// (so the tokenizer never reads a command more leniently than bash runs it). Assertion B:
// every `bypass` seed case outside INPUT_MODE calls `git commit` (skipped on
// bash before 4, which lacks `{name}` redirections). Bash is required on CI (`CI` set);
// elsewhere the check is skipped when no working bash is found.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { requireBash } = require('./helpers/bash-oracle');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const bashCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases.filter((c) => c.shell === 'bash');

// Seed cases bash runs as a commit that the guard does not deny: scheduled for a later slice
// (the seed's `decision` is already the final one) or a C:guard known gap. Checked to still
// pass the guard, so an entry is dropped when its slice lands.
const NOT_DENIED = new Map([
  ['b-brace-sub', 'GRD-12: a subcommand holding `{` is unreadable'],
  ['b-brace-cmd', 'C:guard step 3 known gap (Q3): brace expansion in the command position'],
  ['b-procsub-no-target', 'C:guard step 4 (later slice): a `(` among git\'s arguments is denied'],
  ['b-procsub-no-target-fd', 'C:guard step 4 (later slice): a `(` among git\'s arguments is denied'],
]);

let runHook;

beforeEach(async () => {
  ({ runHook } = await loadLib('hook-io'));
});

function denies(command) {
  const { stdout } = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  return stdout.includes('"permissionDecision":"deny"');
}

// Bypass cases that need not run `git commit` themselves: a carriage return (the Windows bash
// drops it, other builds keep it in the word, so bash's reading depends on its build; the
// guard reads both ways) or a trailing `\` (bash keeps it as a literal `\` at the end of its
// input, sourced or under `eval`, and runs `git commit\`; the guard drops it).
const INPUT_MODE = /\r|\\$/;

const quote = (arg) => `'${arg.replace(/'/g, "'\\''")}'`;

// The stub writes each call as GS, then every argument followed by a NUL; each case starts
// with FS and its index. The log is written by path, so a case's redirections cannot hide it.
function driver(count) {
  let script = [
    'LOG="$PWD/log"',
    'PATH="$PWD/empty"',
    "git() { { printf '\\035'; printf '%s\\0' \"$@\"; } >>\"$LOG\"; }",
    '',
  ].join('\n');
  for (let i = 0; i < count; i += 1) {
    script += `printf '\\034%d' ${i} >>"$LOG"\n( cd work && . ../case-${i}.sh ) </dev/null >/dev/null 2>&1\n`;
  }
  return script;
}

function parseLog(text) {
  const calls = new Map();
  for (const record of text.split('\x1c').slice(1)) {
    const [index, ...rest] = record.split('\x1d');
    calls.set(Number(index), rest.map((call) => call.split('\0').slice(0, -1)));
  }
  return calls;
}

test('bash runs no seed case as a git command the guard would deny, unless the guard denies the case', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-exec-oracle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bash = requireBash(t, dir);
  if (bash === null) return;
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'work'));
  bashCases.forEach((c, i) => fs.writeFileSync(path.join(dir, `case-${i}.sh`), c.command, 'utf8'));
  fs.writeFileSync(path.join(dir, 'driver.sh'), driver(bashCases.length), 'utf8');
  const env = { LC_ALL: 'C', HOME: dir, GIT_DIR: path.join(dir, 'no-repo'), GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(bash.path, ['driver.sh'], { cwd: dir, env, timeout: 60000 });
  assert.equal(result.error, undefined, String(result.error));
  const calls = parseLog(fs.readFileSync(path.join(dir, 'log'), 'utf8'));
  assert.equal(calls.size, bashCases.length, 'every case ran');

  const leaks = [];
  bashCases.forEach((c, i) => {
    const deniedPlain = calls.get(i).find((args) => denies(`git ${args.map(quote).join(' ')}`));
    if (deniedPlain === undefined || denies(c.command)) return;
    if (!NOT_DENIED.has(c.id)) leaks.push(`${c.id}: bash runs git ${JSON.stringify(deniedPlain)}`);
  });
  assert.deepEqual(leaks, []);
  for (const id of NOT_DENIED.keys()) {
    const c = bashCases.find((x) => x.id === id);
    assert.ok(c && !denies(c.command), `${id} is denied now: drop it from NOT_DENIED`);
  }

  if (bash.major < 4) {
    t.diagnostic('bash before 4: the bypass cases are not required to run git commit');
    return;
  }
  const notRun = bashCases
    .filter((c, i) => c.topic === 'bypass' && !INPUT_MODE.test(c.command)
      && !calls.get(i).some((args) => args[0] === 'commit'))
    .map((c) => c.id);
  assert.deepEqual(notRun, [], 'bypass cases bash does not run as git commit');
});
