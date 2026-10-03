// M14 plan validator (docs/spec/modules-m14-m19.md): pure over the worker plan
// (`plan.groups.json`, C:worker-plan) and the run state (`state.json`, C:run-folder).
//
// PLN-01 builds the file-level tracer: parse the plan bytes; a missing file, bytes that are
// not UTF-8 JSON, or a value that is not the C:worker-plan shape become one lint error with
// `group: null`; each `files` path resolves to its units through the stored unit table; each
// group comes back with `n`, `header`, `body`, `fileCount`, `files` (`hunks: null`) and
// `newFiles`, the latter derived from the unit status (`A`, an untracked candidate included,
// since the temporary index marks it intent-to-add), never from the worker. PLN-02 adds
// completeness in `split` (every unit placed exactly once, in a group or in `notIncluded`, by
// ID or by a `hunks: null` path entry), real-change paths in `files` and `notIncluded`, a
// rename named by its new path only, and zero groups. A shape failure is always the only
// error of its result: the plan rules run on a parsed plan only, so a shape error is never
// mixed with plan-rule errors; RUN-16 still adds the shape marker. PLN-03 adds the hunk-level
// slice: group `hunks` IDs exist and are used once (a second naming, also in the same group or
// the same `notIncluded` entry, is a placement error), are never mixed with `files` (an ID in
// `notIncluded[].hunks` counts as `hunks`), and a `notIncluded` ID belongs to the entry's
// path; identical hunks (one stored identity key) share one placement; `files[].hunks` counts
// the path's hunks in the group. Later slices widen it:
// placement bans and `notIncluded` extras (PLN-04), `staged`/`reword` (PLN-05), message lint
// and scan (PLN-06, M6 and M8), the attribution flag and the normalised message (PLN-07).
//
// PLN-06 lints and scans each group's message. The lint `values` are `runState.config.values`
// (CFG-05: `plan` now always stores the layered, effective values there, M4 `config.mjs`
// `DEFAULT_VALUES` included, so this module keeps no default layer of its own). Scan hits
// become one error per distinct pattern ID, in first-hit order
// ("message contains `local-path`"); each carries that ID's `spans` (never the matched
// value) for M17's future redaction of the quoted message. A lint reason that quotes a
// fragment overlapping a span quotes `[<pattern-id>]` in its place, so no matched text
// reaches stdout (C:check).

import { lint, normalise, normaliseText } from './message-grammar.mjs';
import { scanText } from './scanner.mjs';

const WORKER_PLAN = 'plan.groups.json';

// The group's message as lint and the scanner see it: the header, then (when there is a
// body) a blank line and the body, run through M6 `normaliseText` (MSG-06) so a CRLF or lone
// CR an agent wrote into a JSON string, or a trailing run of blank lines, reads the same as
// its LF form. `header`/`body` are already-decoded JS strings (this file's bytes were
// decoded by `parseWorkerPlan` below via `normalise`), so there are no bytes to feed
// `normalise` itself here, and its BOM/byte-decode steps never apply — but an unpaired
// high-surrogate JSON escape (U+D800 written without a matching low surrogate) survives
// `JSON.parse` as a lone surrogate, which `normaliseText` still catches (step 2).
//
// @returns {{ ok: true, text: string } | { ok: false, reason: string }}
function messageOf(header, body) {
  const raw = body === null ? header : `${header}\n\n${body}`;
  const normalised = normaliseText(raw);
  if (!normalised.ok) return normalised;
  return { ok: true, text: normalised.text.replace(/\n$/, '') };
}

// M6's lint reasons quote three message fragments verbatim: the type, the scope and a footer
// token. One that overlaps a scan-hit span would put the matched text on stdout, so `lint` is
// given this as its `quote` callback instead of letting it embed the fragment directly
// (C:check): a fragment that overlaps a hit becomes `[<pattern-id>]`, the first overlapping
// hit's ID; any other fragment passes through unchanged. Because the callback replaces only
// the value `lint` quotes, never the fixed wording around it, there is nothing to re-parse or
// pattern-match after the fact.
function redactingQuote(message, hits) {
  return (fragment) => {
    const hit = firstOverlappingHit(fragment, message, hits);
    return hit === null ? fragment : `[${hit.patternId}]`;
  };
}

function firstOverlappingHit(fragment, message, hits) {
  for (const hit of hits) {
    for (let at = message.indexOf(fragment); at !== -1; at = message.indexOf(fragment, at + 1)) {
      if (at < hit.end && hit.start < at + fragment.length) return hit;
    }
  }
  return null;
}

// The scan hits as one entry per distinct pattern ID, in first-hit order, each with its own
// spans in hit order (C:check: one "message contains `<id>`" error per ID).
function spansByPattern(hits) {
  const byPattern = new Map();
  for (const hit of hits) {
    if (!byPattern.has(hit.patternId)) byPattern.set(hit.patternId, []);
    byPattern.get(hit.patternId).push(hit);
  }
  return byPattern;
}

