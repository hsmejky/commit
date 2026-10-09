// M16 Commit executor (docs/spec/modules-m14-m19.md, C:commit-release): the per-group loop
// of `commit --all`, and nothing about presentation. Effectful; spawns only through M10/M3.
//
// EXE-02 builds the tracer bullet: per stored group of whole-file units in `split`, M12
// `touch()`, (b) M10 `matchIds` on the temporary index, (c) `indexReset` then M10 `stage`,
// the backstop (M10 `writeTree`, `treeDiffUnits`, M8 `scanUnits`) and a plain M10
// `commitGuarded`; the group is marked committed and its SHA becomes the expected HEAD.
// EXE-04 loops over every uncommitted group in order, `touch()` again before each, and
// returns a `taken-over`/`busy` refusal from it with the earlier groups kept.
// EXE-05's `no-groups` refusal (no stored groups, or every one committed) is checked at the
// top of `commitAll`, before the mode dispatch: the lock (M12 `open`) already ran once in
// the caller before `commitAll` is ever invoked. EXE-22 adds `unconfirmed` between the two,
// per C:commit-release phase (a) order (phase (a) is mode-independent): first group of the
// call only, when the state has `awaitingConfirm` and the caller's `confirmed` is not true;
// `confirmed` on the first group clears `awaitingConfirm` right away.
// EXE-06 adds `head-moved`: M3 `head()` against the expected HEAD before each group (right
// after `touch()`, same phase (a) order), and, after each `git commit`, M3 `firstParent` of
// the new HEAD against the SHA expected before that commit. A match advances the expected
// HEAD to the new SHA, as before; a mismatch (a hook or another process committed as well)
// still reports the group committed, with the SHA HEAD holds, and pushes a notice naming the
// group, but leaves the expected HEAD stale, so the next group's own `head()` check catches
// it and refuses `head-moved`. EXE-20 adds the `reword` exception (KD-R43): there the new
// HEAD is `--amend --only` of the old one, so it always keeps the old commit's own parent;
// the check there compares the amended HEAD's first parent against the *expected* HEAD's own
// first parent (both `null` on a root commit), not against the expected HEAD itself.
// EXE-07 adds `index-changed`: M10 `indexFingerprint` against the run state's fingerprint
// before each group (right after `head-moved`), so staging made outside the run between `plan`
// and `commit`, or between two groups, is refused before (b) rather than folded into a group
// or lost to (c)'s reset. The stored fingerprint is re-read after each of the run's own `git
// commit` calls (C:commit-release), so the run's own staging never trips it. Its re-read
// after an unstage is not needed yet: EXE-10's unstage only follows a failure that ends the
// run.
// EXE-08 adds the last phase (a) refusal, `index-lock`: M10 `indexLockExists`, checked right
// before a group's (b)/(c) work ever touches the index (after `index-changed`, before the
// budget check). EXE-16 adds that budget check, M15 `nextStep`, as the actual last step of
// phase (a): not a refusal, so a stop ends the call with the groups committed so far kept
// and this group's own `n` the first of `remaining`, plus the `continue` handback for a
// later call to pick the rest up, S2 `build()` over the injected `scriptPath`
// (C:reply-and-handback).
// EXE-15 adds hook-rewrite detection: while a later group is still pending, the worktree
// diff's hash set right before this group's own `git commit` call is `current`, already
// computed moments earlier for (b) (nothing between then and the commit call touches the
// worktree, only the real index and tree objects), and a fresh snapshot right after is
// `after`. When `after` is not exactly `current` minus this group's own committed hashes (a
// successful commit always takes those out, so comparing the raw sets would flag every
// multi-group run), the state file's `treeChangedDuringCommit` is set to this group's `n`; a
// clean `after` clears it instead. The next group's own (b) `unmatched` refusal then reads
// it: when set, its text names that group as the likely cause of a repo hook (lint-staged, a
// formatter) rewriting files during its commit, instead of "files changed since plan".
// MSG-07 adds the trailers: `messageOf` runs M6 `appendTrailers` over the approved message
// with the run's stored attribution trailer, always applied in `split`/`staged`.
// EXE-20 adds `reword`: no match, no reset, no staging, no verify, no scan — `index-changed`
// is skipped too (Q20's spec-pass-6 amendment), but `head-moved` still runs. `rewordMessageOf`
// carries every foreign trailer of the old message (`state.oldMessage`, GIT-09) verbatim, in
// order, dropping the allowed footer tokens (the new message owns them) and any old
// `Co-Authored-By: … <noreply@anthropic.com>` (Q20), via M6's own `carryOver`. MSG-08 makes
// the attribution append conditional: `rewordMessageOf` reads the group's own stored
// `attribution` flag (PLN-07: `false` for a dictated `source: "user"` text whose old message
// carried no attribution trailer, `true` otherwise) rather than re-deciding with
// `hadAttributionTrailer` itself, so the two never diverge. EXE-10 adds phase (c)'s
// own failures: `stage`'s `stage-failed` and the verify's `mismatch` run M10 `unstage` and
// end the run with `unstaged` present. EXE-12 adds `split`'s own non-zero `git commit`
// (a rejecting hook): `git-failed`, M10 `unstage` (this group reached (c) too), HEAD
// re-read in case the hook had already committed anyway (`sha` then set, the "committed
// as `<sha>`, but git did not exit cleanly" text), no retry, never `--no-verify`. A
// non-zero `--amend --only` in `reword` (no index to unstage there), the backstop
// (EXE-13) and the tree check (EXE-14) are not built yet: reaching one throws. EXE-17 adds the
// deadline: `git commit` takes `deadline - now()` and a timeout is `timed-out` (exit 5, the
// hook tree killed by M2); cleanup and reporting calls (`unstage`, the HEAD re-read,
// `unstagedAfterReset`) run in a `withDeadline` scope on `cleanupDeadline`, so one at or past
// it is not spawned. A skipped or failed `unstage` keeps the original cause, adds the "staging
// may remain" notice, nulls `unstaged` and flags the outcome `unstageKept` (the caller keeps the run
// for the next takeover repair). EXE-19 adds
// `staged`: M10 `verifyIndex` replaces (b) and (c), the backstop and the commit run on the index
// as it is, and no failure unstages (`indexReset` is never set, `unstaged` stays `null`).

