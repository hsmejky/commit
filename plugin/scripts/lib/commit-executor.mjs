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
// the caller before `commitAll` is ever invoked, and EXE-22's `unconfirmed` belongs between
// the two, per C:commit-release phase (a) order (phase (a) is mode-independent).
// EXE-06 adds `head-moved`: M3 `head()` against the expected HEAD before each group (right
// after `touch()`, same phase (a) order), and, after each `git commit`, M3 `firstParent` of
// the new HEAD against the SHA expected before that commit. A match advances the expected
// HEAD to the new SHA, as before; a mismatch (a hook or another process committed as well)
// still reports the group committed, with the SHA HEAD holds, and pushes a notice naming the
// group, but leaves the expected HEAD stale, so the next group's own `head()` check catches
// it and refuses `head-moved`.
// EXE-07 adds `index-changed`: M10 `indexFingerprint` against the run state's fingerprint
// before each group (right after `head-moved`), so staging made outside the run between `plan`
// and `commit`, or between two groups, is refused before (b) rather than folded into a group
// or lost to (c)'s reset. The stored fingerprint is re-read after each of the run's own `git
// commit` calls (C:commit-release), so the run's own staging never trips it. The unstage
// half of that update arrives with M10 `unstage` (EXE-10); today's best-effort reset only
// runs on a path that throws.
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
// The failure paths (EXE-10 to
// EXE-13), the parent and tree check (EXE-14), trailers
// (MSG-07) and the other modes (EXE-19, EXE-20, reached only past `no-groups`) are not built
// yet: reaching one throws.

import { HEAD_MOVED_TEXT, firstParent, head } from './repo-probe.mjs';
import {
  commitGuarded, indexFingerprint, indexLockExists, matchIds, snapshot, stage, treeDiffUnits,
  writeTree,
} from './change-set.mjs';
import { run } from './process-adapter.mjs';
import { scanUnits } from './scanner.mjs';
import { insideRunDir, readState, runDirOf, touch, writeState } from './run.mjs';
import { nextStep } from './run-policy.mjs';
import { build } from './script-call.mjs';

function notBuilt(what, slice) {
  return new Error(`${what} is not built yet (${slice})`);
}

// EXE-05: C:cli-and-exit-codes records no text for `no-groups`, so tests assert the domain
// code's kind and that the text names the state. Correct whichever of the two states caused
// it: no groups were ever stored, or every stored group is already committed (in the second
// case, a hint to run `check` first would be wrong, since `check` itself now refuses
// `already-committed`).
const NO_GROUPS_TEXT = 'no groups to commit: none are stored, or every stored group is already '
  + 'committed';

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

// Low 2 (review-EXE-02): C:commit-release "`split` runs `git reset -q -- .` only when the
// failing group itself reached (c)". EXE-10 builds the real M10 `unstage` and its `unstaged`
// report (EXE-11); until then this best-effort reset is the cheap half, so a failure after
// (c) (`stage-failed`/`mismatch`, a backstop hit, a non-zero `git commit`) never leaves the
// real index staged for the run to repair later.
async function resetIndex({ toplevel, env, now }) {
  await run('git', ['reset', '-q', '--', '.'], { cwd: toplevel, env, now });
}

/**
 * The commit message as approved: the header, then a blank line and the body when there is
 * one, ending with exactly one LF (C:message-grammar). MSG-07 appends the trailers.
 *
 * @param {{ header: string, body: string | null }} group
 * @returns {string}
 */
function messageOf({ header, body }) {
  return body === null ? `${header}\n` : `${header}\n\n${body.replace(/\n+$/, '')}\n`;
}

// Every stored unit of each file the group names (whole-file staging, EXE-02).
function wholeFileUnits(state, group) {
  const ids = new Set(group.units);
  const files = new Set(state.units.filter((unit) => ids.has(unit.id)).map((unit) => unit.path));
  return state.units.filter((unit) => files.has(unit.path));
}

