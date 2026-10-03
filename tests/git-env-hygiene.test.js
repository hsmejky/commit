'use strict';

// GIT-05 (docs/roadmap/06-git-adapters.md): M2's environment hygiene on every git call
// except `git commit` (docs/spec/modules-m1-m9.md M2, Q9, story 147, story 74). Every
// inherited `GIT_*` variable is removed except the keep-set, `GIT_LITERAL_PATHSPECS=1`,
// `core.quotePath=false` and `diff.suppressBlankEmpty=false` are pinned, and read-only calls
// get `GIT_OPTIONAL_LOCKS=0`. Seam 1 cases run `plan` through the entry point; the options
// no `plan` call uses yet (alternate index, stdin input, history pins, a staging call) are
// exercised through M2 `run` itself.

const fs = require('node:fs');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { pathToFileURL } = require('node:url');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const SPAWN_RECORD_PRELOAD = pathToFileURL(
  path.join(__dirname, 'helpers', 'spawn-record-preload.mjs'),
).href;

function seed(c, files) {
  for (const [name, content] of Object.entries(files)) c.writeFile(name, content);
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'seed']);
}

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

test('plan with decoy GIT_DIR and GIT_INDEX_FILE exported inventories and diffs the real repo', async (t) => {
  const c = createCase(t);
  seed(c, { 'real.txt': 'old\n' });
  c.writeFile('real.txt', 'new\n');

  // A second repo with its own modified file: if its `.git` or index reached any call, the
  // units (or the refusal) would come from it instead.
  const decoyDir = path.join(c.root, 'decoy');
  fs.mkdirSync(decoyDir);
  c.git(['init', '-q', '-b', 'main', '.'], { cwd: decoyDir });
  fs.writeFileSync(path.join(decoyDir, 'decoy.txt'), 'old\n');
  c.git(['add', '.'], { cwd: decoyDir });
  c.git(['commit', '-q', '-m', 'decoy'], { cwd: decoyDir });
  fs.writeFileSync(path.join(decoyDir, 'decoy.txt'), 'new\n');

  const result = await runCommit(c, ['plan'], {
    env: {
      GIT_DIR: path.join(decoyDir, '.git'),
      GIT_INDEX_FILE: path.join(decoyDir, '.git', 'index'),
    },
  });

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((unit) => [unit.path, unit.status, unit.range]),
    [['real.txt', 'M', '-1 +1']],
    detail(result),
  );
});

test('plan honours an exported GIT_CONFIG_SYSTEM (in the keep-set)', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  // The case isolates git with GIT_CONFIG_NOSYSTEM=1 and an empty global file; this case
  // drops the first and points GIT_CONFIG_SYSTEM at a file that sets a key `plan` reads.
  const systemConfig = path.join(c.root, 'system.gitconfig');
  fs.writeFileSync(systemConfig, '[i18n]\n\tcommitEncoding = ISO-8859-1\n');

  const result = await runCommit(c, ['plan'], {
    env: { GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: systemConfig },
  });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'state', detail(result));
  assert.match(result.json.error.message, /ISO-8859-1/);
});

// Story 74, smoke test only: no `plan` call passes a pathspec (diff `HEAD`,
// `ls-files --cached` and `status` all run without one), so this exercises only that a
// glob-magic path round-trips through the inventory undisturbed; it passes whether or not
// `GIT_LITERAL_PATHSPECS` is set. The mechanism itself (a pathspec taken literally) is
// asserted directly below, by `run: GIT_LITERAL_PATHSPECS makes [id] and * name themselves`.
// `*` cannot be in a Windows file name, so that file is added on POSIX only; `[id]` runs
// everywhere.
test('plan inventories a path containing [id] and * literally (smoke test)', async (t) => {
  const c = createCase(t);
  const names = ['src/[id].tsx', 'src/d.tsx'];
  if (process.platform !== 'win32') names.push('src/a*b.txt', 'src/axb.txt');
  seed(c, Object.fromEntries(names.map((name) => [name, 'old\n'])));
  const changed = names.filter((name) => !/\/(d\.tsx|axb\.txt)$/.test(name));
  for (const name of changed) c.writeFile(name, 'new\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.deepEqual(
    result.json.hunks.hunks.map((unit) => unit.path),
    changed.slice().sort(),
    detail(result),
  );
});

// Every git spawn `plan` makes, from the spawn-record preload's argument/env record (a
// cross-platform stand-in for KD-R21's PATH git shim).
async function planWithSpawnLog(c, env) {
  const log = path.join(c.root, 'spawns.jsonl');
  const result = await runCommit(c, ['plan'], {
    nodeArgs: ['--import', SPAWN_RECORD_PRELOAD],
    env: { ...env, COMMIT_TEST_SPAWN_LOG: log },
  });
  const gitSpawns = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => (e.api === 'spawn' || e.api === 'spawnSync') && e.file === 'git');
  return { result, gitSpawns };
}

