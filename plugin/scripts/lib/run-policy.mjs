// M15 Run policy (docs/spec/modules-m14-m19.md, C:plan, C:cli-and-exit-codes): every pure
// decision of a run. Pure: facts in, a typed decision with a domain code out; M18 maps the
// domain code to a CLI kind.
//
// GIT-01 builds the first `planRefusal` rows: `env` (git missing, unreadable or older than
// 2.34), `state` (not a repository, bare repository) and `timed-out` (a start-up `spawnSync`
// call, M2, past its fixed short timeout; GIT-07 brings the 540 s deadline). Node older than
// 22 stays enforced by the entry point (`commit.cjs`), before M15 ever loads. CFG-02 adds
// `config` (C:plan step 2 order: `env`, `config`, `state`); GIT-02 onward adds the other
// `state` rows; GIT-04 adds `unmerged` (recorded text) and `encoding` (no recorded text,
// only a message naming the state), both ahead of the not-a-repo/bare rows (moot in
// practice: `unmerged`/`commitEncoding` are only ever facts inside a worktree); RUN-14 pins
// their order with Seam-1 tests.
//
// GIT-09 adds the reword rows (Q20, C:plan step 2), after every other `state` row: an
// unborn or merge-commit HEAD (`state`), then `pushed`.
//
// GIT-10 adds the `signing` row (Q18, C:plan step 6): M11's `ready: false` refuses
// `signing-locked`, last, after every pre-folder row; `plan` calls it again at step 6, after
// the clean-tree check, with the probe's result. RUN-15 adds the clean-tree row itself
// (`nothing`, never in `reword`) between `staged-hit` and `signing`, and its message, naming
// the hidden-only, collapsed-only, `stagedExcluded`-only, non-UTF-8-only, `dirtySubmodules`-
// only or `embeddedRepos`-only reasons M18 still found clean.
//
// RUN-03 adds `releaseDeadline`, `release`'s 45 s budget on its tree-state read.
//
// RUN-13 adds `resolveMode`, without a takeover (`killedLeftover: false`; RUN-24 adds it).
//
// RUN-16 adds `onLintFailure`, the lint-failure counter that ends the worker's retries.
//
// RUN-19 adds `checkGate`, the already-committed-group refusal `check` runs after `open`.
//
// RUN-17 adds `computeConfirm`, `check`'s confirmation table (C:confirmation-triggers). It
// stays data-in/data-out: M18 resolves each group's included unit IDs to paths against
// `state.json`'s unit table, `scanned` map and `scanIgnoreUnits` list before calling in, so
// this function never needs a unit table of its own.
//
// RUN-18 adds `afterCheck`, `check`'s routing over `computeConfirm`'s own decision (C:check):
// zero groups always releases, whatever `confirm` holds (a resumed zero-group run could
// otherwise carry an "edited plan" reason with nothing to confirm); `confirm: null` commits
// right away; a non-null `confirm` commits the same way only when the run is `--no-user` and
// the reason is not `humanOnly` (nobody but the worker reviewed the grouping, Q17); every
// other non-null `confirm` either hands back for a real answer (interactive) or hands back
// and ends the run (`--no-user`, `humanOnly`).

/** The oldest supported git (Q1, Q15, story 202). */
export const MIN_GIT = Object.freeze({ major: 2, minor: 34 });

const NEEDS_GIT = `/commit needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer`;

function isOlder(version, min) {
  return version.major < min.major || (version.major === min.major && version.minor < min.minor);
}

function envRefusal({ git }) {
  if (git.status === 'missing') return `git was not found on PATH; ${NEEDS_GIT}`;
  if (git.status === 'unreadable') {
    return `git reported an unreadable version (${JSON.stringify(git.output)}); ${NEEDS_GIT}`;
  }
  if (git.status === 'ok' && isOlder(git.version, MIN_GIT)) {
    return `git ${git.version.text} is older than ${MIN_GIT.major}.${MIN_GIT.minor}; ${NEEDS_GIT}`;
  }
  return null;
}

