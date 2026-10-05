// M13 Hunk index renderer (docs/spec/modules-m10-m13.md, C:plan-hunks): presentation only.
// Pure: it returns texts, and M18 writes them through M12. Bodies are decoded lossily here
// and nowhere else on the way to the worker; nothing decoded feeds a hash or a patch.
//
// CHG-03 builds the tracer: every unit gets a `body: "file"` block in `hunks.txt`, except a
// binary one (CHG-08: `body: "none"`, no block). CHG-16 adds the per-entry `scan` (read off
// M18's scan map, `runState.scanMap`) and withheld bodies for a pattern hit; CHG-17 adds
// summary-only entries and the body cap, CHG-18 the stdout budget with the spill to
// `hunks.json`. GIT-09 adds `oldMessage` in `reword` mode.

const LOSSY_UTF8 = new TextDecoder('utf-8');

// C:plan-hunks: "Stdout budget: 20 000 characters for the whole output." `stdoutObj` is
// printed with a plain `JSON.stringify` (no whitespace, `commit.cjs`), so the budget is
// measured the same way here, in characters (not bytes), over the object that still holds
// `hunks` and `summaryOnly` in full.
const STDOUT_BUDGET = 20000;

/**
 * Renders the hunk index (C:plan-hunks) for the units `plan --hunks` matched.
 *
 * @param {{ runDir: string, mode: string, config: { values: object },
 *   recentSubjects?: string[], oldMessage?: string,
 *   scanMap?: Object<string, string[]|string> }} runState `runDir`: absolute, forward slashes;
 *   `config.values`: the resolved config, `scanIgnore` included (left out here);
 *   `oldMessage`: HEAD's message, returned only in `reword` mode (C:plan-hunks); `scanMap`:
 *   M18's scan map (`state.json` `scanned`), unit ID → pattern IDs for a hit or `"skipped"`
 *   for an over-limit path (CHG-16).
 * @param {Array<{ id: string, path: string, oldPath: string|null, status: string,
 *   kind: string, range: string, body: Uint8Array }>} units in ID order.
 * @returns {{ stdoutObj: object, hunksTxt: string, hunksJson?: string }} `stdoutObj`:
 *   exactly the C:plan-hunks output shape; `hunksTxt`: one block per unit, a `### <id>
 *   <status> <kind> <range> <path>` line then the lossily decoded body. Per entry, `offset`
 *   is the 1-based line of its `###` line and `lines` the block's line count including it. A
 *   binary unit, a submodule unit with an empty body (a pointer change), or any unit with a
 *   pattern hit, has no block: `body: "none"`, `offset` and `lines` null, so the secret
 *   never reaches `hunks.txt` or the worker's context (CHG-16, Q10). An entry with a hit or
 *   an over-limit skip carries `scan`, the scan map's value for its ID. CHG-17: a unit M10
 *   marked `summaryOnly` (its reason) goes to `summaryOnly` as `{ id, path, reason, added,
 *   deleted }` (plus `scan`), not to `hunks`; one M10 marked `capped` has no block either
 *   (`body: "cap"`, its `range`, `added` and `deleted` kept, `offset` and `lines` null).
 *   CHG-18: when `stdoutObj` (with `hunks` and `summaryOnly` in full) would print past the
 *   20 000-character stdout budget, `stdoutObj` instead carries `hunksIndexFile` (absolute,
 *   `<runDir>/hunks.json`) in place of `hunks` and `summaryOnly`, and `hunksJson` holds the
 *   full index (every `hunks`/`summaryOnly` entry, in ID order, one JSON object per line,
 *   trailing newline) for M18 to write there; `hunksJson` is absent when there is no spill.
 */
