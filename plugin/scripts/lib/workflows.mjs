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
// step 1 to also load the user layer, read regardless of repo state. GIT-02 adds a plan-only
// step right after the shared probe (`readHeadState`, review-GIT-02 finding 5): it stores the
// HEAD state and expected HEAD on `ctx` and queues the detached-HEAD notice, so `release` and
// `commit`, which share `probeRepo` but not this step, never spawn the extra status call. GIT-03 widens the same step to also
// read the in-progress state (M3 `inProgressState`) and store it as `ctx.inProgress`, read by
// step 2's `planRefusal`. GIT-04 widens it again, with the same `ctx.probe` HEAD state call's
// `unmerged` lines and a new M3 `commitEncoding` config read, run concurrently with the
// in-progress read since neither depends on the other's result. CHG-03 builds step 4's M10
// `inventory` (tracked modifications only), step 5's snapshot (M10 `snapshot` and
// `assignIds`: the units, the unit table, the `id → hash` map and the `tracked` list with M9
// `bucketOf`, all on `ctx`). CHG-03b builds step 7 (`state.json`, the run lock with no
// takeover, `plan.json`, in that order) and step 8's in-process hunk index, and drops GIT-02's
// stdout `state`/`expectedHead` stand-in (KD-R65: they are stored in `plan.json` and
// `state.json`). RUN-06 adds step 7's `held` and the HEAD re-read, and `--reword`'s
// clean-tree lock; CHG-04 step 4's index fingerprint (stored in `state.json`) and step 7's
// re-read of it; the sweep is RUN-08's. GIT-09 adds `--reword`'s facts to the plan-only
// HEAD step and their step 2 refusals, and a history step before step 7 (`recentSubjects`,
// `oldMessage`), stored in `state.json`, `plan.json` and the hunk index. CFG-08 widens step 1
// again, with M5 `resolveAttribution` (the tracer reads no settings and never refuses): the
// resolved `{ trailer, source }` is stored as `ctx.attribution` for step 7 to write into
// `state.json` and `plan.json`, ahead of `recentSubjects` in both (C:run-folder). CHG-05
// widens step 4's inventory (candidates, hidden, staged-new, pre-staged) and points step 5's
// snapshot at the temporary index in the run folder's `git-index` (a failed `git add -N` is
// `git-failed`); step 7 stores the lists in `state.json` and `plan.json`. Later
// slices insert the other rows (3 lock peek, 5 scan, 8 guard state) in their place in
// PLAN_STEPS, and widen these.
//
// `release` (RUN-01) runs its own step table the same way: probe, M12 `releaseById`, then the
// `nothing` reply ending with the tree state. RUN-02 added the `call.lock` and `busy`;
// RUN-03 the 45 s M15 `releaseDeadline` (`run-policy.mjs`) on the tree-state read.
//
// `commit` (RUN-04) also runs its own step table (`COMMIT_STEPS`) the same way: probe, the
// shared `subcommandRefusals`, M12 `open`, then a stub that ends the call at once with no
// commits; EXE-02 replaces the stub with the real per-group loop.

import {
  commitEncoding, head, headState, inProgressState, isTracked, oldMessage, probe, recentSubjects,
  rewordFacts,
} from './repo-probe.mjs';
import { assignIds, indexFingerprint, inventory as takeInventory, snapshot, treeState } from './change-set.mjs';
import { bucketOf } from './path-classifier.mjs';
import { releaseById, open, close, create, RUN_DIR_NAME, STATE_VERSION } from './run.mjs';
import { renderHunks } from './hunk-index.mjs';
import { gitPath } from './process-adapter.mjs';
import { reply } from './reply.mjs';
import { planRefusal, releaseDeadline } from './run-policy.mjs';
import { kindForDomainCode } from './domain-codes.mjs';
import { loadConfig } from './config.mjs';
import { resolveAttribution } from './attribution.mjs';

// GIT-02: the detached-HEAD notice (Q21, story 183), recorded verbatim in
// C:cli-and-exit-codes's recorded-texts table (review-GIT-02 finding 9).
const DETACHED_HEAD_NOTICE = 'HEAD is detached: new commits will not be on any branch';

// RUN-06: the `head-moved` refusal text (Q18), recorded verbatim in C:cli-and-exit-codes.
const HEAD_MOVED_TEXT = 'HEAD moved since plan (commit made elsewhere?), run /commit again';

// CHG-04: the `index-changed` refusal text. C:cli-and-exit-codes records no text for it, so
// tests assert the domain code's kind and that the text names the index.
const INDEX_CHANGED_TEXT = 'the index changed since plan (staged elsewhere?), run /commit again';

