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
// worktree) and step 2's `config` row, ahead of `state` (C:plan step 2 order). CFG-04 widens
// step 1 to also load the user layer, read regardless of repo state. GIT-02 widens step 1 to
// store the HEAD state and expected HEAD on `ctx` and queue the detached-HEAD notice, and adds
// `state`/`expectedHead` to `plan`'s output. Later slices insert the other rows (3 run folder
// and lock peek, 5 snapshot and scan, 7 store and lock, 8 guard state and `plan --hunks`) in
// their place in PLAN_STEPS, and widen these.
//
// `release` (RUN-01) runs its own step table the same way: probe, M12 `releaseById`, then the
// `nothing` reply ending with the tree state. RUN-02 added the `call.lock` and `busy`;
// RUN-03 the 45 s M15 `releaseDeadline` (`run-policy.mjs`) on the tree-state read.
//
// `commit` (RUN-04) also runs its own step table (`COMMIT_STEPS`) the same way: probe, the
// shared `subcommandRefusals`, M12 `open`, then a stub that ends the call at once with no
// commits; EXE-02 replaces the stub with the real per-group loop.

import { isTracked, probe } from './repo-probe.mjs';
import { treeState } from './change-set.mjs';
import { releaseById, open, close, create, RUN_DIR_NAME } from './run.mjs';
import { gitPath } from './process-adapter.mjs';
import { reply } from './reply.mjs';
import { planRefusal, releaseDeadline } from './run-policy.mjs';
import { kindForDomainCode } from './domain-codes.mjs';
import { loadConfig } from './config.mjs';

// GIT-02: the detached-HEAD warning (Q21, story 183). No verbatim text is recorded for it in
// C:cli-and-exit-codes (only refusal texts and the guard/signing notices are), so this is a
// fresh notice text; tests assert it names "detached", not an exact string.
const DETACHED_HEAD_NOTICE = 'HEAD is detached: this commit will not be on any branch';

/**
 * Step 1: probe the repo state, git and Node versions (M3). Shared with `release`/`commit`.
 * GIT-02: inside a worktree, also stores the HEAD state and the expected HEAD on `ctx`, and
 * (`plan` only, which alone threads a `notices` array) queues the detached-HEAD notice.
 */
