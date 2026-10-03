// M3 Repo-state probe (docs/spec/modules-m1-m9.md, Q18, Q20, Q21, C:plan): every question
// about repository state, as typed results. Effectful, read-only; spawns only through M2.
//
// INT-01 built where the working tree is; GIT-01 adds the git and Node versions and the
// not-a-repo and bare-repo states. GIT-02 adds `headState()`: branch, detached and unborn
// HEAD from one porcelain v2 `--branch` status call, pinned `--untracked-files=no
// --ignore-submodules=all --no-ahead-behind` (Q21; `--no-ahead-behind` avoids the revision
// walk `--branch` would otherwise do against the upstream, review-GIT-02 finding 8), plus
// standalone `head()` and `headTree()` for later slices (GIT-09's reword facts, EXE's
// head-moved and backstop tree checks). `probe()` itself never calls `headState()`: only
// `plan` reads HEAD state, from its own plan-only step (review-GIT-02 finding 5), so
// `release`/`commit` never spawn the extra status call. GIT-03 adds `inProgressState()`:
// merge, cherry-pick, revert, rebase, bisect, a paused sequence and a pending
// `merge --squash`, from one M2 `gitPath` call. GIT-04 adds the `unmerged` read, from the
// same status call's `u` lines, and the encoding check.

import { existsSync } from 'node:fs';

import { gitPath, gitVersion, run, toplevel } from './process-adapter.mjs';

// `git version 2.47.1`, `git version 2.47.1.windows.1`, `git version 2.39.3 (Apple Git-145)`.
const GIT_VERSION_LINE = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * Parses `git --version` output into numbers.
 *
 * @param {string} output
 * @returns {{ major: number, minor: number, patch: number, text: string } | null}
 */
function parseGitVersion(output) {
  const match = GIT_VERSION_LINE.exec(output);
  if (match === null) return null;
  const [major, minor, patch] = [match[1], match[2], match[3] || '0'].map(Number);
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

function probeGit({ cwd, env }) {
  const result = gitVersion({ cwd, env });
  if (result.status === 'ok') {
    const version = parseGitVersion(result.output);
    return version === null ? { status: 'unreadable', output: result.output } : { status: 'ok', version };
  }
  if (result.status === 'failed' || result.status === 'unreadable') {
    return { status: 'unreadable', output: result.output };
  }
  return { status: result.status };
}

function probeNode(versionText) {
  const [major, minor, patch] = String(versionText).split('.').map(Number);
  return { major, minor, patch, text: String(versionText) };
}

// Outside a working tree: a bare repository, or not a repository at all (also a directory
// inside a `.git` directory, which has no working tree either). Git's own messages are
// localized, so the answer is read from `--is-bare-repository`, never from stderr.
async function classifyNoWorkTree({ cwd, env, now }) {
  const result = await run('git', ['rev-parse', '--is-bare-repository'], { cwd, env, now, readOnly: true });
  const bare = result.code === 0 && result.stdout.toString('utf8').trim() === 'true';
  return bare ? { kind: 'bare' } : { kind: 'not-a-repo' };
}

// Porcelain v2 `--branch` header lines (Q21): `# branch.oid <sha>` or `(initial)` on an
// unborn HEAD; `# branch.head <name>` or `(detached)`. Order between the two is not relied
// on; each is matched by its own prefix.
const BRANCH_OID_PREFIX = '# branch.oid ';
const BRANCH_HEAD_PREFIX = '# branch.head ';

// Porcelain v2 unmerged entries (Q21, GIT-04): a line's first field is `u`, followed by a
// space (`u <XY> <sub> <mH> <mI> <mW> <hH> <h1> <h2> <h3> <path>`); checked as a prefix so
// nothing else (the header lines, an ordinary `1 `/`2 ` change line, a `?` untracked line,
// though none is ever produced here) is mistaken for one.
const UNMERGED_PREFIX = 'u ';

/**
 * Reads branch, detached, unborn HEAD and unmerged entries from one porcelain v2 `--branch`
 * status call, pinned `--untracked-files=no --ignore-submodules=all --no-ahead-behind` (Q21:
 * no untracked scan runs here, a dirty submodule is never read as a status line, and the
 * upstream ahead/behind counts, a revision walk that can be expensive, are never computed).
 * GIT-04 adds the `unmerged` read, from the same call's `u` lines (such as a conflicted
 * `git stash pop` with no in-progress marker left): a repo's unmerged-ness never costs a
 * second status call. Called only from `plan`'s own plan-only step (`workflows.mjs`), never
 * from `probe()` itself, so `release`/`commit` never spawn this call (review-GIT-02 finding 5).
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<{ kind: 'branch' | 'detached', branch: string | null, unborn: boolean,
 *   head: string | null, unmerged: boolean }>} `head`: the HEAD SHA from `branch.oid`, `null`
 *   when unborn; `unmerged`: whether any `u` line was found.
 * @throws {Error} when the status call exits non-zero.
 */
export async function headState({ cwd, env, now }) {
  const result = await run('git', [
    'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules=all',
    '--no-ahead-behind',
  ], { cwd, env, now, readOnly: true });
  if (result.code !== 0) throw new Error(`git status failed (${result.code}): ${result.stderr}`);
  let head = null;
  let unborn = false;
  let kind = 'branch';
  let branch = null;
  let unmerged = false;
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (line.startsWith(BRANCH_OID_PREFIX)) {
      const value = line.slice(BRANCH_OID_PREFIX.length);
      if (value === '(initial)') unborn = true;
      else head = value;
    } else if (line.startsWith(BRANCH_HEAD_PREFIX)) {
      const value = line.slice(BRANCH_HEAD_PREFIX.length);
      if (value === '(detached)') kind = 'detached';
      else branch = value;
    } else if (line.startsWith(UNMERGED_PREFIX)) {
      unmerged = true;
    }
  }
  return { kind, branch, unborn, head, unmerged };
}