import { HEAD_MOVED_TEXT, firstParent, head, headTree } from './repo-probe.mjs';
import {
  commitGuarded, indexFingerprint, indexLockExists, matchIds, snapshot, stage, treeDiffUnits,
  unstage, unstagedAfterReset, verifyIndex, writeTree,
} from './change-set.mjs';
import { appendTrailers, carryOver, normaliseText } from './message-grammar.mjs';
import { scanUnits } from './scanner.mjs';
import { compileGlob } from './glob-matcher.mjs';
import { insideRunDir, readState, runDirOf, touch, writeState } from './run.mjs';
import { withDeadline } from './process-adapter.mjs';
import { nextStep } from './run-policy.mjs';
import { build } from './script-call.mjs';

// EXE-05: C:cli-and-exit-codes records no text for `no-groups`, so tests assert the domain
// code's kind and that the text names the state. Correct whichever of the two states caused
// it: no groups were ever stored, or every stored group is already committed (in the second
// case, a hint to run `check` first would be wrong, since `check` itself now refuses
// `already-committed`).
const NO_GROUPS_TEXT = 'no groups to commit: none are stored, or every stored group is already '
  + 'committed';

// EXE-22: C:cli-and-exit-codes records no text for `unconfirmed` either, so tests assert the
// domain code's kind and that the text names the state (a pending confirmation).
const UNCONFIRMED_TEXT = 'a confirmation is pending: answer it, or pass --confirmed to commit '
  + 'without answering';

/**
 * The `index-changed` refusal text, shared by M18 `plan` step 7 (CHG-04) and this module's
 * pre-group check (EXE-07). C:cli-and-exit-codes records no text for it, so tests assert the
 * domain code's kind and that the text names the index.
 */
export const INDEX_CHANGED_TEXT = 'the index changed since plan (staged elsewhere?), run /commit again';

/**
 * The `index-lock` refusal text (Q18, EXE-08): checked last in phase (a), right before a
 * group's (b)/(c) work ever touches the index, since `reset` and `apply` would otherwise take
 * the lock too and could fail unmapped or leave the index half staged.
 */
export const INDEX_LOCK_TEXT = 'another git process is running in this repo';

/**
 * The phase (b) `unmatched` refusal text (EXE-09, C:commit-release): a stored unit's hash is
 * missing from the temporary index's fresh snapshot — a planned file changed since `plan`,
 * or during an earlier group's own `git commit` (EXE-15 adds the hook-rewrite variant naming
 * that group; until then this is the only text).
 */
export const UNMATCHED_TEXT = 'files changed since plan, run /commit again';

/**
 * The hook-rewrite variant of `UNMATCHED_TEXT` (EXE-15, Q18, C:commit-release): used instead
 * when the state file's `treeChangedDuringCommit` names the group whose own `git commit`
 * left the worktree diff different from what it held right before that call, its own
 * committed hashes aside — the likely sign of a repo hook (lint-staged, a formatter)
 * rewriting other files while it ran.
 *
 * @param {number} n
 * @returns {string}
 */
function hookRewriteText(n) {
  return `files changed during the commit of group ${n} — a repo hook (lint-staged, a `
    + 'formatter) likely rewrote them; run /commit again';
}

// EXE-15: true when `units`' hash set is exactly `hashes` (order-independent). Comparing the
// worktree diff's hash set right after a group's own `git commit` against what it held right
// before that call, its own committed hashes taken out first (a successful commit always
// takes those out of the diff; comparing the raw sets would flag every multi-group run).
function sameHashSet(units, hashes) {
  const a = new Set(units.map((unit) => unit.hash));
  const b = new Set(hashes);
  if (a.size !== b.size) return false;
  for (const hash of a) {
    if (!b.has(hash)) return false;
  }
  return true;
}

// EXE-06: the notice when a hook or another process committed during group `n`, so that
// group's own commit landed but is not HEAD's first parent any more.
function anotherCommitNotice(n) {
  return `another commit was made during group ${n}; later groups refused`;
}

// EXE-14: the notice when the committed tree is not the tree the backstop recorded (a hook staged
// or rewrote something between the scan and the commit). The commit is kept, never undone.
function treeDiffersNotice(n) {
  return `committed tree differs from the scanned index (group ${n})`;
}

// EXE-17 (review Medium-4, C:commit-release): the HEAD re-read after a failed or killed `git commit`
// (or an `internal` throw) was skipped or failed, so a commit may exist that the reply cannot name.
const HEAD_UNREAD_NOTICE = 'HEAD could not be read after the failure; a commit may exist';

// EXE-11 (KD-R108): `git status` failed after the run, so `unstaged` is the stored lists unfiltered.
const UNSTAGED_UNREAD_NOTICE = 'git status failed after the run; unstaged lists every path that was '
  + 'staged before it, some may not differ from HEAD';

// EXE-10: phase (c)'s own refusals, mapped by M18 through the domain-code table:
// `stage-failed` (CLI kind `git`, exit 4) and the verify's `mismatch` (`diff-changed`, exit 6).
function stageFailedText(n) {
  return `staging failed for group ${n}`;
}

