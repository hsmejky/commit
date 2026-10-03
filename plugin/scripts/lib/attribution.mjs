// M5 Attribution resolver (docs/spec/modules-m1-m9.md, Q5, C:plan): resolves the commit
// attribution trailer from Claude's settings layers, highest first (managed, project-local,
// project, user). Effectful, read-only (modules.md): it reads Claude's own settings files
// and never writes, never refuses `plan`, and spawns nothing.
//
// CFG-08 built the tracer: no settings files were read, source always `default`. CFG-09
// adds the user layer only (`<claudeHome>/settings.json`), the two-pass key lookup
// (`attribution.commit`, then the deprecated `includeCoAuthoredBy`) and the trailer-line
// filtering via M6's `parse` (a line that is not footer-shaped, e.g. a 🤖 line, is dropped
// with a warning; M5 has no use for M6's other export, which checks a message against the
// configured rules). `env`, `toplevel` and `managedDir` are accepted now (and ignored) for
// CFG-10 (project-local and project layers, `CLAUDE_PROJECT_DIR`) and CFG-11 (the managed
// layer) to read later.
// Claude's own settings.json is not ours to validate: a missing, unreadable or unparseable
// file, or a non-object top level, is treated as no settings at all (same as a missing
// `commit.json` layer, Q6), not a `config` refusal.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from './message-grammar.mjs';

/** The fixed trailer used while no settings layer sets attribution (Q5). */
const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** The user layer's settings filename, directly under the Claude home (Q5). */
const USER_SETTINGS_FILENAME = 'settings.json';

/**
 * Reads and parses `<claudeHome>/settings.json`. Any problem (missing file, unreadable,
 * invalid UTF-8, unparseable JSON, a non-object top level) is treated as no settings at all:
 * this resolver never refuses `plan` over Claude's own settings file.
 *
 * @param {string|undefined} claudeHome
 * @returns {object}
 */
function readUserSettings(claudeHome) {
  if (typeof claudeHome !== 'string') return {};
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(claudeHome, USER_SETTINGS_FILENAME));
  } catch {
    return {};
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

/**
 * Splits `commitValue` (the raw `attribution.commit` string) into its trailer-shaped lines
 * and the lines dropped because they are not (Q5, M6 footer grammar). `commitValue` is
 * parsed as the part of a message after an empty header line, so a lone trailer line (the
 * common case) is never swallowed as a header the way `parse` would otherwise treat a
 * message's first line.
 *
 * @param {string} commitValue
 * @returns {{ trailer: string | null, dropped: string[] }}
 */
function trailerLinesOf(commitValue) {
  const { body, footer } = parse(`\n${commitValue}`);
  const dropped = body.flatMap((paragraph) => paragraph.split('\n'));
  const trailer = footer !== null && footer.length > 0
    ? footer.map((entry) => entry.raw).join('\n')
    : null;
  return { trailer, dropped };
}

/**
 * Resolves the commit attribution trailer (M5, Q5). CFG-09 reads the user settings layer
 * only (`<claudeHome>/settings.json`): `attribution.commit` wins when it is a string
 * (`''` means no trailer; otherwise its trailer-shaped lines are kept, every other line
 * dropped with a warning); otherwise `includeCoAuthoredBy: false` means no trailer; otherwise
 * the fixed default trailer, source `default`. When either key is read from the user layer
 * (even to a `null` trailer), `source` is `'user'`.
 *
 * @param {{ env?: object, claudeHome?: string, toplevel?: string|null,
 *   managedDir?: string|null }} [injected] `env`, `toplevel` and `managedDir` are accepted
 *   for CFG-10/CFG-11 and ignored here.
 * @returns {{ trailer: string | null, source: string, warnings: string[] }}
 */
export function resolveAttribution(injected = {}) {
  const settings = readUserSettings(injected.claudeHome);
  const commitValue = settings.attribution?.commit;

  if (typeof commitValue === 'string') {
    if (commitValue === '') {
      return { trailer: null, source: 'user', warnings: [] };
    }
    const { trailer, dropped } = trailerLinesOf(commitValue);
    const warnings = dropped.length > 0
      ? [`attribution.commit: dropped ${dropped.length} line(s) that are not a trailer`]
      : [];
    return { trailer, source: 'user', warnings };
  }

  if (settings.includeCoAuthoredBy === false) {
    return { trailer: null, source: 'user', warnings: [] };
  }

  return { trailer: DEFAULT_TRAILER, source: 'default', warnings: [] };
}
