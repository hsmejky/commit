// M4 Config loader (docs/spec/modules-m1-m9.md, Q6, C:plan): reads the config layers.
// Effectful: reads the layer files directly, and spawns two read-only git calls (`git ls-tree`,
// then `git cat-file blob`) for the repo layer's `scanIgnore` at HEAD (CFG-07).
//
// CFG-02 builds the tracer: only the repo layer, read straight from the worktree (never git),
// and only its JSON parseability. Unparseable JSON is a `config` error naming the repo layer
// (Q6); a missing file is no layer at all, so `plan` goes on with the defaults. CFG-03 adds
// the pure `validateLayer`, checked against the parsed repo layer: a non-object top level, a
// wrong JSON type, an out-of-range or non-integer number, or a bad or empty `types` array
// (Q6, stories 106 and 110). CFG-04 adds the user layer, read from `commit.json` directly
// under the Claude home the entry point resolves once and injects (`CLAUDE_CONFIG_DIR`, else
// `.claude` in the OS home, Q5): it goes through the same read/decode/parse/validate pipeline
// as the repo layer (now shared as `readLayer`), and an invalid user layer refuses `plan`
// the same way, naming the user layer instead of the repo layer. Reading the user layer
// never depends on being inside a worktree, unlike the repo layer: `toplevel` is nullable so
// a caller outside a usable repo still gets the user-layer check (C:plan step 2 puts
// `config` ahead of `state`). CFG-05 adds the per-key override, `effectiveConfig` and its
// `DEFAULT_VALUES` (repo beats user beats default, arrays replaced whole). CFG-06 adds
// warnings for unknown keys and values and for a repo-only key in the user layer. CFG-07
// adds `scanIgnore`: `validateLayer` compiles each pattern with M7 `compileGlob` (so the
// worktree layer refuses a bad one), but the effective value is read from the repo config
// at HEAD only (`git ls-tree`, then `git cat-file blob`; none when unborn), sourced
// `repo@HEAD`; an invalid value there
// is `[]` plus a warning, never a refusal (Q6, Q10 as amended by CFG-01).

import fs from 'node:fs';
import path from 'node:path';
import { compileGlob } from './glob-matcher.mjs';
import { run } from './process-adapter.mjs';

/** The repo config layer's path under the toplevel (Q6). */
export const REPO_CONFIG_PATH = '.claude/commit.json';

/**
 * Whether a repo-relative path (forward slashes) is the repo config layer's file, so M8 and
 * M18 never spell the path themselves (M4). Exact, case-sensitive equality: only the
 * toplevel's `.claude/commit.json` is the repo layer.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isRepoConfigPath(filePath) {
  return filePath === REPO_CONFIG_PATH;
}

/** The user config layer's filename, directly under the Claude home (Q5, Q6, public surface). */
export const USER_CONFIG_FILENAME = 'commit.json';

/** A `types` entry: lowercase, starting with a letter (Q6). */
const TYPE_ENTRY_PATTERN = /^[a-z][a-z0-9-]*$/;

/** `maxSubjectLength`'s range: code points of the whole header (Q6). */
const MIN_SUBJECT_LENGTH = 20;
const MAX_SUBJECT_LENGTH = 200;

/** Keys whose only CFG-03 check is "must be a string" (enum membership is CFG-06's warning). */
const STRING_KEYS = ['scope', 'body', 'subjectCase'];

/**
 * The allowed values of a known, well-typed key whose string value can still be unknown
 * (Q6, CFG-06): a future `body: "required"` is the motivating case. `types` and
 * `maxSubjectLength` have no such list (their CFG-03 range/shape check is the only one);
 * `scanIgnore`'s patterns are checked by M7 `compileGlob` in `validateLayer` (CFG-07).
 */
const ENUM_VALUES = Object.freeze({
  scope: Object.freeze(['forbidden', 'optional', 'required']),
  body: Object.freeze(['forbidden', 'optional']),
  subjectCase: Object.freeze(['lower', 'any']),
});

/** Keys allowed only in the repo layer (Q6): a personal file cannot silence a team's scan. */
const REPO_ONLY_KEYS = Object.freeze(['scanIgnore']);

