// M14 plan validator (docs/spec/modules-m14-m19.md): pure over the worker plan
// (`plan.groups.json`, C:worker-plan) and the run state (`state.json`, C:run-folder).
//
// PLN-01 builds the file-level tracer: parse the plan bytes; a missing file, bytes that are
// not UTF-8 JSON, or a value that is not the C:worker-plan shape become one lint error with
// `group: null`; each `files` path resolves to its units through the stored unit table; each
// group comes back with `n`, `header`, `body`, `fileCount`, `files` (`hunks: null`) and
// `newFiles`, the latter derived from the unit status (`A`, an untracked candidate included,
// since the temporary index marks it intent-to-add), never from the worker. Later slices
// widen it: completeness and rename paths (PLN-02), hunk IDs and identical hunks (PLN-03),
// placement bans and `notIncluded` extras (PLN-04), `staged`/`reword` (PLN-05), message lint
// and scan (PLN-06, M6 and M8), the attribution flag and the normalised message (PLN-07).

const WORKER_PLAN = 'plan.groups.json';

/**
 * Validates the worker plan against the run state (C:check "Validates").
 *
 * @param {Uint8Array | null} planBytes the bytes of `plan.groups.json`, or `null` when the
 *   run folder holds no such regular file.
 * @param {{ mode: string, units: Array<{ id: string, path: string, status: string }> }}
 *   runState the parsed `state.json`.
 * @param {{ osUser?: string }} [options] the entry point's injected OS user (unused until
 *   PLN-07's attribution flag).
 * @returns {{ ok: true, groups: object[], notIncluded: object[], notices: string[],
 *   stored: Array<{ n: number, units: string[], header: string, body: string | null }> }
 *   | { ok: false, code: 'lint', errors: Array<{ group: number | null, reason: string }> }}
 *   `groups`/`notIncluded`/`notices` are `check`'s output fields (C:check); `stored` is what
 *   `check` writes into `state.json` per group (with `committed: false`).
 * @throws {Error} for a part of the worker plan no slice has built yet (hunk IDs, a mode
 *   other than `split`).
 */
export function validatePlan(planBytes, runState, options = {}) {
  if (runState.mode !== 'split') {
    throw new Error(`check in ${runState.mode} mode is not built yet (PLN-05)`);
  }
  const parsed = parseWorkerPlan(planBytes);
  if (!parsed.ok) return lintFailure([{ group: null, reason: parsed.reason }]);
  const workerPlan = parsed.value;

  const unitsByPath = new Map();
  for (const unit of runState.units) {
    const list = unitsByPath.get(unit.path);
    if (list === undefined) unitsByPath.set(unit.path, [unit]);
    else list.push(unit);
  }

  const errors = [];
  const groups = [];
  const stored = [];
  workerPlan.groups.forEach((group, index) => {
    const n = index + 1;
    if (group.hunks.length > 0) throw new Error('hunk-level worker plans are not built yet (PLN-03)');
    const files = [];
    const units = [];
    for (const path of new Set(group.files)) {
      const pathUnits = unitsByPath.get(path);
      if (pathUnits === undefined) {
        // PLN-02 owns the full path rules (renames by their new path, a path in two groups).
        errors.push({ group: n, reason: `${path} is not a change` });
        continue;
      }
      const { status } = pathUnits[0];
      files.push({ path, status, new: status === 'A', hunks: null });
      units.push(...pathUnits.map((unit) => unit.id));
    }
    groups.push({
      n,
      header: group.header,
      body: group.body,
      fileCount: files.length,
      files,
      newFiles: files.filter((file) => file.new).map((file) => file.path),
    });
    stored.push({ n, units, header: group.header, body: group.body });
  });
  if (errors.length > 0) return lintFailure(errors);
  return { ok: true, groups, notIncluded: [...workerPlan.notIncluded], notices: [], stored };
}

function lintFailure(errors) {
  return { ok: false, code: 'lint', errors };
}

// Parses the plan bytes into the C:worker-plan shape, or names the first way it fails. Every
// failure here is a shape error (`group: null`), which M15 `onLintFailure` later tells apart
// from the other lint errors (RUN-16).
function parseWorkerPlan(planBytes) {
  if (planBytes === null) {
    return { ok: false, reason: `${WORKER_PLAN} is missing; write it in the run folder, then run check again` };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(planBytes);
  } catch {
    return { ok: false, reason: `${WORKER_PLAN} is not valid UTF-8` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${WORKER_PLAN} is not valid JSON: ${err.message}` };
  }
  const shapeError = workerPlanShapeError(value);
  if (shapeError !== null) return { ok: false, reason: `${WORKER_PLAN}: ${shapeError}` };
  return {
    ok: true,
    value: {
      groups: value.groups.map((group) => ({
        header: group.header,
        body: group.body ?? null,
        files: group.files ?? [],
        hunks: group.hunks ?? [],
      })),
      notIncluded: value.notIncluded ?? [],
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// The C:worker-plan shape: an object with a `groups` array; `version` 1 and `source`
// `worker`/`user` when present; per group a string `header`, a string or null `body`, and
// string arrays `files` and `hunks` when present; `notIncluded` an array of objects with a
// string `path` when present. Returns the first violation, or `null`.
function workerPlanShapeError(value) {
  if (!isObject(value)) return 'expected a JSON object';
  if (value.version !== undefined && value.version !== 1) return '`version` must be 1';
  if (value.source !== undefined && value.source !== 'worker' && value.source !== 'user') {
    return '`source` must be "worker" or "user"';
  }
  if (!Array.isArray(value.groups)) return '`groups` must be an array';
  for (const [index, group] of value.groups.entries()) {
    const where = `groups[${index}]`;
    if (!isObject(group)) return `${where} must be an object`;
    if (typeof group.header !== 'string') return `${where}.header must be a string`;
    if (group.body !== undefined && group.body !== null && typeof group.body !== 'string') {
      return `${where}.body must be a string or null`;
    }
    if (group.files !== undefined && !isStringArray(group.files)) return `${where}.files must be an array of paths`;
    if (group.hunks !== undefined && !isStringArray(group.hunks)) return `${where}.hunks must be an array of hunk IDs`;
  }
  if (value.notIncluded !== undefined) {
    if (!Array.isArray(value.notIncluded)) return '`notIncluded` must be an array';
    for (const [index, entry] of value.notIncluded.entries()) {
      if (!isObject(entry) || typeof entry.path !== 'string') {
        return `notIncluded[${index}] must be an object with a string path`;
      }
    }
  }
  return null;
}