/**
 * Step 1: probe the repo state, git and Node versions (M3). Shared with `release`/`commit`;
 * never reads HEAD state itself (see `readHeadState`).
 */
async function probeRepo(ctx) {
  ctx.probe = await probe({ cwd: ctx.cwd, env: ctx.injected.env, now: ctx.injected.now });
  return undefined;
}

/**
 * `plan`-only step, right after `probeRepo`: reads the HEAD state (M3 `headState`) and stores
 * it, and the expected HEAD, on `ctx`; a detached HEAD queues the notice. Also reads the
 * in-progress state (M3 `inProgressState`, GIT-03) and stores it as `ctx.inProgress`, for step
 * 2's `planRefusal` (`preFolderRefusals`) to refuse on. GIT-04 widens it to also store
 * `ctx.unmerged` (from the same `headState` call's `u` lines) and `ctx.commitEncoding` (M3
 * `commitEncoding`), both read for the same `planRefusal` call; the in-progress and encoding
 * calls are independent reads, so they run concurrently through `Promise.all` (review-GIT-04
 * finding 14). `release` and `commit` run `probeRepo` but never this step, so they never
 * spawn either status call or the config call (review-GIT-02 finding 5); since only `plan`
 * calls it, no duck-typing of `ctx.notices` is needed to tell the subcommands apart
 * (review-GIT-02 finding 11). GIT-09: with `--reword` it also reads M3 `rewordFacts` (unborn,
 * merge commit, root commit, pushed; C:plan step 1) for step 2's reword rows, but only once
 * `inProgress`/`unmerged`/`encoding` are known not to refuse already (review-GIT-09 finding
 * 5): a preview `planRefusal` call over those facts, with `reword` forced `null`, decides
 * whether to spawn it at all, one extra sequential step past the `Promise.all` below, so a
 * throw from `rewordFacts` can never mask an earlier refusal as `internal`. Without
 * `--reword`, or when an earlier row would already refuse, `ctx.reword` stays `null` and
 * nothing is spawned.
 */
async function readHeadState(ctx) {
  const { repo } = ctx.probe;
  if (repo !== null && repo.kind === 'worktree') {
    const { env, now } = ctx.injected;
    const result = await headState({ cwd: repo.toplevel, env, now });
    ctx.state = { kind: result.kind, branch: result.branch, unborn: result.unborn };
    ctx.expectedHead = result.head;
    if (result.kind === 'detached') ctx.notices.push(DETACHED_HEAD_NOTICE);
    ctx.unmerged = result.unmerged;
    const [inProgress, encoding] = await Promise.all([
      inProgressState({ cwd: repo.toplevel, env, now }),
      commitEncoding({ cwd: repo.toplevel, env, now }),
    ]);
    ctx.inProgress = inProgress;
    ctx.commitEncoding = encoding;
    // review-GIT-09 finding 5: an earlier row (env, in-progress, unmerged, encoding) that
    // would refuse anyway must stop the reword read before it ever runs.
    const earlierRefusal = planRefusal({
      ...ctx.probe, inProgress, unmerged: ctx.unmerged, commitEncoding: encoding, reword: null,
    });
    ctx.reword = earlierRefusal === null && ctx.values.reword === true
      ? await rewordFacts({ cwd: repo.toplevel, env, now, head: result.head })
      : null;
  }
  return undefined;
}

/**
 * `plan` step 1 (config part): M4 `loadConfig`. CFG-04: the user layer is read from the
 * injected Claude home regardless of repo state (C:plan step 2 puts `config` ahead of
 * `state`, so a bad user layer must refuse even outside a usable repo); the repo layer is
 * read only when the probe found a worktree to read it from. `release` never runs this: it
 * shares only the `env` refusal with `plan` (C:cli-and-exit-codes), so it never needs a
 * config load. CFG-08 adds M5 `resolveAttribution` here too, the same step C:plan step 1
 * names ("resolve the attribution"): the tracer reads no settings and never refuses, so it
 * cannot change `preFolderRefusals`' outcome; it is stored on `ctx.attribution` for
 * `storeAndLock` (step 7) to write into `state.json` and `plan.json`, read from there by
 * later calls instead of re-resolved. The tracer's `warnings` is always `[]` (no settings are
 * read yet, so there is nothing to warn about); CFG-09, the first slice that can produce one,
 * wires it into both `ctx.notices` and `plan.json`'s (not yet existing) `warnings` field.
 */
