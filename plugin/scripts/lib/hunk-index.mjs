// M13 Hunk index renderer (docs/spec/modules-m10-m13.md, C:plan-hunks): presentation only.
// Pure: it returns texts, and M18 writes them through M12. Bodies are decoded lossily here
// and nowhere else on the way to the worker; nothing decoded feeds a hash or a patch.
//
// CHG-03 builds the tracer: every unit gets a `body: "file"` block in `hunks.txt`, except a
// binary one (CHG-08: `body: "none"`, no block). CHG-16
// adds the per-entry `scan` and withheld bodies, CHG-17 summary-only entries and the body
// cap, CHG-18 the stdout budget with the spill to `hunks.json`. GIT-09 adds `oldMessage` in
// `reword` mode.

const LOSSY_UTF8 = new TextDecoder('utf-8');

/**
 * Renders the hunk index (C:plan-hunks) for the units `plan --hunks` matched.
 *
 * @param {{ runDir: string, mode: string, config: { values: object },
 *   recentSubjects?: string[], oldMessage?: string }} runState `runDir`: absolute, forward slashes;
 *   `config.values`: the resolved config, `scanIgnore` included (left out here);
 *   `oldMessage`: HEAD's message, returned only in `reword` mode (C:plan-hunks).
 * @param {Array<{ id: string, path: string, oldPath: string|null, status: string,
 *   kind: string, range: string, body: Uint8Array }>} units in ID order.
 * @returns {{ stdoutObj: object, hunksTxt: string }} `stdoutObj`: exactly the C:plan-hunks
 *   output shape; `hunksTxt`: one block per unit, a `### <id> <status> <kind> <range>
 *   <path>` line then the lossily decoded body. Per entry, `offset` is the 1-based line of
 *   its `###` line and `lines` the block's line count including it. A binary unit, or a
 *   submodule unit with an empty body (a pointer change), has no block: `body: "none"`,
 *   `offset` and `lines` null.
 */
export function renderHunks(runState, units) {
  const { scanIgnore, ...values } = runState.config.values;
  const blocks = [];
  const hunks = [];
  let nextLine = 1;
  for (const unit of units) {
    // CHG-08, CHG-09: a binary unit or a submodule pointer change has no block (`body:
    // "none"`, C:plan-hunks); a file↔submodule `T` with file lines has one. CHG-10: a
    // `filtered` unit whose cleaned form is binary has no block either.
    if (
      unit.kind === 'binary'
      || (unit.kind === 'filtered' && unit.body.length === 0)
      || (unit.kind === 'submodule' && unit.body.length === 0)
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
