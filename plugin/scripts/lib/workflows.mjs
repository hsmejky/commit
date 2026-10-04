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
// to withhold a hit's whole body) are stored. Later
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

import {
  HEAD_MOVED_TEXT, commitEncoding, head, headState, historyMessages, inProgressState, isTracked,
  oldMessage, probe, recentSubjects, rewordFacts,
} from './repo-probe.mjs';
import {
  assignIds, indexFingerprint, inventory as takeInventory, snapshot, trackedDirectories, treeState,
  unplannableCaseRenames,
} from './change-set.mjs';
import { applyCaps, bucketOf } from './path-classifier.mjs';
import {
  releaseById, releaseOpen, open, close, create, readState, readWorkerPlan, writeState, sweep,
  RUN_DIR_NAME, STATE_VERSION,
} from './run.mjs';
import { INDEX_CHANGED_TEXT, commitAll } from './commit-executor.mjs';
import { validatePlan } from './plan-validator.mjs';
import { renderHunks } from './hunk-index.mjs';
import { gitPath, withDeadline } from './process-adapter.mjs';
import { escapePath, reply } from './reply.mjs';
import {
  cleanupDeadline, deadline, onLintFailure, planRefusal, releaseDeadline, resolveMode,
} from './run-policy.mjs';
import { kindForDomainCode } from './domain-codes.mjs';
import { loadConfig, readLayers } from './config.mjs';
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
    // edit itself flagging the repo config's own units) move to SCN-14.
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
 * lock read-only, before any inventory work: a live lock refuses `lock`.
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
// `other`: `unstagedTracked`'s length (RUN-13, KD-R75) — every path with a worktree change,
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
  try {
    units = assignIds(ctx.mode === 'reword'
      // CHG-15 (Q20, C:plan-hunks "what is diffed"): HEAD's own diff against its single
      // parent, or the empty tree on a root commit (GIT-09's `rewordFacts.root`, read at
      // step 1). No temporary index, so staged changes never reach these units and the real
      // index is untouched (RUN-06).
      ? await snapshot({
        mode: 'reword',
        head: ctx.expectedHead,
        root: ctx.reword.root,
        toplevel: ctx.toplevel,
        env: ctx.injected.env,
        now: ctx.injected.now,
      })
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
  const candidatePaths = new Set(
    ctx.mode === 'reword' ? [] : ctx.inventory.candidates.map((candidate) => candidate.path),
  );
  const byPath = new Map();
  for (const { path, oldPath, status, added, deleted } of units) {
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
 * `{ h4: ["github-token"], h9: "skipped" }`. A hit's `(path, line)` belongs to exactly one
 * unit of that path (hunk-level units never share a line; a whole-file unit's one unit
 * holds every line of the file); a path appears in `skipped` once however many of its units
 * are over the limit, so every one of them is flagged. `scanIgnoreUnits` (a `scanIgnore`
 * edit itself flagging the repo config's own units) is SCN-14's; this slice flags hits and
 * skips only.
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
  for (const { patternId, path, line } of hits) {
    const id = unitByPathLine.get(`${path}\u0000${line}`);
    if (id === undefined) {
      throw new Error(`a scan hit at ${path}:${line} matches no unit's added lines`);
    }
    (scanned[id] ??= []).push(patternId);
  }
  const skippedPaths = new Set(skipped.map(({ path }) => path));
  for (const unit of units) {
    if (skippedPaths.has(unit.path)) scanned[unit.id] = 'skipped';
  }
  return scanned;
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
 */
async function scanDiff(ctx) {
  if (ctx.units === undefined || ctx.mode === 'reword') {
    ctx.scan = { hits: [], skipped: [] };
    ctx.scanMap = {};
    return undefined;
  }
  const { hits, skipped } = scanUnits(ctx.units, {
    scanIgnore: ctx.scanIgnoreMatchers,
    osUser: ctx.injected.osUser,
  });
  ctx.scan = { hits, skipped };
  ctx.scanMap = buildScanMap(ctx.units, { hits, skipped });
  return undefined;
}

/**
 * Step 6: post-scan refusals. A clean tree ends the call with `nothing`, except in `reword`,
 * which takes the lock on a clean tree too (C:plan step 6, RUN-06). Then the signing probe
 * (GIT-10, M11), so a clean tree on a locked key reports "nothing to commit": M15
 * `planRefusal` refuses its `ready: false` (`signing-locked`); `"prompt"` queues the note.
 */
async function postScanRefusals(ctx) {
  if (ctx.inventory.clean === true && ctx.mode !== 'reword') return { status: 'nothing', reason: 'clean' };
  const { env, now, osHome } = ctx.injected;
  ctx.signing = await probeSigning({ toplevel: ctx.toplevel, env, now, osHome });
  const refusal = planRefusal({ ...ctx.probe, signing: ctx.signing });
  if (refusal !== null) return { refusal };
  if (ctx.signing.ready === 'prompt') ctx.notices.push(SIGNING_PROMPT_NOTICE);
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
    // GIT-09: `reword` only (C:run-folder): HEAD's message, and whether HEAD is a root
    // commit, which CHG-15's snapshot diffs against the empty tree.
    ...(ctx.mode === 'reword' ? { oldMessage: ctx.oldMessage, rootCommit: ctx.reword.root } : {}),
  };
  ctx.provisional.write('state.json', `${JSON.stringify(ctx.storedState)}\n`);
  // A race lost to another run's lock (`held`, RUN-06) refuses `lock`; with no `ctx.run`,
  // `plan`'s `finally` deletes only this call's own provisional folder. `holder` becomes the
  // failure's `planId`/`created`/`touched` error fields (`planRefusalFailure`, RUN-07).
  const acquired = ctx.provisional.acquire({ now: ctx.injected.now });
  if (!acquired.ok) return { refusal: { code: acquired.code, message: acquired.message, holder: acquired.holder } };
  ctx.run = acquired.run;
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
    // matched value) and skips from `scanDiff` (step 5). `scanIgnoreChanged` is SCN-14's;
    // `false` is a stand-in until that slice computes it.
    scan: {
      hits: ctx.scan.hits.map(({ path, line, patternId }) => ({ path, line, pattern: patternId })),
      skipped: ctx.scan.skipped,
      scanIgnoreChanged: false,
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
 */
async function renderHunkIndex(ctx) {
  const { stdoutObj, hunksTxt } = renderHunks(
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
// `no-groups`/`taken-over`/`busy` refusal keeps the run instead (no `releaseOpen`; only this
// call's `call.lock` goes, via the `finally` in `commit()` below — `ctx.opened` is already
// true by the time this step runs), matching `usage`/`lock` not ending the run; `head-moved`,
// `index-changed` (`diff-changed`), `index-locked` (`index-lock`), and EXE-09's `unmatched`
// (`diff-changed`) and `git-failed` all end it the same way (C:cli-and-exit-codes).
// The release's notice and the `reply` with `status: "committed"` are INT-02's
// (C:reply-and-handback).
async function commitGroups(ctx) {
  const run = { toplevel: ctx.toplevel, planId: ctx.values.plan };
  const { env, now, osUser } = ctx.injected;
  const outcome = await commitAll(run, {
    now, osUser, env, deadline: ctx.deadline, scriptPath: ctx.injected.scriptPath,
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
  // kind `diff-changed`) and `git-failed` (exit 4: "exits 3-5 end the run").
  if ((!outcome.refusal && outcome.remaining.length === 0)
    || outcome.refusal?.code === 'head-moved' || outcome.refusal?.code === 'index-changed'
    || outcome.refusal?.code === 'index-locked' || outcome.refusal?.code === 'unmatched'
    || outcome.refusal?.code === 'git-failed') {
    releaseOpen(run);
  }
  return outcome;
}

const COMMIT_STEPS = Object.freeze([probeRepo, commitRefusals, openRun, commitGroups]);

/** `check` step 2: see `subcommandRefusals`. */
async function checkRefusals(ctx) {
  return subcommandRefusals(ctx, 'check');
}

/**
 * `check` step 4 (PLN-01): clears the stored groups and `awaitingConfirm` before anything is
 * validated (C:check), so a failed `check` leaves no group that `commit` would accept, then
 * M14 `validatePlan` over `plan.groups.json` and the run state. A lint failure ends the call
 * with exit 2 and the `errors`; RUN-16 counts it in `lintFailures` and asks M15
 * `onLintFailure` whether it ends the worker's retries (`lintEnding`, which `check` turns into
 * a `reply`), passing on the run's `interactive`. On success the validated groups are stored with
 * `committed: false`; the output is `groups`, `notIncluded` and `notices` only, with the
 * lock kept: M15 `checkGate` (RUN-19), `computeConfirm` and the routing to `commit --all`
 * arrive with their own slices (RUN-17, RUN-18, EXE-02, INT-02).
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
    return { lint: validated.errors, lintEnding, interactive: state.interactive };
  }
  writeState(run, { ...state, groups: validated.stored.map((group) => ({ ...group, committed: false })) });
  return { groups: validated.groups, notIncluded: validated.notIncluded, notices: validated.notices };
}

const CHECK_STEPS = Object.freeze([probeRepo, checkRefusals, openRun, validateWorkerPlan]);

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

// RUN-12: `plan`'s deadline bounds its git calls (C:plan). A call that set `ctx.deadline`
// (only `plan` so far) is checked before every step that makes git calls, and before step 7's
// re-reads once the lock is held (`storeAndLock`): past it the call ends as `timed-out` (exit 5
// `timeout`) and `plan`'s own cleanup discards or releases the run. The steps after the
// sweep make no git call, so a clock past the deadline there no longer ends the run. Inside
// a step, GIT-07 bounds each M2 call by `deadline - now()` at its own start (`plan` runs its
// step table inside M2 `withDeadline`); a call that deadline ends or skips marks the scope
// `expired`, and `plan` then ends `timed-out` the same way.
function pastDeadline(ctx) {
  if (ctx.deadline === undefined || ctx.injected.now() < ctx.deadline) return undefined;
  return { refusal: { code: 'timed-out', message: DEADLINE_TEXT } };
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
  // RUN-12: the call's start, so M15 `deadline` and `cleanupDeadline` bound the whole call;
  // GIT-07: read once at dispatch (`cli.mjs`'s `main`, `injected.callStarted`), here only
  // for a direct call that did not pass one.
  const callStarted = injected.callStarted ?? injected.now();
  // Only bare `plan`, `plan --split`, `plan --reword` (RUN-06: the lock on a clean tree;
  // its reword facts GIT-09's, its snapshot CHG-15's) and `plan --staged` (RUN-13: its mode
  // decision; its index-only snapshot is CHG-14's) are built: every other flag changes the
  // mode or the clean-tree outcome (C:plan `mode`).
  const unbuilt = ['dictated', 'take-over', 'hunks'].filter((f) => values[f] !== undefined);
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
  // did not pass one. `release`'s own steps run outside any deadline scope (KD-R78); only
  // the reply's tree-state read is bounded, by `releaseDeadline` (`finalReply`).
  const callStarted = injected.callStarted ?? injected.now();
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
 * `gitOutput`, `unstaged`) but no `reply` yet: the `reply` with `status: "committed"` is
 * asserted first in INT-02 (docs/roadmap/12-integration.md), which builds that reply surface.
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
    if (facts.refusal !== undefined) {
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
        },
      };
    }
    return { output: facts };
  } finally {
    // `close` only after a successful `open` (`ctx.opened`): a failed `open` (`taken-over`,
    // `ended`, `busy`) leaves no `call.lock` of this call's own to close.
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
}

/**
 * Runs `check --plan <planId>` (C:check), the thin file-level form PLN-01 builds: M12 `open`
 * (the call's own lock check, as in `commit`), then `validateWorkerPlan`. `run.close()`
 * always runs for a call that reached a successful `open`.
 *
 * @param {{ plan: string }} values the parsed and validated `check` flags (M1 `parseArgv`).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string,
 *   errors?: object[], reply?: object } }>} a lint failure carries C:check's `errors`, and a
 *   `reply` when it ends the worker's retries (RUN-16).
 */
export async function check(values, injected, { cwd }) {
  const ctx = { injected, cwd, values, opened: false };
  try {
    const facts = await runSteps(CHECK_STEPS, ctx);
    if (facts.refusal !== undefined) return refusalFailure(facts.refusal);
    if (facts.lint !== undefined) return await lintFailureOf(facts, ctx);
    return { output: facts };
  } finally {
    if (ctx.opened) close({ toplevel: ctx.toplevel, planId: values.plan });
  }
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
    failure.reply = await finalReply({ status: 'handback', kind: 'lintFailed', planId: run.planId, errors: facts.lint }, ctx);
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
 * @param {object} values the parsed `infer` flags (none).
 * @param {object} injected the injected environment.
 * @param {{ cwd: string }} call the call's working directory.
 * @returns {Promise<{ output: object } | { failure: { kind: string, message: string } }>}
 */
export async function infer(values, injected, { cwd }) {
  const ctx = { injected, cwd, values };
  const facts = await runSteps(INFER_STEPS, ctx);
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
// below), and it gets this same plain `failed` reply with no handback until INT-05 and
// RPL-05 add the documented `lock` handback. `release`,
// `commit`, `check` and `infer` keep `refusalFailure` above unchanged: their own `reply`
// wiring (`infer` has no `reply` field at all, C:infer) is later slices' (INT-02 and after;
// KD-R73 tracks the gap for `release`/`commit`). `ctx.toplevel` is not set yet this early in
// `plan()` (it is set from step 2), so the usable-worktree check below is done on
// `ctx.probe.repo` directly and passed to the shared `finalReply` as its `toplevel`.
//
// RUN-12, GIT-07: the reply's tree-state read is a reporting call after a failure, so it runs
// against `cleanupDeadline` (M15, C:plan) for every refusal, `timed-out` included: a read
// past 580 s is not spawned, and one that times out omits the tree state.
async function planRefusalFailure(refusal, ctx) {
  const toplevel = usableToplevel(ctx);
  const replyDeadline = ctx.cleanupDeadline;
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