async function loadConfigLayers(ctx) {
  const toplevel = ctx.probe.repo !== null && ctx.probe.repo.kind === 'worktree'
    ? ctx.probe.repo.toplevel
    : null;
  ctx.config = loadConfig({ toplevel, claudeHome: ctx.injected.claudeHome });
  const { trailer, source } = resolveAttribution({
    env: ctx.injected.env, claudeHome: ctx.injected.claudeHome, toplevel,
  });
  ctx.attribution = { trailer, source };
  return undefined;
}

/** Step 2: pre-folder refusals (M15 `planRefusal`); none of them creates the run folder. */
async function preFolderRefusals(ctx) {
  const refusal = planRefusal({
    ...ctx.probe,
    config: ctx.config,
    inProgress: ctx.inProgress,
    unmerged: ctx.unmerged,
    commitEncoding: ctx.commitEncoding,
    reword: ctx.reword,
  });
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

/**
 * Step 4: M10 `indexFingerprint` (CHG-04), read first, before the inventory's own git calls,
 * so step 7's re-read covers every index change since the inventory began (C:plan step 4).
 * Then M10 `inventory`: tracked changes, candidates, hidden, staged-new and pre-staged paths
 * (CHG-05). Also the
 * mode decision (C:plan step 4, review-RUN-06 finding 7): `reword` or `split` for now; the
 * full `modeChoice` (M15 `resolveMode`) is a later slice's.
 */
async function inventory(ctx) {
  ctx.indexFingerprint = await indexFingerprint({ toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now });
  ctx.inventory = await takeInventory({ toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now });
  ctx.mode = ctx.values.reword === true ? 'reword' : 'split';
  return undefined;
}

/**
 * Step 5 (snapshot part, CHG-03): M10 `snapshot` in `split` and `assignIds`. Puts on `ctx`
 * the units (bodies included, for M13), the unit table rows CHG-03b stores in `state.json`
 * (`{ id, hash, path, oldPath, status, kind }`), the `id → hash` map and `plan.json`'s
 * `tracked` list (`bucket` from M9 `bucketOf`; an untracked candidate's `A` unit is left to
 * `untracked.candidates`). CHG-05: the snapshot diffs against the temporary index in the run
 * folder's `git-index`, built from the stored lists; a failed `git add -N` is the
 * `git-failed` refusal. A clean tree takes no snapshot. The scan part is CHG-16's.
 */
async function snapshotUnits(ctx) {
  if (ctx.mode === 'reword') {
    // RUN-06: `reword` takes no snapshot of the working tree (C:plan-hunks: HEAD's own diff,
    // CHG-15's). Until CHG-15 lands its units are empty, so the hunk index is too.
    ctx.units = [];
    ctx.unitTable = [];
    ctx.idMap = {};
    ctx.tracked = [];
    return undefined;
  }
  if (ctx.inventory.clean) return undefined;
  let units;
  try {
    units = assignIds(await snapshot({
      mode: 'split',
      storedLists: {
        candidates: ctx.inventory.candidates.map((candidate) => candidate.path),
        stagedNew: ctx.inventory.stagedNew,
      },
      indexPath: `${ctx.provisional.runDir}/git-index`,
      unborn: ctx.state.unborn,
      toplevel: ctx.toplevel,
      env: ctx.injected.env,
      now: ctx.injected.now,
    }));
  } catch (err) {
    // C:plan: a non-zero `git add -N` into the temporary index is exit 4 `git`.
    if (err.domainCode === 'git-failed') return { refusal: { code: 'git-failed', message: err.message } };
    throw err;
  }
  ctx.units = units;
  ctx.unitTable = units.map(({ id, hash, path, oldPath, status, kind }) => ({ id, hash, path, oldPath, status, kind }));
  ctx.idMap = Object.fromEntries(units.map((unit) => [unit.id, unit.hash]));
  // An untracked candidate's `A` unit is listed under `untracked.candidates`, not `tracked`.
  const candidatePaths = new Set(ctx.inventory.candidates.map((candidate) => candidate.path));
  ctx.tracked = units
    .filter((unit) => !(unit.status === 'A' && candidatePaths.has(unit.path)))
    .map(({ path, oldPath, status, added, deleted }) => ({
      path, oldPath, status, bucket: bucketOf(path), added, deleted,
    }));
  return undefined;
}

/**
 * Step 6: post-scan refusals. A clean tree ends the call with `nothing`, except in `reword`,
 * which takes the lock on a clean tree too (C:plan step 6, RUN-06).
 */
async function postScanRefusals(ctx) {
  if (ctx.inventory.clean === true && ctx.mode !== 'reword') return { status: 'nothing', reason: 'clean' };
  return undefined;
}

/**
 * GIT-09, ahead of step 7 (whose `state.json` stores them): M3 `recentSubjects` and, in
 * `reword`, `oldMessage`, both read at the HEAD step 1 recorded, so a commit made since is
 * never read (step 7's HEAD re-read refuses that run anyway). Read only once the clean-tree
 * and refusal endings are behind, so those spawn neither read.
 */
async function readHistory(ctx) {
  const { env, now } = ctx.injected;
  const at = { cwd: ctx.toplevel, env, now, head: ctx.expectedHead };
  const [subjects, message] = await Promise.all([
    recentSubjects(at),
    ctx.mode === 'reword' ? oldMessage(at) : undefined,
  ]);
  ctx.recentSubjects = subjects;
  ctx.oldMessage = message;
  return undefined;
}

/**
 * Step 7 (CHG-03b): in contract order (C:run-folder, C:plan step 7), M12 writes `state.json`
 * (the stored facts so far: `version`, `mode`, `interactive`, the expected `head`, the index
 * fingerprint, the unit table and the `id → hash` map; the later rows arrive with their slices), then takes the run
 * lock (`acquire`, no takeover; RUN-06: a lost race → `held`, then the HEAD re-read; the
 * takeover path is RUN-21's), then writes `plan.json`. A lock is never taken without `state.json` in place. From
 * the `acquire` on, `ctx.run` is set, so `plan`'s `finally` releases the lock on a throw.
 * CFG-08 adds `attribution` (`{ trailer, source }`, step 1's `ctx.attribution`) to both
 * files, in the contract's order (C:run-folder): ahead of `recentSubjects`, so M16/M17 read
 * the resolved trailer from here instead of re-resolving it. The tracer's `trailer` is never
 * `null`, so both files always get the full `{ trailer, source }` object; C:plan l.248 wants
 * `plan.json`'s `attribution` as `null` when no trailer is added (while `state.json` always
 * keeps `{ trailer, source }`), a split CFG-09 must make once the resolver can return `null`.
 */
async function storeAndLock(ctx) {
  const { planId, runDir } = ctx.provisional;
  ctx.provisional.write('state.json', `${JSON.stringify({
    version: STATE_VERSION,
    mode: ctx.mode,
    interactive: ctx.values['no-user'] !== true,
    head: ctx.expectedHead,
    indexFingerprint: ctx.indexFingerprint,
    units: ctx.unitTable,
    idMap: ctx.idMap,
    // CHG-05 (C:run-folder): the lists the temporary index is rebuilt from.
    preStaged: ctx.inventory.preStaged,
    candidates: ctx.inventory.candidates.map((candidate) => candidate.path),
    stagedNew: ctx.inventory.stagedNew,
    stagedExcluded: ctx.inventory.stagedExcluded,
    attribution: ctx.attribution,
    recentSubjects: ctx.recentSubjects,
    // GIT-09: `reword` only (C:run-folder): HEAD's message, and whether HEAD is a root
    // commit, which CHG-15's snapshot diffs against the empty tree.
    ...(ctx.mode === 'reword' ? { oldMessage: ctx.oldMessage, rootCommit: ctx.reword.root } : {}),
  })}\n`);
  // A race lost to another run's lock (`held`, RUN-06) refuses `lock`; with no `ctx.run`,
  // `plan`'s `finally` deletes only this call's own provisional folder. `holder` (the
  // `planId`/`created`/`touched` the failure shape defines) rides along for RPL-04 to wire
  // into the `failed` reply.
  const acquired = ctx.provisional.acquire({ now: ctx.injected.now });
  if (!acquired.ok) return { refusal: { code: acquired.code, message: acquired.message, holder: acquired.holder } };
  ctx.run = acquired.run;
  // RUN-06: re-read HEAD once the lock is held, against the HEAD step 1 recorded (C:plan
  // step 7): another run that committed since the inventory ends this one with `head-moved`,
  // and `plan`'s `finally` releases the lock and deletes the folder.
  const { env, now } = ctx.injected;
  if (await head({ cwd: ctx.toplevel, env, now }) !== ctx.expectedHead) {
    return { refusal: { code: 'head-moved', message: HEAD_MOVED_TEXT } };
  }
  // CHG-04: then the index fingerprint, against step 4's (the one `state.json` stores for
  // M16): changed with HEAD unchanged → `index-changed` (CLI kind `diff-changed`), released
  // and deleted the same way. Not checked in `reword`, which `--amend --only` never touches.
  if (ctx.mode !== 'reword'
    && await indexFingerprint({ toplevel: ctx.toplevel, env, now }) !== ctx.indexFingerprint) {
    return { refusal: { code: 'index-changed', message: INDEX_CHANGED_TEXT } };
  }
  ctx.run.write('plan.json', entryPerLine({
    version: 1,
    ok: true,
    planId,
    runDir,
    mode: ctx.mode,
    state: ctx.state,
    clean: ctx.inventory.clean,
    preStaged: ctx.inventory.preStaged,
    tracked: ctx.tracked,
    // CHG-05: `collapsed` stays empty until CHG-13's caps.
    untracked: {
      candidates: ctx.inventory.candidates.map(({ path, binary }) => ({ path, bucket: bucketOf(path), binary })),
      collapsed: [],
      hidden: ctx.inventory.hidden,
    },
    stagedExcluded: ctx.inventory.stagedExcluded,
    attribution: ctx.attribution,
    recentSubjects: ctx.recentSubjects,
  }));
  return undefined;
}

// `plan.json` holds one top-level entry per line (C:run-folder), still one JSON object.
function entryPerLine(object) {
  const lines = Object.entries(object).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * Step 8 (CHG-03b, `plan --hunks` part): M13 `renderHunks` over the snapshot's units, in
 * process; M12 writes `hunks.txt` and the output object becomes `plan`'s stdout `hunks`.
 * Guard state and the stored notices are S1's and later slices'; the effective config
 * values are CFG-05's (empty until then); the spill to `hunks.json` is CHG-18's.
 */
async function renderHunkIndex(ctx) {
  const { stdoutObj, hunksTxt } = renderHunks(
    {
      runDir: ctx.provisional.runDir,
      mode: ctx.mode,
      config: { values: {} },
      recentSubjects: ctx.recentSubjects,
      oldMessage: ctx.oldMessage,
    },
    ctx.units,
  );
  ctx.run.write('hunks.txt', hunksTxt);
  return { hunks: stdoutObj };
}

const PLAN_STEPS = Object.freeze([
  probeRepo, readHeadState, loadConfigLayers, preFolderRefusals, createRunFolder, inventory,
  snapshotUnits, postScanRefusals, readHistory, storeAndLock, renderHunkIndex,
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
  // Only bare `plan`, `plan --split` and `plan --reword` (RUN-06: the lock on a clean tree;
  // its reword facts GIT-09's, its snapshot CHG-15's) are built: every other flag
  // changes the mode or the clean-tree outcome (C:plan `mode`).
  const unbuilt = ['dictated', 'staged', 'take-over', 'hunks'].filter((f) => values[f] !== undefined);
  if (unbuilt.length > 0) {
    throw new Error(`plan ${unbuilt.map((f) => `--${f}`).join(' ')} is not built yet`);
  }
  // GIT-02: `notices` lives on `ctx` from the start, so `probeRepo` (step 1) can queue the
  // detached-HEAD notice before any later step runs.
  const ctx = { injected, cwd, values, provisional: null, run: null, notices: [] };
  let facts;
  try {
    facts = await runSteps(PLAN_STEPS, ctx);
  } finally {
    // Every outcome but the hunk index ends without the lock (C:run-folder), a thrown
    // `internal` included: a throw after `acquire` (`ctx.run`) releases the lock first, one
    // before it has no lock to release. Neither `release` nor `discard` throws: a removal
    // error becomes a notice and never changes the outcome. A `release()` that could not
    // remove the lock (`busy`) reports `kept: true` and the folder is left alone too, so the
    // lock and its folder stay consistent for the next `/commit` (review-CHG-03b finding 2);
    // only a reply carries notices so far; a refusal or `internal` drops it (KD-R64).
    if (facts === undefined || facts.hunks === undefined) {
      const released = ctx.run?.release() ?? { notice: null, kept: false };
      if (released.notice !== null) ctx.notices.push(released.notice);
      if (!released.kept) {
        const discarded = ctx.provisional?.discard() ?? null;
        if (discarded !== null) ctx.notices.push(discarded);
      }
    }
  }
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  if (facts.hunks !== undefined) {
    // The lock is held and the worker goes on with the hunk index (C:plan): `reply` is null.
    const { planId, runDir } = ctx.provisional;
    return { output: { planId, runDir, mode: ctx.mode, reply: null, hunks: facts.hunks } };
  }
  return {
    output: {
      planId: null,
      runDir: null,
      // With no mode flag an empty index resolves to `split` (C:plan `mode`); a clean tree
      // has an empty index. M15 `resolveMode` replaces this at step 4.
      mode: 'split',
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
