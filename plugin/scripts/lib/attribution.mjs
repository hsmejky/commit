// M5 Attribution resolver (docs/spec/modules-m1-m9.md, Q5, C:plan): resolves the commit
// attribution trailer from Claude's settings layers, highest first (managed, project-local,
// project, user). Effectful, read-only (modules.md): it reads Claude's own settings files
// and never writes, never refuses `plan`, and spawns nothing.
//
// CFG-08 built the tracer: no settings files were read, source always `default`. CFG-09
// added the user layer only (`<claudeHome>/settings.json`). CFG-10 added the project-local
// (`<projectDir>/.claude/settings.local.json`) and project (`<projectDir>/.claude/
// settings.json`) layers, ahead of the user layer, and dropped the `toplevel` param CFG-09
// accepted and ignored. CFG-11 adds the managed layer (`<managedDir>/managed-settings.json`,
// PRE-16), ahead of every other layer: `managedDir` is the already-resolved, platform-derived
// managed directory the entry point injects, the same way `claudeHome` and `projectDir` are
// (`CLAUDE_PROJECT_DIR` when it sees it, else its own `process.cwd()`; no walk-up to a git
// toplevel — PRE-11, Q5 Amended). This resolver never reads `env` or the cwd itself to find
// any of them, and never reads the managed layer's drop-in directory (Out of Scope). The
// two-pass key lookup (`attribution.commit` across every layer, highest first, then the
// deprecated `includeCoAuthoredBy` across every layer) and the trailer-line filtering are
// unchanged: each line of a winning `attribution.commit` value is tested on its own against
// M6's `isFooterLine` (a line that is not footer-shaped, e.g. a 🤖 line or a blank line, is
// dropped with a warning; M5 has no use for M6's `lint`, which checks a message against the
// configured rules). `env` is still accepted (and ignored) here: the managed directory is
// never read from `env`, so M5 has no use for it either, by design (Q5 Amended). Claude's
// own settings.json is not ours to validate: a missing file is no settings at all from that
// layer (same as a missing `commit.json` layer, Q6), not a `config` refusal. When a layer's
// file exists but cannot be read, is not valid UTF-8, is not valid JSON, or its top level is
// not a JSON object, it is likewise treated as no settings from that layer, but a warning
// names the problem (Q5 Amended, docs/spec/modules-m1-m9.md M5), so a broken file does not
// silently give way to a lower layer (or the default trailer) unnoticed. Every layer's file
// is read and checked for this warning regardless of which layer's key ends up winning.

import fs from 'node:fs';
import path from 'node:path';
import { isFooterLine } from './message-grammar.mjs';

/** The fixed trailer used while no settings layer sets attribution (Q5). */
const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** Splits a config value into lines on LF, CRLF or a lone CR (M6 byte normalisation, Q5). */
const LINE_SPLIT = /\r\n?|\n/;

/** Each layer's display label for a warning (`Claude <label> ignored: ...`), and the path
 * segments (relative to its own base directory: `managedDir` for the managed layer,
 * `projectDir` for the two project layers, `claudeHome` for the user layer) its settings
 * file lives at (Q5, PRE-16). Order matters: this is the precedence order, highest first;
 * the managed layer only applies when `managedDir` is given, project-local and project only
 * when `projectDir` is given. */
const LAYER_DEFS = [
  { source: 'managed', label: 'managed managed-settings.json', segments: ['managed-settings.json'] },
  { source: 'project-local', label: 'project-local settings.local.json', segments: ['.claude', 'settings.local.json'] },
  { source: 'project', label: 'project settings.json', segments: ['.claude', 'settings.json'] },
  { source: 'user', label: 'user settings.json', segments: ['settings.json'] },
];

/**
 * Reads and parses one settings-layer file. A missing file is no settings from this layer at
 * all (Q6). Any other problem reading or parsing it (unreadable, not valid UTF-8, not valid
 * JSON, a non-object top level) is also treated as no settings from this layer, since
 * Claude's own settings file is not this resolver's to validate or refuse `plan` over — but
 * `warning` then names the problem (finding 3, Q5 Amended), so a broken file does not
 * silently give way to a lower layer unnoticed.
 *
 * @param {string} filePath
 * @param {string} label names the layer in the warning (e.g. `project settings.json`).
 * @returns {{ settings: object, warning: string | null }}
 */
function readSettingsFile(filePath, label) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { settings: {}, warning: null };
    return { settings: {}, warning: `Claude ${label} ignored: cannot be read (${err.code})` };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { settings: {}, warning: `Claude ${label} ignored: not valid UTF-8` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { settings: {}, warning: `Claude ${label} ignored: not valid JSON: ${err.message}` };
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { settings: parsed, warning: null };
  }
  return { settings: {}, warning: `Claude ${label} ignored: top level is not a JSON object` };
}