/**
 * The tail of a glob error's message (C:scanignore-globs): M7 `compileGlob` reports only
 * `config`, so the message lists the rules a pattern must meet.
 */
const GLOB_RULES = "is not a supported glob: no braces, classes, '!', '\\', '..' or empty "
  + "segments, '**' only as a whole segment, and at least one literal character";

/** A shallow copy of a layer object without `REPO_ONLY_KEYS` (CFG-07, `readLayer`). */
function withoutRepoOnlyKeys(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  const copy = { ...obj };
  for (const key of REPO_ONLY_KEYS) delete copy[key];
  return copy;
}

/**
 * Computes CFG-06's warnings for one already-validated (error-free) layer object, and a
 * sanitized copy with every warned key removed, so `effectiveConfig`'s existing per-key
 * fallback (repo, then user, then default) applies to it unchanged: removing a key from a
 * layer is exactly "ignored, falls back to the next layer" (Q6). Three cases, none of them
 * an error: a key `effectiveConfig` never reads (not in `DEFAULT_VALUES`); a known, repo-only
 * key given in the user layer (`scanIgnore`, Q6, story 107); and a known key's well-typed
 * string value outside its enum (`ENUM_VALUES`). Pure: no file reads, no ambient state.
 *
 * @param {object} obj the parsed, already-validated layer object (never null/non-object:
 *   `validateLayer` already refused that case as an error).
 * @param {string} layer the layer's display label (same wording `validateLayer` uses).
 * @param {'user' | 'repo'} kind the layer's identity, to check `REPO_ONLY_KEYS` against
 *   (CFG-06 forward note: `validateLayer`'s `layer` string names the layer for messages only,
 *   never its identity, so the wrong-layer check needs this separate parameter).
 * @returns {{ warnings: string[], sanitized: object }}
 */
function collectConfigWarnings(obj, layer, kind) {
  const warnings = [];
  const sanitized = { ...obj };
  for (const key of Object.keys(sanitized)) {
    if (!Object.hasOwn(DEFAULT_VALUES, key)) {
      warnings.push(`the ${layer} key '${key}' is unknown; ignored`);
      delete sanitized[key];
      continue;
    }
    if (REPO_ONLY_KEYS.includes(key) && kind !== 'repo') {
      warnings.push(`the ${layer} key '${key}' is only valid in the repo layer; ignored`);
      delete sanitized[key];
      continue;
    }
    if (Object.hasOwn(ENUM_VALUES, key) && !ENUM_VALUES[key].includes(sanitized[key])) {
      warnings.push(`the ${layer} value ${JSON.stringify(sanitized[key])} for ${key} is unknown; ignored`);
      delete sanitized[key];
    }
  }
  return { warnings, sanitized };
}