const STATE_MESSAGES = Object.freeze({
  'not-a-repo': 'not a git repository (or not inside its working tree); run /commit inside one',
  bare: 'a bare repository has no working tree; run /commit inside a working tree',
});

// GIT-03 (Q21, C:cli-and-exit-codes recorded texts): the message for each `inProgressState`
// kind. `merge`, `cherry-pick` and `revert` share one text; `bisect` has no recorded text
// (C:plan "Recorded texts": tests assert the domain code and that the state is named).
const IN_PROGRESS_MESSAGES = Object.freeze({
  merge: 'finish it with `git commit --no-edit`, or abort it',
  'cherry-pick': 'finish it with `git commit --no-edit`, or abort it',
  revert: 'finish it with `git commit --no-edit`, or abort it',
  rebase: 'continue the rebase by hand',
  sequence: 'continue or abort it by hand',
  squash: 'a squashed merge is staged: commit it by hand, or drop it with `git reset --merge`',
  bisect: 'a bisect is in progress; finish it, or run `git bisect reset`',
});

// GIT-04 (Q21, C:cli-and-exit-codes recorded texts): verbatim, unlike `encoding` below, which
// has no recorded text.
const UNMERGED_MESSAGE = 'resolve the conflicts first';

// GIT-04 (Q21): `i18n.commitEncoding` compared case-insensitively against these two spellings;
// anything else refuses. `null`/`undefined` (the key unset, git's own default) always passes.
// Not trimmed: git does not trim a quoted value either (probe, review-GIT-04 finding 5), so a
// value with surrounding whitespace, which git would still label with, is refused here too.
const UTF8_ENCODINGS = new Set(['utf-8', 'utf8']);

function isUtf8Encoding(value) {
  return UTF8_ENCODINGS.has(value.toLowerCase());
}

// GIT-09 (Q20): only the merge-commit text is recorded (C:cli-and-exit-codes); the unborn and
// pushed texts only name their state.
const UNBORN_REWORD_MESSAGE = 'HEAD is unborn (no commit yet): there is no commit to reword';
const MERGE_REWORD_MESSAGE = 'HEAD is a merge commit; reword it by hand';
const PUSHED_MESSAGE = 'HEAD is already on a remote-tracking ref (pushed): rewording it would rewrite shared history';
// Q18, C:cli-and-exit-codes recorded texts: verbatim.
const SIGNING_LOCKED_MESSAGE = 'signing key locked — unlock it (e.g. sign once in a terminal), then `/commit`';

function rewordRefusal(reword) {
  if (reword == null) return null;
  if (reword.unborn) return { code: 'unborn', message: UNBORN_REWORD_MESSAGE };
  if (reword.merge) return { code: 'merge', message: MERGE_REWORD_MESSAGE };
  if (reword.pushed) return { code: 'pushed', message: PUSHED_MESSAGE };
  return null;
}

