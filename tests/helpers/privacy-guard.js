'use strict';

// FND-07 (docs/roadmap/01-foundation.md; docs/decisions/q15-repository-layout.md, the
// FND-06 amendment; docs/spec/testing-modules.md "Other checks"): the privacy-guard
// test's file set and its runner-name segment matcher.
//
// The segment matcher (`[\\/]<name>[\\/]`, case-insensitive) is a one-line regex this test
// owns, not an option on M8 `scanText`: unlike `local-path`'s OS-user-segment rule
// (C:scan-patterns, Q10), it applies no placeholder, service-user or length exemption, so
// a CI runner whose own user name happens to be a service user (`runner`, `root`) is still
// caught. It does not duplicate library logic (plugin/scripts/lib/scanner.mjs stays free
// of this test-only rule).
//
// The file set is exactly the one FND-06 decided: tracked files (`git ls-files`) plus
// untracked non-ignored files (`git ls-files --others --exclude-standard`, which honours
// `.gitignore` and `.git/info/exclude`), filtered to docs, README, the three manifests
// that exist in this repo, and test sources, excluding `tests/fixtures/**`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The manifest files that exist in this repo (FND-06 amendment to Q15).
const MANIFEST_PATHS = new Set([
  'package.json',
  'plugin/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
]);

function splitLines(text) {
  return text.split('\n').filter((line) => line.length > 0);
}

// Repo-relative paths (forward-slash, as `git ls-files` prints them) in the FND-06 file
// set: docs, README, the fixed manifest list and test sources, excluding fixtures.
function isPrivacyScannedPath(relPath) {
  if (relPath.startsWith('tests/fixtures/')) return false;
  if (relPath.startsWith('docs/')) return true;
  if (relPath === 'README.md') return true;
  if (MANIFEST_PATHS.has(relPath)) return true;
  if (relPath.startsWith('tests/')) return true;
  return false;
}

// Lists the FND-06 file set under `root`, sorted, de-duplicated.
function listPrivacyFileSet(root) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  const all = new Set([...splitLines(tracked), ...splitLines(untracked)]);
  return Array.from(all).filter(isPrivacyScannedPath).sort();
}

// Reads each listed path under `root` into `{ path, content }` entries.
function readFileSet(root, relPaths) {
  return relPaths.map((relPath) => ({
    path: relPath,
    content: fs.readFileSync(path.join(root, relPath), 'utf8'),
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The runner-name segment matcher: `name` as a whole path segment, between `/` or `\` on
// both sides, case-insensitive, anywhere in a line. No placeholder, service-user or length
// exemption: a bare word with no adjacent separator never matches.
function buildSegmentRegex(name) {
  return new RegExp(`[\\\\/]${escapeRegExp(name)}[\\\\/]`, 'i');
}

// Scans `fileEntries` (`{ path, content }`) for `name` as a path segment, line by line.
// Returns one hit per matching line: `{ path, line, text }` (1-based line number).
function findSegmentHits(name, fileEntries) {
  const regex = buildSegmentRegex(name);
  const hits = [];
  for (const entry of fileEntries) {
    const lines = entry.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        hits.push({ path: entry.path, line: i + 1, text: lines[i] });
      }
    }
  }
  return hits;
}

module.exports = {
  MANIFEST_PATHS,
  isPrivacyScannedPath,
  listPrivacyFileSet,
  readFileSet,
  escapeRegExp,
  buildSegmentRegex,
  findSegmentHits,
};