function mismatchText(n) {
  return `files changed while staging group ${n}, run /commit again`;
}

// EXE-12 (C:commit-release's own exit-4 example): a non-zero `git commit` with HEAD unmoved
// (no hook committed anyway).
function commitFailedText(n) {
  return `git commit failed for group ${n}`;
}

// EXE-12 (Q18, C:commit-release "After exit 4 or 5"): a hook rejected the commit (non-zero
// exit) but had itself already made one — HEAD moved from this group's expected SHA anyway.
function committedAnywayText(sha) {
  return `committed as \`${sha}\`, but git did not exit cleanly`;
}

// EXE-17 (Q18, C:commit-release): `git commit` killed at the deadline, HEAD unmoved.
const COMMIT_TIMED_OUT_TEXT = 'git commit did not finish in 9 min — a pre-commit hook or a signing '
  + 'prompt may be waiting';

// EXE-17: the commit landed (HEAD moved) although `git commit` had to be killed.
function committedInTimeText(sha) {
  return `committed as \`${sha}\`, but git did not exit in time`;
}

// EXE-17 (Q18 as amended by EXE-01): the group's `git reset -q -- .` was skipped or failed.
function stagingMayRemainNotice(n) {
  return `group ${n} staging may remain, the next /commit repairs it`;
}

// EXE-13: the backstop's refusal (`backstop-hit`, CLI kind `scan`, exit 3).
function backstopText(n) {
  return `the scan before committing group ${n} found a possible secret`;
}

// EXE-13 (CFG-01 item 1): the `scanIgnore` matchers recompiled by M7 from the patterns
// `plan` stored (`config.values.scanIgnore`, read at HEAD then). Fail-closed: a missing or
// malformed stored list exempts nothing, and a pattern that no longer compiles is dropped,
// so a damaged state can only make the backstop scan more, never less.
function storedScanIgnore(state) {
  const patterns = state.config?.values?.scanIgnore;
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => compileGlob(pattern))
    .filter((compiled) => compiled.ok)
    .map((compiled) => compiled.matcher);
}

/**
 * The commit message as approved: the header, then a blank line and the body when there is
 * one, run through M6 `normaliseText` (MSG-06) so CRLF or lone-CR line ends written into the
 * worker plan's `header`/`body` strings read as LF and the result ends with exactly one LF
 * (C:message-grammar), then MSG-07's `appendTrailers` with the run's stored attribution
 * trailer (`state.attribution.trailer`, resolved once by `plan` and never re-resolved here,
 * C:run-folder). `normaliseText` cannot fail here (`ok: false`): `group.header`/`group.body`
 * are the exact strings `plan`'s lint already ran through this same composition and
 * `normaliseText` call (plan-validator.mjs `messageOf`), so a lone surrogate would already
 * have failed lint before this group was ever stored. Attribution applies always in `split`
 * and `staged` (C:message-grammar "Trailers"); `reword`'s conditional attribution and
 * carried-trailer rules are `rewordMessageOf` below (MSG-08).
 *
 * @param {{ header: string, body: string | null }} group
 * @param {{ attribution: { trailer: string | null, source: string } }} state
 * @returns {string}
 */
function messageOf({ header, body }, state) {
  const raw = body === null ? header : `${header}\n\n${body}`;
  const approved = normaliseText(raw).text;
  return appendTrailers(approved, { attribution: state.attribution.trailer });
}

// EXE-20/MSG-08: `reword`'s own message composition — the approved new text, M6
// `appendTrailers` with the old message's carried trailers (M6 `carryOver`) ahead of the
// current attribution (C:message-grammar footer order: new footers, carried trailers,
// attribution). Conditional attribution (Q20: only when the worker wrote the text, or the
// old message already carried one) reads the group's own stored `attribution` flag
// (PLN-07), never re-deciding with `hadAttributionTrailer` here — the two must never
// diverge.
function rewordMessageOf(group, state) {
  const { header, body } = group;
  const raw = body === null ? header : `${header}\n\n${body}`;
  const approved = normaliseText(raw).text;
  const carried = carryOver(state.oldMessage);
  const attribution = group.attribution ? (state.attribution?.trailer ?? null) : null;
  return appendTrailers(approved, { carried, attribution });
}

// The group's own stored units (CHG-20: a file split across groups stages and matches only
// this group's hunks of it; EXE-02's thin form took every unit of each file it named).
function groupUnits(state, group) {
  const ids = new Set(group.units);
  return state.units.filter((unit) => ids.has(unit.id));
}

// A phase (a) refusal before `group`: the run's index untouched, the earlier groups kept.
// `refusal` carries the domain code and text M18 maps to the failure envelope; `notices`
// carries any EXE-06 "another commit was made" notices from groups already committed by
// this call. The other fields are C:commit-release's (EXE-06 AC3: every mid-run refusal
// carries `commits`/`failed`/`remaining`/`unstaged`, not only `head-moved`'s). EXE-09:
// phase (b)'s `unmatched` and `git-failed` use it too; `gitOutput` is git's verbatim output
// for `git-failed` (exit 4, C:commit-release), `null` otherwise.
// EXE-12: `sha` is set only when a re-read HEAD moved from this group's expected one despite
// the failure (a hook committed anyway); omitted (not merely `null`) otherwise, matching
// C:commit-release's plain exit-4 example, which has no `sha` key at all.
function refused(state, group, commits, refusal, notices, gitOutput = null, sha = undefined) {
  return {
    commits,
    failed: group.n,
    remaining: state.groups.filter((stored) => !stored.committed).map((stored) => stored.n),
    error: null,
    gitOutput,
    unstaged: state.indexReset === true ? [] : null,
    notices,
    refusal,
    ...(sha !== undefined ? { sha } : {}),
  };
}

