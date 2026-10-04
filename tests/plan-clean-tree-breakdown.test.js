'use strict';

// RUN-15 (docs/roadmap/09-runs.md, C:plan step 6, stories 156, 219): M15 `planRefusal`'s
// clean-tree breakdown, named in the real reply text. Seam 1 (docs/spec/testing-seams.md):
// the shipped entry point through the FND-04 harness, real git, no worker and no hook.
// `run-policy-clean-tree.test.js` already covers the message itself as a pure unit test
// from crafted facts; these prove the real `inventory`/`applyCaps` wiring feeds it.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

function seedCommit(c) {
  c.writeFile('seed.txt', 'seed\n');
  c.git(['add', 'seed.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
}

test('a hidden-only untracked file leaves the tree clean, named in the reply', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  c.writeFile('.env', 'SECRET=1\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'nothing', detail(result));
  assert.equal(result.json.reply.text.split('\n')[0], 'nothing to commit: 1 hidden file: `.env`');
});

// POSIX only: a filename holding a byte that is not valid UTF-8 cannot be written on every
// filesystem (notably Windows, whose APIs take UTF-16), so the case skips itself at runtime
// rather than declaring a platform skip, the same way
// `change-set-submodules.test.js`'s non-UTF-8 submodule-path case does.
test('a non-UTF-8-only untracked path leaves the tree clean, named in the reply (POSIX)', async (t) => {
  const c = createCase(t);
  seedCommit(c);
  const name = Buffer.from('f\xff', 'latin1');
  const target = Buffer.concat([Buffer.from(c.repoDir + path.sep), name]);
  try {
    fs.writeFileSync(target, 'x\n');
  } catch {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }
  if (!fs.readdirSync(c.repoDir, { encoding: 'buffer' }).some((entry) => entry.equals(name))) {
    t.skip('the filesystem cannot hold a name that is not valid UTF-8');
    return;
  }

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, detail(result));
  assert.equal(result.json.reply.status, 'nothing', detail(result));
  assert.equal(
    result.json.reply.text.split('\n')[0],
    'nothing to commit: path not UTF-8: `f\\xff`',
  );
});
