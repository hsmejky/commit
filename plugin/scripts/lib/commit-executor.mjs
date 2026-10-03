// M16 Commit executor (docs/spec/modules-m14-m19.md, C:commit-release): the per-group loop
// of `commit --all`, and nothing about presentation. Effectful; spawns only through M10/M3.
//
// EXE-02 builds the tracer bullet: per stored group of whole-file units in `split`, M12
// `touch()`, (b) M10 `matchIds` on the temporary index, (c) `indexReset` then M10 `stage`,
// the backstop (M10 `writeTree`, `treeDiffUnits`, M8 `scanUnits`) and a plain M10
// `commitGuarded`; the group is marked committed and its SHA becomes the expected HEAD.
// EXE-04 loops over every uncommitted group in order, `touch()` again before each, and
// returns a `taken-over`/`busy` refusal from it with the earlier groups kept.
// The phase (a) refusals (EXE-05 to EXE-08, EXE-22), the failure paths (EXE-09 to EXE-13),
// the parent and tree checks (EXE-14, EXE-15), the budget stop (EXE-16), trailers (MSG-07)
// and the other modes (EXE-19, EXE-20) are not built yet: reaching one throws.

import { head } from './repo-probe.mjs';
import {
  commitGuarded, indexFingerprint, matchIds, snapshot, stage, treeDiffUnits, writeTree,
} from './change-set.mjs';
import { run } from './process-adapter.mjs';
import { scanUnits } from './scanner.mjs';
import { insideRunDir, readState, runDirOf, touch, writeState } from './run.mjs';

function notBuilt(what, slice) {
  return new Error(`${what} is not built yet (${slice})`);
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
// `refusal` carries the domain code and text M18 maps to the failure envelope; the other
// fields are C:commit-release's (EXE-06 surfaces `commits`/`failed`/`remaining` in the
// failed output, not built yet: M18 reports the refusal alone for now).
function refused(state, group, commits, refusal) {
  return {
    commits,
    failed: group.n,
    remaining: state.groups.filter((stored) => !stored.committed).map((stored) => stored.n),
    error: null,
    gitOutput: null,
    unstaged: state.indexReset === true ? [] : null,
    refusal,
  };
}

/**
 * Commits the stored groups not yet committed, in order (M16 `commitAll`).
 *
 * @param {{ toplevel: string, planId: string }} run the run M12 `open` returned.
 * @param {{ now: () => number, osUser: string | null, env: object }} options the injected
 *   clock, the OS user for the backstop's M8 `scanUnits` (never stored), and the environment.
 * @returns {Promise<{ commits: Array<{ n: number, sha: string, header: string }>,
 *   failed: number | null, remaining: number[], error: null, gitOutput: null,
 *   unstaged: Array<object> | null, refusal?: { code: 'taken-over' | 'busy',
 *   message: string } }>} C:commit-release's output fields; on a phase (a) refusal before a
 *   later group also `refusal`, with `failed` that group and `remaining` the groups not
 *   committed (never empty, so M18 does not release the run).
 * @throws {Error} on a path not built yet, or an unexpected git or filesystem error.
 */
export async function commitAll(run, { now, osUser, env }) {
  const { toplevel } = run;
  const git = { toplevel, env, now };
  const state = readState(run);
  if (state.mode !== 'split') throw notBuilt(`commit --all in ${state.mode} mode`, 'EXE-19, EXE-20');
  // Medium (review-EXE-02): checked before any group's (c) reset, not after the loop, so a
  // run with pre-staged paths is refused with the real index untouched and nothing committed
  // — EXE-11 (the `unstaged` report those paths would need) is not built yet.
  if (state.preStaged.length > 0) {
    throw notBuilt('the unstaged report for pre-staged paths', 'EXE-11');
  }
  const commits = [];
  for (const group of state.groups.filter((stored) => !stored.committed)) {
    // (a) Again before each group (EXE-04): the lock must still hold this run's `planId`
    // and its mtime is refreshed, so a takeover between groups stops the call here with the
    // earlier groups kept (C:commit-release (a), Q22).
    const touched = touch(run, { now });
    if (!touched.ok) {
      return refused(state, group, commits, { code: touched.code, message: touched.message });
    }

    // (b) Match on the temporary index, the real index untouched.
    const units = wholeFileUnits(state, group);
    const current = await snapshot({
      mode: 'split',
      storedLists: { candidates: state.candidates, stagedNew: state.stagedNew },
      indexPath: insideRunDir(runDirOf(toplevel), `${run.planId}/git-index`),
      unborn: state.head === null,
      ...git,
    });
    const matched = matchIds(Object.fromEntries(units.map((unit) => [unit.id, unit.hash])), current);
    if (!matched.ok) throw notBuilt('the unmatched refusal', 'EXE-09');

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

      const committed = await commitGuarded({
        args: ['commit', '--cleanup=verbatim', '-F', '-'], input: messageOf(group), ...git,
      });
      if (committed.code !== 0) throw notBuilt('a failing git commit', 'EXE-12');
    } catch (err) {
      await resetIndex(git);
      throw err;
    }
    const sha = await head({ cwd: toplevel, env, now });

    group.committed = true;
    state.head = sha;
    state.indexFingerprint = await indexFingerprint(git);
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
  };
}
