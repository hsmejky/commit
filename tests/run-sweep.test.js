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
    const stuck = folder(toplevel, A);
    fs.writeFileSync(path.join(stuck, 'nested'), 'x');
    fs.chmodSync(stuck, 0o555); // its entries cannot be unlinked
    t.after(() => fs.chmodSync(stuck, 0o755));
    folder(toplevel, B);

    const notices = run.sweep({ toplevel, now: later });

    assert.deepEqual(notices, [`\`.commit-plan/${A}\` was not swept (EACCES); the next /commit retries it`]);
    assert.equal(fs.existsSync(path.join(toplevel, '.commit-plan', B)), false, 'the next entry is still swept');
  });
