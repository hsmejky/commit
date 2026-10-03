// M5 Attribution resolver (docs/spec/modules-m1-m9.md, Q5, C:plan): resolves the commit
// attribution trailer from Claude's settings layers, highest first (managed, project-local,
// project, user).
//
// CFG-08 builds the tracer: no settings files are read yet. `resolveAttribution` always
// returns the fixed trailer `Co-Authored-By: Claude <noreply@anthropic.com>`, source
// `default`, no warnings (Q5's fallback rule). Pure for now: no file reads, no ambient
// state, so the trailer holds no model name and nothing an agent controls (a flag, an env
// var, a file it wrote) can change it. Later slices make this module effectful: CFG-09 adds
// the two-pass settings read (`attribution.commit`, then `includeCoAuthoredBy`); CFG-10 adds
// the project-local, project and user layers and `CLAUDE_PROJECT_DIR`; CFG-11 adds the
// managed layer. `env`, `claudeHome`, `toplevel` and `managedDir` are accepted now (and
// ignored) so callers already pass the injected shape those slices will read.

/** The fixed trailer used while no settings layer sets attribution (Q5). */
const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/**
 * Resolves the commit attribution trailer (M5, Q5). The CFG-08 tracer reads no settings
 * files: it always returns the fixed trailer with source `default` and no warnings.
 *
 * @param {{ env?: object, claudeHome?: string|null, toplevel?: string|null,
 *   managedDir?: string|null }} [injected] accepted for the later slices that read settings
 *   through these; this tracer ignores all of them.
 * @returns {{ trailer: string|null, source: string, warnings: string[] }}
 */
export function resolveAttribution(injected = {}) {
  return { trailer: DEFAULT_TRAILER, source: 'default', warnings: [] };
}