// Exported only so `validateLayer`'s own static purity test (tests/config.test.js) can read
// this helper's source directly: M4 itself is effectful (this file imports `fs` and `path`
// at module level), so the whole-module `assertPureSource` helper other pure modules use
// cannot run against `config.mjs`, and `Function.prototype.toString()` never follows a call
// into another function's body (review-CFG-03 finding 1).
export function describeType(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

// `JSON.stringify` prints out-of-range numbers that parsed to `Infinity` or `-Infinity` as
// `null` (e.g. `"maxSubjectLength": 1e400`), which would make the message read "... not
// null" for a value that is very much not null (review-CFG-03 finding 4). Every other value
// JSON.stringify prints is accurate for a message.
function describeValue(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/**
 * Validates a parsed config layer's value domains (Q6, stories 106 and 110): a non-object
 * top level, a wrong JSON type, an out-of-range or non-integer number, or a bad or empty
 * `types` array. Pure: no file reads, no ambient state, so a caller that already has a
 * layer's parsed value (M19 `configFor`) can validate it without going through `loadConfig`.
 * Unknown keys, an unknown value of a known key, and a key in the wrong layer are CFG-06's
 * warnings, not this function's errors. `scanIgnore` must be an array of strings, each
 * compiled by M7 `compileGlob` here (CFG-07, C:scanignore-globs), so a caller validating a
 * layer directly also catches a bad glob: one error per failing pattern, naming it. The
 * user layer is validated without `scanIgnore` (`readLayer`), since there it is CFG-06's
 * wrong-layer warning whatever its value.
 *
 * Collects every applicable error in one pass rather than stopping at the first, so a
 * caller that reports more than one problem at once (M19 `configFor`, and the glob errors
 * alongside the others) can do so without a second pass over the same layer
 * (review-CFG-03 finding 2; shape matches `docs/contracts/infer.md`'s `{ errors }`).
 *
 * @param {unknown} obj the parsed JSON value of a config layer.
 * @param {string} layer names the layer in every error message (e.g. `repo config
 *   (.claude/commit.json)`), matching `loadConfig`'s existing wording.
 * @returns {{ errors: string[] } | null} every error found, or `null` when every known key
 *   present is well-typed and in range.
 */
export function validateLayer(obj, layer) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { errors: [`the ${layer} top level must be a JSON object, not ${describeType(obj)}`] };
  }

  const errors = [];

  if (Object.hasOwn(obj, 'maxSubjectLength')) {
    const value = obj.maxSubjectLength;
    const inRange = typeof value === 'number' && Number.isInteger(value)
      && value >= MIN_SUBJECT_LENGTH && value <= MAX_SUBJECT_LENGTH;
    if (!inRange) {
      errors.push(
        `the ${layer} maxSubjectLength must be an integer between ${MIN_SUBJECT_LENGTH} `
          + `and ${MAX_SUBJECT_LENGTH}, not ${describeValue(value)}`,
      );
    }
  }

  if (Object.hasOwn(obj, 'types')) {
    const value = obj.types;
    const wellFormed = Array.isArray(value) && value.length > 0
      && value.every((entry) => typeof entry === 'string' && TYPE_ENTRY_PATTERN.test(entry));
    if (!wellFormed) {
      errors.push(
        `the ${layer} types must be a non-empty array of lowercase type names, each starting `
          + `with a letter (^[a-z][a-z0-9-]*$), not ${JSON.stringify(value)}`,
      );
    }
  }

  for (const key of STRING_KEYS) {
    if (Object.hasOwn(obj, key) && typeof obj[key] !== 'string') {
      errors.push(`the ${layer} ${key} must be a string, not ${JSON.stringify(obj[key])}`);
    }
  }

  if (Object.hasOwn(obj, 'scanIgnore')) {
    const value = obj.scanIgnore;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      errors.push(`the ${layer} scanIgnore must be an array of strings, not ${JSON.stringify(value)}`);
    } else {
      for (const pattern of value) {
        if (!compileGlob(pattern).ok) {
          errors.push(`the ${layer} scanIgnore pattern ${JSON.stringify(pattern)} ${GLOB_RULES}`);
        }
      }
    }
  }

  return errors.length > 0 ? { errors } : null;
}

// A config layer's file (user or repo) is small and hand-written; a few KB is generous, same
// style as the run-lock read (`run.mjs` `LOCK_MAX_BYTES`). Checked before the read so an oversized file,
// or a non-regular one (a symlink to a device file or a FIFO would otherwise hang or exhaust
// memory, review-CFG-02 finding 10), is never opened.
const CONFIG_MAX_BYTES = 65536;

/**
 * Decodes a config file's raw bytes into its parsed JSON value, shared by `readLayer` and the
 * HEAD read (review-CFG-07 finding 6). Does not check the value's shape: that is each
 * caller's next step.
 *
 * @param {Buffer} buffer the file's raw bytes.
 * @param {string} label the file's display label, named in `problem`.
 * @returns {{ value: unknown } | { problem: string }} `problem`: a message naming `label`.
 */
