'use strict';

// RPL-03 (docs/roadmap/11-reply-and-cli.md): "a test lists, for each row already reachable
// through this slice's blockers (RPL-01's `usage` refusals), the Seam 1 case that reaches
// it; rows not yet built are left to INT-31."
//
// This slice's only blocker is RPL-01, which built M1's own argv-level `usage` refusals (no
// or an unknown subcommand). Every other row of docs/spec/domain-code-cli-kind.md is
// produced by a module (M2-M19) that does not exist yet, so it cannot be reached through the
// shipped CLI at all; M18 exists (INT-01), and GIT-01 made it map the first `env` and
// `state` rows (git missing, not a repository). INT-31 extends this
// manifest once the roadmap builds them. The manifest is data so a later slice adds a row (and, once reachable, a Seam
// 1 case) instead of writing a new test file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCase, runCommit, pathOverride } = require('./helpers/process-seam.js');
const { parseDomainCodeDocRows, firstColumnKey } = require('./helpers/domain-code-doc.js');

const ROWS = [
  {
    row: 'bad argv or flag combination, malformed planId',
    kind: 'usage',
    exitCode: 1,
    reachable: true,
    // The Seam 1 case that reaches it (also covered directly in tests/commit-entry.test.js):
    // no subcommand at all is the simplest illegal argv M1 already rejects.
    async seam1Case(t) {
      const c = createCase(t);
      return runCommit(c, []);
    },
  },
  { row: 'unconfirmed', reachable: false },
  { row: 'staged-empty', reachable: false },
  { row: 'already-committed', reachable: false },
  { row: 'no-groups', reachable: false },
  {
    row: 'config',
    kind: 'config',
    exitCode: 1,
    reachable: true,
    // CFG-02: unparseable JSON in the repo config layer (tests/plan-pre-folder-refusals.test.js).
    async seam1Case(t) {
      const c = createCase(t);
      c.writeFile('.claude/commit.json', '{ "types": [');
      return runCommit(c, ['plan']);
    },
  },
  {
    row: 'env (install path, M3)',
    kind: 'env',
    exitCode: 1,
    reachable: true,
    // GIT-01: M3 finds no git on PATH (tests/plan-pre-folder-refusals.test.js).
    async seam1Case(t) {
      const fs = require('node:fs');
      const path = require('node:path');
      const c = createCase(t);
      const emptyBin = path.join(c.root, 'empty-bin');
      fs.mkdirSync(emptyBin);
      const env = pathOverride(c, [emptyBin]);
      return runCommit(c, ['plan'], { env });
    },
  },
  {
    row: 'not-a-repo, bare, in-progress, unmerged, unborn, merge, encoding',
    kind: 'state',
    exitCode: 6,
    reachable: true,
    // GIT-01: `plan` outside any repository (tests/plan-pre-folder-refusals.test.js).
    async seam1Case(t) {
      const c = createCase(t, { repo: false });
      return runCommit(c, ['plan'], { cwd: c.root });
    },
  },
  { row: 'run-folder', reachable: false },
  { row: 'killed-leftover', reachable: false },
  {
    row: 'case-rename',
    kind: 'state',
    exitCode: 6,
    reachable: true,
    // CHG-07: a staged case-only `git mv` with `core.ignorecase=true`
    // (tests/plan-units-config.test.js).
    async seam1Case(t) {
      const c = createCase(t);
      c.git(['config', 'core.ignorecase', 'true']);
      c.writeFile('readme.txt', 'r\n');
      c.git(['add', '--', 'readme.txt']);
      c.git(['commit', '-q', '-m', 'seed']);
      c.git(['mv', 'readme.txt', 'README.txt']);
      return runCommit(c, ['plan']);
    },
  },
  { row: 'signing-locked', reachable: false },
  {
    row: 'pushed',
    kind: 'pushed',
    exitCode: 6,
    reachable: true,
    // GIT-09: `plan --reword` on a HEAD a remote-tracking ref points at
    // (tests/plan-reword-facts.test.js).
    async seam1Case(t) {
      const c = createCase(t);
      c.writeFile('a.txt', 'one\n');
      c.git(['add', '--', 'a.txt']);
      c.git(['commit', '-q', '-m', 'seed']);
      c.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      return runCommit(c, ['plan', '--reword']);
    },
  },
  { row: 'staged-hit', reachable: false },
  { row: 'held, taken-over, ended, busy', reachable: false },
  { row: 'index-locked', reachable: false },
  { row: 'unmatched, mismatch', reachable: false },
  { row: 'index-changed', reachable: false },
  { row: 'head-moved', reachable: false },
  {
    row: 'lint',
    kind: 'lint',
    exitCode: 2,
    reachable: true,
    // PLN-01: `check` on a run whose folder holds no `plan.groups.json`.
    async seam1Case(t) {
      const c = createCase(t);
      c.writeFile('a.txt', 'one\n');
      c.git(['add', '--', 'a.txt']);
      c.git(['commit', '-q', '-m', 'seed']);
      c.writeFile('a.txt', 'two\n');
      const planned = await runCommit(c, ['plan']);
      return runCommit(c, ['check', '--plan', planned.json.planId]);
    },
  },
  { row: 'backstop-hit', reachable: false },
  { row: 'git-failed', reachable: false },
  { row: 'stage-failed', reachable: false },
  { row: 'timed-out', reachable: false },
  { row: 'unexpected throw -> internal', reachable: false },
  { row: 'clean tree (nothing)', reachable: false },
];

for (const entry of ROWS) {
  if (!entry.reachable) continue;
  test(`reachable row "${entry.row}": Seam 1 reaches exit ${entry.exitCode} ${entry.kind}`, async (t) => {
    const result = await entry.seam1Case(t);
    assert.equal(result.exitCode, entry.exitCode);
    assert.equal(result.json.error.kind, entry.kind);
  });
}

test('every row of docs/spec/domain-code-cli-kind.md is accounted for, reachable or not', () => {
  const docRows = parseDomainCodeDocRows();
  // Not hard-coded: the doc is the oracle for both the row count and, per row (in table
  // order, which this manifest already follows), what it names. A manifest label may carry
  // a shorter or differently annotated aside than the doc row (e.g. this manifest's `env
  // (install path, M3)` vs. the doc's longer parenthetical), so the comparison is on the
  // part before that aside (`firstColumnKey`), and a manifest label naming more than the
  // doc's key (a multi-code doc row whose aside sits after only the first code) passes when
  // it starts with that key.
  assert.equal(ROWS.length, docRows.length);
  assert.equal(ROWS.filter((r) => r.reachable).length, 7);

  docRows.forEach((docRow, i) => {
    const docKey = firstColumnKey(docRow);
    const manifestKey = firstColumnKey(ROWS[i].row);
    assert.ok(
      manifestKey === docKey || manifestKey.startsWith(docKey),
      `ROWS[${i}] = ${JSON.stringify(ROWS[i].row)} does not match doc row ${JSON.stringify(docRow)}`,
    );
  });
});
