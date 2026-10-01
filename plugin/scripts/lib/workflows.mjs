// M18 Subcommand workflows (docs/spec/modules-m14-m19.md, C:plan): sequences over the
// modules, each a numbered step table that is the contract for Seam 1 tests. Effectful
// orchestration; the only module that maps domain codes to CLI kinds (`domain-codes.mjs`).
//
// `plan` holds one function per row of its step table (M18 `plan`, C:plan "Steps"), run in
// order by `runSteps`. A step returns `undefined` to go on, or the facts of the output that
// ends the call: `{ status }` for a reply, or `{ refusal: { code, message } }` with a domain
// code this module maps to a CLI kind. INT-01 built the walking skeleton (steps 1, 4 and 6,
// only as far as a clean tree needs); GIT-01 adds step 2's first rows (`env`, `state`
// outside a usable repo). CFG-02 adds step 1's M4 `loadConfig` (repo layer only, from the
// worktree) and step 2's `config` row, ahead of `state` (C:plan step 2 order). Later slices
// insert the other rows (3 run folder and lock peek, 5 snapshot and scan, 7 store and lock,
// 8 guard state and `plan --hunks`) in their place in PLAN_STEPS, and widen these.
//
// `release` (RUN-01) runs its own step table the same way: probe, M12 `releaseById`, then the
// `nothing` reply ending with the tree state. RUN-02 added the `call.lock` and `busy`;
// RUN-03 the 45 s M15 `releaseDeadline` (`run-policy.mjs`) on the tree-state read.

import { probe } from './repo-probe.mjs';
import { treeState } from './change-set.mjs';
import { releaseById } from './run.mjs';
import { reply } from './reply.mjs';
import { planRefusal, releaseDeadline } from './run-policy.mjs';
import { kindForDomainCode } from './domain-codes.mjs';
import { loadConfig } from './config.mjs';

/** Step 1: probe the repo state, git and Node versions (M3). Shared with `release`. */
async function probeRepo(ctx) {
  ctx.probe = await probe({ cwd: ctx.cwd, env: ctx.injected.env, now: ctx.injected.now });
  return undefined;
}

/**
 * `plan` step 1 (config part): M4 `loadConfig`. CFG-04: the user layer is read from the
 * injected Claude home regardless of repo state (C:plan step 2 puts `config` ahead of
 * `state`, so a bad user layer must refuse even outside a usable repo); the repo layer is
 * read only when the probe found a worktree to read it from. `release` never runs this: it
 * shares only the `env` refusal with `plan` (C:cli-and-exit-codes), so it never needs a
 * config load.
 */
async function loadRepoConfig(ctx) {
  const toplevel = ctx.probe.repo !== null && ctx.probe.repo.kind === 'worktree'
    ? ctx.probe.repo.toplevel
    : null;
  ctx.config = loadConfig({ toplevel, claudeHome: ctx.injected.claudeHome });
  return undefined;
}

/** Step 2: pre-folder refusals (M15 `planRefusal`); none of them creates the run folder. */
async function preFolderRefusals(ctx) {
  const refusal = planRefusal({ ...ctx.probe, config: ctx.config });
  if (refusal !== null) return { refusal };
  ctx.toplevel = ctx.probe.repo.toplevel;
  return undefined;
}

/** Step 4: inventory. Thin: the tree state stands in until CHG-03 builds M10 `inventory`. */
async function inventory(ctx) {
  ctx.inventory = await treeState({ toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now });
  return undefined;
}

/** Step 6: post-scan refusals. A clean tree ends the call with `nothing`. */
async function postScanRefusals(ctx) {
  if (ctx.inventory.clean === true) return { status: 'nothing', reason: 'clean' };
  // CHG-03 / INT-02 go on to steps 7-8 for a tree with changes.
  throw new Error('plan on a working tree with changes is not built yet');
}

const PLAN_STEPS = Object.freeze([probeRepo, loadRepoConfig, preFolderRefusals, inventory, postScanRefusals]);