function decodeLayerBytes(buffer, label) {
  let text;
  try {
    // A fatal-mode decoder catches invalid UTF-8 cheaply and rejects it as unparseable,
    // instead of Node's default `readFileSync(..., 'utf8')`, which silently replaces bad
    // bytes with U+FFFD (Q6, review-CFG-02 finding 4). It also strips a leading UTF-8 BOM
    // (U+FEFF) the same way Node's own JSON file parsing does, so a file saved with a BOM by
    // Windows PowerShell 5.1 or Notepad still parses (Q6, review-CFG-02 finding 2).
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { problem: `the ${label} is not valid UTF-8` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    // The parser's own message carries the position, which helps find the typo (story 110,
    // review-CFG-02 finding 3).
    return { problem: `the ${label} is not valid JSON: ${err.message}` };
  }
}

/**
 * Reads and validates one config layer's file: the read/decode/parse/`validateLayer`
 * pipeline shared by the user and repo layers (CFG-04), each named only by their path and
 * display label. A missing file is no layer at all, not an error (Q6).
 *
 * @param {string} filePath absolute path to the layer's file.
 * @param {string} layer the layer's display label (used in every message, and passed to
 *   `validateLayer` so a key error names the same layer).
 * @param {'user' | 'repo'} kind the layer's identity (CFG-06: `collectConfigWarnings`'
 *   wrong-layer check).
 * @returns {{ error: string } | { value: object | null, warnings: string[] }} `value: null`
 *   when the file is absent; otherwise the parsed, validated and CFG-06-sanitized layer
 *   object. `error` names `layer`.
 */
function readLayer(filePath, layer, kind) {
  let stats;
  try {
    // Follows a link (read only, never write), so a link to a huge file or a FIFO is caught
    // the same as one in place directly (review-CFG-02 finding 10).
    stats = fs.statSync(filePath);
  } catch (err) {
    // No layer at all: no config, no error (Q6, CFG-02 seam "a repo with no config file gets
    // no `config` refusal"). ENOTDIR: a path component (e.g. the repo layer's `.claude`, or
    // the user layer's Claude home) is a file, which is just as absent a layer as ENOENT.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: null, warnings: [] };
    // EACCES, EPERM, ELOOP and the like: the layer exists but cannot be inspected. A `config`
    // refusal naming the layer, not an uncaught throw ending as `internal`
    // (review-CFG-02 finding 1).
    return { error: `the ${layer} cannot be read (${err.code})` };
  }

  // A directory (e.g. `mkdir .claude/commit.json`), a device, socket or FIFO: never a valid
  // config file, and never opened (review-CFG-02 finding 1's EISDIR case, finding 10).
  if (!stats.isFile()) {
    return { error: `the ${layer} is not a regular file` };
  }
  if (stats.size > CONFIG_MAX_BYTES) {
    return { error: `the ${layer} is larger than ${CONFIG_MAX_BYTES} bytes` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    // The layer vanished, or turned unreadable, between the stat and the read.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: null, warnings: [] };
    return { error: `the ${layer} cannot be read (${err.code})` };
  }

  const decoded = decodeLayerBytes(buffer, layer);
  if (decoded.problem !== undefined) return { error: decoded.problem };
  const parsed = decoded.value;
  // CFG-03: a non-object top level, a wrong JSON type, an out-of-range number or a bad
  // `types` array is a `config` error naming the layer and the key (Q6, review-CFG-02
  // finding 5: CFG-02 was JSON-parseability only). `validateLayer` collects every error it
  // finds; this reports the first, same as `loadConfig` did before CFG-03 collected every
  // error (review-CFG-03 finding 2).
  // CFG-07 (review-CFG-06 finding 6): outside the repo layer a repo-only key is CFG-06's
  // wrong-layer warning whatever its value, so it is left out of validation here (a bad
  // user-layer `scanIgnore` must not refuse) but kept for `collectConfigWarnings` below.
  const result = validateLayer(kind === 'repo' ? parsed : withoutRepoOnlyKeys(parsed), layer);
  if (result) return { error: result.errors[0] };
  // CFG-06: unknown keys, an unknown value of a known key, and a known, repo-only key given
  // in the wrong layer warn and fall back instead of refusing (Q6); `sanitized` is `parsed`
  // with every warned key removed, so `effectiveConfig`'s existing per-key fallback applies.
  const { warnings, sanitized } = collectConfigWarnings(parsed, layer, kind);
  return { value: sanitized, warnings };
}

/** The repo layer's display label, matching `REPO_CONFIG_PATH`. Exported so M19 `configFor`
 * (INF-07) calls `validateLayer` with the same label `readLayer` itself uses. */
export const REPO_LAYER = `repo config (${REPO_CONFIG_PATH})`;

/** The user layer's display label, matching `USER_CONFIG_FILENAME`. Exported for the same
 * reason as `REPO_LAYER`. */
export const USER_LAYER = `user config (${USER_CONFIG_FILENAME})`;

/**
 * Q6's defaults (commitlint `config-conventional` types, no scope, no body, 72 code points,
 * lowercase, no `scanIgnore` patterns), used by `effectiveConfig` for whichever key neither
 * layer sets. The sole default layer: nothing else in the codebase should duplicate these
 * values (CFG-05 forward note, review-PLN-06 finding 6).
 */
export const DEFAULT_VALUES = Object.freeze({
  types: Object.freeze([
    'build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test',
  ]),
  scope: 'forbidden',
  body: 'forbidden',
  maxSubjectLength: 72,
  subjectCase: 'lower',
  scanIgnore: Object.freeze([]),
});

/**
 * Computes the effective config values and their sources (CFG-05, Q6): per key, the repo
 * layer wins over the user layer wins over the default; arrays are replaced whole, never
 * merged. Pure: no file reads, so a caller with already-parsed layers (M19 `configFor`)
 * could use it without going through `loadConfig`. Here `scanIgnore` is just another
 * repo-or-user-or-default key; `loadConfig` then replaces its value and source with the
 * read at HEAD (CFG-07), so the worktree's copy is validated but never effective.
 *
 * @param {{ user: object | null, repo: object | null }} layers the parsed, already-validated
 *   layer objects (`null` when that layer is absent).
 * @returns {{ values: object, sources: object }} `sources` values are `default`, `user` or
 *   `repo` (C:plan `config.sources`).
 */
export function effectiveConfig({ user, repo }) {
  const values = {};
  const sources = {};
  for (const key of Object.keys(DEFAULT_VALUES)) {
    if (repo !== null && Object.hasOwn(repo, key)) {
      values[key] = repo[key];
      sources[key] = 'repo';
    } else if (user !== null && Object.hasOwn(user, key)) {
      values[key] = user[key];
      sources[key] = 'user';
    } else {
      values[key] = DEFAULT_VALUES[key];
      sources[key] = 'default';
    }
  }
  return { values, sources };
}

/**
 * Loads the config layers: the user layer, read from `commit.json` directly under the
 * Claude home (CFG-04, Q5, Q6), then, when `toplevel` names a worktree, the repo layer, read
 * from `.claude/commit.json` under it (CFG-02); on success, folds both into the effective
 * values and sources (CFG-05 `effectiveConfig`), over each layer already sanitized of
 * CFG-06's warned keys (unknown key, unknown value of a known key, a known repo-only key
 * given in the user layer). CFG-07: `scanIgnore`'s value and source then come from the repo
 * config at HEAD only (`readScanIgnoreAtHead`), never from the worktree copy (Q10).
 *
 * @param {{ toplevel: string | null, claudeHome: string, unborn?: boolean, env?: object,
 *   now?: () => number }} options `toplevel`: the working tree's toplevel (M3), or `null`
 *   when `plan` is not inside one (the user layer is still read and validated: C:plan step 2
 *   puts `config` ahead of `state`). `claudeHome`: the Claude home the entry point resolved
 *   once and injected (`CLAUDE_CONFIG_DIR`, else `.claude` in the OS home, Q5). `unborn`
 *   (M3 `headState`): no HEAD to read `scanIgnore` from. `env`, `now`: for the HEAD read's
 *   git call (M2 `run`), required when `toplevel` is set and `unborn` is not.
 * @returns {Promise<{ error: string } | { values: object, sources: object,
 *   warnings: string[], scanIgnore: object[] }>} `error` names whichever layer errored first
 *   (user, then repo, matching Q6's layer order) (C:cli-and-exit-codes); otherwise the
 *   effective config (CFG-05), even with neither layer present (every source `default`),
 *   plus every warning from either layer, user first, then the HEAD read's (`plan.warnings`,
 *   C:plan), and `scanIgnore`: the M7 matchers compiled from `values.scanIgnore`.
 */
export async function loadConfig({ toplevel, claudeHome, unborn = false, env, now }) {
  const userResult = readLayer(path.join(claudeHome, USER_CONFIG_FILENAME), USER_LAYER, 'user');
  if (userResult.error !== undefined) return { error: userResult.error };

  let repoValue = null;
  let repoWarnings = [];
  if (toplevel !== null && toplevel !== undefined) {
    const repoResult = readLayer(path.join(toplevel, REPO_CONFIG_PATH), REPO_LAYER, 'repo');
    if (repoResult.error !== undefined) return { error: repoResult.error };
    repoValue = repoResult.value;
    repoWarnings = repoResult.warnings;
  }

  const { values, sources } = effectiveConfig({ user: userResult.value, repo: repoValue });
  const head = toplevel !== null && toplevel !== undefined && !unborn
    ? await readScanIgnoreAtHead({ toplevel, env, now })
    : NO_HEAD_PATTERNS;
  // The worktree copy (validated above) never reaches the effective value; with no valid
  // value read at HEAD, the default applies, sourced `default` like any key no layer sets.
  values.scanIgnore = head.patterns ?? DEFAULT_VALUES.scanIgnore;
  sources.scanIgnore = head.patterns === null ? 'default' : 'repo@HEAD';
  const warnings = [...userResult.warnings, ...repoWarnings];
  if (head.warning !== null) warnings.push(head.warning);
  return { values, sources, warnings, scanIgnore: head.matchers };
}

/**
 * Reads one config layer's raw JSON value straight off disk, with none of `readLayer`'s
 * `validateLayer` check or CFG-06 sanitisation (`readLayers`, INF-07): the caller runs
 * `validateLayer` on the raw value itself, before merging anything into it, and an unknown
 * key (or a known, repo-only key in the wrong layer) survives untouched, since `readLayers`
 * only reports what is on disk now.
 *
 * @param {string} filePath absolute path to the layer's file.
 * @param {string} layer the layer's display label (used in the `error` message only).
 * @returns {{ value: unknown } | { error: string }} `value: {}` when the file is absent (no
 *   layer at all, same as `readLayer`, Q6).
 */
function readRawLayer(filePath, layer) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: {} };
    return { error: `the ${layer} cannot be read (${err.code})` };
  }
  if (!stats.isFile()) {
    return { error: `the ${layer} is not a regular file` };
  }
  if (stats.size > CONFIG_MAX_BYTES) {
    return { error: `the ${layer} is larger than ${CONFIG_MAX_BYTES} bytes` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: {} };
    return { error: `the ${layer} cannot be read (${err.code})` };
  }

  const decoded = decodeLayerBytes(buffer, layer);
  if (decoded.problem !== undefined) return { error: decoded.problem };
  return { value: decoded.value };
}