/**
 * Builds the ordered, available layers (highest precedence first): managed (under
 * `managedDir`) only when `managedDir` is a string, then project-local and project (under
 * `projectDir`) only when `projectDir` is a string (no walk-up to a git toplevel — a
 * `projectDir` without its own `.claude/` yields no project layers, matching the entry
 * point's own resolution, PRE-11), then user (under `claudeHome`) only when `claudeHome` is a
 * string.
 *
 * @param {{ managedDir?: string, projectDir?: string, claudeHome?: string }} injected
 * @returns {Array<{ source: string, settings: object, warning: string | null }>}
 */
function readLayers({ managedDir, projectDir, claudeHome }) {
  const bases = { managed: managedDir, 'project-local': projectDir, project: projectDir, user: claudeHome };
  return LAYER_DEFS
    .filter((def) => typeof bases[def.source] === 'string')
    .map((def) => {
      const filePath = path.join(bases[def.source], ...def.segments);
      return { source: def.source, ...readSettingsFile(filePath, def.label) };
    });
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
 * Resolves the commit attribution trailer (M5, Q5). Layers, highest first: managed
 * (`<managedDir>/managed-settings.json`, PRE-16; its drop-in directory is not read, Out of
 * Scope), project-local (`<projectDir>/.claude/settings.local.json`), project
 * (`<projectDir>/.claude/settings.json`), user (`<claudeHome>/settings.json`).
 * `attribution.commit` wins at the first layer (highest first) where it is a string (`''`
 * means no trailer, a whitespace-only string behaves the same since every line of it is
 * dropped; otherwise its trailer-shaped lines are kept, every other line dropped with a
 * warning); otherwise a boolean `includeCoAuthoredBy` wins at the first layer (highest first)
 * where it is set (`false` means no trailer, `true` means the fixed default trailer); only
 * when no layer sets either key (or no layer could be used) the fixed default trailer,
 * source `default`. Two passes (Q5): every layer's `attribution.commit` is checked, highest
 * first, before any layer's `includeCoAuthoredBy` is — so `attribution.commit` set in a lower
 * layer still wins over `includeCoAuthoredBy` set in a higher one. A boolean
 * `includeCoAuthoredBy` counts as "set" either way, per Q5's "first layer that defines a key
 * wins": `source` names that layer even when the value is `true` and the resulting trailer
 * is the same text the `default` source would give. `source` is the layer a key was read
 * from (even to a `null` trailer); a layer's `settings.json` that could not be read or
 * parsed adds a warning but never changes `source` by itself, and never stops a lower layer
 * from being checked.
 *
 * @param {{ env?: object, claudeHome?: string, projectDir?: string|null,
 *   managedDir?: string|null }} [injected] `projectDir` is the entry point's already-resolved
 *   project directory (`CLAUDE_PROJECT_DIR` when it sees it, else its own `process.cwd()`;
 *   PRE-11); omitted or not a string, there are no project layers. `managedDir` is the
 *   entry point's already-resolved, platform-derived managed directory (PRE-16); omitted or
 *   not a string, there is no managed layer. `env` is accepted and always ignored: the
 *   managed directory is never read from it (CFG-11, Q5 Amended).
 * @returns {{ trailer: string | null, source: string, warnings: string[] }}
 */
export function resolveAttribution(injected = {}) {
  const layers = readLayers(injected);
  const warnings = [];
  for (const layer of layers) {
    if (layer.warning !== null) warnings.push(layer.warning);
  }

  // Pass 1: `attribution.commit`, every layer, highest first (Q5 "two passes").
  for (const layer of layers) {
    const commitValue = layer.settings.attribution?.commit;
    if (typeof commitValue !== 'string') continue;

    if (commitValue === '') {
      return { trailer: null, source: layer.source, warnings };
    }
    const { trailer, dropped } = trailerLinesOf(commitValue);
    if (dropped.length > 0) {
      warnings.push(`attribution.commit: dropped ${dropped.length} line(s) that are not a trailer`);
    }
    return { trailer, source: layer.source, warnings };
  }

  // Pass 2: `includeCoAuthoredBy`, every layer, highest first.
  for (const layer of layers) {
    if (typeof layer.settings.includeCoAuthoredBy === 'boolean') {
      return layer.settings.includeCoAuthoredBy
        ? { trailer: DEFAULT_TRAILER, source: layer.source, warnings }
        : { trailer: null, source: layer.source, warnings };
    }
  }

  return { trailer: DEFAULT_TRAILER, source: 'default', warnings };
}
