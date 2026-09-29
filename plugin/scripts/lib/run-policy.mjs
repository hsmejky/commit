// M15 Run policy (docs/spec/modules-m14-m19.md, C:plan, C:cli-and-exit-codes): every pure
// decision of a run. Pure: facts in, a typed decision with a domain code out; M18 maps the
// domain code to a CLI kind.
//
// GIT-01 builds the first `planRefusal` rows: `env` (git missing, unreadable or older than
// 2.34), `state` (not a repository, bare repository) and `timed-out` (a start-up `spawnSync`
// call, M2, past its fixed short timeout; GIT-07 brings the 540 s deadline). Node older than
// 22 stays enforced by the entry point (`commit.cjs`), before M15 ever loads. CFG-02 adds
// `config` (C:plan step 2 order: `env`, `config`, `state`); GIT-02 onward adds the other
// `state` rows; RUN-14 completes their order.

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

/**
 * The pre-folder refusals of `plan` (C:plan step 2), in order: `env`, then `config` (M4's
 * result, already loaded by M18 step 1: M15 stays pure, so it never reads a layer itself),
 * then `state`, then a start-up call's `timed-out` (M2's fixed short timeout, before any run
 * folder exists).
 *
 * @param {{ git: object, node: object, repo: object|null, config?: { error: string } | null }}
 *   facts the M3 probe result, plus M4's `loadConfig` result under `config` (`null` or
 *   omitted when no repo layer error was found, e.g. outside a worktree).
 * @returns {{ code: string, message: string } | null} the refusal's domain code and
 *   message, or `null` when `plan` goes on.
 */
export function planRefusal(facts) {
  const envMessage = envRefusal(facts);
  if (envMessage !== null) return { code: 'env', message: envMessage };
  if (facts.config != null) return { code: 'config', message: facts.config.error };
  if (facts.repo !== null && Object.hasOwn(STATE_MESSAGES, facts.repo.kind)) {
    return { code: facts.repo.kind, message: STATE_MESSAGES[facts.repo.kind] };
  }
  if (facts.git.status === 'timed-out' || (facts.repo !== null && facts.repo.kind === 'timed-out')) {
    return { code: 'timed-out', message: 'git did not answer its start-up call in time' };
  }
  return null;
}