/**
 * Reads both config layers' raw current content for M19 `configFor` (INF-07, C:infer): the
 * user layer directly under the Claude home, the repo layer from the worktree (never HEAD,
 * unlike `scanIgnore`'s effective value) -- no validation, no CFG-06 sanitisation, since
 * `configFor` merges the proposal's keys into this raw value and checks the result itself
 * with `validateLayer`.
 *
 * @param {{ toplevel: string, claudeHome: string }} options
 * @returns {{ repo: { value: unknown } | { error: string }, user: { value: unknown } |
 *   { error: string } }}
 */
export function readLayers({ toplevel, claudeHome }) {
  return {
    repo: readRawLayer(path.join(toplevel, REPO_CONFIG_PATH), REPO_LAYER),
    user: readRawLayer(path.join(claudeHome, USER_CONFIG_FILENAME), USER_LAYER),
  };
}

/** The HEAD read's result when there is nothing to read (no worktree, unborn, no file or key). */
const NO_HEAD_PATTERNS = Object.freeze({ patterns: null, matchers: Object.freeze([]), warning: null });

/** The repo config at HEAD's display label, for the HEAD read's warnings. */
const HEAD_LAYER = `repo config at HEAD (${REPO_CONFIG_PATH})`;

/**
 * Reads `scanIgnore` from the repo config at HEAD (CFG-07, Q10 as amended by CFG-01): two
 * read-only git calls (C:plan `config.sources`). `git ls-tree -l` first, so only the tree
 * is read: an empty listing is a file absent at HEAD; otherwise its type and size are checked
 * before the blob is read by its object name with `git cat-file blob`, so an oversized
 * blob is never read, like `readLayer`'s stat before its read (review-CFG-07 finding 4).
 * Both outputs are machine-readable, never git's localized messages (finding 3). The file
 * at HEAD is not validated as a layer: only its `scanIgnore` is read, decoded the same way
 * `readLayer` decodes a layer file (`decodeLayerBytes`). A file or key absent at HEAD is
 * no patterns, silently (Q6); anything else that yields no valid value (not a regular file,
 * over `CONFIG_MAX_BYTES`, a failed git call or corrupt blob, not UTF-8, not valid JSON,
 * not an object, not an array of strings, or a pattern M7 `compileGlob` rejects) is no
 * patterns plus a warning naming the repo config at HEAD, never a `config` refusal: `[]`
 * exempts nothing (fail-closed), and the worktree copy is still validated as a layer.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<{ patterns: string[] | null, matchers: object[], warning: string | null }>}
 *   `patterns: null` when no valid `scanIgnore` was read (the default `[]` applies).
 */
