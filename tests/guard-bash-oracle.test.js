'use strict';

// GRD-03: the Bash golden seed (tests/fixtures/guard/segments-seed.json) cross-checked against
// bash's own words (docs/spec/testing-seams.md, C:guard Oracle-skip classes). Each segment
// span G2 reports is handed to bash as `printf '%s\0' <span>`, and the words bash prints must
// equal the seed segment's words (redirections, which bash applies and prints no word for,
// dropped). Cases whose `oracle.bash` names a skip class are not run. Bash is required on CI
// (`CI` set); elsewhere the check is skipped when no working bash is found. The bash version
// is reported as a test diagnostic.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { runBash, requireBash } = require('./helpers/bash-oracle');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const matchCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases.filter(
  (c) => c.shell === 'bash' && c.oracle.bash === 'match',
);

// A `\c`, `\u` or `\U` escape in `$'…'` is decoded by bash 4 and later only (`\u`, `\U`: 4.2);
// macOS /bin/bash 3.2 keeps it literal, so such a case is skipped there.
const NEEDS_BASH_4 = /\$'[^']*\\[cuU]/;

let segmentSpans;

beforeEach(async () => {
  ({ segmentSpans } = await loadLib('shell-tokenizer'));
});

test('Seam 3: each Bash seed segment with oracle `match` has bash\'s own words', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-oracle-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bash = requireBash(t, cwd);
  if (bash === null) return;
  assert.ok(matchCases.length > 50, 'the seed has match cases');
  const cases = bash.major >= 4 ? matchCases : matchCases.filter((c) => !NEEDS_BASH_4.test(c.command));
  if (cases.length < matchCases.length) t.diagnostic(`bash before 4: ${matchCases.length - cases.length} case(s) skipped`);
  // One script for every case: each segment's words, then a record separator.
  const expected = [];
  let script = '';
  for (const c of cases) {
    const spans = segmentSpans(c.command, 'bash');
    assert.equal(spans.length, c.segments.length, `${c.id}: span count`);
    spans.forEach(([start, end], i) => {
      script += `printf '%s\\0' ${c.command.slice(start, end)}\nprintf '\\036'\n`;
      expected.push({ id: c.id, words: c.segments[i].filter((token) => typeof token === 'string') });
    });
  }
  const result = runBash(bash.path, script, cwd);
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  const records = result.stdout.toString('utf8').split('\x1e');
  assert.equal(records.pop(), '');
  assert.equal(records.length, expected.length);
  records.forEach((record, i) => {
    const words = record.split('\0');
    assert.equal(words.pop(), '', `${expected[i].id}: output ends with a NUL`);
    assert.deepEqual(words, expected[i].words, `${expected[i].id}: bash words`);
  });
});