/**
 * The pre-folder refusals of `plan` (C:plan step 2), in order: `env`, then `config` (M4's
 * result, already loaded by M18 step 1: M15 stays pure, so it never reads a layer itself),
 * then `state`, then a start-up call's `timed-out` (M2's fixed short timeout, before any run
 * folder exists).
 *
 * @param {{ git: object, node: object, repo: object|null,
 *   config?: { error: string } | { values: object, sources: object } | null,
 *   inProgress?: { kind: string } | null, unmerged?: boolean, commitEncoding?: string | null,
 *   reword?: { unborn: boolean, merge: boolean, root: boolean, pushed: boolean } | null,
 *   signing?: { enabled: boolean, format?: string, ready?: boolean|string },
 *   stagedHit?: { hidden?: string[], hits?: string[], notUtf8?: string[] } | null,
 *   clean?: { hidden?: { count: number, sample: string[] }, collapsed?: Array<{ dir: string,
 *     count: number }>, stagedExcluded?: Array<{ path: string, reason: 'hidden' } |
 *     { dir: string, count: number, reason: 'collapsed' }>, dirtySubmodules?: string[],
 *     notUtf8?: string[], embeddedRepos?: string[] } | null }}
 *   facts the M3 probe result, plus M4's `loadConfig` result under `config` (CFG-05: an
 *   `{ error }` object only when a layer error was found, else the effective `{ values,
 *   sources }`, which never refuses; `null` or omitted is also "no error" for callers that
 *   never loaded a config at all, e.g. the pure unit tests below). The user layer is checked
 *   even outside a worktree, so this can hold a user-layer error there too (CFG-04). Plus M3
 *   `inProgressState()`'s result under `inProgress` (GIT-03; `null` or omitted outside a
 *   worktree, or when nothing is in progress), plus M3 `headState()`'s `unmerged` (GIT-04;
 *   `false`, `null` or omitted outside a worktree, or when the index holds no unmerged
 *   entry), plus M3 `commitEncoding()`'s result under `commitEncoding` (GIT-04; `null` or
 *   omitted outside a worktree, or when the key is unset), plus M3 `rewordFacts()`'s result
 *   under `reword` (GIT-09; `null` or omitted without `--reword`; a root commit refuses
 *   nothing), plus M11 `probeSigning()`'s result under `signing` (GIT-10; omitted at step 2,
 *   which runs before the probe; only `ready: false` refuses), plus, at step 6 of `plan
 *   --staged` only, `stagedHit: { hidden, hits, notUtf8 }` (CHG-14: escaped paths of the
 *   hidden staged-new paths, the scan-hit paths and the staged non-UTF-8 paths), which
 *   refuses `staged-hit` ahead of the signing row. Plus, also at step 6, `clean` (RUN-15,
 *   never in `reword`): the breakdown of whatever still counts as clean but is named for the
 *   user (hidden-only, collapsed-only, `stagedExcluded`-only, non-UTF-8-only,
 *   `dirtySubmodules`-only or `embeddedRepos`-only), present only when M18's own `clean`
 *   check (M10 `inventory`'s `clean`, recomputed post-cap) found the tree clean; it then
 *   returns `{ code: 'nothing', ... }` ahead of the signing row too, so a clean tree on a
 *   locked key reports "nothing to commit", not `signing` (Q9, Q18).
 * @returns {{ code: string, message: string } | null} the refusal's domain code and
 *   message, or `null` when `plan` goes on.
 */
export function planRefusal(facts) {
  const envMessage = envRefusal(facts);
  if (envMessage !== null) return { code: 'env', message: envMessage };
  if (facts.config?.error !== undefined) return { code: 'config', message: facts.config.error };
  if (facts.inProgress != null) {
    return { code: 'in-progress', message: IN_PROGRESS_MESSAGES[facts.inProgress.kind] };
  }
  if (facts.unmerged === true) return { code: 'unmerged', message: UNMERGED_MESSAGE };
  if (facts.commitEncoding != null && !isUtf8Encoding(facts.commitEncoding)) {
    return {
      code: 'encoding',
      message: `i18n.commitEncoding is set to \`${facts.commitEncoding}\`, not UTF-8: commits would be labelled with the wrong encoding`,
    };
  }
  if (facts.repo !== null && Object.hasOwn(STATE_MESSAGES, facts.repo.kind)) {
    return { code: facts.repo.kind, message: STATE_MESSAGES[facts.repo.kind] };
  }
  const reword = rewordRefusal(facts.reword);
  if (reword !== null) return reword;
  if (facts.git.status === 'timed-out' || (facts.repo !== null && facts.repo.kind === 'timed-out')) {
    return { code: 'timed-out', message: 'git did not answer its start-up call in time' };
  }
  if (facts.stagedHit != null) return { code: 'staged-hit', message: stagedHitMessage(facts.stagedHit) };
  // RUN-15 (Q9, Q16, Q11, C:plan step 6, stories 156, 219): the clean-tree check, after
  // `staged-hit` and before the signing probe, so a clean tree on a locked key reports
  // "nothing to commit" rather than `signing` (never checked in `reword`, M18's own job to
  // skip). `facts.clean` carries the breakdown (already escaped by M18, as `stagedHit`
  // is) of whatever counts as clean but is still named for the user.
  if (facts.clean != null) return { code: 'nothing', message: cleanTreeMessage(facts.clean) };
  if (facts.signing?.ready === false) return { code: 'signing-locked', message: SIGNING_LOCKED_MESSAGE };
  return null;
}

