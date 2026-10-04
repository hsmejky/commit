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
 * @returns {{ stdoutObj: object, hunksTxt: string }} `stdoutObj`: exactly the C:plan-hunks
 *   output shape; `hunksTxt`: one block per unit, a `### <id> <status> <kind> <range>
 *   <path>` line then the lossily decoded body. Per entry, `offset` is the 1-based line of
 *   its `###` line and `lines` the block's line count including it. A binary unit, a
 *   submodule unit with an empty body (a pointer change), or any unit with a pattern hit,
 *   has no block: `body: "none"`, `offset` and `lines` null, so the secret never reaches
 *   `hunks.txt` or the worker's context (CHG-16, Q10). An entry with a hit or an
 *   over-limit skip carries `scan`, the scan map's value for its ID.
 */
export function renderHunks(runState, units) {
  const { scanIgnore, ...values } = runState.config.values;
  const scanMap = runState.scanMap ?? {};
  const blocks = [];
  const hunks = [];
  let nextLine = 1;
  for (const unit of units) {
    const scanEntry = scanMap[unit.id];
    const scanField = scanEntry !== undefined ? { scan: scanEntry } : {};
    // CHG-08, CHG-09: a binary unit or a submodule pointer change has no block (`body:
    // "none"`, C:plan-hunks); a file↔submodule `T` with file lines has one. CHG-10: a
    // `filtered` unit whose cleaned form is binary has no block either (its own `binary`
    // flag, not an empty body: an empty filtered new file still gets one, review-CHG-10
    // finding 9). CHG-16: a unit with a pattern hit (`scanEntry` an array) loses its whole
    // body too, whichever kind it is; an over-limit skip (`scanEntry === "skipped"`) keeps
    // its block (only the scan is skipped, not the body).
    if (
      unit.kind === 'binary'
      || (unit.kind === 'filtered' && unit.binary === true)
      || (unit.kind === 'submodule' && unit.body.length === 0)
      || Array.isArray(scanEntry)
    ) {
      hunks.push({
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
      });
      continue;
    }
    const label = unit.oldPath === null ? unit.path : `${unit.oldPath} -> ${unit.path}`;
    let body = LOSSY_UTF8.decode(unit.body);
    if (!body.endsWith('\n')) body += '\n';
    const text = `### ${unit.id} ${unit.status} ${unit.kind} ${unit.range} ${label}\n${body}`;
    const lines = text.split('\n').length - 1;
    hunks.push({
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
    });
    blocks.push(text);
    nextLine += lines;
  }
  return {
    stdoutObj: {
      version: 1,
      ok: true,
      runDir: runState.runDir,
      mode: runState.mode,
      config: values,
      recentSubjects: runState.recentSubjects ?? [],
      ...(runState.mode === 'reword' ? { oldMessage: runState.oldMessage } : {}),
      counts: { units: units.length, files: new Set(units.map((unit) => unit.path)).size },
      hunksFile: `${runState.runDir}/hunks.txt`,
      hunks,
      summaryOnly: [],
    },
    hunksTxt: blocks.join(''),
  };
}
