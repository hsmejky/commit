'use strict';

// FND-09: pure parsing and graph-checking functions for the roadmap graph check.
// Parses `docs/roadmap/NN-*.md` group files (each `## <ID>:` slice heading, its
// `**Blocked by:**` paragraph and its `**Status:**` line) and checks the graph the
// slices describe: no duplicate or missing ID, no cycle, every in-group blocker has a
// lower number than the slice it blocks, and README.md's slice counts match the files.

const fs = require('node:fs');
const path = require('node:path');

const SLICE_ID = '[A-Z]{3}-\\d{2,3}[a-z]?';
const HEADING_RE = new RegExp(`^## (${SLICE_ID}): (.+)$`);
const BLOCKED_BY_RE = /^\*\*Blocked by:\*\*\s*(.*)$/;
const STATUS_RE = /^\*\*Status:\*\*\s*(.*)$/;
const ID_TOKEN_RE = new RegExp(SLICE_ID, 'g');
const ID_SHAPE_RE = new RegExp(`^([A-Z]{3})-(\\d{2,3})([a-z]?)$`);

// A roadmap group file's name starts with a two-digit group number, e.g.
// `01-foundation.md`. `README.md` and `known-deficiencies.md` do not match, so an ID
// either of them cites is neither a duplicate nor a heading (FND-09 AC 1).
function isGroupFileName(name) {
  return /^\d{2}-.*\.md$/.test(name);
}

function extractIds(text) {
  const matches = text.match(ID_TOKEN_RE);
  return matches ? Array.from(new Set(matches)) : [];
}

// Splits a slice id into the parts the numbering rule compares: group prefix, numeric
// part and optional letter suffix. A letter-suffix id sorts just after its base number
// and before the next number (`03` < `03b` < `04`), which falls out of comparing the
// number first and the suffix second ('' sorts before any letter).
function parseSliceId(id) {
  const match = ID_SHAPE_RE.exec(id);
  if (!match) {
    throw new Error(`not a roadmap slice id: ${id}`);
  }
  return { prefix: match[1], number: Number(match[2]), suffix: match[3] };
}

function isLowerOrder(a, b) {
  if (a.number !== b.number) return a.number < b.number;
  return a.suffix < b.suffix;
}

// Parses one group file's content into slice records. Each record's `blockedByIds` is
// the resolved list of slice ids named in its `**Blocked by:**` paragraph (which may
// wrap across lines, terminated by the next blank line); "None (can start
// immediately)" resolves to an empty list, since it names no id.
function parseGroupFileContent(fileName, content) {
  const lines = content.split(/\r?\n/);
  const records = [];
  let current = null;
  let collectingBlockedBy = false;
  let blockedByParts = [];

  function finalizeBlockedBy() {
    if (current && blockedByParts.length > 0) {
      current.blockedByRaw = blockedByParts.join(' ');
      current.blockedByIds = extractIds(current.blockedByRaw);
    }
    collectingBlockedBy = false;
    blockedByParts = [];
  }

  function pushCurrent() {
    if (current) {
      finalizeBlockedBy();
      records.push(current);
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      pushCurrent();
      current = {
        id: headingMatch[1],
        title: headingMatch[2].trim(),
        file: fileName,
        line: i + 1,
        blockedByRaw: '',
        blockedByIds: [],
        status: null,
      };
      continue;
    }
    if (!current) continue;

    const blockedMatch = BLOCKED_BY_RE.exec(line);
    if (blockedMatch) {
      collectingBlockedBy = true;
      blockedByParts = [blockedMatch[1]];
      continue;
    }
    if (collectingBlockedBy) {
      if (line.trim() === '') {
        finalizeBlockedBy();
      } else {
        blockedByParts.push(line.trim());
      }
      continue;
    }

    const statusMatch = STATUS_RE.exec(line);
    if (statusMatch) {
      current.status = statusMatch[1].trim();
    }
  }
  pushCurrent();
  return records;
}

function listGroupFiles(roadmapDir) {
  return fs.readdirSync(roadmapDir).filter(isGroupFileName).sort();
}

function parseAllGroupFiles(roadmapDir) {
  const records = [];
  for (const file of listGroupFiles(roadmapDir)) {
    const content = fs.readFileSync(path.join(roadmapDir, file), 'utf8');
    records.push(...parseGroupFileContent(file, content));
  }
  return records;
}

// Builds the id -> record map used by every other check. Ids that appear on more than
// one heading (anywhere in the group files) are reported in `duplicates` rather than
// thrown, so a single parse pass can drive every check.
function buildGraph(records) {
  const byId = new Map();
  const duplicateIds = new Set();
  for (const record of records) {
    if (byId.has(record.id)) {
      duplicateIds.add(record.id);
    } else {
      byId.set(record.id, record);
    }
  }
  return { byId, duplicates: Array.from(duplicateIds) };
}