// RUN-15 (C:plan `clean`, stories 156, 219): one part per reason that still applies on a
// clean tree, joined with "; ", each naming its (already escaped) count and paths as M18's
// `stagedHitMessage` does. `hidden.sample` is already capped at 5 by M10; a remainder is
// named as "+N more". `undefined`/empty collections name nothing, so a truly empty tree
// (nothing left at all) still reads as plain "nothing to commit".
function cleanTreeMessage(clean) {
  const { hidden, collapsed = [], stagedExcluded = [], dirtySubmodules = [], notUtf8 = [], embeddedRepos = [] } = clean;
  const list = (paths) => paths.map((p) => `\`${p}\``).join(', ');
  const parts = [];
  if (hidden != null && hidden.count > 0) {
    const shown = list(hidden.sample);
    const extra = hidden.count - hidden.sample.length;
    const noun = hidden.count === 1 ? 'hidden file' : 'hidden files';
    parts.push(`${hidden.count} ${noun}: ${shown}${extra > 0 ? `, +${extra} more` : ''}`);
  }
  const collapsedDirs = collapsed.map(({ dir, count }) => `\`${dir}\` (${count} collapsed)`);
  if (collapsedDirs.length > 0) parts.push(collapsedDirs.join(', '));
  const stagedHidden = stagedExcluded.filter((e) => e.reason === 'hidden').map((e) => e.path);
  if (stagedHidden.length > 0) {
    parts.push(stagedHidden.length === 1
      ? `${list(stagedHidden)} is staged but hidden — commit by hand`
      : `${list(stagedHidden)} are staged but hidden — commit by hand`);
  }
  const stagedCollapsed = stagedExcluded
    .filter((e) => e.reason === 'collapsed')
    .map(({ dir, count }) => `\`${dir}\` (${count} staged, collapsed)`);
  if (stagedCollapsed.length > 0) parts.push(stagedCollapsed.join(', '));
  if (dirtySubmodules.length > 0) {
    parts.push(`${dirtySubmodules.length === 1 ? 'dirty submodule' : 'dirty submodules'}: ${list(dirtySubmodules)}`);
  }
  if (notUtf8.length > 0) {
    parts.push(`${notUtf8.length === 1 ? 'path' : 'paths'} not UTF-8: ${list(notUtf8)}`);
  }
  if (embeddedRepos.length > 0) {
    const noun = embeddedRepos.length === 1 ? 'embedded repository' : 'embedded repositories';
    parts.push(`${noun}: ${list(embeddedRepos)}`);
  }
  return parts.length === 0 ? 'nothing to commit' : `nothing to commit: ${parts.join('; ')}`;
}

// CHG-14 (Q10, C:plan step 6, C:cli-and-exit-codes `staged-hit`): one part per reason that
// applies, joined with "; ", each naming its (already escaped) paths as "`a`, `b`".
function stagedHitMessage({ hidden = [], hits = [], notUtf8 = [] }) {
  const list = (paths) => paths.map((p) => `\`${p}\``).join(', ');
  const parts = [];
  if (hidden.length > 0) {
    parts.push(hidden.length === 1
      ? `${list(hidden)} is staged but hidden — unstage it or commit by hand`
      : `${list(hidden)} are staged but hidden — unstage them or commit by hand`);
  }
  if (hits.length > 0) parts.push(`unstage ${list(hits)} and run \`/commit\` again, or commit by hand`);
  if (notUtf8.length > 0) {
    parts.push(notUtf8.length === 1
      ? `${list(notUtf8)}: path is not UTF-8 — unstage it or commit by hand`
      : `${list(notUtf8)}: paths are not UTF-8 — unstage them or commit by hand`);
  }
  return parts.join('; ');
}

