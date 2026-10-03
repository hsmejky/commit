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

function splitNulTerminated(text) {
  return text.split('\0').filter((line) => line.length > 0);
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

// `-c core.quotePath=false` so a non-ASCII or special-character path comes back as plain
// UTF-8 rather than C-quoted (tests/glob-oracle.test.js uses the same form); `-z` so paths
// are NUL-terminated and never need unquoting or escaping.
function gitLsFiles(root, extraArgs) {
  const stdout = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '-z', ...extraArgs],
    { cwd: root, encoding: 'utf8' },
  );
  return splitNulTerminated(stdout);
}

// Lists the FND-06 file set under `root`, sorted, de-duplicated.
function listPrivacyFileSet(root) {
  const tracked = gitLsFiles(root, []);
  const untracked = gitLsFiles(root, ['--others', '--exclude-standard']);
  const all = new Set([...tracked, ...untracked]);
  return Array.from(all).filter(isPrivacyScannedPath).sort();
}

// Reads each listed path under `root` into `{ path, content }` entries. A path that no
// longer exists on disk (e.g. a tracked file deleted in the worktree) is skipped rather
// than thrown on.
function readFileSet(root, relPaths) {
  const entries = [];
  for (const relPath of relPaths) {
    const full = path.join(root, relPath);
    if (!fs.existsSync(full)) continue;
    entries.push({ path: relPath, content: fs.readFileSync(full, 'utf8') });
  }
  return entries;
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
  buildSegmentRegex,
  findSegmentHits,
};