/**
 * `release` step 2: the probe's `env` refusal, the only refusal `release` shares with `plan`
 * (C:cli-and-exit-codes: `env` for any subcommand, `state` only for `plan` and `infer`).
 */
async function releaseRefusals(ctx) {
  const refusal = planRefusal(ctx.probe);
  if (refusal !== null && refusal.code === 'env') return { refusal };
  const { repo } = ctx.probe;
  if (repo === null || repo.kind !== 'worktree') {
    // Not a repo, a bare repository, or git timed out: what `release` does here is unsettled
    // (KD-S78, docs/spec/known-deficiencies.md), not merely a slice not yet scheduled.
    throw new Error('release outside a working tree is unsettled (KD-S78)');
  }
  ctx.toplevel = repo.toplevel;
  return undefined;
}

/** `release` step 3: M12 `releaseById`, a no-op unless the lock holds this `planId`. */
async function releaseRun(ctx) {
  const result = releaseById({ toplevel: ctx.toplevel, planId: ctx.values.plan, now: ctx.injected.now });
  // A live `call.lock` on the run (RUN-02): `busy`, the only `lock` refusal `release` raises.
  if (!result.ok) return { refusal: { code: result.code, message: result.message } };
  return { status: 'nothing', reason: result.released ? 'released' : 'already-ended' };
}

const RELEASE_STEPS = Object.freeze([probeRepo, releaseRefusals, releaseRun]);

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
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 *   the success fields M1 wraps in the envelope, or the failure M1 turns into the failure
 *   shape and exit code.
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
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  return {
    output: {
      planId: null,
      runDir: null,
      // With no mode flag an empty index resolves to `split` (C:plan `mode`); a clean tree
      // has an empty index. M15 `resolveMode` replaces this at step 4.
      mode: 'split',
      reply: await finalReply(facts, ctx),
      hunks: null,
    },
  };
}

/**
 * Runs `release --plan <planId>` (C:commit-release `release`).
 *
 * @param {{ plan: string }} values the parsed and validated `release` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 */
export async function release(values, injected, { cwd }) {
  // The call's start (RUN-03): read once, first, so it precedes every other clock read the
  // call makes and `releaseDeadline` bounds the whole call, not just the part after it.
  // M15 says `deadline`/`cleanupDeadline` are computed once when a call starts, for every
  // subcommand (docs/spec/modules-m14-m19.md); once GIT-07 lands that read moves to dispatch
  // (`cli.mjs`'s `main`, which already calls each M18 workflow with `injected`) and is
  // threaded through `injected`/`ctx` instead of being re-read here (review-RUN-03 finding 3).
  const callStarted = injected.now();
  const ctx = { injected, cwd, values };
  const facts = await runSteps(RELEASE_STEPS, ctx);
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  return { output: { reply: await finalReply(facts, ctx, { deadline: releaseDeadline(callStarted) }) } };
}

// A refusal before any reply: RPL-04 adds the `failed` reply.
function refusalFailure(refusal) {
  return { failure: { kind: kindForDomainCode(refusal.code), message: refusal.message } };
}

// Every reply ends with the tree state, read after the call's last git call (M10) — except
// past a given `deadline` (RUN-03, `release`'s `releaseDeadline`): the read is skipped
// entirely (never spawned) and the reply omits the tree state, since the call it would report
// on (here, the release itself) is already complete.
//
// GIT-07 (docs/roadmap/06-git-adapters.md): once M2 calls take `timeoutMs` from a deadline,
// this read's own `timeoutMs` must come from `deadline - now()` too, and a read that times out
// must land here as `treeState: undefined` (the line below only skips a read that hasn't
// started), not as a thrown `internal` failure from `change-set.mjs`'s `treeState`.
async function finalReply(facts, ctx, { deadline } = {}) {
  const { env, now } = ctx.injected;
  if (deadline !== undefined && now() >= deadline) {
    return reply({ ...facts, treeState: undefined });
  }
  const finalTree = await treeState({ toplevel: ctx.toplevel, env, now });
  return reply({ ...facts, treeState: finalTree });
}