// `staged-empty`'s text (RUN-13, Q9, Q16; review-RUN-13 finding 4): `plan --staged` with
// nothing staged, the typical case being the index emptied between a `modeChoice` answer of
// "staged" and the respawn. Worded for the user who picked "commit only the staged ones" and
// never typed `--staged` themselves, with a next step, not CLI vocabulary.
export const STAGED_EMPTY_MESSAGE = 'nothing is staged any more: stage the changes again, or run /commit to group all changes';

/**
 * M15 `resolveMode(flags, indexState, killedLeftover)` (RUN-13, C:plan `mode`, Q9, Q16):
 * `plan`'s mode at step 4. A mode flag wins: `--split` plans `split`, `--staged` plans
 * `staged`, or refuses `staged-empty` (exit 1 `usage`) when nothing is staged. Without a
 * flag `plan` never picks `staged`: an empty or fully staged index plans `split`, and a
 * mixed index (staged changes plus other changes) is a `modeChoice` with counts only. M18
 * counts `indexState` from M10's inventory (candidates after the hidden rule, before the
 * caps) and handles `--reword` itself; `killedLeftover` (a takeover's leftover staging,
 * C:run-folder) is RUN-24's.
 *
 * @param {{ split: boolean, staged: boolean }} flags the call's mode flags.
 * @param {{ staged: number, other: number }} indexState `staged`: the staged files;
 *   `other`: the unstaged tracked changes and candidates.
 * @param {boolean} killedLeftover always `false` until RUN-24.
 * @returns {{ mode: 'split' | 'staged' } | { modeChoice: { staged: number, other: number } }
 *   | { refusal: { code: 'staged-empty', message: string } }}
 * @throws {Error} for `killedLeftover: true`, not built yet.
 */
export function resolveMode(flags, indexState, killedLeftover) {
  if (killedLeftover) throw new Error('resolveMode with killedLeftover is not built yet (RUN-24)');
  if (flags.staged) {
    if (indexState.staged === 0) return { refusal: { code: 'staged-empty', message: STAGED_EMPTY_MESSAGE } };
    return { mode: 'staged' };
  }
  if (flags.split || indexState.staged === 0 || indexState.other === 0) return { mode: 'split' };
  return { modeChoice: { staged: indexState.staged, other: indexState.other } };
}

/** The budget of `releaseDeadline` (RUN-03, C:reply-and-handback): kept below the 60 s
 * `release` tool timeout (M17), so a spent budget still ends the call with its own output. */
export const RELEASE_DEADLINE_MS = 45_000;

/**
 * M15 `releaseDeadline(callStarted)` (docs/spec/modules-m14-m19.md, C:reply-and-handback):
 * the instant past which `release` ends `timeout` before the release itself, the run kept
 * (KD-R78 decision), and past which its tree-state read for the reply is skipped rather
 * than spawned.
 *
 * @param {number} callStarted the call's start (its first read of the injected clock).
 * @returns {number}
 */
export function releaseDeadline(callStarted) {
  return callStarted + RELEASE_DEADLINE_MS;
}

/** The budget of `deadline` (RUN-12, C:plan, C:commit-release): `plan`'s 540 s from its
 * start, bounding every step of the call (Q9, Q18). */
export const DEADLINE_MS = 540_000;

/** The budget of `cleanupDeadline` (RUN-12, C:commit-release): the cleanup and reporting git
 * calls after a timeout or an `internal` throw get 40 s more than the spent `deadline`. */
export const CLEANUP_DEADLINE_MS = 580_000;

/**
 * M15 `deadline(callStarted)` (docs/spec/modules-m14-m19.md): the instant past which the call
 * ends as `timeout`. Pure in the call's own start, so every call (a separate
 * `plan --hunks` included) takes its own.
 *
 * @param {number} callStarted the call's start (its first read of the injected clock).
 * @returns {number}
 */
export function deadline(callStarted) {
  return callStarted + DEADLINE_MS;
}

/**
 * M15 `cleanupDeadline(callStarted)` (docs/spec/modules-m14-m19.md): the instant past which a
 * cleanup or reporting git call after a timeout or an `internal` throw is not spawned.
 *
 * @param {number} callStarted the call's start (its first read of the injected clock).
 * @returns {number}
 */
