// M18 Subcommand workflows (docs/spec/modules-m14-m19.md, C:plan): sequences over the
// modules, each a numbered step table that is the contract for Seam 1 tests. Effectful
// orchestration; the only module that maps domain codes to CLI kinds (`domain-codes.mjs`).
//
// `plan` holds one function per row of its step table (M18 `plan`, C:plan "Steps"), run in
// order by `runSteps`. A step returns `undefined` to go on, or the facts of the output that
// ends the call. INT-01 builds the walking skeleton: steps 1, 4 and 6, only as far as a clean
// tree needs, so bare `plan` on a clean tree ends with `nothing`. Later slices insert the
// other rows (2 pre-folder refusals, 3 run folder and lock peek, 5 snapshot and scan, 7 store
// and lock, 8 guard state and `plan --hunks`) in their place in PLAN_STEPS, and widen these.

import { probe } from './repo-probe.mjs';
import { treeState } from './change-set.mjs';
import { reply } from './reply.mjs';

/** Step 1: probe the repo state (M3). */
async function probeRepo(ctx) {
  const { toplevel } = probe({ cwd: ctx.cwd, env: ctx.injected.env });
  // GIT-01 turns this into the `state` refusal (not a repository).
  if (toplevel === null) throw new Error('plan outside a working tree is not built yet');
  ctx.toplevel = toplevel;
  return undefined;
}

/** Step 4: inventory. Thin: the tree state stands in until CHG-03 builds M10 `inventory`. */
async function inventory(ctx) {
  ctx.inventory = await treeState({ toplevel: ctx.toplevel, env: ctx.injected.env });
  return undefined;
}

/** Step 6: post-scan refusals. A clean tree ends the call with `nothing`. */
async function postScanRefusals(ctx) {
  if (ctx.inventory.clean === true) return { status: 'nothing' };
  // CHG-03 / INT-02 go on to steps 7-8 for a tree with changes.
  throw new Error('plan on a working tree with changes is not built yet');
}

const PLAN_STEPS = Object.freeze([probeRepo, inventory, postScanRefusals]);

async function runSteps(steps, ctx) {
  for (const step of steps) {
    const ending = await step(ctx);
    if (ending !== undefined) return ending;
  }
  throw new Error('the step table ended without an outcome');
}

/**
 * Runs `plan` (mint form).
 *
 * @param {object} values the parsed and validated `plan` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment (docs/spec/architectural-decisions.md
 *   "Injected environment").
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ ok: true, output: object }>} the success fields M1 wraps in the
 *   envelope.
 */
export async function plan(values, injected, { cwd }) {
  // Only bare `plan` and `plan --split` are built: every other flag changes the mode or the
  // clean-tree outcome (C:plan `mode`, `--reword` on a clean tree takes the lock).
  const unbuilt = ['reword', 'dictated', 'staged', 'take-over', 'hunks'].filter((f) => values[f] !== undefined);
  if (unbuilt.length > 0) {
    throw new Error(`plan ${unbuilt.map((f) => `--${f}`).join(' ')} is not built yet`);
  }
  const ctx = { injected, cwd };
  const facts = await runSteps(PLAN_STEPS, ctx);
  // Every reply ends with the tree state, read after the call's last git call (M10).
  const finalTree = await treeState({ toplevel: ctx.toplevel, env: injected.env });
  return {
    ok: true,
    output: {
      planId: null,
      runDir: null,
      // With no mode flag an empty index resolves to `split` (C:plan `mode`); a clean tree
      // has an empty index. M15 `resolveMode` replaces this at step 4.
      mode: 'split',
      reply: reply({ ...facts, treeState: finalTree }),
      hunks: null,
    },
  };
}
