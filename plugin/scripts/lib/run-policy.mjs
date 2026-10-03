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
// practice: `unmerged`/`commitEncoding` are only ever facts inside a worktree); RUN-14
// completes their order.
//
// GIT-09 adds the reword rows (Q20, C:plan step 2), after every other `state` row: an
// unborn or merge-commit HEAD (`state`), then `pushed`.
//
// GIT-10 adds the `signing` row (Q18, C:plan step 6): M11's `ready: false` refuses
// `signing-locked`, last, after every pre-folder row; `plan` calls it again at step 6, after
// the clean-tree check, with the probe's result. RUN-15 asserts its place among the post-scan
// rows (`staged-hit`, the clean tree).
//
// RUN-03 adds `releaseDeadline`, `release`'s 45 s budget on its tree-state read.

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
 *   signing?: { enabled: boolean, format?: string, ready?: boolean|string } }}
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
 *   which runs before the probe; only `ready: false` refuses).
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
  if (facts.signing?.ready === false) return { code: 'signing-locked', message: SIGNING_LOCKED_MESSAGE };
  return null;
}

/** The budget of `releaseDeadline` (RUN-03, C:reply-and-handback): kept below the 60 s
 * `release` tool timeout (M17), since the release itself (lock removed, folder deleted) is
 * already complete by the time it could run out. */
export const RELEASE_DEADLINE_MS = 45_000;

/**
 * M15 `releaseDeadline(callStarted)` (docs/spec/modules-m14-m19.md, C:reply-and-handback):
 * the instant past which `release`'s tree-state read for its reply is skipped rather than
 * spawned.
 *
 * @param {number} callStarted the call's start (its first read of the injected clock).
 * @returns {number}
 */
export function releaseDeadline(callStarted) {
  return callStarted + RELEASE_DEADLINE_MS;
}
