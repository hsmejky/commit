'use strict';

// FND-09 (Seam 3, in-process, table-driven against synthetic fixtures plus the real
// docs/roadmap files): parses the group files' slice headings and blocking edges and
// checks the graph the roadmap README claims: no duplicate or missing id, no cycle,
// every in-group blocker has a lower number, README's slice counts match the files,
// and edges already implied transitively are reported, not failed. A release-mode
// switch (read only by this test) lists every slice whose `**Status:**` is not `done`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  isGroupFileName,
  parseSliceId,
  isLowerOrder,
  parseGroupFileContent,
  listGroupFiles,
  parseAllGroupFiles,
  buildGraph,
  findMissingBlockers,
  findCycle,
  findOrderViolations,
  findTransitivelyImplied,
  findNotDone,
  parseReadmeCounts,
  findCountMismatches,
} = require('./helpers/roadmap-graph');

const ROADMAP_DIR = path.join(__dirname, '..', 'docs', 'roadmap');
const RELEASE_ENV_VAR = 'ROADMAP_GRAPH_CHECK_RELEASE_MODE';

function slice(id, title, blockedBy, status) {
  return [
    `## ${id}: ${title}`,
    '',
    'Some prose about the slice.',
    '',
    `**Blocked by:** ${blockedBy}`,
    '',
    `**Status:** ${status}`,
    '',
  ].join('\n');
}

// --- File selection (AC 1) ---------------------------------------------------------

test('only NN-*.md files are treated as roadmap group files', () => {
  assert.equal(isGroupFileName('01-foundation.md'), true);
  assert.equal(isGroupFileName('00-prerequisites-and-spikes.md'), true);
  assert.equal(isGroupFileName('README.md'), false);
  assert.equal(isGroupFileName('known-deficiencies.md'), false);
});

test("slice headings in README.md or known-deficiencies.md are ignored and can't be duplicates", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-graph-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, '01-foundation.md'),
      slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done')
    );
    // Both files contain a real `## FND-01:` heading (which would otherwise parse as a
    // duplicate of the one in 01-foundation.md); isGroupFileName rejects both names, so
    // parseAllGroupFiles must not read either one as a group file.
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'known-deficiencies.md'),
      slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done')
    );
    const records = parseAllGroupFiles(tmpDir);
    const { byId, duplicates } = buildGraph(records);
    assert.equal(records.length, 1);
    assert.equal(byId.size, 1);
    assert.deepEqual(duplicates, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --- Parsing -------------------------------------------------------------------------

test('a slice heading, its blocked-by list and its status parse', () => {
  const content = [
    slice('FND-02', 'Plugin manifest', 'FND-01.', 'done'),
    slice('FND-03', 'CI matrix', 'FND-01.', 'ready-for-agent'),
  ].join('\n');
  const records = parseGroupFileContent('01-foundation.md', content);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    id: 'FND-02',
    title: 'Plugin manifest',
    file: '01-foundation.md',
    line: 1,
    blockedByRaw: 'FND-01.',
    blockedByIds: ['FND-01'],
    status: 'done',
  });
  assert.equal(records[1].blockedByIds[0], 'FND-01');
  assert.equal(records[1].status, 'ready-for-agent');
});

test('"None (can start immediately)" resolves to no blockers', () => {
  const content = slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done');
  const [record] = parseGroupFileContent('01-foundation.md', content);
  assert.deepEqual(record.blockedByIds, []);
});