export function cleanupDeadline(callStarted) {
  return callStarted + CLEANUP_DEADLINE_MS;
}

/** The remaining-budget floor of M15 `nextStep` (EXE-16, C:commit-release, Q18, stories 172,
 * 173): a later group of a `commit --all` call only starts while at least this much of the
 * 540 s `deadline` is still left. */
export const NEXT_GROUP_FLOOR_MS = 480_000;

/**
 * M15 `nextStep({ now, deadline, groupIndex })` (docs/spec/modules-m14-m19.md,
 * C:commit-release): whether M16 `commitAll`'s per-group loop, the last check of phase (a),
 * may start the next group. The first group of the call (`groupIndex === 0`) always starts,
 * however little of `deadline` is left, so a single-group call (or one restarted right after
 * a prior stop) still makes progress; a later group starts only while at least
 * `NEXT_GROUP_FLOOR_MS` of the budget remain. A stop is not a failure: the caller ends the
 * call with the groups committed so far kept, `failed: null` and a non-empty `remaining`
 * (EXE-16).
 *
 * @param {{ now: number, deadline: number, groupIndex: number }} facts `now` the current
 *   instant (the injected clock's own value, read once per group by the caller); `deadline`
 *   this call's M15 `deadline()`; `groupIndex` this group's position in the call's own loop
 *   (0 for the first group this call processes, never the group's stored `n`, which may
 *   already be past a group an earlier call committed).
 * @returns {{ go: true, deadline: number } | { go: false }} `go: true` echoes `deadline`
 *   back, so a caller holding only this result still has it.
 */
export function nextStep({ now, deadline, groupIndex }) {
  if (groupIndex === 0 || deadline - now >= NEXT_GROUP_FLOOR_MS) return { go: true, deadline };
  return { go: false };
}

/**
 * M15 `onLintFailure` (RUN-16, C:check "Lint failure", Q18, Q20): whether a `check` lint
 * failure ends the worker's retries. The second failure since the last `plan --hunks`, or
 * the first when `plan.groups.json` has `"source": "user"` (the worker must not rewrite
 * dictated text unseen), is `lintFailed`; any other is `fix` (exit 2, no `reply`, the worker
 * fixes the plan and runs `check` again). A shape failure counts like any other; `kind` only
 * shapes the `lintFailed` handback, which offers no `edit` when every error is a shape error
 * (story 214, C:reply-and-handback; RPL builds the answers).
 *
 * @param {{ lintFailures?: number }} runState the state `check` read; `lintFailures` counts
 *   the failures before this one since the last `plan --hunks` (absent: none).
 * @param {'worker' | 'user' | undefined} source the worker plan's `source` (`undefined` when
 *   the plan never parsed, which reads as `worker`).
 * @param {'shape' | 'plan'} kind `shape` when every error is a shape error.
 * @returns {'fix' | 'lintFailed'}
 */
export function onLintFailure(runState, source, kind) {
  if (source === 'user') return 'lintFailed';
  return (runState.lintFailures ?? 0) >= 1 ? 'lintFailed' : 'fix';
}

// RUN-19 (C:check, domain-code table): a run stopped at the budget (EXE-16) with `continue`
// keeps the lock and the folder with some groups already committed; `checkGate` keeps `check`
// from clearing and re-validating a plan over that state (`validateWorkerPlan` would otherwise
// discard the stored groups and their `committed` SHAs are only readable through `commit`'s
// own output, not recomputed by a fresh `check`).
const ALREADY_COMMITTED_TEXT = 'check cannot run again: this run already committed a group; '
  + 'continue with commit --all, or end the run with release';

/**
 * M15 `checkGate(runState)` (RUN-19, C:check, Q9, domain-code table): refuses `check` once any
 * group this run stored has been committed.
 *
 * @param {{ groups?: Array<{ committed: boolean }> }} runState the state `check` read.
 * @returns {{ refusal: { code: 'already-committed', message: string } } | null}
 */