// A `**Blocked by:**` entry naming an id with no matching heading.
function findMissingBlockers(records, byId) {
  const missing = [];
  for (const record of records) {
    for (const blockerId of record.blockedByIds) {
      if (!byId.has(blockerId)) {
        missing.push({ slice: record.id, blocker: blockerId });
      }
    }
  }
  return missing;
}

function buildForwardAdjacency(records, byId) {
  const adjacency = new Map();
  for (const record of records) adjacency.set(record.id, []);
  for (const record of records) {
    for (const blockerId of record.blockedByIds) {
      if (byId.has(blockerId)) adjacency.get(blockerId).push(record.id);
    }
  }
  return adjacency;
}

// Depth-first cycle search over the "blocker must come before the slice it blocks"
// graph. Returns the cycle as an array of ids (first id repeated at the end) or null.
function findCycle(records, byId) {
  const adjacency = buildForwardAdjacency(records, byId);
  const state = new Map(); // 0 unvisited (implicit), 1 in progress, 2 done
  const stack = [];

  function visit(id) {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) || []) {
      const nextState = state.get(next) || 0;
      if (nextState === 0) {
        const found = visit(next);
        if (found) return found;
      } else if (nextState === 1) {
        const startIndex = stack.indexOf(next);
        return stack.slice(startIndex).concat(next);
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const id of adjacency.keys()) {
    if ((state.get(id) || 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// An in-group blocker (same prefix) whose order is not lower than the slice it blocks.
// Cross-group blockers are unconstrained. Blockers missing from `byId` are skipped
// (already reported by findMissingBlockers).
function findOrderViolations(records, byId) {
  const violations = [];
  for (const record of records) {
    const sliceKey = parseSliceId(record.id);
    for (const blockerId of record.blockedByIds) {
      const blocker = byId.get(blockerId);
      if (!blocker) continue;
      const blockerKey = parseSliceId(blockerId);
      if (blockerKey.prefix !== sliceKey.prefix) continue;
      if (!isLowerOrder(blockerKey, sliceKey)) {
        violations.push({ slice: record.id, blocker: blockerId });
      }
    }
  }
  return violations;
}

// The set of ids that (transitively) block `id`, memoized. Guards against revisiting a
// node already on the current path so a cycle (reported separately) cannot loop forever.
function computeAncestors(byId, id, memo, visiting) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) return new Set();
  visiting.add(id);
  const record = byId.get(id);
  const result = new Set();
  if (record) {
    for (const blockerId of record.blockedByIds) {
      if (!byId.has(blockerId)) continue;
      result.add(blockerId);
      for (const ancestor of computeAncestors(byId, blockerId, memo, visiting)) {
        result.add(ancestor);
      }
    }
  }
  visiting.delete(id);
  memo.set(id, result);
  return result;
}

// A direct blocker already reachable through another of the same slice's direct
// blockers (transitively implied). Reported, not a failure (FND-09 AC).
function findTransitivelyImplied(records, byId) {
  const memo = new Map();
  const implied = [];
  for (const record of records) {
    const direct = record.blockedByIds.filter((id) => byId.has(id));
    for (const blockerId of direct) {
      const isImplied = direct.some((otherId) => {
        if (otherId === blockerId) return false;
        return computeAncestors(byId, otherId, memo, new Set()).has(blockerId);
      });
      if (isImplied) implied.push({ slice: record.id, blocker: blockerId });
    }
  }
  return implied;
}

function findNotDone(records) {
  return records.filter((record) => record.status !== 'done').map((record) => record.id);
}

function parseReadmeCounts(content) {
  const rowRe = /^\|\s*([\w.-]+\.md)\s*\|\s*([A-Z]{3})\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm;
  const rows = [];
  let match = rowRe.exec(content);
  while (match) {
    rows.push({ file: match[1], prefix: match[2], slices: Number(match[3]), needsHuman: Number(match[4]) });
    match = rowRe.exec(content);
  }
  const totalRe = /^\|\s*\*\*Total\*\*\s*\|\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/m;
  const totalMatch = totalRe.exec(content);
  const total = totalMatch ? { slices: Number(totalMatch[1]), needsHuman: Number(totalMatch[2]) } : null;
  return { rows, total };
}

// Compares README.md's per-file and total slice counts against what was actually
// parsed out of the group files.
function findCountMismatches(records, readmeCounts) {
  const mismatches = [];
  const byFile = new Map();
  for (const record of records) {
    byFile.set(record.file, (byFile.get(record.file) || 0) + 1);
  }
  for (const row of readmeCounts.rows) {
    const actual = byFile.get(row.file) || 0;
    if (actual !== row.slices) {
      mismatches.push({ file: row.file, expected: row.slices, actual });
    }
  }
  if (readmeCounts.total && records.length !== readmeCounts.total.slices) {
    mismatches.push({ file: 'Total', expected: readmeCounts.total.slices, actual: records.length });
  }
  return mismatches;
}

module.exports = {
  isGroupFileName,
  extractIds,
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
};