test('a Blocked by paragraph that wraps across lines parses every id it names', () => {
  const content = [
    '## INT-31: Domain-code row coverage',
    '',
    '**Blocked by:** CFG-07, CHG-05, CHG-19, CHG-20, EXE-01, EXE-05, EXE-06, EXE-07, EXE-08,',
    'EXE-10, EXE-11, EXE-12, EXE-13, EXE-16, EXE-17, EXE-22, GIT-09, GIT-12, INT-01, INT-07,',
    'INT-09, INT-14, INT-15, INT-24, RPL-01, RPL-02, RUN-02, RUN-04, RUN-05, RUN-06, RUN-07,',
    'RUN-12, RUN-13, RUN-14, RUN-15, RUN-19, RUN-24.',
    '',
    '**Status:** ready-for-agent',
    '',
  ].join('\n');
  const [record] = parseGroupFileContent('12-integration.md', content);
  assert.equal(record.blockedByIds.length, 37);
  assert.ok(record.blockedByIds.includes('CFG-07'));
  assert.ok(record.blockedByIds.includes('RUN-24'));
});

// --- Duplicate ids ---------------------------------------------------------------------

test('a duplicate heading id anywhere in the group files is named', () => {
  const fileA = slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done');
  const fileB = slice('FND-01', 'Repo skeleton again', 'None (can start immediately).', 'done');
  const records = [
    ...parseGroupFileContent('01-foundation.md', fileA),
    ...parseGroupFileContent('02-guard.md', fileB),
  ];
  const { duplicates } = buildGraph(records);
  assert.deepEqual(duplicates, ['FND-01']);
});

test('no duplicates are reported when every id is unique', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done'),
    slice('FND-02', 'Plugin manifest', 'FND-01.', 'done'),
  ].join('\n'));
  const { duplicates } = buildGraph(records);
  assert.deepEqual(duplicates, []);
});

// --- Missing blockers --------------------------------------------------------------

test('a blocker naming an id with no matching heading is reported as missing', () => {
  const records = parseGroupFileContent('01-foundation.md', slice('FND-09', 'Graph check', 'FND-99.', 'ready-for-agent'));
  const { byId } = buildGraph(records);
  const missing = findMissingBlockers(records, byId);
  assert.deepEqual(missing, [{ slice: 'FND-09', blocker: 'FND-99' }]);
});

test('no missing blockers are reported when every blocker resolves', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'Repo skeleton', 'None (can start immediately).', 'done'),
    slice('FND-02', 'Plugin manifest', 'FND-01.', 'done'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  assert.deepEqual(findMissingBlockers(records, byId), []);
});

// --- Cycles --------------------------------------------------------------------------

test('a cycle in the blocking graph is detected and named', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'FND-02.', 'ready-for-agent'),
    slice('FND-02', 'B', 'FND-01.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  const cycle = findCycle(records, byId);
  assert.ok(cycle, 'expected a cycle to be found');
  assert.ok(cycle.includes('FND-01') && cycle.includes('FND-02'));
  assert.equal(cycle[0], cycle[cycle.length - 1]);
});

test('a plain chain has no cycle', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'FND-01.', 'done'),
    slice('FND-03', 'C', 'FND-02.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  assert.equal(findCycle(records, byId), null);
});

// --- In-group ordering (numbering, including letter suffixes and gaps) ------------------

test('an in-group blocker whose number is not lower than the slice it blocks fails', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-03', 'CI matrix', 'FND-05.', 'ready-for-agent'),
    slice('FND-05', 'Stepping clock', 'None (can start immediately).', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  const violations = findOrderViolations(records, byId);
  assert.deepEqual(violations, [{ slice: 'FND-03', blocker: 'FND-05' }]);
});

test('a cross-group blocker is unconstrained by number', () => {
  const records = [
    ...parseGroupFileContent('01-foundation.md', slice('FND-04', 'Harness', 'GRD-09.', 'ready-for-agent')),
    ...parseGroupFileContent('02-guard.md', slice('GRD-09', 'Later guard slice', 'None (can start immediately).', 'ready-for-agent')),
  ];
  const { byId } = buildGraph(records);
  assert.deepEqual(findOrderViolations(records, byId), []);
});

