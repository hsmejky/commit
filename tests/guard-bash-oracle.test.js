'use strict';

// GRD-03: the Bash golden seed (tests/fixtures/guard/segments-seed.json) cross-checked against
// bash's own words (docs/spec/testing-seams.md, C:guard Oracle-skip classes). Each segment
// span G2 reports is handed to bash as `printf '%s\0' <span>`, and the words bash prints must
// equal the seed segment's words (redirections, which bash applies and prints no word for,
// dropped). Cases whose `oracle.bash` names a skip class are not run. Bash is required on CI
// (`CI` set); elsewhere the check is skipped when no working bash is found.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const matchCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases.filter(
  (c) => c.shell === 'bash' && c.oracle.bash === 'match',
);

let segmentSpans;

beforeEach(async () => {
  ({ segmentSpans } = await loadLib('shell-tokenizer'));
});

// On Windows `bash` on PATH may be the WSL launcher; Git for Windows' own bash sits next to
// git's install root, found from `git --exec-path`.
function bashCandidates() {
  if (process.platform !== 'win32') return ['bash'];
  const found = [];
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (exec.status === 0) {
    const root = exec.stdout.trim().replace(/[\\/](?:mingw64|mingw32|clangarm64)?[\\/]?libexec[\\/]git-core$/i, '');
    found.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  }
  return [...found.filter((p) => fs.existsSync(p)), 'bash'];
}

function runBash(bash, script, cwd) {
  return spawnSync(bash, [], { input: script, cwd, env: { ...process.env, LC_ALL: 'C' } });
}

function findBash(cwd) {
  for (const bash of bashCandidates()) {
    const probe = runBash(bash, "printf '%s\\0' a 'b c'\n", cwd);
    if (probe.status === 0 && probe.stdout.toString('utf8') === 'a\0b c\0') return bash;
  }
  return null;
}

test('Seam 3: each Bash seed segment with oracle `match` has bash\'s own words', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-oracle-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bash = findBash(cwd);
  if (bash === null) {
    assert.ok(!process.env.CI, 'no working bash found on CI');
    t.skip('no working bash found');
    return;
  }
  assert.ok(matchCases.length > 50, 'the seed has match cases');
  // One script for every case: each segment's words, then a record separator.
  const expected = [];
  let script = '';
  for (const c of matchCases) {
    const spans = segmentSpans(c.command, 'bash');
    assert.equal(spans.length, c.segments.length, `${c.id}: span count`);
    spans.forEach(([start, end], i) => {
      script += `printf '%s\\0' ${c.command.slice(start, end)}\nprintf '\\036'\n`;
      expected.push({ id: c.id, words: c.segments[i].filter((token) => typeof token === 'string') });
    });
  }
  const result = runBash(bash, script, cwd);
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
