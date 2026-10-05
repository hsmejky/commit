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
// `git-failed`); step 7 stores the lists in `state.json` and `plan.json`. GIT-10 adds M11
// `probeSigning` to step 6, after the clean-tree check: its `ready: false` refuses through
// M15 `planRefusal`, `"prompt"` queues the signing note, and step 7 stores the result in
// `plan.json` `signing`. CFG-10 widens step 1's M5 call again, with the injected
// `projectDir` (CFG-08/CFG-09's `toplevel` param, always ignored, is dropped), so the
// project-local and project settings layers feed `resolveAttribution` ahead of the user
// layer. CHG-16 adds step 5's scan part (`scanDiff`, after `snapshotUnits`): M8 `scanUnits`
// over the snapshot's units, with `loadConfigLayers`' compiled `scanIgnore` matchers
// (`ctx.scanIgnoreMatchers`, kept off `ctx.config`) and the injected `osUser`; `ctx.scan`
// (`plan.json` `scan`) and `ctx.scanMap` (`state.json` `scanned`, read by `renderHunkIndex`
// to withhold a hit's whole body) are stored, alongside `ctx.scanLines` (`state.json`
// `scanLines`, PLN-04: each hit's line, parallel to `scanned`, read by M14 `validatePlan`
// for the left-out-hit notice's `path:line`, never by `renderHunkIndex`). Later
// slices insert the other row (3 lock peek) in its place in
// PLAN_STEPS, and widen these.
//
// `release` (RUN-01) runs its own step table the same way: probe, M12 `releaseById`, then the
// `nothing` reply ending with the tree state. RUN-02 added the `call.lock` and `busy`;
// RUN-03 the 45 s M15 `releaseDeadline` (`run-policy.mjs`) on the tree-state read.
//
// `commit` (RUN-04) also runs its own step table (`COMMIT_STEPS`) the same way: probe, the
// shared `subcommandRefusals`, M12 `open`, then (EXE-02) the M16 per-group loop
// (`commit-executor.mjs`), releasing the run once no group remains, or on a `head-moved` or
// `index-changed` refusal (EXE-06, EXE-07), which also ends the run.

import path from 'node:path';

import {
  HEAD_MOVED_TEXT, commitEncoding, head, headState, historyMessages, inProgressState, isTracked,
  oldMessage, probe, recentSubjects, rewordFacts,
} from './repo-probe.mjs';
import {
  assignIds, indexFingerprint, inventory as takeInventory, matchIds, snapshot, snapshotBlob, trackedDirectories,
  treeState, unplannableCaseRenames, unstagedUnits,
} from './change-set.mjs';
import { applyCaps, bucketOf } from './path-classifier.mjs';
import {
  releaseById, releaseOpen, open, close, create, readState, readWorkerPlan, writeState, writeRunFile,
  sweep, insideRunDir, runDirOf, RUN_DIR_NAME, STATE_VERSION, lockHolderClock,
} from './run.mjs';
import { INDEX_CHANGED_TEXT, UNMATCHED_TEXT, commitAll } from './commit-executor.mjs';
import { validatePlan } from './plan-validator.mjs';
import { renderHunks } from './hunk-index.mjs';
import { gitPath, withDeadline } from './process-adapter.mjs';
import { escapePath, reply } from './reply.mjs';
import {
  afterCheck, checkGate, cleanupDeadline, computeConfirm, deadline, onLintFailure, planRefusal,
  releaseDeadline, resolveMode,
} from './run-policy.mjs';
import { kindForDomainCode } from './domain-codes.mjs';
import { loadConfig, readLayers, scanIgnoreChanged, isRepoConfigPath, REPO_CONFIG_PATH } from './config.mjs';
import { resolveAttribution } from './attribution.mjs';
import { scanUnits } from './scanner.mjs';
import { probeSigning } from './signing-probe.mjs';
import { guardState } from './heartbeat.mjs';
import { configFor, infer as inferFromMessages } from './history-inference.mjs';

// GIT-02: the detached-HEAD notice (Q21, story 183), recorded verbatim in
// C:cli-and-exit-codes's recorded-texts table (review-GIT-02 finding 9).
const DETACHED_HEAD_NOTICE = 'HEAD is detached: new commits will not be on any branch';

// GIT-10: the signing prompt notice (Q18, story 171), recorded verbatim in
// C:cli-and-exit-codes; queued when M11 reports `ready: "prompt"`.
const SIGNING_PROMPT_NOTICE = 'signing enabled; a passphrase prompt may appear';

// GRD-17: the guard notice for a `not-seen` guard state (Q23), recorded verbatim in
// C:cli-and-exit-codes; the run goes on.
const GUARD_NOTICE = 'Guard hook did not run: `node` missing from the hook\'s PATH, plugin hooks '
  + 'disabled, or `disableAllHooks` set. Direct `git commit` is not blocked.';

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
 * names ("resolve the attribution"): it never refuses, so it cannot change
 * `preFolderRefusals`' outcome; the result is stored on `ctx.attribution` for `storeAndLock`
 * (step 7) to write into `state.json` and `plan.json`, read from there by later calls instead
 * of re-resolved. CFG-09 reads the user settings layer and can produce a warning (a dropped
 * `attribution.commit` line): it is queued into `ctx.notices` here, the same sink
 * `probeRepo`'s detached-HEAD notice uses, and also collected on `ctx.warnings` for
 * `storeAndLock` to write into `plan.json`'s `warnings` field (C:plan). CFG-10 passes
 * `ctx.injected.projectDir` (the entry point's own `CLAUDE_PROJECT_DIR`-or-`cwd` resolution,
 * no walk-up, PRE-11) so M5 also reads the project-local and project layers ahead of the
 * user one; it no longer takes `toplevel`, which CFG-08/CFG-09 accepted and ignored. CFG-11
 * passes `ctx.injected.managedDir` (the entry point's platform-derived managed directory,
 * never read from `env`, PRE-16) so M5 reads the managed layer ahead of every other one.
 * CFG-05: on success `ctx.config` is M4's effective `{ values, sources }` (never bare
 * `null` any more), read by `storeAndLock` (step 7) into `state.json` and `plan.json`. CFG-06
 * adds `loadConfig`'s own `warnings` (unknown key, unknown value of a known key, a known
 * repo-only key given in the wrong layer, Q6): stripped off `ctx.config` before it is stored
 * (which stays exactly `{ values, sources }`, C:plan `config`) and queued the same way as
 * M5's warnings, onto `ctx.notices` and `ctx.warnings`; each is also written to stderr as it
 * is queued (the entry point injects the real stream as `ctx.injected.stderr`, read only
 * here, so a direct `workflows.plan` call with no `stderr` injected is unaffected,
 * `?.`-guarded). CFG-07: `loadConfig` also reads `scanIgnore` at HEAD (read-only git
 * calls), so it gets `readHeadState`'s `unborn` (none to read) and the injected `env`/`now`;
 * its HEAD warning is queued like the others, and its compiled matchers are not stored.
 */