test('a letter-suffix id sorts between its base number and the next number (03 < 03b < 04)', () => {
  assert.equal(isLowerOrder(parseSliceId('CHG-03'), parseSliceId('CHG-03b')), true);
  assert.equal(isLowerOrder(parseSliceId('CHG-03b'), parseSliceId('CHG-04')), true);
  assert.equal(isLowerOrder(parseSliceId('CHG-03'), parseSliceId('CHG-04')), true);
  assert.equal(isLowerOrder(parseSliceId('CHG-04'), parseSliceId('CHG-03b')), false);
});

test('a letter-suffix slice blocked by its base number, blocking the next number, has no order violation', () => {
  const records = parseGroupFileContent('07-change-set.md', [
    slice('CHG-03', 'Path classifier', 'None (can start immediately).', 'done'),
    slice('CHG-03b', 'Take the run lock at step 7', 'CHG-03.', 'ready-for-agent'),
    slice('CHG-04', 'Change-set engine', 'CHG-03b.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  assert.deepEqual(findOrderViolations(records, byId), []);
});

test('a numbering gap left by a removed or merged id does not fail the order check', () => {
  const records = parseGroupFileContent('11-reply-and-cli.md', [
    slice('RPL-01', 'First', 'None (can start immediately).', 'done'),
    // RPL-02 removed/merged; the next slice is RPL-03.
    slice('RPL-03', 'Third', 'RPL-01.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  assert.deepEqual(findOrderViolations(records, byId), []);
  assert.deepEqual(findMissingBlockers(records, byId), []);
});

// --- Transitively implied edges (reported, not failed) ------------------------------

test('a blocking edge already reachable through another blocker is listed as transitively implied', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'FND-01.', 'done'),
    // FND-03 names both FND-01 and FND-02, but FND-01 is already implied by FND-02.
    slice('FND-03', 'C', 'FND-01, FND-02.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  const implied = findTransitivelyImplied(records, byId);
  assert.deepEqual(implied, [{ slice: 'FND-03', blocker: 'FND-01' }]);
  // Reported, but not a graph error: order and missing checks stay clean.
  assert.deepEqual(findOrderViolations(records, byId), []);
  assert.deepEqual(findMissingBlockers(records, byId), []);
});

test('a direct blocker with no alternate path is not reported as transitively implied', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'None (can start immediately).', 'done'),
    slice('FND-03', 'C', 'FND-01, FND-02.', 'ready-for-agent'),
  ].join('\n'));
  const { byId } = buildGraph(records);
  assert.deepEqual(findTransitivelyImplied(records, byId), []);
});

// --- README slice counts -------------------------------------------------------------

test("a mismatch between README's stated slice count and the parsed files is reported", () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'FND-01.', 'done'),
  ].join('\n'));
  const readme = parseReadmeCounts([
    '| File | Prefix | Slices | needs-human | Delivers |',
    '| --- | --- | --- | --- | --- |',
    '| 01-foundation.md | FND | 3 | 1 | repo skeleton |',
    '| **Total** | | **3** | **1** | |',
  ].join('\n'));
  const mismatches = findCountMismatches(records, readme);
  assert.deepEqual(mismatches, [
    { file: '01-foundation.md', expected: 3, actual: 2 },
    { file: 'Total', expected: 3, actual: 2 },
  ]);
});

test('matching README counts report no mismatch', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'FND-01.', 'done'),
  ].join('\n'));
  const readme = parseReadmeCounts([
    '| File | Prefix | Slices | needs-human | Delivers |',
    '| --- | --- | --- | --- | --- |',
    '| 01-foundation.md | FND | 2 | 0 | repo skeleton |',
    '| **Total** | | **2** | **0** | |',
  ].join('\n'));
  assert.deepEqual(findCountMismatches(records, readme), []);
});

// --- Release mode: every slice not Status: done ---------------------------------------

test('release mode lists every slice whose Status line is not done', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-03', 'B', 'FND-01.', 'ready-for-agent'),
    slice('FND-06', 'C', 'None (can start immediately).', 'needs-human'),
  ].join('\n'));
  assert.deepEqual(findNotDone(records), ['FND-03', 'FND-06']);
});

