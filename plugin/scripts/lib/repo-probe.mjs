// M3 Repo-state probe (docs/spec/modules-m1-m9.md, Q18, Q20, Q21, C:plan): every question
// about repository state, as typed results. Effectful, read-only; spawns only through M2.
//
// INT-01 built where the working tree is; GIT-01 adds the git and Node versions and the
// not-a-repo and bare-repo states. GIT-02 adds the HEAD state from one porcelain v2
// `--branch` status, GIT-03/GIT-04 the refused states.

import { gitVersion, run, toplevel } from './process-adapter.mjs';

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
  const result = await run('git', ['rev-parse', '--is-bare-repository'], { cwd, env, now });
  const bare = result.code === 0 && result.stdout.toString('utf8').trim() === 'true';
  return bare ? { kind: 'bare' } : { kind: 'not-a-repo' };
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
 *   repo: { kind: 'worktree', toplevel: string } | { kind: 'bare' } | { kind: 'not-a-repo' }
 *     | { kind: 'timed-out' } | null,
 * }>} `repo` is `null` when git is missing or its version check timed out (no repo question
 *   can be asked).
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
  const result = await run('git', ['ls-files', '-z', '--cached'], { cwd, env, now });
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
