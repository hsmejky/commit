// M5 Attribution resolver (docs/spec/modules-m1-m9.md, Q5, C:plan): resolves the commit
// attribution trailer from Claude's settings layers, highest first (managed, project-local,
// project, user). Effectful, read-only (modules.md): it reads Claude's own settings files
// and never writes, never refuses `plan`, and spawns nothing.
//
// CFG-08 built the tracer: no settings files were read, source always `default`. CFG-09
// adds the user layer only (`<claudeHome>/settings.json`), the two-pass key lookup
// (`attribution.commit`, then the deprecated `includeCoAuthoredBy`) and the trailer-line
// filtering, each line of the value tested on its own against M6's `isFooterLine` (a line
// that is not footer-shaped, e.g. a 🤖 line or a blank line, is dropped with a warning; M5
// has no use for M6's `lint`, which checks a message against the configured rules). `env`,
// `toplevel` and `managedDir` are accepted now (and ignored) for CFG-10 (project-local and
// project layers, `CLAUDE_PROJECT_DIR`) and CFG-11 (the managed layer) to read later.
// Claude's own settings.json is not ours to validate: a missing file is no settings at all
// (same as a missing `commit.json` layer, Q6), not a `config` refusal. When the file exists
// but cannot be read, is not valid UTF-8, is not valid JSON, or its top level is not a JSON
// object, it is likewise treated as no settings, but a warning names the problem (Q5
// Amended, docs/spec/modules-m1-m9.md M5), so a broken file does not silently bring the
// default trailer back unnoticed.

import fs from 'node:fs';
import path from 'node:path';
import { isFooterLine } from './message-grammar.mjs';

/** The fixed trailer used while no settings layer sets attribution (Q5). */
const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** The user layer's settings filename, directly under the Claude home (Q5). */
const USER_SETTINGS_FILENAME = 'settings.json';

/** Splits a config value into lines on LF, CRLF or a lone CR (M6 byte normalisation, Q5). */
const LINE_SPLIT = /\r\n?|\n/;

/**
 * Reads and parses `<claudeHome>/settings.json`. A missing file is no settings at all (Q6).
 * Any other problem reading or parsing it (unreadable, not valid UTF-8, not valid JSON, a
 * non-object top level) is also treated as no settings, since Claude's own settings file is
 * not this resolver's to validate or refuse `plan` over — but `warning` then names the
 * problem (finding 3, Q5 Amended), so a broken file does not silently restore the default
 * trailer unnoticed.
 *
 * @param {string|undefined} claudeHome
 * @returns {{ settings: object, warning: string | null }}
 */
function readUserSettings(claudeHome) {
  if (typeof claudeHome !== 'string') return { settings: {}, warning: null };
  const filePath = path.join(claudeHome, USER_SETTINGS_FILENAME);

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { settings: {}, warning: null };
    return {
      settings: {},
      warning: `Claude user ${USER_SETTINGS_FILENAME} ignored: cannot be read (${err.code})`,
    };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      settings: {},
      warning: `Claude user ${USER_SETTINGS_FILENAME} ignored: not valid UTF-8`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      settings: {},
      warning: `Claude user ${USER_SETTINGS_FILENAME} ignored: not valid JSON: ${err.message}`,
    };
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { settings: parsed, warning: null };
  }
  return {
    settings: {},
    warning: `Claude user ${USER_SETTINGS_FILENAME} ignored: top level is not a JSON object`,
  };
}

/**
 * Splits `commitValue` (the raw `attribution.commit` string) into its trailer-shaped lines
 * and the lines dropped because they are not (Q5 story 117: "its trailer-shaped lines are
 * used; other lines ... are dropped"). Each line is tested independently against M6's
 * `isFooterLine`, not grouped into paragraphs the way a commit message body is: a blank
 * line, a non-footer line in the same run as a trailer, or a trailer in an earlier
 * "paragraph" never swallows a trailer-shaped line elsewhere in the value. CRLF and a lone
 * CR are normalised to LF first (M6 byte normalisation) before splitting. A blank line is
 * always dropped, never kept. A kept line is right-trimmed (finding 8): `commit` runs
 * `--cleanup=verbatim`, so trailing spaces in the setting would otherwise reach the commit.
 *
 * @param {string} commitValue
 * @returns {{ trailer: string | null, dropped: string[] }}
 */
function trailerLinesOf(commitValue) {
  const lines = commitValue.split(LINE_SPLIT);
  const kept = [];
  const dropped = [];
  for (const line of lines) {
    if (line.trim() !== '' && isFooterLine(line)) {
      kept.push(line.trimEnd());
    } else {
      dropped.push(line);
    }
  }
  const trailer = kept.length > 0 ? kept.join('\n') : null;
  return { trailer, dropped };
}

/**
 * Resolves the commit attribution trailer (M5, Q5). CFG-09 reads the user settings layer
 * only (`<claudeHome>/settings.json`): `attribution.commit` wins when it is a string (`''`
 * means no trailer, a whitespace-only string behaves the same since every line of it is
 * dropped; otherwise its trailer-shaped lines are kept, every other line dropped with a
 * warning); otherwise a boolean `includeCoAuthoredBy` wins (`false` means no trailer, `true`
 * means the fixed default trailer); otherwise (neither key set, or `settings.json` could not
 * be used) the fixed default trailer, source `default`. A boolean `includeCoAuthoredBy`
 * counts as "set" either way, per Q5's "first layer that defines a key wins": `source` is
 * `'user'` even when the value is `true` and the resulting trailer is the same text the
 * `default` source would give. When any key is read from the user layer (even to a `null`
 * trailer), `source` is `'user'`; a `settings.json` that could not be read or parsed adds a
 * warning but never changes `source` by itself.
 *
 * @param {{ env?: object, claudeHome?: string, toplevel?: string|null,
 *   managedDir?: string|null }} [injected] `env`, `toplevel` and `managedDir` are accepted
 *   for CFG-10/CFG-11 and ignored here.
 * @returns {{ trailer: string | null, source: string, warnings: string[] }}
 */
export function resolveAttribution(injected = {}) {
  const { settings, warning } = readUserSettings(injected.claudeHome);
  const settingsWarnings = warning !== null ? [warning] : [];
  const commitValue = settings.attribution?.commit;

  if (typeof commitValue === 'string') {
    if (commitValue === '') {
      return { trailer: null, source: 'user', warnings: settingsWarnings };
    }
    const { trailer, dropped } = trailerLinesOf(commitValue);
    const warnings = dropped.length > 0
      ? [...settingsWarnings, `attribution.commit: dropped ${dropped.length} line(s) that are not a trailer`]
      : settingsWarnings;
    return { trailer, source: 'user', warnings };
  }

  if (typeof settings.includeCoAuthoredBy === 'boolean') {
    return settings.includeCoAuthoredBy
      ? { trailer: DEFAULT_TRAILER, source: 'user', warnings: settingsWarnings }
      : { trailer: null, source: 'user', warnings: settingsWarnings };
  }

  return { trailer: DEFAULT_TRAILER, source: 'default', warnings: settingsWarnings };
}