/**
 * Reads `i18n.commitEncoding` (Q21, GIT-04): `plan` writes commit messages as UTF-8 only, so
 * any other configured encoding would get the commit labelled with the wrong one. One
 * `git config --get` call, over the merged config (system, global, local, worktree), the
 * same layering `commit`/`plan` would otherwise see.
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<string | null>} the configured value with only its trailing newline
 *   stripped (git does not trim a quoted value, so neither does this: a leading or trailing
 *   space in the value is kept and refused by `isUtf8Encoding`, review-GIT-04 finding 5), or
 *   `null` when the key is unset (git's own default is UTF-8).
 * @throws {Error} on any exit code other than 0 (set, including a multi-valued key, which
 *   `git config --get` resolves to its last value) or 1 (unset).
 */
export async function commitEncoding({ cwd, env, now }) {
  const result = await run('git', ['config', '--get', 'i18n.commitEncoding'], { cwd, env, now, readOnly: true });
  if (result.code === 1) return null;
  if (result.code !== 0) {
    throw new Error(`git config --get i18n.commitEncoding failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout.toString('utf8').replace(/\n$/, '');
}

// Git-path names `inProgressState` checks, each paired with the kind it reports. `rebase-merge`
// and `rebase-apply` are checked first (review-GIT-03 finding 1, Q21 amended): a rebase
// stopped on a conflicting `merge` todo command (`git rebase -r`, or a hand-written `merge`
// line) leaves both a rebase marker and `MERGE_HEAD` (confirmed on git 2.54), and the rebase
// marker must win so the advice is "continue the rebase by hand", not the merge
// finish-or-abort text; the refusal's domain code and exit code are the same either way, only
// the message changes. `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD` are checked before
// `sequencer`, so a paused multi-pick cherry-pick or revert (its own head marker already
// committed by hand, only `sequencer/` left) is told apart from one still active (whose head
// marker exists): the first marker found, in this order, wins.
const IN_PROGRESS_PATHS = Object.freeze([
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
  ['sequencer', 'sequence'],
  ['SQUASH_MSG', 'squash'],
]);

/**
 * Detects an in-progress merge, cherry-pick, revert, rebase, bisect, paused sequence or
 * pending `merge --squash` (Q21, GIT-03), from one M2 `gitPath` call over every marker's
 * name (so a linked worktree resolves its own paths), then an `existsSync` check per path.
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<{ kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'bisect' |
 *   'sequence' | 'squash' } | null>} `null` when nothing is in progress.
 */
export async function inProgressState({ cwd, env, now }) {
  const names = IN_PROGRESS_PATHS.map(([name]) => name);
  const paths = await gitPath(names, { cwd, env, now });
  for (let i = 0; i < IN_PROGRESS_PATHS.length; i += 1) {
    if (existsSync(paths[i])) return { kind: IN_PROGRESS_PATHS[i][1] };
  }
  return null;
}

/**
 * The current HEAD SHA, read on its own (GIT-09's reword facts, EXE's `head-moved` check
 * against a run's stored expected HEAD) rather than from the status call `headState` already
 * parsed for the initial probe. Uses `--verify -q` (review-GIT-02 finding 6) so a real
 * failure (corruption, a bad repo) throws instead of being read as "unborn": an unborn HEAD
 * exits 1 with `--verify -q` (confirmed), never another code.
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<string | null>} the SHA, or `null` on an unborn HEAD (exit 1).
 * @throws {Error} on any exit code other than 0 or 1.
 */
export async function head({ cwd, env, now }) {
  const result = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd, env, now, readOnly: true });
  if (result.code === 0) return result.stdout.toString('utf8').trim();
  if (result.code === 1) return null;
  throw new Error(`git rev-parse HEAD failed (${result.code}): ${result.stderr}`);
}

/**
 * The tree ID of `HEAD^{tree}` (GIT-02; consumed by EXE's backstop tree comparison). Uses
 * `--verify -q` for the same reason as `head()` (review-GIT-02 finding 6).
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<string | null>} the tree ID, or `null` on an unborn HEAD (exit 1).
 * @throws {Error} on any exit code other than 0 or 1.
 */
export async function headTree({ cwd, env, now }) {
  const result = await run('git', ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { cwd, env, now, readOnly: true });
  if (result.code === 0) return result.stdout.toString('utf8').trim();
  if (result.code === 1) return null;
  throw new Error(`git rev-parse HEAD^{tree} failed (${result.code}): ${result.stderr}`);
}

/**
 * Probes the repository `plan` runs in.
 *
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the call's
 *   working directory; `env`: the injected process environment; `now`: the injected clock.
 *   The Node version is the running Node's own (`process.versions.node`).
 * @returns {Promise<{
 *   git: { status: 'ok', version: { major: number, minor: number, patch: number, text: string } }
 *     | { status: 'unreadable', output: string } | { status: 'missing' } | { status: 'timed-out' },
 *   node: { major: number, minor: number, patch: number, text: string },
 *   repo: { kind: 'worktree', toplevel: string }
 *     | { kind: 'bare' } | { kind: 'not-a-repo' } | { kind: 'timed-out' } | null,
 * }>} `repo` is `null` when git is missing or its version check timed out (no repo question
 *   can be asked). `repo` never carries HEAD state: `probe()` is shared by `plan`, `release`
 *   and `commit` (`workflows.mjs` `probeRepo`), and only `plan` needs it, from its own
 *   plan-only step calling the exported `headState()` directly (review-GIT-02 finding 5).
 */
export async function probe({ cwd, env, now }) {
  const git = probeGit({ cwd, env });
  const node = probeNode(process.versions.node);
  if (git.status === 'missing' || git.status === 'timed-out') return { git, node, repo: null };
  const top = toplevel(cwd, { env });
  let repo;
  if (top.status === 'ok') repo = { kind: 'worktree', toplevel: top.toplevel };
  else if (top.status === 'none') repo = await classifyNoWorkTree({ cwd, env, now });
  else if (top.status === 'timed-out') repo = { kind: 'timed-out' };
  else return { git: { status: 'missing' }, node, repo: null };
  return { git, node, repo };
}

// ASCII-only lowercase byte: folds 'A'-'Z' (0x41-0x5A) to 'a'-'z' (0x61-0x7A); every other
// byte, ASCII or not, is left alone. No non-ASCII character folds onto one of these bytes,
// so a multi-byte UTF-8 path (bytes 0x80 and up) can never be mistaken for a fold.
function lowerByte(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

const SLASH = 0x2f;
const BOUND_LAST_BYTE = 0x30; // '0': the byte right after '/' (0x2F) in ASCII order.

/**
 * Whether the index holds a path, or any path under it, compared ASCII-case-insensitively
 * (RUN-05: a tracked `.commit-plan` refuses `plan`, C:run-folder). A case variant such as
 * `.Commit-Plan/notes.txt` counts on every platform: on a case-insensitive filesystem
 * (Windows, macOS) it is the same directory (review-RUN-05 finding 1).
 *
 * One `git ls-files -z --cached` call with no pathspec, run from the toplevel, matched here:
 * no pathspec magic, so neither git's version nor an inherited or pinned
 * `GIT_*_PATHSPECS` variable changes the answer (GIT-05 pins `GIT_LITERAL_PATHSPECS=1`).
 *
 * The index is sorted bytewise (memcmp of each full path). An ASCII uppercase byte always
 * sorts before its lowercase form, and `/` (0x2F) sorts before `0` (0x30), so every case
 * variant of `name` and every path under it (`name/…`, any case) sorts strictly before
 * `${name}0`. The scan below stops the moment an entry's raw bytes reach that bound
 * (review-RUN-05 finding 7): nothing sorted after it can still match. It also returns the
 * moment it finds a match, so a hit near the top of the index costs almost nothing either.
 * It scans the buffer in place (`Buffer#indexOf` plus byte comparisons), never
 * materializing the full entry list as strings or regexes.
 *
 * Left for later, if the remaining cost still matters (neither blocks this slice): passing
 * `--sparse` on git >= 2.35 to avoid expanding a sparse index before this scan runs, and a
 * streaming read that stops at the bound without collecting the rest of the output at all
 * (needs a kill path, GIT-07).
 *
 * @param {string} name the path, relative to the toplevel, such as `.commit-plan`. ASCII only.
 * @param {{ cwd: string, env: object, now?: () => number }} options `cwd`: the toplevel.
 * @returns {Promise<string | null>} the matched entry's leading `name`-length segment, in the
 *   case the index actually holds (for example `.Commit-Plan`), or `null` when nothing in
 *   the index names `name` or a path under it.
 * @throws {Error} when git exits non-zero.
 */
export async function isTracked(name, { cwd, env, now }) {
  const result = await run('git', ['ls-files', '-z', '--cached'], { cwd, env, now, readOnly: true });
  if (result.code !== 0) throw new Error(`git ls-files failed (${result.code}): ${result.stderr}`);
  const buf = result.stdout;
  const wantedLen = name.length;
  const wantedBytes = Buffer.from(name.toLowerCase(), 'latin1');

  let offset = 0;
  while (offset < buf.length) {
    let end = buf.indexOf(0, offset);
    if (end === -1) end = buf.length;
    const len = end - offset;

    if (len >= wantedLen) {
      let matches = true;
      for (let i = 0; i < wantedLen; i += 1) {
        if (lowerByte(buf[offset + i]) !== wantedBytes[i]) {
          matches = false;
          break;
        }
      }
      if (matches && (len === wantedLen || buf[offset + wantedLen] === SLASH)) {
        return buf.toString('latin1', offset, offset + wantedLen);
      }
    }

    // Bound check on the raw (un-folded) bytes against `${name}0`: stop once an entry sorts
    // at or after it, since every match sorts strictly before it (see above).
    let cmp = 0;
    for (let i = 0; i <= wantedLen; i += 1) {
      const a = i < len ? buf[offset + i] : -1;
      const b = i < wantedLen ? wantedBytes[i] : BOUND_LAST_BYTE;
      if (a !== b) {
        cmp = a < b ? -1 : 1;
        break;
      }
    }
    if (cmp >= 0) break;

    offset = end + 1;
  }
  return null;
}
