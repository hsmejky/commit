'use strict';

// RUN-08 (docs/roadmap/09-runs.md): M12 `sweep` in process (Q22, C:run-folder "Orphan renamed
// locks" and the sweep bullet, story 195). The Seam 1 cases are tests/plan-sweep.test.js;
// these cover what `plan` cannot reach yet: the renamed lock files and their chains, which
// adoption owns (RUN-20b), and the cleanup error that becomes a notice.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { makeReadOnlyFolder, removalErrorCode } = require('./helpers/read-only-folder.js');

let run;
beforeEach(async () => {
  run = await loadLib('run');
});

const HOUR_MS = 60 * 60 * 1000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// Every entry is created now; the injected clock reads 25 hours on, so all of them are aged.
const later = () => Date.now() + 25 * HOUR_MS;

function toplevelOf(t) {
  const toplevel = fs.mkdtempSync(path.join(os.tmpdir(), 'run-sweep-'));
  t.after(() => fs.rmSync(toplevel, { recursive: true, force: true }));
  fs.mkdirSync(path.join(toplevel, '.commit-plan'));
  return toplevel;
}

function folder(toplevel, planId) {
  const dir = path.join(toplevel, '.commit-plan', planId);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), '{}\n');
  return dir;
}

function lockFile(toplevel, name, planId) {
  fs.writeFileSync(path.join(toplevel, '.commit-plan', name), JSON.stringify({ planId, created: new Date().toISOString() }));
}

test('sweep keeps every folder on a renamed lock file\'s chain, and the renamed lock files', (t) => {
  const toplevel = toplevelOf(t);
  // `lock.A` (A's takeover, killed) holds X = B's lock; B has no state.json in the real case,
  // and `lock.B` holds C's: A, B and C are one chain. D stands alone, E is the lock holder.
  for (const id of [A, B, C, D, E]) folder(toplevel, id);
  lockFile(toplevel, `lock.${A}`, B);
  lockFile(toplevel, `lock.${B}`, C);
  lockFile(toplevel, 'lock', E);

  assert.deepEqual(run.sweep({ toplevel, now: later }), []);

  const left = fs.readdirSync(path.join(toplevel, '.commit-plan')).sort();
  assert.deepEqual(left, [A, B, C, E, 'lock', `lock.${A}`, `lock.${B}`].sort(), 'only D is swept');
});

test('sweep keeps the renaming run\'s folder of a renamed lock whose content is unreadable', (t) => {
  const toplevel = toplevelOf(t);
  folder(toplevel, A);
  folder(toplevel, B);
  fs.writeFileSync(path.join(toplevel, '.commit-plan', `lock.${A}`), 'not json');

  assert.deepEqual(run.sweep({ toplevel, now: later }), []);

  assert.deepEqual(fs.readdirSync(path.join(toplevel, '.commit-plan')).sort(), [A, `lock.${A}`].sort());
});

test('sweep does nothing without a .commit-plan directory, or through one that is a link', (t) => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'run-sweep-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.deepEqual(run.sweep({ toplevel: bare, now: later }), []);

  const target = path.join(bare, 'elsewhere');
  fs.mkdirSync(path.join(target, A), { recursive: true });
  const linked = path.join(bare, 'repo');
  fs.mkdirSync(linked);
  fs.symlinkSync(target, path.join(linked, '.commit-plan'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.deepEqual(run.sweep({ toplevel: linked, now: later }), []);
  assert.deepEqual(fs.readdirSync(target), [A], 'nothing is removed through the link');
});

test('sweep turns a removal error into a notice and goes on with the other entries',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as non-root' },
  (t) => {
    const toplevel = toplevelOf(t);
    const code = removalErrorCode();
    const stuck = makeReadOnlyFolder(path.join(toplevel, '.commit-plan', A)); // its entries cannot be unlinked
    folder(toplevel, B);

    // The mode is restored before `toplevelOf`'s own `t.after` removes the tree: `node:test`
    // runs `after` hooks in registration order, and a tree removal while `stuck` is still
    // read-only would throw itself, failing the test on its own teardown rather than
    // on the assertions above (review-RUN-08 finding 1).
    let notices;
    try {
      notices = run.sweep({ toplevel, now: later });
    } finally {
      fs.chmodSync(stuck, 0o755);
    }

    assert.deepEqual(notices, [`\`.commit-plan/${A}\` was not swept (${code}); the 24-hour sweep retries it`]);
    assert.equal(fs.existsSync(path.join(stuck, 'nested')), true, 'the stuck folder is kept');
    assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan', B)), false, 'the next entry is still swept');
  });

test('sweep keeps every folder and notices an unreadable lock file, but still sweeps an aged lock temp file',
  { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions as non-root' },
  (t) => {
    const toplevel = toplevelOf(t);
    folder(toplevel, B); // on lock.A's chain, which becomes unreadable below
    folder(toplevel, D); // not on any chain
    lockFile(toplevel, `lock.${A}`, B);
    const lockA = path.join(toplevel, '.commit-plan', `lock.${A}`);
    fs.chmodSync(lockA, 0o000); // unreadable: EACCES on read, not on lstat

    const tempFile = path.join(toplevel, '.commit-plan', `lock-${E}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify({ planId: E, created: new Date().toISOString() }));

    let notices;
    try {
      notices = run.sweep({ toplevel, now: later });
    } finally {
      fs.chmodSync(lockA, 0o644);
    }

    assert.deepEqual(notices, [`\`.commit-plan/lock.${A}\` could not be read (EACCES); old run folders were not swept`]);
    assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan', B)), true, 'the chain folder survives');
    assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan', D)), true, 'the non-chain folder survives too');
    assert.equal(fs.existsSync(tempFile), false, 'an aged lock temp file is swept all the same');
  });
