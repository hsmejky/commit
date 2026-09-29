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