async function loadConfigLayers(ctx) {
  const toplevel = ctx.probe.repo !== null && ctx.probe.repo.kind === 'worktree'
    ? ctx.probe.repo.toplevel
    : null;
  const configResult = await loadConfig({
    toplevel, claudeHome: ctx.injected.claudeHome, unborn: ctx.state?.unborn ?? false,
    env: ctx.injected.env, now: ctx.injected.now,
  });
  if (configResult.error !== undefined) {
    ctx.config = configResult;
  } else {
    const { values, sources, warnings: configWarnings, scanIgnore } = configResult;
    ctx.config = { values, sources };
    // CHG-16: the compiled M7 matchers, kept off `ctx.config` (which stays exactly
    // `{ values, sources }`, C:plan `config`) so `scanDiff` (step 5) can exempt a matched
    // unit's path from the scan (Q10). `scanIgnoreChanged`/`scanIgnoreUnits` (a `scanIgnore`
    // edit itself flagging the repo config's own units) are SCN-14's, set in `scanDiff`.
    ctx.scanIgnoreMatchers = scanIgnore;
    for (const warning of configWarnings) {
      ctx.notices.push(warning);
      ctx.warnings.push(warning);
      ctx.injected.stderr?.write(`${warning}\n`);
    }
  }
  const { trailer, source, warnings } = resolveAttribution({
    env: ctx.injected.env, claudeHome: ctx.injected.claudeHome, projectDir: ctx.injected.projectDir,
    managedDir: ctx.injected.managedDir,
  });
  ctx.attribution = { trailer, source };
  for (const warning of warnings) {
    ctx.notices.push(warning);
    ctx.warnings.push(warning);
  }
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
 * outcome that takes no lock (`plan`'s `finally`). Then M12 `peek` (RUN-07) checks the run
 * lock read-only, before any inventory work: a live lock refuses `lock`; a stale one is taken
 * over here (RUN-21): M12 `acquire({ takeOver })`, then `finishTakeover` deletes the old
 * folder and the renamed lock. From then on `ctx.run` holds the lock, so step 7 takes none.
 */
async function createRunFolder(ctx) {
  const { env, now } = ctx.injected;
  const [excludePath] = await gitPath(['info/exclude'], { cwd: ctx.toplevel, env, now });
  const tracked = await isTracked(RUN_DIR_NAME, { cwd: ctx.toplevel, env, now });
  const created = create({ toplevel: ctx.toplevel, excludePath, tracked });
  if (!created.ok) return { refusal: { code: created.code, message: created.message } };
  ctx.provisional = created.provisional;
  // RUN-07: a read-only `peek` before any inventory work. A live lock refuses `lock` the
  // same way a lost race at step 7 does (RUN-06), carrying the same `holder` shape; `plan`'s
  // `finally` discards this call's own provisional folder since `ctx.run` is never set here.
  const peeked = ctx.provisional.peek({ now: ctx.injected.now });
  if (!peeked.ok) return { refusal: { code: peeked.code, message: peeked.message, holder: peeked.holder } };
  if (peeked.stale === null) return undefined;
  // RUN-21 (Q22, C:plan step 3): the automatic takeover of a stale lock. A takeover that
  // loses a race refuses like a live lock (`held`, a fresh handback naming the lock now in
  // place); `plan`'s `finally` then discards only this call's own provisional folder. Once
  // it holds the lock, every later outcome releases it there too, and the takeover notice,
  // kept on `ctx.notices`, goes into whatever output `plan` ends with (story 210).
  const acquired = ctx.provisional.acquire({ now: ctx.injected.now, takeOver: peeked.stale });
  if (!acquired.ok) return { refusal: { code: acquired.code, message: acquired.message, holder: acquired.holder } };
  ctx.run = acquired.run;
  if (acquired.takeover === null) return undefined;
  ctx.notices.push(acquired.takeover.notice);
  // The taken-over run's index-repair check goes here, before the folder is deleted (RUN-23).
  const finished = ctx.run.finishTakeover();
  if (finished !== null) ctx.notices.push(finished);
  return undefined;
}

/**
 * Step 4: M10 `indexFingerprint` (CHG-04), read first, before the inventory's own git calls,
 * so step 7's re-read covers every index change since the inventory began (C:plan step 4).
 * Then M10 `inventory`: tracked changes, candidates, hidden, staged-new and pre-staged paths
 * (CHG-05), pre-cap (CHG-13: the caps are step 5, `collapseCandidates` below). The mode
 * decision is the next step, `resolveRunMode`.
 */
async function inventory(ctx) {
  ctx.indexFingerprint = await indexFingerprint({ toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now });
  ctx.inventory = await takeInventory({ toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now });
  return undefined;
}

/**
 * Step 4, the mode decision (RUN-13, C:plan step 4, review-RUN-06 finding 7): `--reword`
 * keeps `reword`; otherwise M15 `resolveMode` (no takeover yet: `killedLeftover: false`,
 * RUN-24) over the inventory's counts. `staged-empty` refuses; a `modeChoice` ends the call
 * with counts only, `mode: null` and no run folder (the provisional one is discarded by
 * `plan`'s `finally`).
 */
async function resolveRunMode(ctx) {
  if (ctx.values.reword === true) {
    ctx.mode = 'reword';
    return undefined;
  }
  const flags = { split: ctx.values.split === true, staged: ctx.values.staged === true };
  const decision = resolveMode(flags, indexState(ctx.inventory), false);
  if (decision.refusal !== undefined) return { refusal: decision.refusal };
  if (decision.modeChoice !== undefined) return { status: 'handback', kind: 'modeChoice', ...decision.modeChoice };
  ctx.mode = decision.mode;
  return undefined;
}

// M15 `resolveMode`'s `indexState` from M10's pre-cap inventory (C:plan step 4: candidates
// counted after the hidden rule and before the caps). `staged`: every path the index changes
// against HEAD (`preStaged`, a hidden staged-new path included: its content is staged).
// `other`: `unstagedTracked`'s length (RUN-13) — every path with a worktree change,
// a `git add -p` style `MM` file and a staged-new one edited again (`AM`, a force-added
// `.env` included) alike, since `unstagedTracked` is read straight off the status entries
// and is not narrowed by the hidden rule the way `stagedNew`/`stagedExcluded` are — plus the
// candidates, plus the staged-new paths not in `preStaged` (intent-to-add, `git add -N`
// stages no content; never also in `unstagedTracked`, so never double-counted).
function indexState(inv) {
  const staged = new Set(inv.preStaged);
  const other = inv.unstagedTracked.length
    + inv.candidates.length
    + inv.stagedNew.filter((entry) => !staged.has(entry.path)).length;
  return { staged: staged.size, other };
}

/**
 * Step 4, after the mode decision and only in the resolved `split` mode (C:plan step 4,
 * review-CHG-07 finding 1): a staged case-only rename the temporary index cannot plan (M10
 * `unplannableCaseRenames`, over the pre-cap lists) refuses with `case-rename` (exit 6
 * `state`, CHG-07 decision, Q11). `staged` commits the index as-is and `reword` takes no
 * snapshot, so neither is refused, and a mixed index gets its `modeChoice` first (RUN-13
 * keeps M15 `resolveMode` before this step). The staged-new paths the hidden rule excluded
 * count too: their old path's deletion would be lost the same way (review-CHG-07
 * finding 4). Before the caps, so `stagedExcluded` holds only hidden entries here.
 */
async function refuseCaseRenames(ctx) {
  if (ctx.mode !== 'split') return undefined;
  const { stagedNew, stagedExcluded, tracked } = ctx.inventory;
  const renames = await unplannableCaseRenames({
    stagedNew: [
      ...stagedNew.map((entry) => entry.path),
      ...stagedExcluded.filter((entry) => entry.reason === 'hidden').map((entry) => entry.path),
    ],
    tracked,
    toplevel: ctx.toplevel,
    env: ctx.injected.env,
    now: ctx.injected.now,
  });
  if (renames.length === 0) return undefined;
  return { refusal: { code: 'case-rename', message: caseRenameMessage(renames) } };
}

// `plan`'s own stdout fields, a refusal's `error` object included, stay within 1 kB (C:plan,
// Q24): the message gets at most 900 bytes once JSON-encoded, the rest is the envelope.
const CASE_RENAME_MESSAGE_BUDGET = 900;

// The size of `text` inside a JSON string: UTF-8 bytes after JSON escaping.
function jsonBytes(text) {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

// The longest tail of `text` (whole code points) that fits in `max` JSON bytes behind `…`.
function tailWithin(text, max) {
  if (jsonBytes(text) <= max) return text;
  const chars = [...text];
  let tail = '';
  for (let i = chars.length - 1; i >= 0 && jsonBytes(`…${chars[i]}${tail}`) <= max; i -= 1) {
    tail = `${chars[i]}${tail}`;
  }
  return `…${tail}`;
}

// C:cli-and-exit-codes recorded text: the first five renames, then a count of the rest, each
// path escaped as in the reply (RPL-06 `\xNN`, M17 `escapePath`); when the message would pass
// its budget, every named path is cut to an equal share of it, keeping its tail behind `…`.
function caseRenameMessage(renames) {
  const shown = renames.slice(0, 5)
    .map(({ oldPath, path }) => ({ oldPath: escapePath(oldPath), path: escapePath(path) }));
  const more = renames.length > 5 ? ` and ${renames.length - 5} more` : '';
  const build = (cut) => 'cannot plan a staged case-only rename on a case-insensitive filesystem or with '
    + `core.ignorecase=true: ${shown.map(({ oldPath, path }) => `${cut(oldPath)} → ${cut(path)}`).join(', ')}`
    + `${more}; commit the rename by hand, then run /commit again`;
  const whole = build((p) => p);
  if (jsonBytes(whole) <= CASE_RENAME_MESSAGE_BUDGET) return whole;
  const share = Math.floor((CASE_RENAME_MESSAGE_BUDGET - jsonBytes(build(() => ''))) / (2 * shown.length));
  return build((p) => tailWithin(p, share));
}

/**
 * Step 5 (caps part, CHG-13): M9 `applyCaps` over step 4's pre-cap `candidates` and
 * `stagedNew`, in `split` only, now that the mode decision above has counted them (C:plan
 * step 4; the trap this guards: counting them after the caps would see a collapsed
 * directory's survivors only, review-CHG-13 finding 3). `trackedDirectories` is the one extra
 * git call caps need, skipped when there is nothing to cap. A collapsed directory's paths
 * leave `candidates` and `stagedNew` (so they never reach the temporary index or a scan) for
 * `collapsed` and `stagedExcluded`; other modes keep `collapsed` empty (C:untracked-files).
 * `clean` is recomputed: a tree whose only untracked/staged-new content collapses away is
 * clean, same as `inventory`'s own pre-cap `clean` would have been with nothing to collapse.
 */
async function collapseCandidates(ctx) {
  if (ctx.mode !== 'split') return undefined;
  const { candidates, stagedNew, tracked } = ctx.inventory;
  if (candidates.length + stagedNew.length === 0) return undefined;
  const trackedDirs = await trackedDirectories({
    toplevel: ctx.toplevel, env: ctx.injected.env, now: ctx.injected.now, unborn: ctx.state.unborn,
  });
  const capped = applyCaps(candidates, stagedNew, trackedDirs);
  ctx.inventory.candidates = capped.candidates;
  ctx.inventory.stagedNew = capped.stagedNew;
  ctx.inventory.collapsed = capped.collapsed;
  ctx.inventory.stagedExcluded.push(...capped.stagedExcluded);
  ctx.inventory.clean = tracked.length === 0
    && ctx.inventory.candidates.length === 0 && ctx.inventory.stagedNew.length === 0;
  return undefined;
}

/**
 * Step 5 (snapshot part, CHG-03): M10 `snapshot` in `split` and `assignIds`. Puts on `ctx`
 * the units (bodies included, for M13), the unit table rows CHG-03b stores in `state.json`
 * (`{ id, hash, path, oldPath, status, kind, identityKey }`; `identityKey` is built by
 * CHG-06), the `id → hash` map and `plan.json`'s `tracked` list, one entry per file
 * (`bucket` from M9 `bucketOf`; an untracked candidate's `A` unit is left to
 * `untracked.candidates`). CHG-05: the snapshot diffs against the temporary index in the run
 * folder's `git-index`, built from the stored lists; a failed `git add -N` is the
 * `git-failed` refusal. A clean tree takes no snapshot. The scan part is CHG-16's.
 */
async function snapshotUnits(ctx) {
  if (ctx.mode !== 'reword' && ctx.inventory.clean) return undefined;
  let units;
  const { env, now } = ctx.injected;
  try {
    units = assignIds(ctx.mode === 'reword'
      // CHG-15 (Q20, C:plan-hunks "what is diffed"): HEAD's own diff against its single
      // parent, or the empty tree on a root commit (GIT-09's `rewordFacts.root`, read at
      // step 1). No temporary index, so staged changes never reach these units and the real
      // index is untouched (RUN-06).
      ? await snapshot({ mode: 'reword', head: ctx.expectedHead, root: ctx.reword.root, toplevel: ctx.toplevel, env, now })
      // CHG-14: the index against HEAD only, no temporary index.
      : ctx.mode === 'staged'
      ? await snapshot({ mode: 'staged', toplevel: ctx.toplevel, env, now })
      : await snapshot({
        mode: 'split',
        tracked: ctx.inventory.tracked,
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
  ctx.unitTable = units.map(({ id, hash, path, oldPath, status, kind, identityKey }) => ({
    id, hash, path, oldPath, status, kind, identityKey,
  }));
  ctx.idMap = Object.fromEntries(units.map((unit) => [unit.id, unit.hash]));
  // An untracked candidate's `A` unit is listed under `untracked.candidates`, not `tracked`.
  // CHG-06: one `tracked` entry per file, summing its hunk-level units' counts. `reword`
  // has no candidates, so every unit counts (C:plan: "tracked lists every change").
  // CHG-14 (C:plan): in `staged`, `tracked` lists only the unstaged changes (the worktree
  // against the real index), one entry per file; `unstagedLeft` counts them.
  const candidatePaths = new Set(
    ctx.mode === 'split' ? ctx.inventory.candidates.map((candidate) => candidate.path) : [],
  );
  const trackedUnits = ctx.mode === 'staged'
    ? await unstagedUnits({ toplevel: ctx.toplevel, env, now })
    : units;
  const byPath = new Map();
  for (const { path, oldPath, status, added, deleted } of trackedUnits) {
    if (status === 'A' && candidatePaths.has(path)) continue;
    const entry = byPath.get(path);
    if (entry === undefined) {
      byPath.set(path, { path, oldPath, status, bucket: bucketOf(path), added, deleted });
    } else {
      entry.added += added;
      entry.deleted += deleted;
    }
  }
  ctx.tracked = [...byPath.values()];
  // A plain `mv` target is a candidate whose unit is an `R`: C:plan lists it once, in
  // `tracked`, and drops it from `untracked.candidates` (`state.json` keeps it).
  ctx.renameTargets = new Set(units
    .filter((unit) => unit.status === 'R' && candidatePaths.has(unit.path))
    .map((unit) => unit.path));
  return undefined;
}

/**
 * Maps every scan hit and skipped path to the unit that holds it (C:plan-hunks "scan map"):
 * `{ h4: ["github-token"], h9: "skipped" }`, plus (PLN-04) a parallel `scanLines` map of the
 * same hits' line numbers (`{ h4: [14] }`, never `"skipped"`: a skipped unit has no hit to
 * number), kept separate from `scanned` so `scanned`'s own shape (read by `renderHunkIndex`
 * as `string[] | "skipped"` for the public `hunks.json`/`hunks.txt` "scan" field,
 * C:plan-hunks) never widens. A hit's `(path, line)` belongs to exactly one
 * unit of that path (hunk-level units never share a line; a whole-file unit's one unit
 * holds every line of the file); a path appears in `skipped` once however many of its units
 * are over the limit, so every one of them is flagged. `scanIgnoreUnits` (SCN-14: a
 * `scanIgnore` edit itself flagging the repo config's own units) is computed by M8
 * `scanUnits` straight onto `ctx.scanIgnoreUnits`; this map covers hits and skips only.
 *
 * @throws {Error} when a hit's `(path, line)` matches no unit's `addedLines` (review-CHG-16
 *   finding 2): this cannot happen today (no two units with added lines share a path), so a
 *   hit silently falling through to a kept body would be the wrong default for a secret.
 */
function buildScanMap(units, { hits, skipped }) {
  const unitByPathLine = new Map();
  for (const unit of units) {
    for (const { line } of unit.addedLines ?? []) {
      unitByPathLine.set(`${unit.path}\u0000${line}`, unit.id);
    }
  }
  const scanned = {};
  const scanLines = {};
  for (const { patternId, path, line } of hits) {
    const id = unitByPathLine.get(`${path}\u0000${line}`);
    if (id === undefined) {
      throw new Error(`a scan hit at ${path}:${line} matches no unit's added lines`);
    }
    (scanned[id] ??= []).push(patternId);
    (scanLines[id] ??= []).push(line);
  }
  const skippedPaths = new Set(skipped.map(({ path }) => path));
  for (const unit of units) {
    if (skippedPaths.has(unit.path)) scanned[unit.id] = 'skipped';
  }
  return { scanned, scanLines };
}

/**
 * Step 5 (scan part, CHG-16): M8 `scanUnits` over the snapshot's units (CFG-07's compiled
 * `scanIgnore` matchers, captured by `loadConfigLayers` as `ctx.scanIgnoreMatchers` instead
 * of on `ctx.config`; the entry point's `osUser`, Q10). Stores `ctx.scan` (`plan.json`
 * `scan.hits`/`scan.skipped`, C:plan) and `ctx.scanMap` (`state.json` `scanned`,
 * C:plan-hunks), read by `renderHunkIndex` (step 8) to withhold a hit's whole body and flag
 * every entry's `scan`. A clean tree (no units) scans nothing. `reword`'s units are HEAD's
 * own diff against its single parent (CHG-15): content already committed, not a change the
 * run is about to make, so Q20 ("no content changes, so no content scan") applies and this
 * step scans nothing in `reword` mode either.
 *
 * SCN-14: also reads the repo config's content on the snapshot side (M10 `snapshotBlob`) and
 * compares it against the `scanIgnore` read at HEAD (`ctx.config.values.scanIgnore`, M4's own
 * "headPatterns") with M4's pure `scanIgnoreChanged`. The flag and the repo-config units it
 * marks (M8's `scanIgnoreUnits`, by `isRepoConfigPath`) are stored as `ctx.scanIgnoreChanged`
 * and `ctx.scanIgnoreUnits`, both `false`/`[]` in the clean/`reword` short-circuit above.
 * M18 step 5 gates the comparison on there being a unit to flag: when no unit's path or old
 * path is the repo config, `ctx.scanIgnoreChanged` is `false` without reading `snapshotBlob`
 * at all (the repo config may not even be in the snapshot, e.g. gitignored and untracked).
 */
async function scanDiff(ctx) {
  if (ctx.units === undefined || ctx.mode === 'reword') {
    ctx.scan = { hits: [], skipped: [] };
    ctx.scanMap = {};
    ctx.scanLines = {};
    ctx.scanIgnoreChanged = false;
    ctx.scanIgnoreUnits = [];
    return undefined;
  }
  const hasConfigUnit = ctx.units.some((unit) => isRepoConfigPath(unit.path)
    || (unit.oldPath != null && isRepoConfigPath(unit.oldPath)));
  ctx.scanIgnoreChanged = hasConfigUnit
    && scanIgnoreChanged(ctx.config.values.scanIgnore, await snapshotBlob(REPO_CONFIG_PATH));
  const { hits, skipped, scanIgnoreUnits } = scanUnits(ctx.units, {
    scanIgnore: ctx.scanIgnoreMatchers,
    osUser: ctx.injected.osUser,
    scanIgnoreChanged: ctx.scanIgnoreChanged,
    isRepoConfigPath,
  });
  ctx.scan = { hits, skipped };
  const { scanned, scanLines } = buildScanMap(ctx.units, { hits, skipped });
  ctx.scanMap = scanned;
  ctx.scanLines = scanLines;
  ctx.scanIgnoreUnits = scanIgnoreUnits;
  return undefined;
}

/**
 * Step 6: post-scan refusals. A clean tree ends the call with `nothing`, except in `reword`,
 * which takes the lock on a clean tree too (C:plan step 6, RUN-06). RUN-15: M15 `planRefusal`
 * builds the `nothing` reply's text itself, from the breakdown `cleanBreakdownOf` below reads
 * off `ctx.inventory` (post-cap, C:plan `clean`), so a clean tree still names its hidden-only,
 * collapsed-only, `stagedExcluded`-only, non-UTF-8-only, `dirtySubmodules`-only or
 * `embeddedRepos`-only reason, the same way `stagedHitOf` below already escapes paths for
 * `planRefusal`'s `stagedHit` branch. Then the signing probe (GIT-10, M11), so a clean tree on
 * a locked key reports "nothing to commit": M15 `planRefusal` refuses its `ready: false`
 * (`signing-locked`); `"prompt"` queues the note.
 */
async function postScanRefusals(ctx) {
  const stagedHit = stagedHitOf(ctx);
  if (stagedHit !== null) return { refusal: planRefusal({ ...ctx.probe, stagedHit }) };
  if (ctx.inventory.clean === true && ctx.mode !== 'reword') {
    const { message } = planRefusal({ ...ctx.probe, clean: cleanBreakdownOf(ctx.inventory) });
    return { status: 'nothing', reason: 'clean', cleanText: message };
  }
  const { env, now, osHome } = ctx.injected;
  ctx.signing = await probeSigning({ toplevel: ctx.toplevel, env, now, osHome });
  const refusal = planRefusal({ ...ctx.probe, signing: ctx.signing });
  if (refusal !== null) return { refusal };
  if (ctx.signing.ready === 'prompt') ctx.notices.push(SIGNING_PROMPT_NOTICE);
  return undefined;
}

// RUN-15 (C:plan `clean`, stories 156, 219): the clean-tree breakdown `planRefusal`'s `clean`
// branch names, paths escaped as in the reply (M17 `escapePath`), like `stagedHitOf` below.
// `notUtf8` is already in its `\xNN` form for each bad byte (M10 `escapeNonUtf8`), but a
// valid-UTF-8 control character elsewhere in the same path (a literal LF or ESC byte) is not:
// `escapePath` is idempotent on the `\xNN` text, so mapping it over `notUtf8` here escapes
// those control characters too without double-escaping (review-RUN-15 Medium 2).
function cleanBreakdownOf(inventory) {
  return {
    hidden: { count: inventory.hidden.count, sample: inventory.hidden.sample.map(escapePath) },
    collapsed: inventory.collapsed.map(({ dir, count }) => ({ dir: escapePath(dir), count })),
    stagedExcluded: inventory.stagedExcluded.map((entry) => (entry.reason === 'hidden'
      ? { path: escapePath(entry.path), reason: 'hidden' }
      : { dir: escapePath(entry.dir), count: entry.count, reason: 'collapsed' })),
    dirtySubmodules: inventory.dirtySubmodules.map(escapePath),
    notUtf8: inventory.notUtf8.map(escapePath),
    embeddedRepos: inventory.embeddedRepos.map(escapePath),
  };
}

// CHG-14 (Q10, Q11, C:plan step 6): `plan --staged` commits the index as-is, so it cannot
// leave out a staged-new path the hidden rule excludes, a path the scan hit in the index
// diff, or a staged path that is not UTF-8 (no unit can hold it). M15 `planRefusal`'s
// `stagedHit` facts, paths escaped as in the reply (M17 `escapePath`), or `null`.
function stagedHitOf(ctx) {
  if (ctx.mode !== 'staged') return null;
  const hidden = ctx.inventory.stagedExcluded
    .filter((entry) => entry.reason === 'hidden').map((entry) => entry.path);
  const hiddenSet = new Set(hidden);
  const hits = [...new Set(ctx.scan.hits.map((hit) => hit.path))].filter((p) => !hiddenSet.has(p));
  const notUtf8 = ctx.inventory.stagedNotUtf8;
  if (hidden.length === 0 && hits.length === 0 && notUtf8.length === 0) return null;
  // `notUtf8` already has each bad byte as `\xNN` (M10 `escapeNonUtf8`); `escapePath` is
  // idempotent on that text, so mapping it over escapes any remaining valid-UTF-8 control
  // character too, without double-escaping (review-RUN-15 Medium 2).
  return { hidden: hidden.map(escapePath), hits: hits.map(escapePath), notUtf8: notUtf8.map(escapePath) };
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
 * lock (`acquire`, no takeover; RUN-06: a lost race → `held`; skipped when step 3's takeover
 * already holds it, RUN-21), then the HEAD re-read on both paths, then writes `plan.json`. A lock is never taken without `state.json` in place. From
 * the `acquire` on, `ctx.run` is set, so `plan`'s `finally` releases the lock on a throw.
 * CFG-08 adds `attribution` (`{ trailer, source }`, step 1's `ctx.attribution`) to both
 * files, in the contract's order (C:run-folder): ahead of `recentSubjects`, so M16/M17 read
 * the resolved trailer from here instead of re-resolving it. `state.json` always keeps the
 * full `{ trailer, source }` object (M16/M17 need `source` even when `trailer` is `null`,
 * e.g. to tell an explicit `includeCoAuthoredBy: false` apart from nothing to report);
 * `plan.json`'s `attribution` is `null` when `ctx.attribution.trailer` is `null` (C:plan,
 * CFG-09). `plan.json` also gets `warnings` (step 1's `ctx.warnings`, C:plan): empty until
 * CFG-09, the first producer. CFG-05 adds `config` (`ctx.config`, step 1's M4 `loadConfig`
 * result) to both files, `{ values, sources }` (C:plan `config.sources`): by this step a
 * `config` error would already have refused at step 2, so `ctx.config` always holds the
 * effective values here.
 */
async function storeAndLock(ctx) {
  const { planId, runDir } = ctx.provisional;
  // Kept on `ctx` so step 8 (`storeNotices`) rewrites it with `notices` added.
  ctx.storedState = {
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
    // CHG-14 (C:run-folder): the paths whose index content differs from both HEAD and the
    // worktree, with their index blob IDs; `[]` in `reword`.
    indexOnly: ctx.mode === 'reword' ? [] : ctx.inventory.indexOnly,
    // CHG-13 (C:run-folder state.json row): empty outside `split`, same as `plan.json`'s
    // `untracked.collapsed`.
    collapsed: ctx.inventory.collapsed,
    stagedExcluded: stagedExcludedOf(ctx),
    dirtySubmodules: dirtySubmodulesOf(ctx),
    // CHG-12 (C:run-folder): the paths that are not UTF-8, each bad byte as `\xNN`, for
    // `check`'s `notIncluded` (PLN-04); `[]` in `reword`, which commits no tree path.
    notUtf8: ctx.mode === 'reword' ? [] : ctx.inventory.notUtf8,
    // C:run-folder: untracked embedded repositories, for `check`'s `notIncluded` (CHG-09).
    embeddedRepos: ctx.mode === 'reword' ? [] : ctx.inventory.embeddedRepos,
    // CFG-05: M4's effective config values and their sources, stored so `plan --hunks`,
    // `check` and `commit` read them from here instead of re-reading a config layer
    // (C:run-folder).
    config: ctx.config,
    attribution: ctx.attribution,
    recentSubjects: ctx.recentSubjects,
    // CHG-16 (C:plan-hunks "scan map"): every scan hit and skipped path mapped to the unit
    // that holds it, cut from the very diff `scanDiff` (step 5) scanned.
    scanned: ctx.scanMap,
    // PLN-04: each hit's line, parallel to `scanned` (never `"skipped"`), for `check`'s
    // left-out-hit notice (`path:line`); kept separate so `scanned`'s own shape, read by
    // `renderHunkIndex` for the public hunk index, never widens.
    scanLines: ctx.scanLines,
    // SCN-14 (C:plan-hunks "scan map"): the repo-config units `scanDiff` flagged when its
    // `scanIgnore` changed on the snapshot side.
    scanIgnoreUnits: ctx.scanIgnoreUnits,
    // GIT-09: `reword` only (C:run-folder): HEAD's message, and whether HEAD is a root
    // commit, which CHG-15's snapshot diffs against the empty tree.
    ...(ctx.mode === 'reword' ? { oldMessage: ctx.oldMessage, rootCommit: ctx.reword.root } : {}),
  };
  ctx.provisional.write('state.json', `${JSON.stringify(ctx.storedState)}\n`);
  // A race lost to another run's lock (`held`, RUN-06) refuses `lock`; with no `ctx.run`,
  // `plan`'s `finally` deletes only this call's own provisional folder. `holder` becomes the
  // failure's `planId`/`created`/`touched` error fields (`planRefusalFailure`, RUN-07).
  if (ctx.run === null) {
    const acquired = ctx.provisional.acquire({ now: ctx.injected.now });
    if (!acquired.ok) return { refusal: { code: acquired.code, message: acquired.message, holder: acquired.holder } };
    ctx.run = acquired.run;
  }
  // RUN-12: the re-reads below are git calls under `plan`'s deadline; past it `plan`'s
  // `finally` releases the run just taken.
  const late = pastDeadline(ctx);
  if (late !== undefined) return late;
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
  // GRD-17 (C:plan step 8 "Guard state"): S1 `guardState`, read here, ahead of the sweep,
  // so `plan.json` carries the guard state and is still written before the sweep (the RUN-08
  // sweep test keys its clock shift on `plan.json`); the sweep touches only the run-folder
  // directory, so the order is not observable. `not-seen` queues the guard notice first,
  // ahead of the notices of earlier steps (C:reply-and-handback example).
  ctx.guard = guardState({ claudeHome: ctx.injected.claudeHome, toplevel: ctx.toplevel, now: ctx.injected.now });
  if (ctx.guard === 'not-seen') ctx.notices.unshift(GUARD_NOTICE);
  ctx.run.write('plan.json', entryPerLine({
    version: 1,
    ok: true,
    planId,
    runDir,
    mode: ctx.mode,
    state: ctx.state,
    clean: ctx.inventory.clean,
    preStaged: ctx.inventory.preStaged,
    // CHG-14 (C:plan): the unstaged changes left by a `staged` commit; `null` in other modes.
    unstagedLeft: ctx.mode === 'staged' ? (ctx.tracked ?? []).length : null,
    tracked: ctx.tracked,
    untracked: {
      candidates: ctx.inventory.candidates
        .filter(({ path }) => ctx.renameTargets?.has(path) !== true)
        .map(({ path, binary }) => ({ path, bucket: bucketOf(path), binary })),
      collapsed: ctx.inventory.collapsed,
      hidden: ctx.inventory.hidden,
    },
    stagedExcluded: stagedExcludedOf(ctx),
    dirtySubmodules: dirtySubmodulesOf(ctx),
    // CHG-16 (C:plan `scan`): hits (M8's `patternId` as C:plan's `pattern`, never the
    // matched value) and skips from `scanDiff` (step 5). `scanIgnoreChanged` is SCN-14's:
    // whether the repo config's `scanIgnore` differs on the snapshot side from HEAD.
    scan: {
      hits: ctx.scan.hits.map(({ path, line, patternId }) => ({ path, line, pattern: patternId })),
      skipped: ctx.scan.skipped,
      scanIgnoreChanged: ctx.scanIgnoreChanged,
    },
    // CFG-05 (C:plan `config.sources`): the effective values, repo over user over default.
    config: ctx.config,
    attribution: ctx.attribution.trailer === null ? null : ctx.attribution,
    // GIT-10: M11's result from step 6 (C:plan `signing`).
    signing: ctx.signing,
    // C:plan `env`: step 1's versions and the guard state read above.
    env: { node: ctx.probe.node.text, git: ctx.probe.git.version.text, guard: ctx.guard },
    recentSubjects: ctx.recentSubjects,
    warnings: ctx.warnings,
  }));
  // RUN-08 (C:plan step 7): then the sweep of old run folders and leftover lock temporary
  // files. Its cleanup errors are notices, never a changed outcome; step 8 stores them in
  // `state.json` with the others.
  ctx.notices.push(...sweep({ toplevel: ctx.toplevel, now: ctx.injected.now }));
  return undefined;
}

/**
 * Step 8 (GRD-17, C:plan): the notices, stored only now so they include the guard notice,
 * step 1's (detached HEAD, config warnings), step 6's signing prompt, the takeover's kept
 * since step 3 and the sweep's cleanup errors, are added to `state.json` in one more atomic
 * write (M12 `run.write`), so none computed after step 7 is lost (KD-R67).
 */
async function storeNotices(ctx) {
  ctx.run.write('state.json', `${JSON.stringify({ ...ctx.storedState, notices: ctx.notices })}\n`);
  return undefined;
}

// C:plan `stagedExcluded`: `[]` in `reword` mode, whose `--amend --only` commits no staged
// path, so `check` must not note that the run unstages one.
function stagedExcludedOf(ctx) {
  return ctx.mode === 'reword' ? [] : ctx.inventory.stagedExcluded;
}

// C:plan `dirtySubmodules` (CHG-09): submodules with dirt but no pointer change; `[]` in
// `reword`, which commits no tree path.
function dirtySubmodulesOf(ctx) {
  return ctx.mode === 'reword' ? [] : ctx.inventory.dirtySubmodules;
}

// `plan.json` holds one top-level entry per line (C:run-folder), still one JSON object.
function entryPerLine(object) {
  const lines = Object.entries(object).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * Step 8 (CHG-03b, `plan --hunks` part): M13 `renderHunks` over the snapshot's units, in
 * process; M12 writes `hunks.txt` and the output object becomes `plan`'s stdout `hunks`.
 * Guard state and the stored notices come before it (GRD-17); the effective config values
 * are CFG-05's `ctx.config.values` (`scanIgnore` dropped by `renderHunks` itself); the spill
 * to `hunks.json` is CHG-18's.
 *
 * INT-24 (C:plan step 8, Q20): `--dictated` skips the step; the dictated text needs no
 * diff, so the run keeps its lock with `hunks: null` (and `reply: null`) on stdout.
 */
async function renderHunkIndex(ctx) {
  if (ctx.values.dictated === true) return { hunks: null };
  const { stdoutObj, hunksTxt, hunksJson } = renderHunks(
    {
      runDir: ctx.provisional.runDir,
      mode: ctx.mode,
      config: { values: ctx.config.values },
      recentSubjects: ctx.recentSubjects,
      oldMessage: ctx.oldMessage,
      scanMap: ctx.scanMap,
    },
    ctx.units,
  );
  ctx.run.write('hunks.txt', hunksTxt);
  // CHG-18: past the stdout budget, the full index also goes to `hunks.json`.
  if (hunksJson !== undefined) ctx.run.write('hunks.json', hunksJson);
  // RUN-16 (C:plan step 8, C:plan-hunks): `plan --hunks` resets `lintFailures`, rewriting
  // `state.json` from the state it read so the stored notices survive.
  const run = { toplevel: ctx.toplevel, planId: ctx.provisional.planId };
  writeState(run, { ...readState(run), lintFailures: 0 });
  return { hunks: stdoutObj };
}

const PLAN_STEPS = Object.freeze([
  probeRepo, readHeadState, loadConfigLayers, preFolderRefusals, createRunFolder, inventory,
  resolveRunMode, refuseCaseRenames,
  collapseCandidates, snapshotUnits, scanDiff, postScanRefusals, readHistory, storeAndLock, storeNotices,
  renderHunkIndex,
]);

/** `plan --hunks` step 2 (CHG-19): see `subcommandRefusals`. */
async function planHunksRefusals(ctx) {
  return subcommandRefusals(ctx, 'plan --hunks');
}

/**
 * `plan --hunks` step 4 (CHG-19, M18 "`plan --hunks`", C:plan-hunks), a separate call only:
 * `head-moved` via M3 against the stored HEAD; M10 `snapshot` rebuilt from the **stored**
 * lists (C:run-folder; a file created or force-added since is not recomputed, CHG-05), as
 * `commit`'s phase (b) does, or HEAD's own diff in `reword`; then `matchIds` in exact mode:
 * the same hash set → the current units under `plan`'s IDs, any difference → `unmatched`
 * (CLI kind `diff-changed`). `staged` takes the same index-only snapshot `plan` itself takes
 * for it (CHG-14: the index against HEAD, no temporary index). On a match: M13
 * `renderHunks`, `hunks.txt` through M12, and `state.json` rewritten from the state it read
 * with only `lintFailures: 0` and `resumed: true` changed (the map, the scan map and the
 * notices survive; `plan --hunks` never writes the map).
 */
async function resnapshotUnits(ctx) {
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  const state = readState(run);
  const { env, now } = ctx.injected;
  if (await head({ cwd: ctx.toplevel, env, now }) !== state.head) {
    return { refusal: { code: 'head-moved', message: HEAD_MOVED_TEXT } };
  }
  const folder = insideRunDir(runDirOf(ctx.toplevel), run.planId);
  let current;
  try {
    current = await snapshot(state.mode === 'reword'
      ? { mode: 'reword', head: state.head, root: state.rootCommit, toplevel: ctx.toplevel, env, now }
      : state.mode === 'staged'
      ? { mode: 'staged', toplevel: ctx.toplevel, env, now }
      : {
        mode: 'split',
        storedLists: { candidates: state.candidates, stagedNew: state.stagedNew },
        // CHG-10: the stored units' paths, so a filtered file is classified as `plan` did.
        tracked: state.units.map((unit) => unit.path),
        indexPath: path.join(folder, 'git-index'),
        unborn: state.head === null,
        toplevel: ctx.toplevel,
        env,
        now,
      });
  } catch (err) {
    // C:plan: a non-zero `git add -N` into the temporary index is exit 4 `git`.
    if (err.domainCode === 'git-failed') return { refusal: { code: 'git-failed', message: err.message } };
    throw err;
  }
  const matched = matchIds(state.idMap, current, { exact: true });
  if (!matched.ok) return { refusal: { code: 'unmatched', message: UNMATCHED_TEXT } };
  const { stdoutObj, hunksTxt, hunksJson } = renderHunks(
    {
      runDir: folder.split(path.sep).join('/'),
      mode: state.mode,
      config: { values: state.config.values },
      recentSubjects: state.recentSubjects,
      oldMessage: state.oldMessage,
      scanMap: state.scanned,
    },
    matched.units,
  );
  writeRunFile(run, 'hunks.txt', hunksTxt);
  // CHG-18: past the stdout budget, the full index also goes to `hunks.json`.
  if (hunksJson !== undefined) writeRunFile(run, 'hunks.json', hunksJson);
  writeState(run, { ...state, lintFailures: 0, resumed: true });
  return { hunks: stdoutObj };
}

const PLAN_HUNKS_STEPS = Object.freeze([probeRepo, planHunksRefusals, openRun, resnapshotUnits]);

// CHG-19 (C:cli-and-exit-codes): the `plan --hunks` refusals that end the run — `head-moved`,
// `diff-changed` (`unmatched`) and exits 3-5 — release the lock and delete the run folder;
// a `lock` refusal (`taken-over`, `ended`, `busy`) keeps it.
const PLAN_HUNKS_RUN_ENDING = new Set(['head-moved', 'unmatched', 'git-failed', 'timed-out']);

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

/** Step 3 of `commit` and `check`: M12 `open`, the whole call's own lock check (RUN-04). */
async function openRun(ctx) {
  const opened = open(ctx.values.plan, { toplevel: ctx.toplevel, now: ctx.injected.now });
  if (!opened.ok) return { refusal: { code: opened.code, message: opened.message } };
  // Marks that `open` succeeded, so the caller's `finally` knows there is a `call.lock` to
  // close (a failed `open` leaves nothing for `close` to do).
  ctx.opened = true;
  return undefined;
}

// `commit` step 4 (EXE-02, extended by EXE-04's mid-loop `touch`, EXE-06's `head-moved` and
// EXE-07's `index-changed`): M16 `commitAll` over the stored groups, then the run's release
// once it ends with no refusal, or with `head-moved`/`index-changed` (C:commit-release: the
// lock and the run folder go after the last group, and "on every failure that ends the
// run"; the folder takes this call's `call.lock` with it, so the `finally`'s `close`
// finds nothing left). EXE-05's phase (a) `no-groups` refusal (no stored groups, or
// every stored group already committed) is `commitAll`'s own, after the lock check
// (M12 `open`, step 3) and before any group work. A
// `no-groups`/`unconfirmed`/`taken-over`/`busy` refusal keeps the run instead (no
// `releaseOpen`; only this call's `call.lock` goes, via the `finally` in `commit()` below —
// `ctx.opened` is already true by the time this step runs), matching `usage`/`lock` not
// ending the run (EXE-22's `unconfirmed` is `commitAll`'s own first-group-only check, just
// ahead of `no-groups`, C:commit-release); `head-moved`,
// `index-changed` (`diff-changed`), `index-locked` (`index-lock`), and EXE-09's `unmatched`
// (`diff-changed`) and `git-failed` all end it the same way (C:cli-and-exit-codes).
// INT-02: the release's own notice (a cleanup error after the commits, C:run-folder) joins
// the outcome's `notices`, which `check` merges into `reply.notices` (C:check).
async function commitGroups(ctx) {
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  const { env, now, osUser } = ctx.injected;
  const outcome = await commitAll(run, {
    now, osUser, env, deadline: ctx.deadline, scriptPath: ctx.injected.scriptPath,
    // EXE-22: `check`'s own `SUBCOMMAND_OPTIONS` declares no `confirmed` flag (M1), so
    // `ctx.values.confirmed` is always `undefined` on `commitCheckedGroups`'s own call here
    // — harmless, since that path never runs with `awaitingConfirm` still set (`check`
    // clears it in step 5 before ever reaching `commit`, and the `confirm` route returns
    // before this function is called at all).
    confirmed: ctx.values.confirmed === true,
  });
  // `remaining.length === 0` is also required for the no-refusal case (not just
  // `!outcome.refusal`): EXE-16's budget stop ends `commitAll` with no `refusal` but a
  // non-empty `remaining`, and that outcome must keep the run (EXE-16 AC1), same as a
  // mid-loop `taken-over`/`busy` refusal does today. `head-moved` releases regardless of
  // `remaining` (review-EXE-06 Medium-1): C:cli-and-exit-codes lists it with
  // `diff-changed`/`index-lock`/`internal` among the refusals that "end the run: they
  // release the lock and delete the run folder, so the next `/commit` starts fresh" — a
  // moved HEAD is not something a retry within this run can fix. Once RUN-27's `runEnd`
  // lands, it replaces this condition outright.
  // EXE-07's `index-changed` (CLI kind `diff-changed`) and EXE-08's `index-locked` (CLI kind
  // `index-lock`) end the run the same way, and so do EXE-09's phase (b) `unmatched` (CLI
  // kind `diff-changed`) and `git-failed` (exit 4: "exits 3-5 end the run"), and EXE-10's
  // phase (c) `stage-failed` (exit 4) and `mismatch` (`diff-changed`), after their unstage.
  if ((!outcome.refusal && outcome.remaining.length === 0)
    || outcome.refusal?.code === 'head-moved' || outcome.refusal?.code === 'index-changed'
    || outcome.refusal?.code === 'index-locked' || outcome.refusal?.code === 'unmatched'
    || outcome.refusal?.code === 'git-failed' || outcome.refusal?.code === 'stage-failed'
    || outcome.refusal?.code === 'mismatch'
    // EXE-13: the backstop's `backstop-hit` (exit 3 `scan`), after its unstage.
    || outcome.refusal?.code === 'backstop-hit') {
    const released = releaseOpen(run);
    if (released.notice !== null) outcome.notices.push(released.notice);
    // review-INT-02 Low-3: a `release()` that could not remove the lock (`busy`) reports
    // `kept: true` with the folder left alone too (review-CHG-03b finding 2); `committedOutput`
    // reads this to keep `reply.planId` instead of nulling it for a run C:run-folder still
    // holds.
    outcome.kept = released.kept;
  }
  return outcome;
}

const COMMIT_STEPS = Object.freeze([probeRepo, commitRefusals, openRun, commitGroups]);

/** `check` step 2: see `subcommandRefusals`. */
async function checkRefusals(ctx) {
  return subcommandRefusals(ctx, 'check');
}

/**
 * `check` step 4 (RUN-19): M15 `checkGate` over the run state read after the lock check (step
 * 3, `openRun`), before step 5 ever clears or re-validates anything. Once a budget stop
 * (EXE-16) has left any stored group committed, `check` must not clear `state.groups` (the
 * next step would) nor validate a fresh plan over it, so this runs first and keeps the run on
 * a refusal, same as every other `usage` refusal (no `releaseOpen`; only this call's
 * `call.lock` goes, via `check`'s own `finally`).
 */
async function checkAlreadyCommitted(ctx) {
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  return checkGate(readState(run)) ?? undefined;
}

/**
 * `check` step 5 (PLN-01): clears the stored groups and `awaitingConfirm` before anything is
 * validated (C:check), so a failed `check` leaves no group that `commit` would accept, then
 * M14 `validatePlan` over `plan.groups.json` and the run state. A lint failure ends the call
 * with exit 2 and the `errors`; RUN-16 counts it in `lintFailures` and asks M15
 * `onLintFailure` whether it ends the worker's retries (`lintEnding`, which `check` turns into
 * a `reply`), passing on the run's `interactive`; it also carries `shapeOnly` (RPL-08 reads
 * it to drop the `edit` answer when the plan's one error is a shape error) into the
 * `lintFailed` reply facts, unused until then. On success the validated groups are stored with
 * `committed: false`, and `groups`, `notIncluded`, `confirm` and `notices` are kept on
 * `ctx.checked` for step 6 (`commitCheckedGroups`): `confirm` is M15 `computeConfirm`'s
 * decision (RUN-17, landed), resolved here from the stored groups' unit IDs against this
 * run's unit table, scan map and `scanIgnoreUnits`; RUN-18 routes it into `check`'s reply.
 */
async function validateWorkerPlan(ctx) {
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  const state = readState(run);
  if (state.groups !== undefined || state.awaitingConfirm !== undefined) {
    delete state.groups;
    delete state.awaitingConfirm;
    writeState(run, state);
  }
  const validated = validatePlan(readWorkerPlan(run), state, { osUser: ctx.injected.osUser });
  if (!validated.ok) {
    const lintEnding = onLintFailure(state, validated.source, validated.kind);
    writeState(run, { ...state, lintFailures: (state.lintFailures ?? 0) + 1 });
    return { lint: validated.errors, lintEnding, interactive: state.interactive, shapeOnly: validated.kind === 'shape' };
  }
  writeState(run, { ...state, groups: validated.stored.map((group) => ({ ...group, committed: false })) });
  // INT-27 (Q23, C:plan `notices`, C:reply-and-handback): every notice `plan` stored in
  // `state.json`'s `notices` (GRD-17: the guard notice, the signing `prompt` note,
  // the detached-HEAD warning, `warnings`, and the sweep's cleanup errors) carries into
  // `check`'s own output, ahead of its own notices (the same order `plan` itself uses,
  // step 8), since the worker only ever surfaces the final reply.
  const storedNotices = Array.isArray(state.notices) ? state.notices : [];
  // RUN-17 (C:confirmation-triggers): resolve each stored group's included unit IDs to paths
  // against this run's unit table, scan map and `scanIgnoreUnits`, for M15 `computeConfirm`.
  const scanned = state.scanned ?? {};
  const scanIgnoreSet = new Set(state.scanIgnoreUnits ?? []);
  const unitPath = new Map((state.units ?? []).map((unit) => [unit.id, unit.path]));
  // Each new file's `kind` (RUN-17 M1 fix, C:confirmation-triggers, Q16): a status-`A` path's
  // own unit table entry, for `new binary file <path>` vs `new file <path>`.
  const newFileKind = new Map(
    (state.units ?? []).filter((unit) => unit.status === 'A').map((unit) => [unit.path, unit.kind]),
  );
  const confirmGroups = validated.stored.map((row, i) => {
    const skippedFiles = [];
    const scanIgnoreFiles = [];
    const seenSkip = new Set();
    const seenIgnore = new Set();
    for (const id of row.units) {
      // `validatePlan` only ever stores IDs it resolved against this same unit table, so
      // `unitPath.get(id)` always hits; there is no raw-ID fallback to keep in step with it.
      const path = unitPath.get(id);
      if (scanned[id] === 'skipped' && !seenSkip.has(path)) {
        seenSkip.add(path);
        skippedFiles.push(path);
      }
      if (scanIgnoreSet.has(id) && !seenIgnore.has(path)) {
        seenIgnore.add(path);
        scanIgnoreFiles.push(path);
      }
    }
    const newFiles = validated.groups[i].newFiles.map(
      (path) => ({ path, binary: newFileKind.get(path) === 'binary' }),
    );
    return { newFiles, skippedFiles, scanIgnoreFiles };
  });
  const confirm = computeConfirm(state.mode, confirmGroups, {
    resumed: state.resumed === true, interactive: state.interactive !== false,
  });
  ctx.checked = {
    groups: validated.groups, notIncluded: validated.notIncluded, confirm,
    notices: [...storedNotices, ...validated.notices],
  };
  // Terminates `CHECK_STEPS` with a defined value (`runSteps` throws on falling off the end).
  // `check()` runs `commitCheckedGroups` itself, in a separate, unscoped `runSteps` call
  // (review-INT-02 Medium-1) rather than as a further step here.
  return ctx.checked;
}

/**
 * `check` step 6 (INT-02, routed by RUN-18's M15 `afterCheck`), run by `check()` itself after
 * `runStepsWithin(CHECK_STEPS, ctx)` returns, through a second, plain
 * `runSteps([commitCheckedGroups], ctx)` — the same way `commit()` runs `commitGroups`
 * (`COMMIT_STEPS`'s own step 4), unscoped by any `withDeadline` (review-INT-02 Medium-1; see
 * that call site's comment). A plan with any hunk-level file entry (`hunks` not `null`) keeps
 * the run without routing at all (KD-R83): INT-02 is the whole-file path only, and M16's (c)
 * apply stages whole paths today, so a hunk-level group would also commit the file's other
 * hunks, `notIncluded` ones included (removal owned by INT-18's criterion, after CHG-20's hunk
 * `stage`). Otherwise `afterCheck(confirm, groups, state)` decides: `releaseNothing` (zero
 * groups, checked first by `afterCheck` itself) and `handedBack` both release the run
 * (`releaseOpen`) without committing; `confirm` stores `awaitingConfirm` and keeps the run;
 * `commit` runs `commitGroups` under this call's lock and `deadline`, but outside the GIT-07
 * deadline *scope* `CHECK_STEPS` ran in — `commitAll`'s own git calls (its cleanup and
 * reporting ones included, once EXE-10/EXE-11/EXE-17 build them against `cleanupDeadline`)
 * must not be capped a second time by the spent outer `deadline`, and a `scope.expired` past
 * it must not blank out `commits`/`remaining`/`unstaged` the way `runStepsWithin` does for its
 * own steps. `ctx.checked.route` carries the decision out to `check()`, which builds the
 * matching reply (`committedOutput`, `releasedCheckOutput` or the kept `confirm` output). The
 * output is `commit --all`'s with `groups` and `notIncluded` merged in, and `check`'s own
 * notices ahead of `commit`'s in `notices`.
 */
async function commitCheckedGroups(ctx) {
  const { groups, notIncluded, notices, confirm } = ctx.checked;
  const wholeFiles = groups.every((group) => group.files.every((file) => file.hunks === null));
  if (groups.length > 0 && !wholeFiles) return { groups, notIncluded, notices, confirm };
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  const state = readState(run);
  const route = afterCheck(confirm, groups, state);
  if (route === 'releaseNothing' || route === 'handedBack') {
    const released = releaseOpen(run);
    return {
      groups, notIncluded, confirm, route,
      notices: released.notice === null ? notices : [...notices, released.notice],
    };
  }
  if (route === 'confirm') {
    writeState(run, { ...state, awaitingConfirm: true });
    return { groups, notIncluded, confirm, notices, route };
  }
  const outcome = await commitGroups(ctx);
  return { ...outcome, groups, notIncluded, confirm, route, notices: [...notices, ...outcome.notices] };
}

const CHECK_STEPS = Object.freeze([
  probeRepo, checkRefusals, openRun, checkAlreadyCommitted, validateWorkerPlan,
]);

/**
 * `infer` step 2 (INF-01): the probe's refusals, the `env` row, the first `state` clause
 * (not a git repository, a bare repository) and a start-up call's `timed-out`, with `plan`'s
 * own texts (C:infer, C:cli-and-exit-codes); no other `plan` row applies, since `infer` only
 * reads history.
 */
async function inferRefusals(ctx) {
  const refusal = planRefusal(ctx.probe);
  if (refusal !== null) return { refusal };
  ctx.toplevel = ctx.probe.repo.toplevel;
  return undefined;
}

/**
 * `infer` step 3: M3 reads the last 200 non-merge messages (none when unborn) and M19
 * `infer` turns them into C:infer's fields. Read-only: no lock, no run folder. INF-07: under
 * `outcome: proposal`, M4 `readLayers` reads both layers' raw worktree content and M19
 * `configFor` turns them into `configJson`; `configFor` itself returns `null` for the other
 * two outcomes (no proposal to merge in).
 */
async function inferFromHistory(ctx) {
  const { env, now, claudeHome } = ctx.injected;
  const at = { cwd: ctx.toplevel, env, now };
  const messages = await historyMessages({ ...at, head: await head(at) });
  const facts = inferFromMessages(messages);
  const layers = readLayers({ toplevel: ctx.toplevel, claudeHome });
  return { ...facts, configJson: configFor(facts.proposal, layers) };
}

const INFER_STEPS = Object.freeze([probeRepo, inferRefusals, inferFromHistory]);

// RUN-12: the text of `plan`'s `timeout` past its M15 `deadline` (C:cli-and-exit-codes
// `timeout` row; no recorded text).
const DEADLINE_TEXT = '/commit passed its 540-second deadline';
// KD-R78 decision: the text of `release`'s `timeout` past its 45 s M15 `releaseDeadline`.
const RELEASE_DEADLINE_TEXT = '/commit release passed its 45-second deadline';

// RUN-12: `plan`'s deadline bounds its git calls (C:plan). A call that set `ctx.deadline`
// (only `plan` so far) is checked before every step that makes git calls, and before step 7's
// re-reads once the lock is held (`storeAndLock`): past it the call ends as `timed-out` (exit 5
// `timeout`) and `plan`'s own cleanup discards or releases the run. The steps after the
// sweep make no git call, so a clock past the deadline there no longer ends the run. Inside
// a step, GIT-07 bounds each M2 call by `deadline - now()` at its own start (`plan` runs its
// step table inside M2 `withDeadline`); a call that deadline ends or skips marks the scope
// `expired`, and `plan` then ends `timed-out` the same way. `release`, `check` and `infer`
// (`runStepsWithin`) also stop before the next step once their scope is `expired`, even with
// the clock still short of the deadline, so `release` never removes a lock after a timed-out
// git call (KD-R78 decision).
//
// KD-S87: the `ctx.scope?.expired` clause below is untested today, because no scoped M2 git
// call precedes `releaseById` or `openRun` in a working tree; the slice that adds the first
// such call must add a Seam 1 test for it.
function pastDeadline(ctx) {
  if (ctx.deadline === undefined) return undefined;
  if (ctx.injected.now() < ctx.deadline && ctx.scope?.expired !== true) return undefined;
  return { refusal: { code: 'timed-out', message: ctx.deadlineText ?? DEADLINE_TEXT } };
}

// GIT-07: runs `steps` inside M2 `withDeadline` on `ctx.deadline`. A git call that deadline
// ended or skipped (`scope.expired`) ends the call `timed-out`, whatever the steps returned
// or threw (a step can throw on what a timed-out call left it, such as `release`'s KD-S78
// throw on a probe that timed out); any other throw passes through.
async function runStepsWithin(steps, ctx) {
  const scope = { deadline: ctx.deadline, now: ctx.injected.now };
  ctx.scope = scope;
  let facts;
  try {
    facts = await withDeadline(scope, () => runSteps(steps, ctx));
  } catch (err) {
    if (!scope.expired) throw err;
  }
  if (scope.expired) return { refusal: { code: 'timed-out', message: ctx.deadlineText ?? DEADLINE_TEXT } };
  return facts;
}

const GIT_FREE_STEPS = new Set([storeNotices, renderHunkIndex]);

async function runSteps(steps, ctx) {
  for (const step of steps) {
    const late = GIT_FREE_STEPS.has(step) ? undefined : pastDeadline(ctx);
    if (late !== undefined) return late;
    const ending = await step(ctx);
    if (ending !== undefined) return ending;
  }
  throw new Error('the step table ended without an outcome');
}

/**
 * Runs `plan` (mint form), or the separate `plan --hunks --plan <planId>` form (CHG-19,
 * `planHunks`).
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
  if (values.hunks) return planHunks(values, injected, { cwd });
  // RUN-12: the call's start, so M15 `deadline` and `cleanupDeadline` bound the whole call;
  // GIT-07: read once at dispatch (`cli.mjs`'s `main`, `injected.callStarted`), here only
  // for a direct call that did not pass one.
  const callStarted = injected.callStarted ?? injected.now();
  // Only bare `plan`, `plan --split`, `plan --reword` (RUN-06: the lock on a clean tree;
  // its reword facts GIT-09's, its snapshot CHG-15's; `--dictated` INT-24's, which skips
  // the hunk step) and `plan --staged` (RUN-13: its mode decision; its index-only snapshot
  // is CHG-14's) are built: every other flag changes the mode or the clean-tree outcome
  // (C:plan `mode`).
  const unbuilt = ['take-over'].filter((f) => values[f] !== undefined);
  if (unbuilt.length > 0) {
    throw new Error(`plan ${unbuilt.map((f) => `--${f}`).join(' ')} is not built yet`);
  }
  // GIT-02: `notices` lives on `ctx` from the start, so `probeRepo` (step 1) can queue the
  // detached-HEAD notice before any later step runs.
  const ctx = {
    injected, cwd, values, provisional: null, run: null, notices: [], warnings: [],
    deadline: deadline(callStarted), cleanupDeadline: cleanupDeadline(callStarted),
  };
  let facts;
  let thrown;
  // GIT-07: every M2 call of the steps takes `deadline - now()` at its own start (M2
  // `withDeadline`); `run` marks the scope `expired` when that deadline ended or skipped one.
  const scope = { deadline: ctx.deadline, now: injected.now };
  try {
    facts = await withDeadline(scope, () => runSteps(PLAN_STEPS, ctx));
  } catch (err) {
    // KD-R64 (RUN-12): an unexpected throw ends `plan` as `internal` here, with the reply and
    // the notices collected so far (the cleanup's own below included), instead of reaching
    // `commit.cjs`'s backstop, which has neither.
    thrown = { error: err };
  } finally {
    // GIT-07: a git call the deadline ended (its step then threw, or went on with what it
    // had, such as M11's `"unknown"`) ends `plan` as `timeout` (C:plan), whatever the steps
    // returned; the cleanup below then discards or releases the run.
    if (scope.expired) {
      facts = { refusal: { code: 'timed-out', message: DEADLINE_TEXT } };
      thrown = undefined;
    }
    // Every outcome but the hunk index ends without the lock (C:run-folder), a thrown
    // `internal` included: a throw after `acquire` (`ctx.run`) releases the lock first, one
    // before it has no lock to release. Neither `release` nor `discard` throws: a removal
    // error becomes a notice and never changes the outcome. A `release()` that could not
    // remove the lock (`busy`) reports `kept: true` and the folder is left alone too, so the
    // lock and its folder stay consistent for the next `/commit` (review-CHG-03b finding 2);
    // a `nothing`/`failed` reply carries notices since RPL-04 (`planRefusalFailure` below),
    // an `internal` throw's since RUN-12 (`planInternalFailure`).
    if (facts === undefined || facts.hunks === undefined) {
      const released = ctx.run?.release() ?? { notice: null, kept: false };
      if (released.notice !== null) ctx.notices.push(released.notice);
      if (!released.kept) {
        const discarded = ctx.provisional?.discard() ?? null;
        if (discarded !== null) ctx.notices.push(discarded);
      }
    }
  }
  if (thrown !== undefined) return await planInternalFailure(thrown.error, ctx);
  if (facts.refusal !== undefined) return await planRefusalFailure(facts.refusal, ctx);
  if (facts.hunks !== undefined) {
    // The lock is held and the worker goes on with the hunk index (C:plan): `reply` is null.
    const { planId, runDir } = ctx.provisional;
    return { output: { planId, runDir, mode: ctx.mode, reply: null, hunks: facts.hunks } };
  }
  return {
    output: {
      planId: null,
      runDir: null,
      // The resolved mode (a clean tree's), or `null` with a `modeChoice` (C:plan `mode`).
      mode: ctx.mode ?? null,
      reply: await finalReply({ ...facts, notices: ctx.notices }, ctx, { deadline: ctx.deadline }),
      hunks: null,
    },
  };
}

/**
 * Runs the separate `plan --hunks --plan <planId>` (CHG-19, M18 "`plan --hunks`",
 * C:plan-hunks): M12 `open`, then `resnapshotUnits`. The call takes its own M15 `deadline`
 * (540 s from its own start) for every M2 call of its steps (exceeded → `timeout`) and
 * `cleanupDeadline` for a refusal's tree-state read. `head-moved`, `diff-changed`, an
 * exit 3-5 refusal and an `internal` throw end the run (C:cli-and-exit-codes: M12
 * `releaseOpen`, its notice in the `failed` reply); a `lock` refusal keeps it. `close()`
 * runs for every call that reached a successful `open`.
 *
 * @param {{ plan: string, hunks: true }} values
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: object }>} on success the C:plan-hunks
 *   output object itself.
 */
async function planHunks(values, injected, { cwd }) {
  const callStarted = injected.callStarted ?? injected.now();
  const ctx = {
    injected, cwd, values, notices: [], opened: false,
    deadline: deadline(callStarted), cleanupDeadline: cleanupDeadline(callStarted),
  };
  try {
    // GIT-07: every M2 call of the steps takes `deadline - now()` at its own start; a call
    // that deadline ended or skipped ends the call `timed-out`, whatever the steps did.
    const scope = { deadline: ctx.deadline, now: injected.now };
    let facts;
    let thrown;
    try {
      facts = await withDeadline(scope, () => runSteps(PLAN_HUNKS_STEPS, ctx));
    } catch (err) {
      thrown = err;
    }
    if (scope.expired) {
      facts = { refusal: { code: 'timed-out', message: DEADLINE_TEXT } };
      thrown = undefined;
    }
    if (ctx.opened && (thrown !== undefined || PLAN_HUNKS_RUN_ENDING.has(facts.refusal?.code))) {
      const released = releaseOpen({ toplevel: ctx.toplevel, planId: values.plan });
      if (released.notice !== null) ctx.notices.push(released.notice);
    }
    if (thrown !== undefined) return await planInternalFailure(thrown, ctx);
    if (facts.refusal !== undefined) return await planRefusalFailure(facts.refusal, ctx);
    return { output: facts.hunks };
  } finally {
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
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
  // The call's start (RUN-03), so `releaseDeadline` bounds the whole call, not just the part
  // after it. GIT-07: read once at dispatch (`cli.mjs`'s `main`) and threaded through
  // `injected.callStarted` (review-RUN-03 finding 3); read here only for a direct call that
  // did not pass one. `release`'s own steps (probe, M12 `releaseById`) run under the same
  // 45 s `releaseDeadline` (user decision on KD-R78): past it, or after a git call it ended,
  // `release` ends `timed-out` (exit 5 `timeout`) before `releaseById`, so the run folder
  // and the lock are kept for the next `plan`'s takeover. The reply's tree-state read is
  // bounded by the same deadline (`finalReply`).
  const callStarted = injected.callStarted ?? injected.now();
  const ctx = {
    injected, cwd, values, deadline: releaseDeadline(callStarted), deadlineText: RELEASE_DEADLINE_TEXT,
  };
  const facts = await runStepsWithin(RELEASE_STEPS, ctx);
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  return { output: { reply: await finalReply(facts, ctx, { deadline: releaseDeadline(callStarted) }) } };
}

/**
 * Runs `commit --plan <planId> --all` (C:commit-release `commit`, M12 `open`).
 *
 * `open` is the whole call's own lock check (RUN-04): `taken-over` (the lock holds another
 * `planId`, or its own lock/`call.lock`/folder vanishes mid-call with a late `ENOENT`) and
 * `ended` (no lock, or a state `version` mismatch) are refused before any group-commit work;
 * `busy` covers only a live `call.lock`. A matched lock's call then runs M16 `commitAll`
 * over the stored groups (EXE-02) and releases the run (lock and folder) once no
 * group remains, or on a `head-moved`, `index-changed` or `index-locked` refusal (EXE-06,
 * EXE-07, EXE-08, C:cli-and-exit-codes), which also ends the run. `run.close()` always runs for a call
 * that reached a successful `open` (success or a later failure alike), never when `open`
 * itself failed (there is then no call.lock to
 * close). A run with no stored groups (or all committed) is refused `no-groups` (exit 1
 * `usage`, EXE-05) before any group work, right after the lock check: the run is kept (no
 * `releaseOpen`), and `close()` still removes this call's own `call.lock`. The same
 * `taken-over`/`busy` codes can also surface mid-loop, from EXE-04's `touch` before a later
 * group: unlike `open`'s own refusal above, that case has already committed earlier groups,
 * which `commitAll` reports in `commits`, and the run is kept rather than released, matching
 * `no-groups`.
 *
 * The output holds C:commit-release's fields (`commits`, `failed`, `remaining`, `error`,
 * `gitOutput`, `unstaged`) but no `reply` yet (KD-R73): INT-02 builds the `committed` reply
 * on `check`'s in-process `commit --all` only (`committedOutput`).
 *
 * @param {{ plan: string }} values the parsed and validated `commit` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 */
export async function commit(values, injected, { cwd }) {
  // EXE-16: the call's start (as `plan`'s own, RUN-12), so M15 `deadline` bounds M16
  // `commitAll`'s budget check (`nextStep`) across every group; read once at dispatch
  // (GIT-07, `injected.callStarted`), here only for a direct call that did not pass one.
  const callStarted = injected.callStarted ?? injected.now();
  const ctx = { injected, cwd, values, opened: false, deadline: deadline(callStarted) };
  try {
    const facts = await runSteps(COMMIT_STEPS, ctx);
    // EXE-06 AC3: a mid-run refusal (`head-moved` or `index-changed` here (EXE-06, EXE-07);
    // `taken-over`/`busy` from EXE-04's `touch` between groups) is still M16 `commitAll`'s
    // own outcome, with real groups already committed — unlike the other subcommands'
    // pre-folder refusals, it carries `commits`/`failed`/`remaining`/`unstaged`/`notices` per
    // C:commit-release, not only the refusal's own `kind`/`message` (review-EXE-04 Medium-1).
    // EXE-09: `gitOutput` too, git's verbatim output on a `git-failed` exit 4 (`null` on
    // every other refusal), so that failure never reads as success.
    if (facts.refusal !== undefined) return commitAllFailure(facts);
    // review-INT-02 N1: `commitGroups`' own `kept` (Low-3, review-INT-02 r2) is read by
    // `check`'s `committedOutput`, not reported here — C:commit-release's output shape has
    // no `kept` field, so a direct `commit --all` strips it the same way `committedOutput`
    // already does.
    const { kept, ...output } = facts;
    return { output };
  } finally {
    // `close` only after a successful `open` (`ctx.opened`): a failed `open` (`taken-over`,
    // `ended`, `busy`) leaves no `call.lock` of this call's own to close.
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
}

// A refusal M16 `commitAll` itself returned (`commit`, and `check`'s in-process
// `commit --all`): the C:commit-release fields beside the refusal's `kind`/`message`; the
// `failed` reply on it is KD-R73's gap.
function commitAllFailure(facts) {
  const { commits, failed, remaining, gitOutput, unstaged, notices } = facts;
  return {
    failure: {
      kind: kindForDomainCode(facts.refusal.code),
      message: facts.refusal.message,
      commits,
      failed,
      remaining,
      gitOutput,
      unstaged,
      notices,
      // EXE-13: a backstop refusal's `hits` (C:commit-release exit 3), M8's `patternId` as
      // C:plan's `pattern`, never the matched value.
      ...(facts.hits ? { hits: facts.hits.map(({ path, line, patternId }) => ({ path, line, pattern: patternId })) } : {}),
    },
  };
}

/**
 * Runs `check --plan <planId>` (C:check), the thin file-level form PLN-01 builds: M12 `open`
 * (the call's own lock check, as in `commit`), then `checkAlreadyCommitted` (RUN-19, M15
 * `checkGate`), then `validateWorkerPlan` — `CHECK_STEPS`, run inside the GIT-07 deadline
 * scope (`runStepsWithin`) — then `commitCheckedGroups` (INT-02's commit routing), run after
 * that scope has already exited, through its own plain `runSteps` call (review-INT-02
 * Medium-1; see `commitCheckedGroups`'s own comment). `run.close()` always runs for a call
 * that reached a successful `open`.
 *
 * GIT-07 (C:cli-and-exit-codes exit 5 `timeout` row names `check`): `check` takes its own M15
 * `deadline` the same way `plan` does, so a step past it ends as `timed-out` (review-GIT-07
 * finding Medium-2) instead of running unbounded; today none of `CHECK_STEPS`' own steps make
 * an M2 call past the exempt `probe()` (`validateWorkerPlan` is pure file/state work), so the
 * scope only guards future steps (M10 `treeState`) that will — `commitCheckedGroups`'s own
 * `commitAll` calls are deliberately outside it (Medium-1). A `timed-out` outcome reached
 * after `openRun` (`ctx.opened`), from either part, ends the run the same way every other
 * exit 3-5 refusal does (C:cli-and-exit-codes "exits 3-5 end the run"; review-GIT-07 r2
 * finding Low-2): `releaseOpen` runs before the reply, so the lock and the run folder go with
 * it, and the `finally`'s `close` below finds nothing of this call's own left to close, the
 * same pattern `commitGroups`' run-ending refusals and `plan --hunks`' `PLAN_HUNKS_RUN_ENDING`
 * use.
 *
 * @param {{ plan: string }} values the parsed and validated `check` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string,
 *   errors?: object[], reply?: object } }>} a lint failure carries C:check's `errors`, and a
 *   `reply` when it ends the worker's retries (RUN-16).
 */
export async function check(values, injected, { cwd }) {
  const callStarted = injected.callStarted ?? injected.now();
  const ctx = { injected, cwd, values, opened: false, deadline: deadline(callStarted) };
  try {
    const facts = await runStepsWithin(CHECK_STEPS, ctx);
    const validationEnding = checkRefusalEnding(facts, ctx, values);
    if (validationEnding !== undefined) return validationEnding;
    if (facts.lint !== undefined) return await lintFailureOf(facts, ctx);
    // review-INT-02 Medium-1: a second, plain `runSteps` call, unscoped by `withDeadline` —
    // `commitAll`'s own git calls (cleanup and reporting ones included, once
    // EXE-10/EXE-11/EXE-17 build them against `cleanupDeadline`) are never capped a second
    // time by the spent outer `deadline`, and a `timed-out` outcome here keeps whatever
    // `commits`/`remaining`/`unstaged` `commitAll` actually reached instead of being blanked
    // the way `runStepsWithin` blanks its own steps' outcome on `scope.expired`.
    const checked = await runSteps([commitCheckedGroups], ctx);
    const commitEnding = checkRefusalEnding(checked, ctx, values);
    if (commitEnding !== undefined) return commitEnding;
    if (checked.route === 'releaseNothing' || checked.route === 'handedBack' || checked.route === 'confirm') {
      return { output: await routedCheckOutput(checked, ctx, callStarted) };
    }
    if (checked.commits === undefined) return { output: checked };
    return { output: await committedOutput(checked, ctx, callStarted) };
  } finally {
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
}

// Shared refusal handling for both `CHECK_STEPS`' own outcome and the separate
// `commitCheckedGroups` call (review-INT-02 Medium-1): a `timed-out` refusal reached after
// `openRun` ends the run (lock and folder released) like every other exit 3-5 refusal
// (review-GIT-07 r2 finding Low-2); one before `openRun` ever ran has no run to release. One
// carrying `commits` is `commitAll`'s own refusal (e.g. `head-moved`), reported through
// `commitAllFailure`, not a bare refusal. Returns `undefined` when `facts` holds no refusal.
function checkRefusalEnding(facts, ctx, values) {
  if (facts.refusal === undefined) return undefined;
  // review-INT-02 N2: release only a `timed-out` with no `commits` (the pre-step or
  // `CHECK_STEPS` timeout) — one carrying `commits` is `commitAll`'s own outcome, and
  // `commitGroups` already decided whether to release (its own rule, matching `commit()`);
  // double-releasing here would delete the run folder out from under staging `commitAll`
  // deliberately kept (EXE-16's budget stop, a mid-loop `taken-over`/`busy`).
  if (ctx.opened && facts.refusal.code === 'timed-out' && facts.commits === undefined) {
    releaseOpen({ toplevel: ctx.toplevel, planId: values.plan });
  }
  if (facts.commits !== undefined) return commitAllFailure(facts);
  return refusalFailure(facts.refusal);
}

// INT-02 (C:check `confirm: null`, C:reply-and-handback): `check`'s in-process `commit --all`
// that ended with no refusal. All groups committed → the `committed` reply (the run is
// released by then, so `planId: null`, unless `release()` could not remove the lock —
// `outcome.kept: true`, review-INT-02 Low-3 — in which case the folder is still C:run-folder's
// for the next `plan`'s takeover, so `planId` names it instead); EXE-16's budget stop → the
// `continue` handback M16 `commitAll` built, moved from the output's interim top-level
// `handback` into `reply.handback`, with the run kept under `planId`. Either way the merged
// `notices` land in `reply.notices`. The tree-state read is a reporting call after the
// commits, so it runs against `cleanupDeadline` (M15) rather than the spent `deadline`
// (review-INT-02 Low-1, documented at C:commit-release's `cleanupDeadline` paragraph).
async function committedOutput(facts, ctx, callStarted) {
  // review-RUN-18 Medium-2: `route` is `commitCheckedGroups`'s own internal decision
  // (`commitCheckedGroups`'s `commit` branch carries it into `facts` alongside `handback`
  // and `kept`); C:check's output never has a `route` field, so it is stripped here too.
  const { handback, kept, route, ...output } = facts;
  // EXE-11: `unstaged` (what the run's index reset unstaged) goes to the reply's text too.
  const { commits, notices, unstaged } = output;
  const replyFacts = handback === undefined
    ? { status: 'committed', commits, unstaged, notices, planId: kept === true ? ctx.values.plan : null }
    : { status: 'handback', kind: 'continue', planId: ctx.values.plan, commits, unstaged, notices, handback };
  return { ...output, reply: await finalReply(replyFacts, ctx, { deadline: cleanupDeadline(callStarted) }) };
}

// RUN-18 (C:check): the three non-committing `afterCheck` routes. `releaseNothing` and
// `handedBack` already released the run in `commitCheckedGroups`, so `planId` is `null`;
// `confirm` kept the run (`awaitingConfirm` stored), so `planId` stays the run's. The tree
// read runs against `cleanupDeadline`, same as `committedOutput`: it reports on the state
// after this call's own work (the release, or nothing at all) is already done.
// review-RUN-18 Medium-1: `releaseNothing` always nulls the output's `confirm` here, even
// though `computeConfirm` may have returned a non-null stray `edited plan` reason for a
// resumed zero-group run (run-policy.mjs `afterCheck`'s own doc comment names this stray
// value) — C:check's "Zero groups" row fixes `confirm: null` regardless.
async function routedCheckOutput(facts, ctx, callStarted) {
  const { route, notices, confirm, ...output } = facts;
  const replyDeadline = cleanupDeadline(callStarted);
  let replyFacts;
  let outputConfirm = confirm;
  if (route === 'releaseNothing') {
    outputConfirm = null;
    replyFacts = { status: 'nothing', reason: 'zero-groups', notIncluded: facts.notIncluded, notices, planId: null };
  } else if (route === 'handedBack') {
    replyFacts = { status: 'handback', kind: 'handedBack', notices, planId: null };
  } else {
    replyFacts = {
      status: 'handback', kind: 'confirm', humanOnly: confirm?.humanOnly === true, notices,
      planId: ctx.values.plan,
    };
  }
  return { ...output, confirm: outputConfirm, notices, reply: await finalReply(replyFacts, ctx, { deadline: replyDeadline }) };
}

// RUN-16 (C:check "Lint failure", Q18): a `fix` is exit 2 with the `errors` and no `reply`.
// A `lintFailed` adds one: interactive, the `lintFailed` handback, keeping the run for its
// `resume`; with `--no-user` (`interactive: false`), the run ends here (M12 `releaseOpen`:
// the lock and the folder go, so the `finally`'s `close` finds nothing) and the reply is
// `failed` with the errors. M15 `runEnd` replaces this branch when RUN-27 builds it.
async function lintFailureOf(facts, ctx) {
  const count = facts.lint.length;
  const message = `${count} ${count === 1 ? 'error' : 'errors'}`;
  const failure = { kind: kindForDomainCode('lint'), message, errors: facts.lint };
  if (facts.lintEnding === 'fix') return { failure };
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  if (facts.interactive !== false) {
    failure.reply = await finalReply(
      { status: 'handback', kind: 'lintFailed', planId: run.planId, errors: facts.lint, shapeOnly: facts.shapeOnly },
      ctx,
    );
    return { failure };
  }
  const released = releaseOpen(run);
  failure.reply = await finalReply({
    status: 'failed',
    message: `Lint failed: ${message}`,
    errors: facts.lint,
    notices: released.notice === null ? [] : [released.notice],
  }, ctx);
  return { failure };
}

/**
 * Runs `infer` (C:infer): read-only, takes no lock and creates no run folder.
 *
 * GIT-07 (C:cli-and-exit-codes exit 5 `timeout` row names `infer`): `inferFromHistory`'s M3
 * history read is a real M2 call with no cap of its own, so `infer` takes its own M15
 * `deadline` the same way `plan` does (review-GIT-07 finding Medium-2), ending `timed-out`
 * instead of running unbounded.
 *
 * @param {object} values the parsed `infer` flags (none).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 */
export async function infer(values, injected, { cwd }) {
  const callStarted = injected.callStarted ?? injected.now();
  const ctx = { injected, cwd, values, deadline: deadline(callStarted) };
  const facts = await runStepsWithin(INFER_STEPS, ctx);
  if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
  return { output: facts };
}

// A refusal before any reply: RPL-04 adds the `failed` reply.
function refusalFailure(refusal) {
  return { failure: { kind: kindForDomainCode(refusal.code), message: refusal.message } };
}

// RPL-04: `plan`'s own refusal failure, built with the M17 `failed` reply (C:reply-and-
// handback, "Every pre-folder refusal... carries a `failed` reply with the base `callerRule`
// and no handback"). `facts.refusal` reaches here from every `plan` refusal, pre- and
// post-folder alike — every step of `PLAN_STEPS` that can end the run with one — so this is
// `plan`'s single refusal→reply seam, not only the merge case. A lock refusal (`held`,
// `EEXIST`) reaches it too: its error carries the holder fields (RUN-07, `holderFields`
// below); one with a readable holder clock (`lockHolderClock`, non-null: a minted `planId`
// **and** a `created` that parses) **and** a user to ask gets the `lock` handback instead
// (INT-05, `lockHandbackFailure` below) — an unparseable `created`, no `planId`, or an
// already-gone lock keeps this plain `failed` reply with no handback (C:reply-and-handback "A
// `lock` refusal whose holder has no `planId`... carries no handback" — the same unreadable
// case `heldMessage` falls back to for its own message text, review-INT-05 finding 2), and so
// does `--no-user` (Q22: "A run without a user gets a plain refusal and returns it to its
// parent"; C:reply-and-handback marks the `lock` row `interactive`, the same as `lintFailed`'s
// own `--no-user` skip in `lintFailureOf` below — unlike `modeChoice`, which carries no such
// qualifier and never checks `--no-user`). `release`, `commit`, `check` and `infer` keep
// `refusalFailure` above unchanged: their own `reply` wiring (`infer` has no `reply` field at
// all, C:infer) is later slices' (INT-02 built `check`'s success reply only; KD-R73 tracks the
// gap for `release`/`commit`). `ctx.toplevel` is not set yet this early in `plan()` (it is set
// from step 2), so the usable-worktree check below is done on `ctx.probe.repo` directly and
// passed to the shared `finalReply` as its `toplevel`.
//
// RUN-12, GIT-07: the reply's tree-state read is a reporting call after a failure, so it runs
// against `cleanupDeadline` (M15, C:plan) for every refusal, `timed-out` included: a read
// past 580 s is not spawned, and one that times out omits the tree state.
async function planRefusalFailure(refusal, ctx) {
  const toplevel = usableToplevel(ctx);
  const replyDeadline = ctx.cleanupDeadline;
  const clock = refusal.code === 'held' ? lockHolderClock(refusal.holder, ctx.injected.now()) : null;
  if (clock !== null && ctx.values['no-user'] !== true) {
    return lockHandbackFailure(refusal, ctx, toplevel, replyDeadline, clock);
  }
  return {
    failure: {
      kind: kindForDomainCode(refusal.code),
      message: refusal.message,
      reply: await finalReply(
        { status: 'failed', message: refusal.message, notices: ctx.notices },
        ctx,
        { toplevel, deadline: replyDeadline },
      ),
      ...(refusal.code === 'held' ? { errorFields: holderFields(refusal.holder) } : {}),
    },
  };
}

// INT-05 (C:reply-and-handback `lock` row, Q22, docs/roadmap/12-integration.md): a live lock
// with a readable holder clock (a `peek` refusal at step 3, or a lost race at step 7's
// `acquire`, RUN-06/RUN-07; the caller above already computed `clock` with `lockHolderClock`
// and excluded `--no-user`), becomes a `lock` handback: `take over` respawns `takeOver:
// <planId>` plus the refused call's own mode flag (`--staged`/`--split`, Q9: bare `plan`
// repeats none), `wait` ends the run, and `ifNoUser` waits and returns the text to the parent
// (reached only if a caller built this handback for a run that turns out to have no user
// after all, never by `--no-user` itself, which is filtered out before this function is
// called). `clock`'s `hhmm`/`idleSeconds` ride into the reply facts instead of a raw `holder`/
// `nowMs` pair, since the pure M17 reply module may not read the clock itself (review-INT-05
// finding 1). The refused call never held a lock of its own (`ctx.run` is never set before
// this point), so `plan`'s `finally` only discards this call's provisional folder; the
// holder's own lock and folder are never touched.
async function lockHandbackFailure(refusal, ctx, toplevel, replyDeadline, clock) {
  const modeFlag = ctx.values.staged === true ? 'staged' : (ctx.values.split === true ? 'split' : null);
  return {
    failure: {
      kind: kindForDomainCode(refusal.code),
      message: refusal.message,
      reply: await finalReply(
        {
          status: 'handback', kind: 'lock', holder: refusal.holder, modeFlag,
          hhmm: clock.hhmm, idleSeconds: clock.idleSeconds, notices: ctx.notices,
        },
        ctx,
        { toplevel, deadline: replyDeadline },
      ),
      errorFields: holderFields(refusal.holder),
    },
  };
}

// KD-R64 (RUN-12): an unexpected throw inside `plan`'s steps ends the call as `internal`
// (exit 1) with a `failed` reply carrying the notices collected so far (the cleanup's
// discard or release notice included); its tree-state read runs against `cleanupDeadline`.
// The message keeps `commit.cjs`'s backstop wording, which still catches throws outside the
// step table (an unbuilt flag, a module that fails to load).
async function planInternalFailure(err, ctx) {
  const message = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  // C:cli-and-exit-codes: "stderr carries debug output only." Before this function existed, a
  // throw inside `plan` always escaped to `commit.cjs`'s backstop, which wrote the stack there
  // (`commit: unexpected error\n<stack>`). Since RUN-12 catches the throw here instead (so the
  // reply and notices survive it, KD-R64), nothing wrote it any more; write the same line here
  // so an internal failure from inside `plan`'s steps stays as diagnosable as one from outside
  // them. `ctx.injected.stderr` is `?.`-guarded like `loadConfigLayers`' warnings above, so a
  // direct `workflows.plan` call with no `stderr` injected is unaffected.
  ctx.injected.stderr?.write(`commit: unexpected error\n${err instanceof Error ? err.stack : String(err)}\n`);
  const facts = { status: 'failed', message, notices: ctx.notices };
  // A tree-state read that throws too (the repository that broke the step may break it)
  // never replaces the original error: the reply then omits the tree state.
  const failedReply = await finalReply(facts, ctx, { toplevel: usableToplevel(ctx), deadline: ctx.cleanupDeadline })
    .catch(() => reply({ ...facts, treeState: undefined }));
  return { failure: { kind: 'internal', message, reply: failedReply } };
}

// The usable worktree's top level from the probe (`undefined` when there is none, or the
// call ended before the probe ran): `ctx.toplevel` is set only from step 2.
function usableToplevel(ctx) {
  const repo = ctx.probe?.repo ?? null;
  return repo !== null && repo.kind === 'worktree' ? repo.toplevel : undefined;
}

// RUN-07 (C:cli-and-exit-codes): a `lock` error carries the holder's `planId`, `created` and
// `touched` (the lock's mtime, as an ISO time), from a `peek` refusal and a lost `acquire`
// alike; M12 already sets `planId` and `created` to `null` for an unreadable lock. A lock
// gone again before `acquire`'s lost race could read it names no holder: all three `null`.
function holderFields(holder) {
  if (holder === null) return { planId: null, created: null, touched: null };
  return { planId: holder.planId, created: holder.created, touched: new Date(holder.touched).toISOString() };
}

// Every reply ends with the tree state, read after the call's last git call (M10) — except
// past a given `readDeadline` (RUN-03, `release`'s `releaseDeadline`; RUN-12, `plan`'s
// `cleanupDeadline`): the read is skipped entirely (never spawned) and the reply omits the
// tree state, since the call it would report on (here, the release itself) is already
// complete. `toplevel` defaults to `ctx.toplevel` (the usual case, set from `plan` step 2 or
// `release` step 1 onward); `planRefusalFailure` passes its own, since a `plan` refusal can
// end before `ctx.toplevel` is set, and `undefined` (no usable worktree: `not-a-repo`,
// `bare`, a pre-toplevel start-up `spawnSync` `timed-out` (M2, before the probe has run; a
// `plan` refusal past RUN-12's own 540 s `deadline` already has a toplevel by then and is
// caught by the `readDeadline` check below instead, not by this one), or no git at all,
// C:reply-and-handback) skips the read the same way a spent `readDeadline` does.
//
// GIT-07 (docs/roadmap/06-git-adapters.md): a read that starts runs inside M2 `withDeadline`,
// so its `timeoutMs` is `readDeadline - now()` at its own start; one that deadline ends (the
// scope `expired`, `change-set.mjs`'s `treeState` then throws) lands here as
// `treeState: undefined`, the same as a read skipped outright, never as a thrown `internal`
// failure. Any other failure of the read still throws.
//
// The option is named `deadline` at every call site (`plan`'s success reply's `ctx.deadline`,
// `release`'s own, `planRefusalFailure`'s `replyDeadline`, `planInternalFailure`'s
// `ctx.cleanupDeadline`); read into `readDeadline` here only, so it never shadows the M15
// `deadline()` function this module imports (review-RUN-12 finding 2).
async function finalReply(facts, ctx, { deadline: readDeadline, toplevel = ctx.toplevel } = {}) {
  const { env, now } = ctx.injected;
  if (toplevel === undefined || (readDeadline !== undefined && now() >= readDeadline)) {
    return reply({ ...facts, treeState: undefined });
  }
  if (readDeadline === undefined) return reply({ ...facts, treeState: await treeState({ toplevel, env, now }) });
  const scope = { deadline: readDeadline, now };
  let finalTree;
  try {
    finalTree = await withDeadline(scope, () => treeState({ toplevel, env, now }));
  } catch (err) {
    if (!scope.expired) throw err;
  }
  return reply({ ...facts, treeState: scope.expired ? undefined : finalTree });
}
