// M4 Config loader (docs/spec/modules-m1-m9.md, Q6, C:plan): reads the config layers.
// Effectful (reads the repo layer's file from the worktree); it spawns nothing.
//
// CFG-02 builds the tracer: only the repo layer, read straight from the worktree (never git),
// and only its JSON parseability. Unparseable JSON is a `config` error naming the repo layer
// (Q6); a missing file is no layer at all, so `plan` goes on with the defaults. Later CFG
// slices add the user layer, per-key validation, warnings, defaults, `sources`, and the
// `scanIgnore` machinery read at HEAD (M7, Q6, Q10).

import fs from 'node:fs';
import path from 'node:path';

/** The repo config layer's path under the toplevel (Q6). */
export const REPO_CONFIG_PATH = '.claude/commit.json';

// The repo config is a small hand-written file; a few KB is generous, same style as the
// run-lock read (`run.mjs` `LOCK_MAX_BYTES`). Checked before the read so an oversized file,
// or a non-regular one (a symlink to a device file or a FIFO would otherwise hang or exhaust
// memory, review-CFG-02 finding 10), is never opened.
const CONFIG_MAX_BYTES = 65536;

/**
 * Loads the config layers (thin for CFG-02: only the repo layer, read from the worktree).
 *
 * @param {{ toplevel: string }} options `toplevel`: the working tree's toplevel (M3).
 * @returns {{ error: string } | null} `null` when the repo layer is absent, or when it is
 *   present and its JSON parses; otherwise the `config` refusal's message, naming the repo
 *   layer (Q6, C:cli-and-exit-codes).
 */
export function loadConfig({ toplevel }) {
  const repoConfigPath = path.join(toplevel, REPO_CONFIG_PATH);

  let stats;
  try {
    // Follows a link (read only, never write), so a link to a huge file or a FIFO is caught
    // the same as one in place directly (review-CFG-02 finding 10).
    stats = fs.statSync(repoConfigPath);
  } catch (err) {
    // No repo layer at all: no config, no error (Q6, CFG-02 seam "a repo with no config file
    // gets no `config` refusal"). ENOTDIR: a path component (e.g. `.claude`) is a file, which
    // is just as absent a layer as ENOENT.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    // EACCES, EPERM, ELOOP and the like: the layer exists but cannot be inspected. A `config`
    // refusal naming the repo layer, not an uncaught throw ending as `internal`
    // (review-CFG-02 finding 1).
    return { error: `the repo config (${REPO_CONFIG_PATH}) cannot be read (${err.code})` };
  }

  // A directory (e.g. `mkdir .claude/commit.json`), a device, socket or FIFO: never a valid
  // config file, and never opened (review-CFG-02 finding 1's EISDIR case, finding 10).
  if (!stats.isFile()) {
    return { error: `the repo config (${REPO_CONFIG_PATH}) is not a regular file` };
  }
  if (stats.size > CONFIG_MAX_BYTES) {
    return { error: `the repo config (${REPO_CONFIG_PATH}) is larger than ${CONFIG_MAX_BYTES} bytes` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(repoConfigPath);
  } catch (err) {
    // The layer vanished, or turned unreadable, between the stat and the read.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    return { error: `the repo config (${REPO_CONFIG_PATH}) cannot be read (${err.code})` };
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
    return { error: `the repo config (${REPO_CONFIG_PATH}) is not valid UTF-8` };
  }

  try {
    JSON.parse(text);
  } catch (err) {
    // The parser's own message carries the position, which helps find the typo (story 110,
    // review-CFG-02 finding 3).
    return { error: `the repo config (${REPO_CONFIG_PATH}) is not valid JSON: ${err.message}` };
  }
  // A non-object top level (`[]`, `null`, `42`, `"x"`) parses and is accepted here: CFG-02 is
  // JSON-parseability only. Whether that is itself an error is CFG-03's per-key/per-layer
  // validation (Q6, review-CFG-02 finding 5).
  return null;
}