test('release mode reports nothing when every slice is done', () => {
  const records = parseGroupFileContent('01-foundation.md', [
    slice('FND-01', 'A', 'None (can start immediately).', 'done'),
    slice('FND-02', 'B', 'FND-01.', 'done'),
  ].join('\n'));
  assert.deepEqual(findNotDone(records), []);
});

test('release mode excludes ids named in the exclude option, but still reports other not-done slices', () => {
  const records = parseGroupFileContent('16-release.md', [
    slice('REL-05', 'Release checklist', 'None (can start immediately).', 'ready-for-agent'),
    slice('REL-06', 'Other slice', 'REL-05.', 'ready-for-agent'),
  ].join('\n'));
  assert.deepEqual(findNotDone(records, { exclude: ['REL-05'] }), ['REL-06']);
});

// --- Against the real repo -----------------------------------------------------------

test('the real docs/roadmap group files parse with globally unique ids', () => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  assert.ok(records.length > 0);
  const { duplicates } = buildGraph(records);
  assert.deepEqual(duplicates, []);
});

test('every blocker in the real docs/roadmap files resolves to an existing id', () => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  const { byId } = buildGraph(records);
  assert.deepEqual(findMissingBlockers(records, byId), []);
});

test('the real docs/roadmap blocking graph has no cycle', () => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  const { byId } = buildGraph(records);
  assert.equal(findCycle(records, byId), null);
});

test('every in-group blocking edge in the real docs/roadmap files has a lower number', () => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  const { byId } = buildGraph(records);
  assert.deepEqual(findOrderViolations(records, byId), []);
});

test("the real README's per-file and total slice counts match the group files", () => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  const readmeContent = require('node:fs').readFileSync(path.join(ROADMAP_DIR, 'README.md'), 'utf8');
  const readmeCounts = parseReadmeCounts(readmeContent);
  assert.ok(readmeCounts.rows.length > 0);
  assert.ok(readmeCounts.total);
  assert.deepEqual(findCountMismatches(records, readmeCounts), []);
});

test('transitively implied edges in the real docs/roadmap files are listed and do not fail the check', (t) => {
  const records = parseAllGroupFiles(ROADMAP_DIR);
  const { byId } = buildGraph(records);
  const implied = findTransitivelyImplied(records, byId);
  t.diagnostic(`${implied.length} transitively implied edge(s)`);
  for (const { slice: sliceId, blocker } of implied) {
    t.diagnostic(`  ${sliceId} <- ${blocker}`);
  }
  // Every reported pair names two ids that actually exist in the real graph.
  for (const { slice: sliceId, blocker } of implied) {
    assert.ok(byId.has(sliceId), `${sliceId} should be a real slice id`);
    assert.ok(byId.has(blocker), `${blocker} should be a real slice id`);
  }
});

// Opt-in release mode: not run by `npm test`. Set ROADMAP_GRAPH_CHECK_RELEASE_MODE=1 to
// check that every slice other than REL-05 is Status: done before a 0.1.0 release. REL-05
// is excluded here: its own criterion is that every *other* slice is done, so requiring
// REL-05 itself to already be done would be circular.
test(
  'release mode: every real slice other than REL-05 is Status: done',
  { skip: !process.env[RELEASE_ENV_VAR] && `set ${RELEASE_ENV_VAR}=1 to run` },
  () => {
    const records = parseAllGroupFiles(ROADMAP_DIR);
    const notDone = findNotDone(records, { exclude: ['REL-05'] });
    assert.deepEqual(notDone, []);
  }
);

// listGroupFiles reads the real directory directly, independent of parseAllGroupFiles.
test('listGroupFiles excludes README.md and known-deficiencies.md from the real directory', () => {
  const files = listGroupFiles(ROADMAP_DIR);
  assert.ok(files.length > 0);
  assert.ok(!files.includes('README.md'));
  assert.ok(!files.includes('known-deficiencies.md'));
  assert.ok(files.every(isGroupFileName));
});
