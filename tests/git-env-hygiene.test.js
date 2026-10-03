'use strict';

// GIT-05 (docs/roadmap/06-git-adapters.md): M2's environment hygiene on every git call
// except `git commit` (docs/spec/modules-m1-m9.md M2, Q9, story 147, story 74). Every
// inherited `GIT_*` variable is removed except the keep-set, `GIT_LITERAL_PATHSPECS=1`,
// `core.quotePath=false` and `diff.suppressBlankEmpty=false` are pinned, and read-only calls
// get `GIT_OPTIONAL_LOCKS=0`. Seam 1 cases run `plan` through the entry point; the options
// no `plan` call uses yet (alternate index, stdin input, history pins, a staging call) are
// exercised through M2 `run` itself.

const fs = require('node:fs');
const os = require('node:os');
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

// CHG-05: the temporary index's own writes (`reset -q -- .`, `add -N`) are the only calls without
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

test('run: onStdout gets every stdout chunk as it arrives, and stdout comes back empty', async (t) => {
  const c = createCase(t);
  const chunks = [];

  const result = await processAdapter.run('git', ['hash-object', '--stdin'], {
    cwd: c.repoDir, env: c.env, readOnly: true, input: 'hello\n', onStdout: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 0);
  assert.ok(chunks.every((chunk) => Buffer.isBuffer(chunk)));
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'ce013625030ba8dba906f756967f9e9ca394464a\n');
});

test('run: an onStdout that throws rejects the call with its error once the child has ended', async (t) => {
  const c = createCase(t);

  await assert.rejects(
    processAdapter.run('git', ['hash-object', '--stdin'], {
      cwd: c.repoDir, env: c.env, readOnly: true, input: 'hello\n',
      onStdout: () => { throw new Error('consumer failed'); },
    }),
    /consumer failed/,
  );
});


// The two cases below spawn processes that never exit on their own, so each process proves
// it is still running by ticking a heartbeat file (`heartbeat` below) instead of the test
// trusting its pid alone: on a busy Windows box a killed child's pid can be handed to an
// unrelated process within a second, which `process.kill(pid, 0)` would then report as alive
// (a false failure) and a cleanup kill by pid would hit (a stray kill). A pid is only acted
// on while its heartbeat is still ticking, which no other process can do.

const TICK_MS = 50;
const LIFETIME_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// A `node -e` snippet that writes its pid to `<base>.pid` and then a growing counter to
// `<base>.beat` every TICK_MS. It never exits on its own within a case; it does exit after
// LIFETIME_MS, a last line of defence against an immortal process if even the cleanup below
// never runs (e.g. the test process itself is killed).
function heartbeat(base) {
  return `{ const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${base}.pid`)}, String(process.pid));`
    + ` let n = 0; setInterval(() => { fs.writeFileSync(${JSON.stringify(`${base}.beat`)}, String(++n)); }, ${TICK_MS});`
    + ` setTimeout(() => process.exit(0), ${LIFETIME_MS}); }`;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// True if the heartbeat process at `base` is still running: its counter moves within one
// second (20 ticks), polled so a running process is reported as soon as it ticks.
async function ticking(base) {
  const before = readOrNull(`${base}.beat`);
  for (let waited = 0; waited < 1000; waited += TICK_MS) {
    await sleep(TICK_MS);
    const now = readOrNull(`${base}.beat`);
    if (now !== null && now !== before) return true;
  }
  return false;
}

// Registers, before the case's own cleanup (`after` hooks run in the order they were added,
// and the case directory cannot be removed on Windows while a process still runs in it), a
// hook that kills every heartbeat process in `bases()` that is still running: a regression
// then fails the case instead of leaking an immortal process or hanging the suite.
function killLeftovers(t, bases) {
  t.after(async () => {
    for (const base of bases()) {
      const pid = Number(readOrNull(`${base}.pid`));
      if (!Number.isInteger(pid) || pid <= 0 || !(await ticking(base))) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
      // Windows keeps the case directory busy (the process's cwd) until the killed process
      // is fully gone, so wait (bounded) for its pid to disappear before the case's cleanup.
      for (let waited = 0; waited < 5000; waited += TICK_MS) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await sleep(TICK_MS);
      }
    }
  });
}

// Waits (bounded) until the heartbeat process at `base` has stopped ticking.
async function stopped(base) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await ticking(base))) return true;
  }
  return false;
}

test(
  'run: an onStdout that throws kills the child instead of leaving it running to completion',
  { timeout: 30_000 },
  async (t) => {
    let base = null;
    killLeftovers(t, () => (base === null ? [] : [base]));
    const c = createCase(t);
    base = path.join(c.root, 'child');
    // A non-git child (M2 only touches env for git) that emits one stdout chunk, then runs
    // forever on its own: it has no reason to ever stop except being killed, so finding its
    // heartbeat stopped afterwards proves the kill happened rather than the child finishing.
    const script = `${heartbeat(base)} process.stdout.write('first\\n');`;

    await assert.rejects(
      processAdapter.run(process.execPath, ['-e', script], {
        cwd: os.tmpdir(), // not the case directory: Windows cannot remove a dying process's cwd
        env: c.env,
        onStdout: () => { throw new Error('consumer failed'); },
      }),
      /consumer failed/,
    );

    assert.ok(fs.existsSync(`${base}.pid`), `child pid file was never written: ${base}.pid`);
    assert.equal(await stopped(base), true, 'child was not killed after the consumer threw');
  },
);

test(
  'run: an onStdout that throws rejects without waiting for a process the child left holding '
    + 'stdout open',
  { timeout: 30_000 },
  async (t) => {
    let root = null;
    killLeftovers(t, () => (root === null ? [] : [path.join(root, 'child'), path.join(root, 'grandchild')]));
    const c = createCase(t);
    root = c.root;
    const child = path.join(root, 'child');
    const grandchild = path.join(root, 'grandchild');
    // The child starts a grandchild that inherits its stdout and outlives it (`detached`, so
    // the Windows job object of the child does not take it down with the child), as the real git.exe behind Git for Windows' `cmd\git.exe` launcher, or a
    // textconv filter, does for git; only then does it emit its chunk. Killing the child
    // leaves the grandchild holding the stdout pipe, so the child's `close` event cannot
    // fire while it runs: the call must settle on the child's own exit instead.
    const script = "const { spawn } = require('child_process');"
      + `const g = spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat(grandchild))}],`
      + " { detached: true, cwd: require('os').tmpdir(), stdio: ['ignore', 'inherit', 'ignore'] }); g.unref();"
      + `${heartbeat(child)}`
      + ` const fs = require('fs'); const wait = setInterval(() => {`
      + ` if (fs.existsSync(${JSON.stringify(`${grandchild}.beat`)})) { clearInterval(wait); process.stdout.write('first\\n'); }`
      + ` }, ${TICK_MS});`;

    await assert.rejects(
      processAdapter.run(process.execPath, ['-e', script], {
        cwd: os.tmpdir(),
        env: c.env,
        onStdout: () => { throw new Error('consumer failed'); },
      }),
      /consumer failed/,
    );

    // Still running when the call has settled: the call did not wait for it.
    assert.equal(await ticking(grandchild), true, 'the call waited for the grandchild to end');
    assert.equal(await stopped(child), true, 'child was not killed after the consumer threw');
  },
);