export function checkGate(runState) {
  if (Array.isArray(runState.groups) && runState.groups.some((group) => group.committed)) {
    return { refusal: { code: 'already-committed', message: ALREADY_COMMITTED_TEXT } };
  }
  return null;
}

/**
 * M15 `afterCheck(confirm, groups, runState)` (RUN-18, C:check, Q16, Q17): `check`'s routing
 * once M15 `computeConfirm` has decided `confirm`. Scoped to whole-file groups only: a
 * hunk-level group (KD-R83) never reaches this function, since M16's apply stages whole paths
 * today and `check` keeps the run instead, without routing at all.
 *
 * @param {{ reasons: string[], humanOnly: boolean } | null} confirm `computeConfirm`'s result.
 * @param {Array<unknown>} groups the stored groups (only `.length` matters here): `[]` is
 *   `check`'s own "zero groups" ending (C:check), checked first so a resumed zero-group run's
 *   stray `edited plan` reason never reaches the routing below.
 * @param {{ interactive?: boolean }} runState the run state `check` read; `interactive: false`
 *   is `--no-user` (`undefined`/`true` is interactive, the same convention `state.json`
 *   itself uses).
 * @returns {'commit' | 'confirm' | 'handedBack' | 'releaseNothing'} `commit`: go on as
 *   `commit --all` right away; `confirm`: store `awaitingConfirm` and hand back
 *   without committing, the run kept; `handedBack`: hand back without committing and release
 *   the run; `releaseNothing`: release the run, nothing committed.
 */
export function afterCheck(confirm, groups, runState) {
  if (groups.length === 0) return 'releaseNothing';
  if (confirm === null) return 'commit';
  if (runState.interactive === false) return confirm.humanOnly ? 'handedBack' : 'commit';
  return 'confirm';
}

/**
 * M15 `computeConfirm(mode, groups, { resumed, interactive })` (RUN-17, C:confirmation-triggers,
 * Q16): `check`'s `confirm` field. A hit is never a trigger (its unit never reaches a group,
 * PLN-04). Pure: `groups` is M18's own per-stored-group view, already resolved from unit IDs to
 * paths against `state.json`'s unit table, `scanned` map and `scanIgnoreUnits` list, so this
 * function never needs a unit table of its own.
 *
 * @param {'split' | 'staged' | 'reword'} mode
 * @param {Array<{ newFiles: Array<{ path: string, binary: boolean }>, skippedFiles: string[],
 *   scanIgnoreFiles: string[] }>}
 *   groups per stored group, in `n` order: `newFiles` (forced `[]` in `reword`; `path` is the
 *   same derivation as `check`'s own `groups[].newFiles`, C:check, `binary` is the unit's
 *   `kind === 'binary'`) triggers in `split` only, as `new file <path>` or (Q16,
 *   C:confirmation-triggers) `new binary file <path>` when `binary` is true;
 *   `skippedFiles` (a size-skipped path, M8 `scanUnits`'s `skipped`) and `scanIgnoreFiles` (a
 *   path flagged by a `scanIgnore` change, M8 `scanUnits`'s `scanIgnoreUnits`) are each `[]` in
 *   `reword`, which never scans, and both set `humanOnly` in `split` and `staged`.
 * @param {{ resumed: boolean, interactive: boolean }} run `resumed`: set only by a separate
 *   `plan --hunks` (Q16); interactive only, in every mode — also asserted by INT-12's own
 *   separate `plan --hunks` case.
 * @returns {{ reasons: string[], humanOnly: boolean } | null} `null` when no trigger holds.
 */
export function computeConfirm(mode, groups, { resumed, interactive }) {
  const reasons = [];
  if (groups.length > 1) reasons.push(`${groups.length} groups`);
  if (mode === 'split') {
    for (const group of groups) {
      for (const file of group.newFiles ?? []) {
        reasons.push(file.binary ? `new binary file ${file.path}` : `new file ${file.path}`);
      }
    }
  }
  let humanOnly = false;
  for (const group of groups) {
    for (const path of group.skippedFiles ?? []) {
      reasons.push(`skipped file ${path}`);
      humanOnly = true;
    }
    for (const path of group.scanIgnoreFiles ?? []) {
      reasons.push(`scanIgnore change ${path}`);
      humanOnly = true;
    }
  }
  if (resumed === true && interactive !== false) reasons.push('edited plan');
  return reasons.length === 0 ? null : { reasons, humanOnly };
}