// EXE-17: runs `fn` in a `withDeadline` scope on `cleanupDeadline` (M2 skips a call whose
// budget is at or below 0 and marks the scope expired). Never throws: a cleanup or reporting
// call must not replace the original cause. Without a `cleanupDeadline` the call is unscoped.
async function inCleanup(cx, fn) {
  const scope = { deadline: cx.cleanupDeadline, now: cx.now };
  try {
    const value = typeof cx.cleanupDeadline === 'number' ? await withDeadline(scope, fn) : await fn();
    return { ok: true, value, expired: scope.expired === true };
  } catch (error) {
    return { ok: false, error, expired: scope.expired === true };
  }
}

// EXE-17: M10 `unstage` against `cleanupDeadline`; true only when `git reset -q -- .` ran and
// succeeded. A skipped (past `cleanupDeadline`) or failed one is false (KD-R103).
async function cleanUnstage(cx) {
  const result = await inCleanup(cx, () => unstage({ toplevel: cx.toplevel, env: cx.env, now: cx.now }));
  return result.ok && result.value.ok === true && !result.expired;
}

// EXE-17: an outcome whose group's unstage did not happen keeps its exit code and kind, adds
// the notice, reports `unstaged: null` and asks the caller to keep the run (`unstageKept`, M15 `runEnd`).
function withUnstageResult(outcome, n, unstaged) {
  if (unstaged) return outcome;
  return { ...outcome, unstaged: null, unstageKept: true, notices: [...outcome.notices, stagingMayRemainNotice(n)] };
}

// EXE-12 (Q18, C:commit-release "After exit 4 or 5"): a non-zero `git commit` ends the run
// as exit 4 `git-failed` with git's output verbatim. HEAD is re-read in case the rejecting
// hook had itself already made a commit (a hanging `post-commit`, a partial pre-commit): an
// unmoved HEAD gives the plain "git commit failed for group <n>" text and the group stays
// uncommitted; a moved HEAD reports that SHA and "committed as `<sha>`, but git did not exit
// cleanly", and per Q18 the group counts as committed in the report (in `commits`, out of
// `remaining`) while `failed` still names it as the step whose exit ended the run.
// EXE-17: a `git commit` the deadline killed (`committed.timedOut`) takes the same road with
// code `timed-out` (exit 5) and the other texts; the HEAD re-read runs against
// `cleanupDeadline`, and one that cannot be read in time is read as unmoved.
async function gitCommitFailed({ state, run, group, commits, notices, committed, cx }) {
  const gitOutput = `${committed.stdout}${committed.stderr}`;
  const timedOut = committed.timedOut === true;
  const code = timedOut ? 'timed-out' : 'git-failed';
  const read = await inCleanup(cx, () => head({ cwd: cx.toplevel, env: cx.env, now: cx.now }));
  // A HEAD that could not be read (skipped past `cleanupDeadline`, or failed) is read as unmoved,
  // and the reply says so.
  if (!read.ok) notices.push(HEAD_UNREAD_NOTICE);
  const headAfter = read.ok ? read.value : state.head;
  if (headAfter === state.head) {
    const message = timedOut ? COMMIT_TIMED_OUT_TEXT : commitFailedText(group.n);
    return refused(state, group, commits, { code, message }, notices, gitOutput);
  }
  group.committed = true;
  // Best effort: the run is released right after this refusal, so the stored flag only matters
  // when the release keeps the run (a busy lock), and a write failure must not turn the exit-4
  // `git-failed` into `internal`.
  try {
    writeState(run, state);
  } catch {
    // ignored on purpose
  }
  commits.push({ n: group.n, sha: headAfter, header: group.header });
  return refused(
    state, group, commits,
    { code, message: timedOut ? committedInTimeText(headAfter) : committedAnywayText(headAfter) },
    notices, gitOutput, headAfter,
  );
}

// EXE-16: M15 `nextStep`'s budget stop, the last check of phase (a). Not a failure (no
// `refusal`, `failed: null`): the call ends cleanly with the groups committed so far kept,
// and `remaining` (never empty, since this group itself was not reached) for a later
// `continue` call to pick up. C:commit-release's output shape, same as the no-refusal return
// at the end of `commitAll`, plus the `continue` handback (AC1, AC6): the one answer's `run`
// is the same `commit --plan <id> --all` (no `--confirmed`), built with S2 `build()` over the
// injected `scriptPath` so it matches the anchored allow rule; `ifNoUser` runs it unasked.
// Placed on the output itself, like `notices`: `check`'s in-process `commit --all` moves it
// into `reply.handback` (INT-02); a direct `commit --all` keeps it there until its own reply
// lands (KD-R73).
function budgetStop(state, commits, notices, scriptPath, planId) {
  return {
    commits,
    failed: null,
    remaining: state.groups.filter((stored) => !stored.committed).map((stored) => stored.n),
    error: null,
    gitOutput: null,
    unstaged: state.indexReset === true ? [] : null,
    notices,
    handback: {
      kind: 'continue',
      question: null,
      answers: [{
        label: 'continue',
        run: build({ scriptPath, subcommand: 'commit', args: ['--plan', planId, '--all'] }),
        timeoutMs: 600_000,
      }],
      ifNoUser: { answer: 'continue' },
    },
  };
}

