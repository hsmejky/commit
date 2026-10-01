// M4 Config loader (docs/spec/modules-m1-m9.md, Q6, C:plan): reads the config layers.
// Effectful (reads the repo layer's file from the worktree); it spawns nothing.
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
// `config` ahead of `state`). Later CFG slices add per-key override and effective values,
// warnings for unknown keys and values, defaults, `sources`, and the `scanIgnore` machinery
// read at HEAD (M7, Q6, Q10).

import fs from 'node:fs';
import path from 'node:path';

/** The repo config layer's path under the toplevel (Q6). */
export const REPO_CONFIG_PATH = '.claude/commit.json';

/** The user config layer's filename, directly under the Claude home (Q5, Q6, public surface). */
export const USER_CONFIG_FILENAME = 'commit.json';

/** A `types` entry: lowercase, starting with a letter (Q6). */
const TYPE_ENTRY_PATTERN = /^[a-z][a-z0-9-]*$/;

/** `maxSubjectLength`'s range: code points of the whole header (Q6). */
const MIN_SUBJECT_LENGTH = 20;
const MAX_SUBJECT_LENGTH = 200;

/** Keys whose only CFG-03 check is "must be a string" (enum membership is CFG-06's warning). */
const STRING_KEYS = ['scope', 'body', 'subjectCase'];

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
 * warnings, not this function's errors; `scanIgnore` is CFG-07's (M7 `compileGlob`, folded
 * into this function then).
 *
 * Collects every applicable error in one pass rather than stopping at the first, so a
 * caller that reports more than one problem at once (M19 `configFor`, and CFG-07's glob
 * errors alongside these) can do so without a second pass over the same layer
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

  return errors.length > 0 ? { errors } : null;
}

// A config layer's file (user or repo) is small and hand-written; a few KB is generous, same
// style as the run-lock read (`run.mjs` `LOCK_MAX_BYTES`). Checked before the read so an oversized file,
// or a non-regular one (a symlink to a device file or a FIFO would otherwise hang or exhaust
// memory, review-CFG-02 finding 10), is never opened.
const CONFIG_MAX_BYTES = 65536;

/**
 * Reads and validates one config layer's file: the read/decode/parse/`validateLayer`
 * pipeline shared by the user and repo layers (CFG-04), each named only by their path and
 * display label. A missing file is no layer at all, not an error (Q6).
 *
 * @param {string} filePath absolute path to the layer's file.
 * @param {string} layer the layer's display label (used in every message, and passed to
 *   `validateLayer` so a key error names the same layer).
 * @returns {{ error: string } | { value: object | null }} `value: null` when the file is
 *   absent; otherwise the parsed and validated layer object. `error` names `layer`.
 */
function readLayer(filePath, layer) {
  let stats;
  try {
    // Follows a link (read only, never write), so a link to a huge file or a FIFO is caught
    // the same as one in place directly (review-CFG-02 finding 10).
    stats = fs.statSync(filePath);
  } catch (err) {
    // No layer at all: no config, no error (Q6, CFG-02 seam "a repo with no config file gets
    // no `config` refusal"). ENOTDIR: a path component (e.g. the repo layer's `.claude`, or
    // the user layer's Claude home) is a file, which is just as absent a layer as ENOENT.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: null };
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
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { value: null };
    return { error: `the ${layer} cannot be read (${err.code})` };
  }

  let text;
  try {
    // A fatal-mode decoder catches invalid UTF-8 cheaply and rejects it as unparseable,
    // instead of Node's default `readFileSync(..., 'utf8')`, which silently replaces bad
    // bytes with U+FFFD (Q6, review-CFG-02 finding 4). It also strips a leading UTF-8 BOM
    // (U+FEFF) the same way Node's own JSON file parsing does, so a file saved with a BOM by
    // Windows PowerShell 5.1 or Notepad still parses (Q6, review-CFG-02 finding 2).
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { error: `the ${layer} is not valid UTF-8` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // The parser's own message carries the position, which helps find the typo (story 110,
    // review-CFG-02 finding 3).
    return { error: `the ${layer} is not valid JSON: ${err.message}` };
  }
  // CFG-03: a non-object top level, a wrong JSON type, an out-of-range number or a bad
  // `types` array is a `config` error naming the layer and the key (Q6, review-CFG-02
  // finding 5: CFG-02 was JSON-parseability only). `validateLayer` collects every error it
  // finds; this reports the first, same as `loadConfig` did before CFG-03 collected every
  // error (review-CFG-03 finding 2).
  const result = validateLayer(parsed, layer);
  return result ? { error: result.errors[0] } : { value: parsed };
}

/** The repo layer's display label, matching `REPO_CONFIG_PATH`. */
const REPO_LAYER = `repo config (${REPO_CONFIG_PATH})`;

/** The user layer's display label, matching `USER_CONFIG_FILENAME`. */
const USER_LAYER = `user config (${USER_CONFIG_FILENAME})`;

/**
 * Loads the config layers: the user layer, read from `commit.json` directly under the
 * Claude home (CFG-04, Q5, Q6), then, when `toplevel` names a worktree, the repo layer, read
 * from `.claude/commit.json` under it (CFG-02). Thin: no per-key override yet (CFG-05), no
 * `scanIgnore` at HEAD yet (CFG-07).
 *
 * @param {{ toplevel: string | null, claudeHome: string }} options `toplevel`: the working
 *   tree's toplevel (M3), or `null` when `plan` is not inside one (the user layer is still
 *   read and validated: C:plan step 2 puts `config` ahead of `state`). `claudeHome`: the
 *   Claude home the entry point resolved once and injected (`CLAUDE_CONFIG_DIR`, else
 *   `.claude` in the OS home, Q5).
 * @returns {{ error: string } | null} `null` when neither layer present errors; otherwise
 *   the `config` refusal's message, naming whichever layer errored first (user, then repo,
 *   matching Q6's layer order) (C:cli-and-exit-codes).
 */
export function loadConfig({ toplevel, claudeHome }) {
  const userResult = readLayer(path.join(claudeHome, USER_CONFIG_FILENAME), USER_LAYER);
  if (userResult.error !== undefined) return { error: userResult.error };

  if (toplevel === null || toplevel === undefined) return null;

  const repoResult = readLayer(path.join(toplevel, REPO_CONFIG_PATH), REPO_LAYER);
  if (repoResult.error !== undefined) return { error: repoResult.error };

  return null;
}
