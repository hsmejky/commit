// M15 Run policy (docs/spec/modules-m14-m19.md, C:plan, C:cli-and-exit-codes): every pure
// decision of a run. Pure: facts in, a typed decision with a domain code out; M18 maps the
// domain code to a CLI kind.
//
// GIT-01 builds the first `planRefusal` rows: `env` (git missing, unreadable or older than
// 2.34; Node older than 22) and `state` (not a repository, bare repository). CFG and GIT-02
// onward add `config` and the other `state` rows; RUN-14 completes their order.

/** The oldest supported git (Q1, Q15, story 202). */
export const MIN_GIT = Object.freeze({ major: 2, minor: 34 });

/** The oldest supported Node major (Q1, Q15, story 202). */
export const MIN_NODE_MAJOR = 22;

const NEEDS_GIT = `/commit needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer`;

function isOlder(version, min) {
  return version.major < min.major || (version.major === min.major && version.minor < min.minor);
}

function envRefusal({ git, node }) {
  if (git.status === 'missing') return `git was not found on PATH; ${NEEDS_GIT}`;
  if (git.status === 'unreadable') {
    return `git reported an unreadable version (${JSON.stringify(git.output)}); ${NEEDS_GIT}`;
  }
  if (git.status === 'ok' && isOlder(git.version, MIN_GIT)) {
    return `git ${git.version.text} is older than ${MIN_GIT.major}.${MIN_GIT.minor}; ${NEEDS_GIT}`;
  }
  if (!(node.major >= MIN_NODE_MAJOR)) {
    return `Node ${node.text} is older than ${MIN_NODE_MAJOR}; /commit needs Node ${MIN_NODE_MAJOR} or newer`;
  }
  return null;
}

const STATE_MESSAGES = Object.freeze({
  'not-a-repo': 'not a git repository (or not inside its working tree); run /commit inside one',
  bare: 'a bare repository has no working tree; run /commit inside a working tree',
});

/**
 * The pre-folder refusals of `plan` (C:plan step 2), in order: `env`, then `state`.
 *
 * @param {{ git: object, node: object, repo: object|null }} facts the M3 probe result.
 * @returns {{ code: string, message: string } | null} the refusal's domain code and
 *   message, or `null` when `plan` goes on.
 */
export function planRefusal(facts) {
  const envMessage = envRefusal(facts);
  if (envMessage !== null) return { code: 'env', message: envMessage };
  if (facts.repo !== null && Object.hasOwn(STATE_MESSAGES, facts.repo.kind)) {
    return { code: facts.repo.kind, message: STATE_MESSAGES[facts.repo.kind] };
  }
  return null;
}
