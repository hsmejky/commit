'use strict';

// Probe run by the process-seam self-test (FND-04) as its own `node --test` process: one
// passing and one failing case, each recording its case root to the file named by
// SEAM_PROBE_RECORD, so the outer test can check both roots are gone afterwards.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createCase } = require('../../helpers/process-seam.js');

function record(root) {
  fs.appendFileSync(process.env.SEAM_PROBE_RECORD, `${root}\n`);
}

test('a passing case', (t) => {
  const c = createCase(t);
  record(c.root);
  c.writeFile('x.txt', 'x\n');
});

test('a failing case', (t) => {
  const c = createCase(t);
  record(c.root);
  c.writeFile('x.txt', 'x\n');
  assert.fail('deliberate failure');
});