/**
 * Commits the stored groups not yet committed, in order (M16 `commitAll`).
 *
 * @param {{ toplevel: string, planId: string }} run the run M12 `open` returned.
 * @param {{ now: () => number, osUser: string | null, env: object, deadline: number,
 *   scriptPath: string, confirmed?: boolean }} options the injected clock, the OS user for
 *   the backstop's M8 `scanUnits` (never stored), the environment, this call's M15
 *   `deadline()` (EXE-16's budget stop), the injected `scriptPath` (`process.argv[1]`) a
 *   budget stop's `continue` handback builds its `run` from, and EXE-22's `confirmed`
 *   (`--confirmed`, `true` only when the flag was passed).
 * @returns {Promise<{ commits: Array<{ n: number, sha: string, header: string }>,
 *   failed: number | null, remaining: number[], error: null, gitOutput: string | null,
 *   unstaged: Array<object> | null, notices: string[], handback?: object, sha?: string,
 *   refusal?: { code: 'no-groups' | 'unconfirmed' | 'taken-over' | 'busy' | 'head-moved'
 *   | 'index-changed' | 'index-locked' | 'unmatched' | 'git-failed', message: string } }>} C:commit-release's output fields; `handback` is EXE-16's budget-stop `continue`
 *   handback (present only on that outcome, interim, C:reply-and-handback); `no-groups` (no
 *   stored groups, or every one committed) refuses before any group, with `failed: null` and
 *   `remaining: []`. On a phase (a) refusal before a later group instead, `refusal` with
 *   `failed` that group and `remaining` the groups not committed (never empty); `head-moved`
 *   when HEAD is not the SHA this run expects (EXE-06); `index-changed` when the index
 *   fingerprint differs from the stored one, i.e. staging from outside the run (EXE-07);
 *   `index-locked` when `index.lock` exists, checked last in phase (a) (EXE-08). Phase (b)
 *   (EXE-09): `git-failed` with `gitOutput` when a `git add -N` rebuilding the temporary
 *   index exits non-zero; `unmatched` when a stored unit's hash is missing from the fresh
 *   snapshot, its text naming the previous group as the likely hook-rewrite cause when the
 *   state file's `treeChangedDuringCommit` names it (EXE-15), else the generic text. (c)
 *   (EXE-12): `git-failed` with `gitOutput` on a non-zero `git commit`, `unstage` run first
 *   (this group reached (c)); `sha` set, omitted otherwise, to a re-read HEAD when it moved
 *   from this group's expected one anyway (the rejecting hook had itself already committed).
 *   `notices` holds any "another commit was made during group `<n>`" notices from groups
 *   this call already committed before a `head-moved` refusal (EXE-06), `[]` otherwise.
 *   `no-groups`/`taken-over`/`busy` (`usage`/`lock`, M18's call) keep the run; the caller
 *   releases it on `head-moved`, `index-changed` (`diff-changed`) and `index-locked`
 *   (`index-lock`), `unmatched` (`diff-changed`) and `git-failed` (`git`) instead
 *   (C:cli-and-exit-codes, C:commit-release).
 * @throws {Error} on a path not built yet, or an unexpected git or filesystem error.
 */
export async function commitAll(run, options) {
  const state = readState(run);
  let output;
  try {
    output = await commitGroups(run, state, options);
  } catch (err) {
    await noteCommitBeforeThrow(err, run, state, options);
    throw err;
  }
  // EXE-11 (C:commit-release `unstaged`): on every output, run-ending or mid-run, gated only
  // by `indexReset` (`[]` from the groups below once it is set); the list is read after
  // their last git call, from the state file's `preStaged` and `indexOnly` (KD-R69).
  if (Array.isArray(output.unstaged)) {
    const preStaged = state.preStaged ?? [];
    const indexOnly = state.indexOnly ?? [];
    // EXE-17: a reporting call, so it runs against `cleanupDeadline`.
    const read = await inCleanup(
      { toplevel: run.toplevel, env: options.env, now: options.now, cleanupDeadline: options.cleanupDeadline },
      () => unstagedAfterReset(preStaged, indexOnly, {
        toplevel: run.toplevel, env: options.env, now: options.now,
      }),
    );
    if (read.ok) {
      output.unstaged = read.value;
    } else {
      // The commits and the release are done by now; a failing `git status` must not turn
      // them into `internal` and lose the commit list. The contract has no "unknown" value
      // for `unstaged` (KD-R108), so it lists every earlier-staged path (the reset did
      // unstage them all), `ignored: false`, and a notice says the list may be too long.
      const blobs = new Map(indexOnly.map((entry) => [entry.path, entry.blob]));
      const bytes = (text) => Buffer.from(text, 'utf8');
      output.unstaged = [...new Set([...preStaged, ...blobs.keys()])]
        .sort((a, b) => Buffer.compare(bytes(a), bytes(b)))
        .map((path) => ({ path, ignored: false, blob: blobs.get(path) ?? null }));
      output.notices = [...output.notices, UNSTAGED_UNREAD_NOTICE];
    }
  }
  return output;
}

// EXE-17 (EXE-01 item 3): an unexpected throw may come after `git commit` landed (a state write
// that fails, a hook that moved HEAD). HEAD is re-read against `cleanupDeadline`: one that is not
// the HEAD the run expects rides on the error as `committedSha` (M18 reports "committed as
// `<sha>`, but the script failed" with `sha`); one that cannot be read adds `headNotice`
// instead. Never throws, so the original error stays the cause.
async function noteCommitBeforeThrow(err, run, state, options) {
  if (err === null || typeof err !== 'object') return;
  const cx = { toplevel: run.toplevel, env: options.env, now: options.now, cleanupDeadline: options.cleanupDeadline };
  const read = await inCleanup(cx, () => head({ cwd: cx.toplevel, env: cx.env, now: cx.now }));
  if (!read.ok) {
    err.headNotice = HEAD_UNREAD_NOTICE;
  } else if (typeof read.value === 'string' && read.value !== state.head) {
    err.committedSha = read.value;
  }
}

