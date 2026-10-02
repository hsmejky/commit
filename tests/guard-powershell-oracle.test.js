'use strict';

// GRD-06: the PowerShell golden seed (tests/fixtures/guard/segments-seed.json) cross-checked
// against the PowerShell parser API (docs/spec/testing-seams.md, C:guard Oracle-skip
// classes), under Windows PowerShell 5.1 (`powershell.exe`, oracle key `ps51`) and PowerShell
// 7 (`pwsh`, key `ps7`). Each segment span G2 reports is parsed, and the elements of its first
// command must equal the seed segment's string tokens, with a leading `&` dropped (the parser
// reads it as the command's invocation operator, not an element). Cases whose oracle value
// names a skip class are not run. The check runs only on CI (`CI` set), so the default
// `npm test` needs no PowerShell: on Windows both executables are required; elsewhere `pwsh`
// is used when found (the ubuntu:22.04 container has none) and the check is skipped
// otherwise. Each shell's version is reported as a test diagnostic.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLib } = require('./helpers/load-lib');
const { powerShellVersion, parseSpans } = require('./helpers/powershell-oracle');

const SEED = path.join(__dirname, 'fixtures', 'guard', 'segments-seed.json');
const psCases = JSON.parse(fs.readFileSync(SEED, 'utf8')).cases.filter((c) => c.shell === 'powershell');

let segmentSpans;

beforeEach(async () => {
  ({ segmentSpans } = await loadLib('shell-tokenizer'));
});

const SHELLS = [
  { key: 'ps51', exe: 'powershell.exe', windowsOnly: true },
  { key: 'ps7', exe: 'pwsh', windowsOnly: false },
];

for (const shell of SHELLS) {
  test(`Seam 3: each PowerShell seed segment with oracle.${shell.key} \`match\` has the ${shell.exe} parser's elements`, (t) => {
    if (!process.env.CI) {
      t.skip('the PowerShell oracle runs only on CI');
      return;
    }
    if (shell.windowsOnly && process.platform !== 'win32') {
      t.skip(`${shell.exe} exists only on Windows`);
      return;
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-ps-oracle-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const version = powerShellVersion(shell.exe, cwd);
    if (version === null) {
      if (process.platform === 'win32') throw new Error(`no working ${shell.exe} found on Windows CI`);
      t.skip(`no working ${shell.exe} found`);
      return;
    }
    t.diagnostic(`${shell.exe} ${version}`);
    const cases = psCases.filter((c) => c.oracle[shell.key] === 'match');
    assert.ok(cases.length > 20, 'the seed has match cases');
    const spans = [];
    const expected = [];
    for (const c of cases) {
      const caseSpans = segmentSpans(c.command, 'powershell');
      assert.equal(caseSpans.length, c.segments.length, `${c.id}: span count`);
      caseSpans.forEach(([start, end], i) => {
        spans.push(c.command.slice(start, end));
        const words = c.segments[i].filter((token) => typeof token === 'string');
        expected.push({ id: c.id, words: words[0] === '&' ? words.slice(1) : words });
      });
    }
    const actual = parseSpans(shell.exe, spans, cwd);
    actual.forEach((words, i) => {
      assert.deepEqual(words, expected[i].words, `${expected[i].id}: ${shell.exe} parser elements`);
    });
  });
}