/**
 * Validates the worker plan against the run state (C:check "Validates").
 *
 * @param {Uint8Array | null} planBytes the bytes of `plan.groups.json`, or `null` when the
 *   run folder holds no such regular file.
 * @param {{ mode: string, units: Array<{ id: string, path: string, oldPath?: string | null,
 *   status: string, identityKey?: string }> }} runState the parsed `state.json`.
 * @param {{ osUser?: string | null }} [options] `osUser` is the entry point's injected OS
 *   user name, passed straight through to M8 `scanText` for each message (never stored,
 *   Q10 as amended by EXE-01).
 * @returns {{ ok: true, groups: object[], notIncluded: object[], notices: string[],
 *   stored: Array<{ n: number, units: string[], header: string, body: string | null }> }
 *   | { ok: false, code: 'lint', errors: Array<{ group: number | null, reason: string,
 *   spans?: Array<{ patternId: string, start: number, end: number }> }> }}
 *   `groups`/`notIncluded`/`notices` are `check`'s output fields (C:check); `stored` is what
 *   `check` writes into `state.json` per group (with `committed: false`).
 * @throws {Error} for a part of the worker plan no slice has built yet (a mode other than
 *   `split`).
 */
export function validatePlan(planBytes, runState, options = {}) {
  if (runState.mode !== 'split') {
    throw new Error(`check in ${runState.mode} mode is not built yet (PLN-05)`);
  }
  const parsed = parseWorkerPlan(planBytes);
  if (!parsed.ok) return lintFailure([{ group: null, reason: parsed.reason }]);
  const workerPlan = parsed.value;

  const table = unitTable(runState.units);
  const placement = new Placement();
  const errors = [];
  const groups = [];
  const stored = [];
  const messageValues = runState.config.values;
  const osUser = options.osUser ?? null;
  if (mixesFilesAndHunks(workerPlan)) {
    errors.push({ group: null, reason: '`files` and `hunks` are mixed; use hunk IDs everywhere or paths everywhere' });
  }
  workerPlan.groups.forEach((group, index) => {
    const n = index + 1;
    const normalisedMessage = messageOf(group.header, group.body);
    if (!normalisedMessage.ok) {
      errors.push({ group: n, reason: normalisedMessage.reason });
    } else {
      const message = normalisedMessage.text;
      const hits = scanText(message, { osUser });
      for (const reason of lint(message, messageValues, { quote: redactingQuote(message, hits) })) {
        errors.push({ group: n, reason });
      }
      for (const [patternId, spans] of spansByPattern(hits)) {
        errors.push({ group: n, reason: `message contains \`${patternId}\``, spans });
      }
    }
    const files = [];
    const units = [];
    for (const path of new Set(group.files)) {
      const pathUnits = resolvePath(path, table, n, errors);
      if (pathUnits === null) continue;
      placement.place(pathUnits, { group: n }, path, errors);
      const { status } = pathUnits[0];
      files.push({ path, status, new: status === 'A', hunks: null });
      units.push(...pathUnits.map((unit) => unit.id));
    }
    // Hunk-level slice: one `files` entry per path, in first-ID order, counting the path's
    // hunks in this group.
    const filesByPath = new Map();
    for (const id of group.hunks) {
      const unit = table.byId.get(id);
      if (unit === undefined) {
        errors.push({ group: n, reason: `${id} is not a hunk ID of this run` });
        continue;
      }
      placement.place([unit], { group: n }, `${id} (${unit.path})`, errors);
      units.push(id);
      const file = filesByPath.get(unit.path);
      if (file !== undefined) {
        file.hunks += 1;
        continue;
      }
      const entry = { path: unit.path, status: unit.status, new: unit.status === 'A', hunks: 1 };
      filesByPath.set(unit.path, entry);
      files.push(entry);
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
  for (const entry of workerPlan.notIncluded) {
    const pathUnits = resolvePath(entry.path, table, null, errors);
    if (entry.hunks === undefined || entry.hunks === null) {
      if (pathUnits !== null) placement.place(pathUnits, { group: null }, entry.path, errors);
      continue;
    }
    for (const id of entry.hunks) {
      const unit = table.byId.get(id);
      if (unit === undefined) {
        errors.push({ group: null, reason: `${id} is not a hunk ID of this run` });
        continue;
      }
      if (unit.path !== entry.path) {
        errors.push({ group: null, reason: `${id} is a hunk of ${unit.path}, not of ${entry.path}` });
      }
      placement.place([unit], { group: null }, `${id} (${unit.path})`, errors);
    }
  }
  for (const unit of runState.units) {
    // A rename named by its old path already has its own error, which says where it goes.
    if (placement.has(unit.id) || table.namedByOldPath.has(unit.id)) continue;
    errors.push({ group: null, reason: `${unit.id} (${unit.path}) not placed; put it in a group or in notIncluded` });
  }
  for (const ids of identicalClasses(runState.units)) {
    // A member already named in a placement error has its own error saying where it goes;
    // do not also report the class as split (the cascade PLN-03's review flagged).
    if (ids.some((id) => placement.hadError(id))) continue;
    const places = new Set(ids.filter((id) => placement.has(id)).map((id) => placement.of(id)));
    if (places.size > 1) errors.push({ group: null, reason: `${listOf(ids)} are identical; place them together` });
  }
  if (errors.length > 0) return lintFailure(errors);
  return { ok: true, groups, notIncluded: [...workerPlan.notIncluded], notices: [], stored };
}

// C:check: a plan is file-level (`files`) or hunk-level (`hunks`), never both. A
// `notIncluded[].hunks` ID list counts as `hunks`; a `hunks: null` path entry is valid in
// either slice.
function mixesFilesAndHunks(workerPlan) {
  const usesFiles = workerPlan.groups.some((group) => group.files.length > 0);
  const usesHunks = workerPlan.groups.some((group) => group.hunks.length > 0)
    || workerPlan.notIncluded.some((entry) => Array.isArray(entry.hunks) && entry.hunks.length > 0);
  return usesFiles && usesHunks;
}

// The stored unit table indexed for path resolution: units by path, by ID, and the rename
// units by their old path (C:worker-plan: a rename is named by its new path only).
function unitTable(units) {
  const byPath = new Map();
  const byOldPath = new Map();
  const byId = new Map();
  for (const unit of units) {
    byId.set(unit.id, unit);
    pushTo(byPath, unit.path, unit);
    if (unit.status === 'R' && typeof unit.oldPath === 'string') pushTo(byOldPath, unit.oldPath, unit);
  }
  return { byPath, byOldPath, byId, namedByOldPath: new Set() };
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// Resolves a path named in `files` or `notIncluded` to its units, or records why it cannot:
// the old path of a rename, or a path that is not a change. `group` is the group number, or
// `null` for a `notIncluded` entry.
function resolvePath(path, table, group, errors) {
  const pathUnits = table.byPath.get(path);
  if (pathUnits !== undefined) return pathUnits;
  const renames = table.byOldPath.get(path);
  if (renames !== undefined) {
    for (const unit of renames) table.namedByOldPath.add(unit.id);
    errors.push({ group, reason: `use the new path ${renames[0].path} for the rename of ${path}` });
    return null;
  }
  errors.push({ group, reason: `${path} is not a change` });
  return null;
}

// Where each unit is placed (C:check completeness): a group number, or `null` for
// `notIncluded`. A second placement of a unit is one error per naming (a path, or an ID).
class Placement {
  #where = new Map();
  #errored = new Set();

  has(id) {
    return this.#where.has(id);
  }

  // The unit's group number, or `null` for `notIncluded`.
  of(id) {
    return this.#where.get(id);
  }

  // Whether this unit was already named in a placement error (as the earlier naming or the
  // repeat). Used to skip the identical-hunks check for a class that already has its own
  // placement error, so one mistake does not cascade into a second, derived error.
  hadError(id) {
    return this.#errored.has(id);
  }

  place(units, { group }, label, errors) {
    const earlier = units.find((unit) => this.#where.has(unit.id));
    if (earlier !== undefined) {
      const before = this.#where.get(earlier.id);
      const places = before === group
        ? `${describePlace(group)} twice`
        : `${describePlace(before)} and ${describePlace(group)}`;
      errors.push({ group, reason: `${label} is in ${places}; place it once` });
      for (const unit of units) this.#errored.add(unit.id);
    }
    for (const unit of units) {
      if (!this.#where.has(unit.id)) this.#where.set(unit.id, group);
    }
  }
}

// The IDs of every class of identical hunks (C:check: same path, same `-` / `+` lines, i.e.
// one stored identity key) with more than one member, each in unit-table order.
function identicalClasses(units) {
  const byKey = new Map();
  for (const unit of units) {
    if (typeof unit.identityKey === 'string') pushTo(byKey, unit.identityKey, unit.id);
  }
  return [...byKey.values()].filter((ids) => ids.length > 1);
}

// "h3 and h5", "h1, h3 and h5".
function listOf(ids) {
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

function describePlace(group) {
  return group === null ? 'notIncluded' : `group ${group}`;
}

function lintFailure(errors) {
  return { ok: false, code: 'lint', errors };
}

// Parses the plan bytes into the C:worker-plan shape, or names the first way it fails. Every
// failure here is a shape error (`group: null`), which M15 `onLintFailure` later tells apart
// from the other lint errors (RUN-16). The bytes go through M6 `normalise` (MSG-06, Q9)
// before `JSON.parse`: a UTF-8 BOM is stripped, a UTF-16 BOM selects that decoder, and
// invalid UTF-8 fails here with `normalise`'s own reason (`message not UTF-8`) instead of a
// generic "not valid UTF-8".
function parseWorkerPlan(planBytes) {
  if (planBytes === null) {
    return { ok: false, reason: `${WORKER_PLAN} is missing; write it in the run folder, then run check again` };
  }
  const normalised = normalise(planBytes);
  if (!normalised.ok) return { ok: false, reason: normalised.reason };
  const text = normalised.text;
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
// string `path` and a `hunks` that is null or a string array, when present. Returns the
// first violation, or `null`.
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
      if (entry.hunks !== undefined && entry.hunks !== null && !isStringArray(entry.hunks)) {
        return `notIncluded[${index}].hunks must be null or an array of hunk IDs`;
      }
    }
  }
  return null;
}