export function renderHunks(runState, units) {
  const { scanIgnore, ...values } = runState.config.values;
  const scanMap = runState.scanMap ?? {};
  const blocks = [];
  const hunks = [];
  const summaryOnly = [];
  // CHG-18: every entry pushed to `hunks` or `summaryOnly` above, kept in the same (ID)
  // order, so a spill to `hunks.json` can print "the full index" as one combined list
  // without re-deriving the interleaving.
  const allEntries = [];
  let nextLine = 1;
  for (const unit of units) {
    const scanEntry = scanMap[unit.id];
    const scanField = scanEntry !== undefined ? { scan: scanEntry } : {};
    // CHG-17: a summary-only file (M10's one whole-file unit with its reason) is a
    // `summaryOnly` entry, never a `hunks` one: no kind, range or block (C:plan-hunks).
    if (unit.summaryOnly !== undefined) {
      const entry = {
        id: unit.id, path: unit.path, reason: unit.summaryOnly, added: unit.added, deleted: unit.deleted, ...scanField,
      };
      summaryOnly.push(entry);
      allEntries.push(entry);
      continue;
    }
    // CHG-08, CHG-09: a binary unit or a submodule pointer change has no block (`body:
    // "none"`, C:plan-hunks); a file↔submodule `T` with file lines has one. CHG-10: a
    // `filtered` unit whose cleaned form is binary has no block either (its own `binary`
    // flag, not an empty body: an empty filtered new file still gets one, review-CHG-10
    // finding 9). CHG-11: an attribute-hidden text file (`kind: "text"`, git's raw
    // `binary: true` kept) has none either (C:plan-hunks). CHG-16: a unit with a pattern hit (`scanEntry` an array) loses its whole
    // body too, whichever kind it is; an over-limit skip (`scanEntry === "skipped"`) keeps
    // its block (only the scan is skipped, not the body).
    if (
      unit.kind === 'binary'
      || ((unit.kind === 'filtered' || unit.kind === 'text') && unit.binary === true)
      || (unit.kind === 'submodule' && unit.body.length === 0)
      || Array.isArray(scanEntry)
    ) {
      const entry = {
        id: unit.id,
        path: unit.path,
        oldPath: unit.oldPath,
        status: unit.status,
        kind: unit.kind,
        range: unit.range,
        lines: null,
        offset: null,
        body: 'none',
        ...scanField,
      };
      hunks.push(entry);
      allEntries.push(entry);
      continue;
    }
    // CHG-17: past the body cap (M10's `capped`), a unit keeps its own ID, range and counts
    // but has no block (`body: "cap"`, C:plan-hunks).
    if (unit.capped === true) {
      const entry = {
        id: unit.id,
        path: unit.path,
        oldPath: unit.oldPath,
        status: unit.status,
        kind: unit.kind,
        range: unit.range,
        lines: null,
        offset: null,
        body: 'cap',
        added: unit.added,
        deleted: unit.deleted,
        ...scanField,
      };
      hunks.push(entry);
      allEntries.push(entry);
      continue;
    }
    const label = unit.oldPath === null ? unit.path : `${unit.oldPath} -> ${unit.path}`;
    let body = LOSSY_UTF8.decode(unit.body);
    if (!body.endsWith('\n')) body += '\n';
    const text = `### ${unit.id} ${unit.status} ${unit.kind} ${unit.range} ${label}\n${body}`;
    const lines = text.split('\n').length - 1;
    {
      const entry = {
        id: unit.id,
        path: unit.path,
        oldPath: unit.oldPath,
        status: unit.status,
        kind: unit.kind,
        range: unit.range,
        lines,
        offset: nextLine,
        body: 'file',
        ...scanField,
      };
      hunks.push(entry);
      allEntries.push(entry);
    }
    blocks.push(text);
    nextLine += lines;
  }
  const base = {
    version: 1,
    ok: true,
    runDir: runState.runDir,
    mode: runState.mode,
    config: values,
    recentSubjects: runState.recentSubjects ?? [],
    ...(runState.mode === 'reword' ? { oldMessage: runState.oldMessage } : {}),
    counts: { units: units.length, files: new Set(units.map((unit) => unit.path)).size },
    hunksFile: `${runState.runDir}/hunks.txt`,
  };
  // CHG-18 (C:plan-hunks): the 20 000-character stdout budget is measured over the full
  // shape (`hunks` and `summaryOnly` in, same as `commit.cjs`'s plain `JSON.stringify`).
  // Past it, the full index spills to `hunks.json` (one entry per line, in ID order) and
  // stdout carries `hunksIndexFile` (absolute) instead of `hunks` and `summaryOnly`.
  const full = { ...base, hunks, summaryOnly };
  if (JSON.stringify(full).length <= STDOUT_BUDGET) {
    return { stdoutObj: full, hunksTxt: blocks.join('') };
  }
  return {
    stdoutObj: { ...base, hunksIndexFile: `${runState.runDir}/hunks.json` },
    hunksTxt: blocks.join(''),
    hunksJson: `${allEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  };
}