test('plan removes decoy GIT_*_PATHSPECS and still refuses a tracked .commit-plan', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  c.writeFile('.commit-plan/notes.txt', 'tracked\n');
  c.git(['add', '-f', '.commit-plan/notes.txt']);
  c.git(['commit', '-q', '-m', 'track it']);

  const { result, gitSpawns } = await planWithSpawnLog(c, {
    GIT_ICASE_PATHSPECS: '1', GIT_GLOB_PATHSPECS: '1', GIT_NOGLOB_PATHSPECS: '1',
  });

  assert.equal(result.exitCode, 6, detail(result));
  assert.equal(result.json.error.kind, 'state', detail(result));
  assert.equal(result.json.error.message, '`.commit-plan` is tracked; remove it by hand');
  assert.ok(gitSpawns.length > 0);
  for (const spawn of gitSpawns) {
    const names = Object.keys(spawn.gitEnv).filter((name) => /_PATHSPECS$/i.test(name));
    assert.deepEqual(names, ['GIT_LITERAL_PATHSPECS'], JSON.stringify(spawn));
    assert.equal(spawn.gitEnv.GIT_LITERAL_PATHSPECS, '1', JSON.stringify(spawn));
  }
});

// CHG-05: the temporary index's own writes (`reset -q`, `add -N`) are the only calls without
// `GIT_OPTIONAL_LOCKS=0`, and they and the diff carry `GIT_INDEX_FILE` at the run folder's
// `git-index`: the real index is never written.
test('every git call plan makes is read-only or writes only the temporary index; only the keep-set and the pins reach it', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'old\n' });
  c.writeFile('a.txt', 'new\n');

  const { result, gitSpawns } = await planWithSpawnLog(c, {
    GIT_WORK_TREE: path.join(c.root, 'home'),
    GIT_TRACE: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.quotePath',
    GIT_CONFIG_VALUE_0: 'true',
    // The most direct config-injection vector besides GIT_CONFIG_COUNT, and the object-store
    // redirect: both are outside the keep-set, so the generic strip rule removes them too.
    GIT_CONFIG_PARAMETERS: "'core.quotepath'='true'",
    GIT_OBJECT_DIRECTORY: path.join(c.root, 'decoy-objects'),
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_ASKPASS: 'askpass-decoy',
  });

  assert.equal(result.exitCode, 0, detail(result));
  // The start-up calls, the probes and the diff all ran.
  assert.ok(gitSpawns.some((e) => e.api === 'spawnSync' && e.args.includes('--show-toplevel')));
  assert.ok(gitSpawns.some((e) => e.args.includes('diff')), JSON.stringify(gitSpawns));
  // GIT-09: the `recentSubjects` read is a history read, which adds M2's two history pins.
  assert.ok(gitSpawns.some((e) => e.args.includes('log')), JSON.stringify(gitSpawns));
  for (const spawn of gitSpawns) {
    const history = spawn.args.includes('log') ? {
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_2: 'log.showSignature',
      GIT_CONFIG_KEY_3: 'i18n.logOutputEncoding',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_VALUE_3: 'UTF-8',
    } : {};
    const indexFile = spawn.gitEnv.GIT_INDEX_FILE;
    const temporary = indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile };
    if (indexFile !== undefined) assert.match(indexFile, /\/\.commit-plan\/[^/]+\/git-index$/);
    const writesTemporary = indexFile !== undefined && (spawn.args.includes('reset') || spawn.args.includes('add'));
    assert.deepEqual(spawn.gitEnv, {
      GIT_ASKPASS: 'askpass-decoy',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_GLOBAL: c.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_KEY_1: 'diff.suppressBlankEmpty',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_LITERAL_PATHSPECS: '1',
      ...(writesTemporary ? {} : { GIT_OPTIONAL_LOCKS: '0' }),
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      ...history,
      ...temporary,
    }, JSON.stringify(spawn.args));
  }
});

// The M2 options no `plan` call uses yet, through `run` itself.
let processAdapter;
beforeEach(async () => {
  processAdapter = await loadLib('process-adapter');
});

function indexBytes(c) {
  return fs.readFileSync(path.join(c.repoDir, '.git', 'index'));
}