async function readScanIgnoreAtHead({ toplevel, env, now }) {
  const invalid = (problem) => ({
    patterns: null,
    matchers: Object.freeze([]),
    warning: `${problem}; its scanIgnore is ignored ([] used)`,
  });
  // `code` is `null` when the child was killed by a signal rather than exiting (`run`'s
  // `close` handler, `process-adapter.mjs`), so that case is named instead of printed as
  // "git exited null".
  const failed = (code) => invalid(
    code === null
      ? `the ${HEAD_LAYER} could not be read (git was killed)`
      : `the ${HEAD_LAYER} could not be read (git exited ${code})`,
  );

  // `-z`: `<mode> SP <type> SP <object> SP+ <size> TAB <path> NUL`; `<size>` is `-` for a
  // non-blob, and not a number when the blob cannot be read (a corrupt object).
  const listing = await run('git', ['ls-tree', '-l', '-z', 'HEAD', '--', REPO_CONFIG_PATH], {
    cwd: toplevel, env, now, readOnly: true,
  });
  if (listing.code !== 0) return failed(listing.code);
  const entry = listing.stdout.toString('utf8');
  // Not committed yet: no layer at all, like an absent file (Q6).
  if (entry === '') return NO_HEAD_PATTERNS;
  const fields = /^(\d+) (\S+) ([0-9a-f]+) +(\S+)\t/.exec(entry);
  if (fields === null) {
    return invalid(`the ${HEAD_LAYER} could not be read (unexpected git ls-tree output)`);
  }
  const [, mode, type, object, size] = fields;
  // A directory, a gitlink, or a symlink (its blob is the link target, not the file).
  if (type !== 'blob' || mode === '120000') {
    return invalid(`the ${HEAD_LAYER} is not a regular file`);
  }
  if (!/^\d+$/.test(size)) {
    return invalid(`the ${HEAD_LAYER} could not be read (its blob is unreadable)`);
  }
  if (Number(size) > CONFIG_MAX_BYTES) {
    return invalid(`the ${HEAD_LAYER} is larger than ${CONFIG_MAX_BYTES} bytes`);
  }

  // By object name, so the blob read is the one just listed even if HEAD moves meanwhile.
  const blob = await run('git', ['cat-file', 'blob', object], {
    cwd: toplevel, env, now, readOnly: true,
  });
  if (blob.code !== 0) return failed(blob.code);

  const decoded = decodeLayerBytes(blob.stdout, HEAD_LAYER);
  if (decoded.problem !== undefined) return invalid(decoded.problem);
  const parsed = decoded.value;
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (isObject && !Object.hasOwn(parsed, 'scanIgnore')) return NO_HEAD_PATTERNS;
  // `validateLayer`'s own messages, over `scanIgnore` alone (or the non-object top level).
  const errors = validateLayer(isObject ? { scanIgnore: parsed.scanIgnore } : parsed, HEAD_LAYER);
  if (errors) return invalid(errors.errors[0]);
  return {
    patterns: parsed.scanIgnore,
    matchers: Object.freeze(parsed.scanIgnore.map((pattern) => compileGlob(pattern).matcher)),
    warning: null,
  };
}
