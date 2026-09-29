// M3 Repo-state probe (docs/spec/modules-m1-m9.md, Q18, Q20, Q21, C:plan): every question
// about repository state, as typed results. Effectful, read-only; spawns only through M2.
//
// INT-01 builds the thinnest probe the walking skeleton needs: where the working tree is.
// GIT-01 adds not-a-repo and bare-repo refusals and the git and Node versions, GIT-02 the
// HEAD state from one porcelain v2 `--branch` status, GIT-03/GIT-04 the refused states.

import { toplevel } from './process-adapter.mjs';

/**
 * Probes the repository `plan` runs in.
 *
 * @param {{ cwd: string, env: object }} options `cwd`: the call's working directory; `env`:
 *   the injected process environment.
 * @returns {{ toplevel: string|null }} `toplevel` is `null` outside a working tree.
 */
export function probe({ cwd, env }) {
  return { toplevel: toplevel(cwd, { env }) };
}