async function probeRepo(ctx) {
  ctx.probe = await probe({ cwd: ctx.cwd, env: ctx.injected.env, now: ctx.injected.now });
  const { repo } = ctx.probe;
  if (repo !== null && repo.kind === 'worktree') {
    ctx.state = { kind: repo.state.kind, branch: repo.state.branch, unborn: repo.state.unborn };
    ctx.expectedHead = repo.state.head;
    if (repo.state.kind === 'detached' && Array.isArray(ctx.notices)) {
      ctx.notices.push(DETACHED_HEAD_NOTICE);
    }
  }
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
async function loadConfigLayers(ctx) {
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

/**
 * Step 3 (RUN-05): M12 `create` checks `.commit-plan` (a link, a non-directory, or a path
 * the index holds, which M3 `isTracked` asks git for → `run-folder`), adds the exclude line
 * to the common dir's `info/exclude`, mints the `planId` and creates the provisional run
 * folder. `plan` discards it on every
 * outcome that takes no lock (`plan`'s `finally`). RUN-07 adds the lock `peek` here.
 */
async function createRunFolder(ctx) {
  const { env, now } = ctx.injected;
  const [excludePath] = await gitPath(['info/exclude'], { cwd: ctx.toplevel, env, now });
  const tracked = await isTracked(RUN_DIR_NAME, { cwd: ctx.toplevel, env, now });
  const created = create({ toplevel: ctx.toplevel, excludePath, tracked });
  if (!created.ok) return { refusal: { code: created.code, message: created.message } };
  ctx.provisional = created.provisional;
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

const PLAN_STEPS = Object.freeze([
  probeRepo, loadConfigLayers, preFolderRefusals, createRunFolder, inventory, postScanRefusals,
]);

/**
 * `release`/`commit` step 2: the probe's `env` refusal, the only refusal either shares with
 * `plan` (C:cli-and-exit-codes: `env` for any subcommand, `state` only for `plan` and
 * `infer`). Shared by `releaseRefusals` and `commitRefusals`, which differ only in the
 * KD-S78 error string's subcommand word.
 */
async function subcommandRefusals(ctx, subcommand) {
  const refusal = planRefusal(ctx.probe);
  if (refusal !== null && refusal.code === 'env') return { refusal };
  const { repo } = ctx.probe;
  if (repo === null || repo.kind !== 'worktree') {
    // Not a repo, a bare repository, or git timed out: what this subcommand does here is
    // unsettled (KD-S78, docs/spec/known-deficiencies.md), not merely a slice not yet
    // scheduled.
    throw new Error(`${subcommand} outside a working tree is unsettled (KD-S78)`);
  }
  ctx.toplevel = repo.toplevel;
  return undefined;
}

/** `release` step 2: see `subcommandRefusals`. */
async function releaseRefusals(ctx) {
  return subcommandRefusals(ctx, 'release');
}

/** `release` step 3: M12 `releaseById`, a no-op unless the lock holds this `planId`. */
async function releaseRun(ctx) {
  const result = releaseById({ toplevel: ctx.toplevel, planId: ctx.values.plan, now: ctx.injected.now });
  // A live `call.lock` on the run (RUN-02): `busy`, the only `lock` refusal `release` raises.
  if (!result.ok) return { refusal: { code: result.code, message: result.message } };
  return { status: 'nothing', reason: result.released ? 'released' : 'already-ended' };
}

const RELEASE_STEPS = Object.freeze([probeRepo, releaseRefusals, releaseRun]);

/**
 * `commit` step 2: see `subcommandRefusals`. `commit --plan` implies a prior successful
 * `plan`, so the "outside a working tree" case is left unsettled the same way `release`'s
 * own equivalent is (KD-S78): a slice that reaches it is not yet scheduled.
 */
async function commitRefusals(ctx) {
  return subcommandRefusals(ctx, 'commit');
}

/** `commit` step 3: M12 `open`, the whole call's own lock check (RUN-04). */
async function openRun(ctx) {
  const opened = open(ctx.values.plan, { toplevel: ctx.toplevel, now: ctx.injected.now });
  if (!opened.ok) return { refusal: { code: opened.code, message: opened.message } };
  // Marks that `open` succeeded, so `commit`'s `finally` knows there is a `call.lock` to
  // close (a failed `open` leaves nothing for `close` to do).
  ctx.opened = true;
  return undefined;
}

// `commit` step 4 (temporary): ends the call at once with no commits. With no group-commit
// behaviour built yet (M14/M16), a matched lock's call falls straight through to this stub;
// EXE-02 replaces it with the real per-group loop.
async function stubEnd() {
  return { commits: [] };
}

const COMMIT_STEPS = Object.freeze([probeRepo, commitRefusals, openRun, stubEnd]);

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
  // GIT-02: `notices` lives on `ctx` from the start, so `probeRepo` (step 1) can queue the
  // detached-HEAD notice before any later step runs.
  const ctx = { injected, cwd, provisional: null, notices: [] };
  let facts;
  try {
    facts = await runSteps(PLAN_STEPS, ctx);
  } finally {
    // No outcome built yet takes the lock (step 7, CHG-03b), so every one discards the
    // provisional folder, a thrown `internal` included (C:run-folder). `discard` never
    // throws: a removal error becomes a notice and never changes the outcome. Only a reply
    // carries notices so far; a refusal or `internal` drops it (KD-R64).
    const notice = ctx.provisional === null ? null : ctx.provisional.discard();
    if (notice !== null) ctx.notices.push(notice);
  }
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  return {
    output: {
      planId: null,
      runDir: null,
      // With no mode flag an empty index resolves to `split` (C:plan `mode`); a clean tree
      // has an empty index. M15 `resolveMode` replaces this at step 4.
      mode: 'split',
      // GIT-02: `state` (C:plan `state.kind`) and `expectedHead` (`null` when unborn; stored
      // for GIT-09/EXE's later head-moved checks, ahead of CHG-03b's own `state.json` write).
      state: ctx.state,
      expectedHead: ctx.expectedHead,
      reply: await finalReply({ ...facts, notices: ctx.notices }, ctx),
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

/**
 * Runs `commit --plan <planId> --all` (C:commit-release `commit`, M12 `open`).
 *
 * `open` is the whole call's own lock check (RUN-04): `taken-over` (the lock holds another
 * `planId`, or its own lock/`call.lock`/folder vanishes mid-call with a late `ENOENT`) and
 * `ended` (no lock, or a state `version` mismatch) are refused before any group-commit work;
 * `busy` covers only a live `call.lock`. With no group-commit behaviour built yet (M14/M16),
 * a matched lock's call falls straight through to a stub that ends it at once, exit 0, with
 * no commits; EXE-02 replaces the stub with the real per-group loop. `run.close()` always
 * runs for a call that reached a successful `open` (success or a later failure alike), never
 * when `open` itself failed (there is then no call.lock to close).
 *
 * The success envelope is kept bare on purpose: the full `commits`/`failed`/`remaining`/
 * `reply` shape (C:commit-release, C:reply-and-handback) needs a real `reply.status` the
 * stub cannot honestly report (`"committed"` requires at least one commit; `"nothing"`'s
 * `reason` union does not yet have an entry for this stub). The `reply` with
 * `status: "committed"` is asserted first in INT-02 (docs/roadmap/12-integration.md), which
 * is the natural place to build that reply surface instead of inventing a placeholder here
 * that it would have to reconcile or rip out; EXE-02 builds the per-group loop itself.
 *
 * @param {{ plan: string }} values the parsed and validated `commit` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 */
export async function commit(values, injected, { cwd }) {
  const ctx = { injected, cwd, values, opened: false };
  try {
    const facts = await runSteps(COMMIT_STEPS, ctx);
    if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
    return { output: facts };
  } finally {
    // `close` only after a successful `open` (`ctx.opened`): a failed `open` (`taken-over`,
    // `ended`, `busy`) leaves no `call.lock` of this call's own to close.
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
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