// Story 74, the mechanism itself. `[id].tsx` and `d.tsx`/`i.tsx` are seeded so that, without
// the pin, `[id]` is glob magic matching the single characters `i` or `d`: an `ls-files`
// pathspec of `src/[id].tsx` would then list `src/d.tsx` and `src/i.tsx`, never the file
// actually named `src/[id].tsx`. With `GIT_LITERAL_PATHSPECS=1` pinned, the pathspec names
// exactly the file with that literal name. `*` cannot be in a Windows file name, so the
// second case runs on POSIX only.
test('run: GIT_LITERAL_PATHSPECS makes [id] name itself, not a character-class match', async (t) => {
  const c = createCase(t);
  seed(c, { 'src/[id].tsx': 'bracket\n', 'src/i.tsx': 'i\n', 'src/d.tsx': 'd\n' });
  const options = { cwd: c.repoDir, env: c.env, readOnly: true };

  const result = await processAdapter.run('git', ['ls-files', '--', 'src/[id].tsx'], options);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString('utf8'), 'src/[id].tsx\n');
});

test('run: GIT_LITERAL_PATHSPECS makes * name itself, not a glob match (POSIX only)', { skip: process.platform === 'win32' }, async (t) => {
  const c = createCase(t);
  seed(c, { 'src/a*b.txt': 'star\n', 'src/axb.txt': 'x\n' });
  const options = { cwd: c.repoDir, env: c.env, readOnly: true };

  const result = await processAdapter.run('git', ['ls-files', '--', 'src/a*b.txt'], options);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.toString('utf8'), 'src/a*b.txt\n');
});

test('run: GIT_OPTIONAL_LOCKS=0 on a read-only call only, so only a staging call may write the index', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  // Stat-dirty, content unchanged: a refresh would rewrite the index's stat data.
  const fixed = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(c.repoDir, 'a.txt'), fixed, fixed);
  const before = indexBytes(c);
  const options = { cwd: c.repoDir, env: c.env };

  const readOnly = await processAdapter.run('git', ['status', '--porcelain'], { ...options, readOnly: true });
  assert.equal(readOnly.code, 0, readOnly.stderr);
  assert.deepEqual(indexBytes(c), before);

  const staging = await processAdapter.run('git', ['status', '--porcelain'], options);
  assert.equal(staging.code, 0, staging.stderr);
  assert.notDeepEqual(indexBytes(c), before);
});

test('run: the index option is the call\'s alternate index, in place of an inherited one', async (t) => {
  const c = createCase(t);
  seed(c, { 'a.txt': 'a\n' });
  const realIndex = indexBytes(c);
  const alternate = path.join(c.root, 'alternate.index');
  const env = { ...c.env, GIT_INDEX_FILE: path.join(c.root, 'decoy.index') };
  const options = { cwd: c.repoDir, env, index: alternate };

  const empty = await processAdapter.run('git', ['ls-files'], { ...options, readOnly: true });
  assert.equal(empty.stdout.toString('utf8'), '');
  const staged = await processAdapter.run('git', ['read-tree', 'HEAD'], options);
  assert.equal(staged.code, 0, staged.stderr);
  const listed = await processAdapter.run('git', ['ls-files'], { ...options, readOnly: true });

  assert.equal(listed.stdout.toString('utf8'), 'a.txt\n');
  assert.ok(fs.existsSync(alternate));
  assert.equal(fs.existsSync(path.join(c.root, 'decoy.index')), false);
  assert.deepEqual(indexBytes(c), realIndex);
});

test('run: a history read pins log.showSignature=false and i18n.logOutputEncoding=UTF-8', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '.']);
  c.git(['commit', '-q', '-m', 'café']);
  c.git(['config', 'log.showSignature', 'true']);
  c.git(['config', 'i18n.logOutputEncoding', 'ISO-8859-1']);
  const options = { cwd: c.repoDir, env: c.env, readOnly: true };

  const subject = await processAdapter.run('git', ['log', '-1', '--format=%s'], { ...options, history: true });
  assert.deepEqual(subject.stdout, Buffer.from('café\n', 'utf8'));
  const signature = await processAdapter.run('git', ['config', '--get', 'log.showSignature'], { ...options, history: true });
  assert.equal(signature.stdout.toString('utf8'), 'false\n');

  // Not a history read: the user's own settings stand.
  const plain = await processAdapter.run('git', ['log', '-1', '--format=%s'], options);
  assert.deepEqual(plain.stdout, Buffer.from('café\n', 'latin1'));
});

test('run: input is written to stdin, which is then closed', async (t) => {
  const c = createCase(t);
  const options = { cwd: c.repoDir, env: c.env, readOnly: true };

  const text = await processAdapter.run('git', ['hash-object', '--stdin'], { ...options, input: 'hello\n' });
  const bytes = await processAdapter.run('git', ['hash-object', '--stdin'], { ...options, input: Buffer.from('hello\n') });

  assert.equal(text.stdout.toString('utf8'), 'ce013625030ba8dba906f756967f9e9ca394464a\n');
  assert.equal(bytes.stdout.toString('utf8'), 'ce013625030ba8dba906f756967f9e9ca394464a\n');
});