// RUN-27 (C:cli-and-exit-codes error table, C:run-folder): the refusal codes that keep the run
// (`usage`, `lint` and `lock` kinds: the run can go on, or the lock is not this run's). Every
// other refusal code that reaches `runEnd` ends it: `diff-changed`, `head-moved`, `index-lock`
// and the exit 3-5 kinds (`scan`, `git`, `timeout`) release the lock and delete the folder,
// and so does each `plan` refusal that takes the lock after a takeover.
const KEEP_REFUSALS = new Set([
  'unconfirmed', 'no-groups', 'already-committed', 'lint',
  'held', 'taken-over', 'ended', 'busy',
]);

/**
 * M15 `runEnd(event, runState)` (RUN-27, C:cli-and-exit-codes, C:run-folder, Q18, Q22): the
 * single source of which ending outcomes release the run (the lock goes, the run folder is
 * deleted) and which keep it; M18 releases (M12 `releaseOpen`) only on a `release` verdict.
 *
 * Events (`kind`):
 * - `refusal`, `code`: a refusal's domain code. `usage`, `lint` and `lock` codes keep;
 *   `diff-changed`, `head-moved`, `index-lock` and exits 3-5 release.
 * - `lintFailure`, `ending` (`fix` | `lintFailed`, M15 `onLintFailure`): `fix` keeps (the
 *   worker retries), an interactive `lintFailed` keeps for its `resume`, a `--no-user` one
 *   releases (`runState.interactive === false`).
 * - `checkResult`, `route` (M15 `afterCheck`): `confirm` keeps; `handedBack` and
 *   `releaseNothing` release; `commit` is not an ending of its own (`commitOutcome` decides).
 * - `commitOutcome`, `remaining` (count), optional `code` (the refusal): no refusal and
 *   nothing remaining releases; a budget stop (`remaining` left, no refusal) keeps;
 *   a refusal follows `refusal`.
 * - `release`, optional `timedOut`: `release` ends the run, except its own `timeout`, which
 *   keeps both for the next `plan`'s takeover.
 * - `internal`: an unexpected throw releases.
 * - `plan`, `hunks` (boolean): `plan` releases on every ending but the hunk index it hands
 *   to the worker with the lock held.
 *
 * Any event whose `unstageKept` is true (the unstage of a group that reached phase (c)
 * failed or was skipped past `cleanupDeadline`, so the state still holds `indexReset` and the
 * unfinished group) keeps: the next run's takeover repair resets the index.
 *
 * @param {{ kind: string, code?: string, ending?: string, route?: string, remaining?: number,
 *   timedOut?: boolean, hunks?: boolean, unstageKept?: boolean }} event
 * @param {{ interactive?: boolean }} [runState] the run state (`interactive: false` is
 *   `--no-user`; absent or `true` is interactive).
 * @returns {'keep' | 'release'}
 */
export function runEnd(event, runState = {}) {
  if (event.unstageKept === true) return 'keep';
  switch (event.kind) {
    case 'refusal':
      return KEEP_REFUSALS.has(event.code) ? 'keep' : 'release';
    case 'lintFailure':
      if (event.ending === 'fix') return 'keep';
      return runState.interactive === false ? 'release' : 'keep';
    case 'checkResult':
      return event.route === 'confirm' ? 'keep' : 'release';
    case 'commitOutcome':
      if (event.code !== undefined) return runEnd({ kind: 'refusal', code: event.code });
      return event.remaining === 0 ? 'release' : 'keep';
    case 'release':
      return event.timedOut === true ? 'keep' : 'release';
    case 'internal':
      return 'release';
    case 'plan':
      return event.hunks === true ? 'keep' : 'release';
    default:
      throw new Error(`runEnd: unknown event kind ${event.kind}`);
  }
}
