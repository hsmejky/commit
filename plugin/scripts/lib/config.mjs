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
  let text;
  try {
    text = fs.readFileSync(repoConfigPath, 'utf8');
  } catch (err) {
    // No repo layer at all: no config, no error (Q6, CFG-02 seam "a repo with no config file
    // gets no `config` refusal"). ENOTDIR: a path component (e.g. `.claude`) is a file, which
    // is just as absent a layer as ENOENT.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    JSON.parse(text);
  } catch {
    return { error: `the repo config (${REPO_CONFIG_PATH}) is not valid JSON` };
  }
  return null;
}