// A phase (a) refusal before `group`: the run's index untouched, the earlier groups kept.
// `refusal` carries the domain code and text M18 maps to the failure envelope; `notices`
// carries any EXE-06 "another commit was made" notices from groups already committed by
// this call. The other fields are C:commit-release's (EXE-06 AC3: every mid-run refusal
// carries `commits`/`failed`/`remaining`/`unstaged`, not only `head-moved`'s). EXE-09:
// phase (b)'s `unmatched` and `git-failed` use it too; `gitOutput` is git's verbatim output
// for `git-failed` (exit 4, C:commit-release), `null` otherwise.
function refused(state, group, commits, refusal, notices, gitOutput = null) {
  return {
    commits,
    failed: group.n,
    remaining: state.groups.filter((stored) => !stored.committed).map((stored) => stored.n),
    error: null,
    gitOutput,
    unstaged: state.indexReset === true ? [] : null,
    notices,
    refusal,
  };
}

// EXE-16: M15 `nextStep`'s budget stop, the last check of phase (a). Not a failure (no
// `refusal`, `failed: null`): the call ends cleanly with the groups committed so far kept,
// and `remaining` (never empty, since this group itself was not reached) for a later
// `continue` call to pick up. C:commit-release's output shape, same as the no-refusal return
// at the end of `commitAll`, plus the `continue` handback (AC1, AC6): the one answer's `run`
// is the same `commit --plan <id> --all` (no `--confirmed`), built with S2 `build()` over the
// injected `scriptPath` so it matches the anchored allow rule; `ifNoUser` runs it unasked.
// Interim placement on the output itself, like `notices` (C:reply-and-handback), until
// INT-02 moves it into `reply.handback`.
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
 *   scriptPath: string }} options the injected clock, the OS user for the backstop's M8
 *   `scanUnits` (never stored), the environment, this call's M15 `deadline()` (EXE-16's
 *   budget stop), and the injected `scriptPath` (`process.argv[1]`) a budget stop's
 *   `continue` handback builds its `run` from.
 * @returns {Promise<{ commits: Array<{ n: number, sha: string, header: string }>,
 *   failed: number | null, remaining: number[], error: null, gitOutput: string | null,
 *   unstaged: Array<object> | null, notices: string[], handback?: object,
 *   refusal?: { code: 'no-groups' | 'taken-over' | 'busy' | 'head-moved' | 'index-changed'
 *   | 'index-locked' | 'unmatched' | 'git-failed', message: string } }>} C:commit-release's output fields; `handback` is EXE-16's budget-stop `continue`
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
 *   state file's `treeChangedDuringCommit` names it (EXE-15), else the generic text.
 *   `notices` holds any "another commit was made during group `<n>`" notices from groups
 *   this call already committed before a `head-moved` refusal (EXE-06), `[]` otherwise.
 *   `no-groups`/`taken-over`/`busy` (`usage`/`lock`, M18's call) keep the run; the caller
 *   releases it on `head-moved`, `index-changed` (`diff-changed`) and `index-locked`
 *   (`index-lock`), `unmatched` (`diff-changed`) and `git-failed` (`git`) instead
 *   (C:cli-and-exit-codes, C:commit-release).
 * @throws {Error} on a path not built yet, or an unexpected git or filesystem error.
 */
export async function commitAll(run, { now, osUser, env, deadline, scriptPath }) {
  const { toplevel } = run;
  const git = { toplevel, env, now };
  const state = readState(run);
  // (a) Phase (a) refusals, in C:commit-release order. The lock (M12 `open`, with its
  // `call.lock`) already ran once in the caller before this function is ever invoked, and
  // `touch()` refreshes it again before each group below. EXE-22's `unconfirmed` belongs
  // here, ahead of `no-groups` — leave it this way round when it lands. Phase (a) is
  // mode-independent (C:commit-release, M16), so this check runs before the mode dispatch
  // below: `plan --staged`/`--reword` then `commit --all` without `check` has no stored
  // groups either, and must refuse `no-groups`, not fall into the not-built-yet throw.
  if (!Array.isArray(state.groups) || state.groups.every((group) => group.committed)) {
    return {
      commits: [], failed: null, remaining: [], error: null, gitOutput: null, unstaged: null,
      notices: [],
      refusal: { code: 'no-groups', message: NO_GROUPS_TEXT },
    };
  }
  // (b)/(c) mode dispatch: only `split` is built.
  if (state.mode !== 'split') throw notBuilt(`commit --all in ${state.mode} mode`, 'EXE-19, EXE-20');
  // Medium (review-EXE-02): checked before any group's (c) reset, not after the loop, so a
  // run with pre-staged paths is refused with the real index untouched and nothing committed
  // — EXE-11 (the `unstaged` report those paths would need) is not built yet.
  if (state.preStaged.length > 0) {
    throw notBuilt('the unstaged report for pre-staged paths', 'EXE-11');
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
    // with the real index untouched and that staging left in place.
    if (await indexFingerprint(git) !== state.indexFingerprint) {
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

    // (b) Match on the temporary index, the real index untouched. EXE-09: a `git add -N`
    // that fails while rebuilding it (a stored not-ignored candidate now ignored, for
    // example) is a `git-failed` refusal carrying git's output, not a throw: the real index
    // was never touched (the rebuild runs entirely on the temporary one), so this group's
    // failure still reports the groups committed so far, like any other mid-run failure.
    const units = wholeFileUnits(state, group);
    let current;
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
      // uncut in the reply's capped, escaped `text` (INT-02).
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

    // (c) Apply on the real index.
    state.indexReset = true;
    writeState(run, state);
    const ignoredPaths = state.stagedNew.filter((entry) => entry.ignored).map((entry) => entry.path);
    try {
      const staged = await stage({ units, ignoredPaths, ...git });
      if (!staged.ok) throw notBuilt(`the ${staged.code} failure`, 'EXE-10');

      // The backstop over the recorded tree (thin: no stored scanIgnore patterns yet).
      const tree = await writeTree(git);
      const { hits } = scanUnits(await treeDiffUnits(state.head, tree, git), { scanIgnore: [], osUser });
      if (hits.length > 0) throw notBuilt('the backstop refusal', 'EXE-13');

      // EXE-23 (Q18): the repo's signing config stays untouched — never `--no-gpg-sign` or
      // `-c commit.gpgsign=false`; M2's scrub keeps an exported `GIT_CONFIG_SYSTEM`.
      const committed = await commitGuarded({
        args: ['commit', '--cleanup=verbatim', '-F', '-'], input: messageOf(group), ...git,
      });
      if (committed.code !== 0) throw notBuilt('a failing git commit', 'EXE-12');

      // EXE-15: only while a later group is still pending — nothing after this one would
      // ever read the diagnosis. `current` (phase (b), moments earlier) already is the
      // worktree diff's hash set right before this `git commit` call; a fresh snapshot right
      // after is compared against it, this group's own hashes taken out first.
      if (groupIndex < pending.length - 1) {
        let afterUnits;
        try {
          afterUnits = await snapshot({
            mode: 'split',
            storedLists: { candidates: state.candidates, stagedNew: state.stagedNew },
            tracked: state.units.map((unit) => unit.path),
            indexPath: insideRunDir(runDirOf(toplevel), `${run.planId}/git-index`),
            unborn: state.head === null,
            ...git,
          });
        } catch (err) {
          // EXE-09: the same rebuild failure (a stored candidate turned ignored, for
          // example) surfaces properly as the next group's own phase-(b) `git-failed`
          // refusal; this group already committed, so skip the diagnosis instead of
          // turning its success into a throw, and leave `treeChangedDuringCommit` as it was
          // (unknown, not asserted clean).
          if (err.domainCode !== 'git-failed') throw err;
          afterUnits = null;
        }
        if (afterUnits !== null) {
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
      await resetIndex(git);
      throw err;
    }
    const sha = await head({ cwd: toplevel, env, now });

    // EXE-06: HEAD's first parent must be the SHA expected before this commit (`null` on an
    // unborn branch, matching `state.head` there too). A match means HEAD is this group's
    // own commit; a mismatch means a hook or another process committed as well — the group
    // is still reported committed, with the SHA HEAD now holds, but the expected HEAD is
    // left stale so the next group's check above catches it and refuses `head-moved`.
    const parentBefore = await firstParent({ cwd: toplevel, env, now, sha });
    group.committed = true;
    state.indexFingerprint = await indexFingerprint(git);
    if (parentBefore === state.head) {
      state.head = sha;
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