// `commitAll`'s per-group loop over the state it read; `unstaged` here is only `[]` or
// `null` (`indexReset`), filled in by `commitAll`.
async function commitGroups(run, state, { now, osUser, env, deadline, cleanupDeadline, scriptPath, confirmed }) {
  const { toplevel } = run;
  const git = { toplevel, env, now };
  const cx = { toplevel, env, now, cleanupDeadline };
  // EXE-17: `git commit` takes the time left before `deadline`, computed at its own start.
  const commitBudget = () => (typeof deadline === 'number' ? deadline - now() : undefined);
  // (a) Phase (a) refusals, in C:commit-release order. The lock (M12 `open`, with its
  // `call.lock`) already ran once in the caller before this function is ever invoked, and
  // `touch()` refreshes it again before each group below.
  // EXE-22: `unconfirmed`, ahead of `no-groups`, first group of the call only — this check
  // runs once, here, not inside the per-group loop below, same as `no-groups`. Only a
  // `check` that returned a `confirm` handback ever sets `awaitingConfirm` (C:check), so a
  // plain `commit --all` while one is pending is refused until the `yes` answer's `run`
  // carries `--confirmed`. `--confirmed` on this call's first group clears `awaitingConfirm`
  // right away, so a later budget-stop `continue` (EXE-16, no `--confirmed` on its own `run`)
  // still passes.
  if (state.awaitingConfirm) {
    if (!confirmed) {
      return {
        commits: [], failed: null, remaining: [], error: null, gitOutput: null, unstaged: null,
        notices: [],
        refusal: { code: 'unconfirmed', message: UNCONFIRMED_TEXT },
      };
    }
    delete state.awaitingConfirm;
    writeState(run, state);
  }
  // Phase (a) is mode-independent (C:commit-release, M16), so this check runs before the
  // mode dispatch below: `plan --staged`/`--reword` then `commit --all` without `check` has
  // no stored groups either, and must refuse `no-groups`, not fall into the not-built-yet
  // throw.
  if (!Array.isArray(state.groups) || state.groups.every((group) => group.committed)) {
    return {
      commits: [], failed: null, remaining: [], error: null, gitOutput: null, unstaged: null,
      notices: [],
      refusal: { code: 'no-groups', message: NO_GROUPS_TEXT },
    };
  }
  const commits = [];
  const notices = [];
  const pending = state.groups.filter((stored) => !stored.committed);
  for (const [groupIndex, group] of pending.entries()) {
    // (a) Again before each group (EXE-04): the lock must still hold this run's `planId`
    // and its mtime is refreshed, so a takeover between groups stops the call here with the
    // earlier groups kept (C:commit-release (a), Q22).
    const touched = touch(run, { now });
    if (!touched.ok) {
      return refused(state, group, commits, { code: touched.code, message: touched.message }, notices);
    }

    // (a) EXE-06: HEAD must still be the SHA this run expects (the one `plan` recorded,
    // then the SHA of each group this run committed) — a manual commit, or a mismatch left
    // by an earlier group's own check below, both show up here.
    const headNow = await head({ cwd: toplevel, env, now });
    if (headNow !== state.head) {
      return refused(state, group, commits, { code: 'head-moved', message: HEAD_MOVED_TEXT }, notices);
    }

    // (a) EXE-07: the index must still be the one this run left (`plan`'s, then the one read
    // after each of this run's own commits) — any outside `git add`/`reset` shows up here,
    // with the real index untouched and that staging left in place. EXE-20, Q20 (spec-pass-6
    // amendment): skipped in `reword` — `--amend --only` never reads or changes the index, so
    // staging a file during a reword must not end the run with `index-changed`.
    if (state.mode !== 'reword' && await indexFingerprint(git) !== state.indexFingerprint) {
      return refused(state, group, commits, { code: 'index-changed', message: INDEX_CHANGED_TEXT }, notices);
    }

    // (a) EXE-08: the last refusal of phase (a), right before this group's (b)/(c) work ever
    // touches the index — `reset` and `apply` take the lock too and would otherwise fail
    // unmapped (exit 1) and could leave the index half staged.
    if (await indexLockExists(git)) {
      return refused(state, group, commits, { code: 'index-locked', message: INDEX_LOCK_TEXT }, notices);
    }

    // (a) EXE-16: the last check of phase (a), M15 `nextStep` — the first group of this call
    // always goes; a later one only while at least 480 s of `deadline` remain. A stop is not
    // a refusal: the loop ends here with the groups committed so far kept and this group (and
    // every one after it) left in `remaining`, for a later `continue` call to pick up.
    if (!nextStep({ now: now(), deadline, groupIndex }).go) {
      return budgetStop(state, commits, notices, scriptPath, run.planId);
    }

    let sha;
    // EXE-14: the tree M10 `writeTree` recorded for the backstop; stays null in `reword` (no scan,
    // KD-R42), where the tree check is skipped.
    let recordedTree = null;
    if (state.mode === 'reword') {
      // EXE-20, Q20: no match, no reset, no staging, no verify, no scan — `--amend --only`
      // changes the message only; whatever is staged stays staged and untouched. On failure
      // the real index is never touched either, so there is nothing to reset (unlike `split`).
      const committed = await commitGuarded({
        args: ['commit', '--amend', '--only', '--cleanup=verbatim', '-F', '-'],
        input: rewordMessageOf(group, state),
        ...git,
        timeoutMs: commitBudget(),
      });
      // EXE-12: a failing `--amend --only` (a rejecting pre-commit hook) is the same exit 4 as
      // `split`'s; `reword` never touches the index, so there is nothing to unstage.
      if (committed.code !== 0) {
        return gitCommitFailed({ state, run, group, commits, notices, committed, cx });
      }
      sha = await head({ cwd: toplevel, env, now });
    } else {
      // EXE-19 (Q18, C:commit-release `staged`): M10 `verifyIndex` replaces (b) and (c) — no
      // reset, no staging, `indexReset` never set. The index diff's hash set must equal the
      // stored units' (the one group holds every unit); a difference is `unmatched` (`diff-changed`,
      // exit 6) with the index left as it is, so `unstaged` stays `null`. Then the backstop and
      // the commit run on the index as it stands; a failure never unstages (nothing was staged).
      const staged = state.mode === 'staged';
      const units = groupUnits(state, group);
      if (staged) {
        const verified = await verifyIndex(units, git);
        if (!verified.ok) {
          return refused(state, group, commits, { code: 'unmatched', message: UNMATCHED_TEXT }, notices);
        }
      }
      // EXE-17: true when the group's staging is back out (or never happened, `staged`).
      const cleanup = async () => (staged ? true : cleanUnstage(cx));
      // (b) Match on the temporary index, the real index untouched. EXE-09: a `git add -N`
      // that fails while rebuilding it (a stored not-ignored candidate now ignored, for
      // example) is a `git-failed` refusal carrying git's output, not a throw: the real index
      // was never touched (the rebuild runs entirely on the temporary one), so this group's
      // failure still reports the groups committed so far, like any other mid-run failure.
      let current;
      let matchedUnits = null;
      if (!staged) {
        try {
          current = await snapshot({
            mode: 'split',
            storedLists: { candidates: state.candidates, stagedNew: state.stagedNew },
            // CHG-10: the stored units' paths, so a filtered file is classified as `plan` did.
            tracked: state.units.map((unit) => unit.path),
            indexPath: insideRunDir(runDirOf(toplevel), `${run.planId}/git-index`),
            unborn: state.head === null,
            ...git,
          });
        } catch (err) {
          if (err.domainCode !== 'git-failed') throw err;
          // Short, like the contract's other exit-4 example ("git commit failed for group 2"):
          // `err.message` carries git's full raw output too, which would duplicate `gitOutput`
          // uncut in the reply's capped, escaped `text` (C:reply-and-handback).
          const message = `git add -N failed rebuilding the temporary index for group ${group.n}`;
          return refused(state, group, commits, { code: 'git-failed', message }, notices, err.gitOutput);
        }
        // EXE-09: a stored unit's hash missing from this fresh snapshot — the file changed since
        // `plan` (or during an earlier group's own `git commit`, EXE-15's hook-rewrite variant) —
        // is `unmatched`, CLI kind `diff-changed`; the real index was never touched by (b).
        const matched = matchIds(Object.fromEntries(units.map((unit) => [unit.id, unit.hash])), current);
        if (!matched.ok) {
          // EXE-15: the previous group's own commit may have left this behind (the hook-rewrite
          // notice), which explains an otherwise-generic "files changed since plan".
          const message = typeof state.treeChangedDuringCommit === 'number'
            ? hookRewriteText(state.treeChangedDuringCommit)
            : UNMATCHED_TEXT;
          return refused(state, group, commits, { code: 'unmatched', message }, notices);
        }
        matchedUnits = matched.units;
      }

      // (c) Apply on the real index (`split` only; `staged` committed the index as it is).
      if (!staged) {
        state.indexReset = true;
        writeState(run, state);
      }
      const ignoredPaths = state.stagedNew.filter((entry) => entry.ignored).map((entry) => entry.path);
      try {
        // CHG-20: the group's units as matched in the current snapshot, so `stage` knows which
        // are hunks (staged from the current ranges) and which whole files.
        const applied = staged ? { ok: true } : await stage({ units: matchedUnits, ignoredPaths, ...git });
        if (!applied.ok) {
          // EXE-10 (C:commit-release (c)): this group reached (c), so its staging is taken
          // back out (M10 `unstage`) before the refusal, and `unstaged` is present (`indexReset`
          // is set). A failing or skipped unstage (keep the run, notice) is EXE-17's.
          const unstaged = await cleanup();
          const refusal = applied.code === 'stage-failed'
            ? { code: 'stage-failed', message: stageFailedText(group.n) }
            : { code: 'mismatch', message: mismatchText(group.n) };
          return withUnstageResult(
            refused(state, group, commits, refusal, notices, applied.gitOutput ?? null), group.n, unstaged,
          );
        }

        // EXE-13 (C:commit-release): the backstop over the recorded tree, fail-closed. The
        // tree is recorded first, so the scan reads exactly that tree; the diff from the
        // expected HEAD (`null`: the empty tree, unborn) carries the attribute-hidden `--text`
        // pass. Paths are exempted only by the patterns `plan` stored, recompiled here, never
        // by a fresh read of HEAD that an earlier group of this run may have moved (CFG-01).
        const tree = await writeTree(git);
        recordedTree = tree;
        const { hits } = scanUnits(await treeDiffUnits(state.head, tree, git), {
          scanIgnore: storedScanIgnore(state), osUser,
        });
        if (hits.length > 0) {
          const unstaged = await cleanup();
          return withUnstageResult({
            ...refused(state, group, commits, { code: 'backstop-hit', message: backstopText(group.n) }, notices),
            hits,
          }, group.n, unstaged);
        }

        // EXE-23 (Q18): the repo's signing config stays untouched — never `--no-gpg-sign` or
        // `-c commit.gpgsign=false`; M2's scrub keeps an exported `GIT_CONFIG_SYSTEM`.
        const committed = await commitGuarded({
          args: ['commit', '--cleanup=verbatim', '-F', '-'],
          input: messageOf(group, state),
          ...git,
          timeoutMs: commitBudget(),
        });
        if (committed.code !== 0) {
          // EXE-12 (Q18: never retry, never `--no-verify` — neither happens here, one plain
          // `commitGuarded` call above): this group reached (c), so its staging is taken back
          // out (M10 `unstage`), same as EXE-10's `stage-failed`. EXE-19: `staged` staged
          // nothing, so its index stays as it is.
          // EXE-17: a `git commit` the deadline killed (`timedOut`) is the same road, `timed-out`.
          const unstaged = await cleanup();
          return withUnstageResult(
            await gitCommitFailed({ state, run, group, commits, notices, committed, cx }), group.n, unstaged,
          );
        }

        // EXE-15: only while a later group is still pending — nothing after this one would
        // ever read the diagnosis. `current` (phase (b), moments earlier) already is the
        // worktree diff's hash set right before this `git commit` call; a fresh snapshot right
        // after is compared against it, this group's own hashes taken out first.
        if (!staged && groupIndex < pending.length - 1) {
          let afterUnits;
          try {
            afterUnits = await snapshot({
              mode: 'split',
              storedLists: { candidates: state.candidates, stagedNew: state.stagedNew },
              tracked: state.units.map((unit) => unit.path),
              indexPath: insideRunDir(runDirOf(toplevel), `${run.planId}/git-index`),
              // HEAD always exists once this group's own `git commit` has landed (a few lines
              // above), even when `state.head` (the SHA expected *before* this commit, `null`
              // on a run that started unborn) has not been advanced yet — that only happens
              // later, past this block. Passing `state.head === null` here (review-EXE-15
              // finding H1) would make the temporary index start empty on such a run, so every
              // candidate re-adds as a new-file unit and `after` can never equal `current`
              // minus this group's own hashes: `treeChangedDuringCommit` would be set on every
              // unborn multi-group run, hook or not.
              unborn: false,
              ...git,
            });
          } catch {
            // A pure diagnostic must never turn an already-landed commit into a throw
            // (review-EXE-15 finding L1): whatever fails here — the same EXE-09 rebuild
            // failure the next group's own phase-(b) would otherwise raise as `git-failed`,
            // a `check-attr` failure, a git timeout, anything — this group already committed,
            // so skip the diagnosis and leave `treeChangedDuringCommit` as it was (unknown,
            // not asserted clean).
            afterUnits = null;
          }
          if (afterUnits !== null) {
            // `units`: this group's own units, hunks included (CHG-20), so a file split
            // across groups is not read as changed by the commit of its first group.
            const ownHashes = new Set(units.map((unit) => unit.hash));
            const expected = current.map((unit) => unit.hash).filter((hash) => !ownHashes.has(hash));
            if (sameHashSet(afterUnits, expected)) {
              delete state.treeChangedDuringCommit;
            } else {
              state.treeChangedDuringCommit = group.n;
            }
          }
        }
      } catch (err) {
        // C:commit-release "On failure": a throw after this group reached (c) (`internal`; a
        // non-zero `git commit` is mapped above, EXE-12) never leaves the real index
        // staged for the run to repair later.
        // EXE-17 (KD-R103): `cleanup` never throws, so it cannot replace `err`.
        // RUN-27: a failed or skipped unstage rides on `err` (`unstageKept`, with the notice),
        // so the caller's `internal` ending keeps the run for the next takeover's repair.
        const unstaged = await cleanup();
        if (!unstaged && err !== null && typeof err === 'object') {
          err.unstageKept = true;
          err.stagingNotice = stagingMayRemainNotice(group.n);
        }
        throw err;
      }
      sha = await head({ cwd: toplevel, env, now });
    }

    // EXE-06: HEAD's first parent must be the SHA expected before this commit (`null` on an
    // unborn branch, matching `state.head` there too). A match means HEAD is this group's
    // own commit; a mismatch means a hook or another process committed as well — the group
    // is still reported committed, with the SHA HEAD holds, but the expected HEAD is left
    // stale so the next group's check above catches it and refuses `head-moved`. EXE-20:
    // `reword`'s `--amend --only` always keeps the old commit's own parent, so there the
    // check instead compares the amended HEAD's first parent against the *expected* HEAD's
    // own first parent (both `null` on a root commit), never against the expected HEAD itself.
    const parentBefore = await firstParent({ cwd: toplevel, env, now, sha });
    const expectedParent = state.mode === 'reword'
      ? await firstParent({ cwd: toplevel, env, now, sha: state.head })
      : state.head;
    group.committed = true;
    if (state.mode !== 'reword') state.indexFingerprint = await indexFingerprint(git);
    if (parentBefore === expectedParent) {
      state.head = sha;
      // EXE-14 (KD-R41): only when HEAD is this group's own commit; with an extra commit the
      // first-parent notice below already says the story.
      if (recordedTree !== null && await headTree({ cwd: toplevel, env, now }) !== recordedTree) {
        notices.push(treeDiffersNotice(group.n));
      }
    } else {
      notices.push(anotherCommitNotice(group.n));
    }
    writeState(run, state);
    commits.push({ n: group.n, sha, header: group.header });
  }
  return {
    commits,
    failed: null,
    remaining: [],
    error: null,
    gitOutput: null,
    unstaged: state.indexReset === true ? [] : null,
    notices,
  };
}
