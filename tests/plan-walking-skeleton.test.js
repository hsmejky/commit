'use strict';

// INT-01 (docs/roadmap/12-integration.md): the walking skeleton. Bare `plan` on a clean repo
// runs M1 → M18 `plan` → M2/M3/M10 reads → M17 reply → M1 envelope, and prints the `nothing`
// reply. Seam 1 only (docs/spec/testing-seams.md): the shipped entry point as a subprocess
// through the FND-04 harness, with no worker and no hook.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { parseBaseCallerRule } = require('./helpers/reply-contract-doc.js');

function seedCommit(c) {
  c.writeFile('README.md', 'hello\n');
  c.git(['add', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
}

const CLEAN_REPOS = [
  ['a clean repo with one commit', seedCommit],
  ['a clean unborn repo', () => {}],
];

for (const [name, setUp] of CLEAN_REPOS) {
  test(`bare plan on ${name} exits 0 with a nothing reply and leaves no run folder`, async (t) => {
    const c = createCase(t);
    setUp(c);
    const statusBefore = c.git(['status', '--porcelain', '--untracked-files=all']);

    const result = await runCommit(c, ['plan']);

    assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
    const { json } = result;
    assert.equal(json.version, 1);
    assert.equal(json.ok, true);
    // C:plan: on a clean tree no run is kept, so `planId`/`runDir` are null and `hunks` is
    // null because `reply` is set.
    assert.equal(json.planId, null);
    assert.equal(json.runDir, null);
    assert.equal(json.hunks, null);

    const { reply } = json;
    assert.equal(reply.version, 1);
    assert.equal(reply.status, 'nothing');
    assert.equal(reply.handback, null);
    assert.equal(reply.callerRule, parseBaseCallerRule());
    assert.equal(typeof reply.text, 'string');
    assert.match(reply.text, /working tree clean$/);

    // No lock or run folder left (RUN-05: the run-folder directory itself stays, empty),
    // and the repo itself untouched.
    assert.deepEqual(fs.readdirSync(path.join(c.repoDir, '.commit-plan')), []);
    assert.equal(c.git(['status', '--porcelain', '--untracked-files=all']), statusBefore);
  });
}

// M17 is pure (docs/spec/modules.md): the reply module's raw source holds no process, clock,
// filesystem or import beyond its allowed pure dependencies.
test('M17 reply module stays pure', () => {
  const { assertPureSource } = require('./helpers/assert-pure-source');
  assertPureSource('reply');
});
