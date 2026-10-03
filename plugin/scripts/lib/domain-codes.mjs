// M18 Subcommand workflows (docs/spec/modules-m14-m19.md): the domain code → CLI kind table
// (docs/spec/domain-code-cli-kind.md). Architectural decisions "Typed results and one error
// table": only M18 maps a domain code to a CLI kind; every module below it (M2-M17) returns
// a typed result carrying its own domain code and never a CLI kind. M1 alone turns a kind
// into an exit code (`lib/cli.mjs`).
//
// Left out of this table on purpose, because a module never reports them as a domain code
// through it:
// - the generic "bad argv or flag combination, malformed `planId`" row: M1 itself is the
//   producer and returns the `usage` kind directly (RPL-01, RPL-02), above M18;
// - "unexpected throw" (any module): a catch-all `internal`, produced by whichever layer
//   catches it, never looked up here;
// - "clean tree" (`nothing`): not a failure, so it has no CLI kind, only the success reply
//   status `nothing`.

/**
 * Every domain code a module below M18 can report, mapped to its CLI kind
 * (docs/spec/domain-code-cli-kind.md). Several domain codes share one kind (e.g. `held` and
 * `busy` both mean `lock`); the map is keyed by domain code, one entry per code.
 */
export const DOMAIN_CODE_TO_KIND = Object.freeze({
  // usage (exit 1)
  unconfirmed: 'usage',
  'staged-empty': 'usage',
  'already-committed': 'usage',
  'no-groups': 'usage',
  // config (exit 1)
  config: 'config',
  // env (exit 1)
  env: 'env',
  // state (exit 6)
  'not-a-repo': 'state',
  bare: 'state',
  'in-progress': 'state',
  unmerged: 'state',
  unborn: 'state',
  merge: 'state', // a merge-commit HEAD, in `reword`
  encoding: 'state',
  'run-folder': 'state',
  'killed-leftover': 'state',
  'case-rename': 'state',
  // signing (exit 6)
  'signing-locked': 'signing',
  // pushed (exit 6)
  pushed: 'pushed',
  // staged-hit (exit 6)
  'staged-hit': 'staged-hit',
  // lock (exit 6)
  held: 'lock',
  'taken-over': 'lock',
  ended: 'lock',
  busy: 'lock',
  // index-lock (exit 6)
  'index-locked': 'index-lock',
  // diff-changed (exit 6)
  unmatched: 'diff-changed',
  mismatch: 'diff-changed',
  'index-changed': 'diff-changed',
  // head-moved (exit 6)
  'head-moved': 'head-moved',
  // lint (exit 2)
  lint: 'lint',
  // scan (exit 3)
  'backstop-hit': 'scan',
  // git (exit 4)
  'git-failed': 'git',
  'stage-failed': 'git',
  // timeout (exit 5)
  'timed-out': 'timeout',
});

/**
 * Looks up the CLI kind for a domain code a module below M18 returned in a typed result.
 *
 * @param {string} domainCode
 * @returns {string} the CLI kind (C:cli-and-exit-codes).
 * @throws {Error} when `domainCode` has no entry: an unmapped code must fail loudly here,
 *   the same way `lib/cli.mjs` `failure()` refuses to exit 0 on an unmapped kind, instead of
 *   silently reaching M1 as `undefined`, or, for a domain code spelled like an inherited
 *   property (e.g. `constructor`), resolving to that inherited value (`Object.hasOwn` checks
 *   ownership, not just presence).
 */
export function kindForDomainCode(domainCode) {
  if (!Object.hasOwn(DOMAIN_CODE_TO_KIND, domainCode)) {
    throw new Error(`no CLI kind mapped for domain code ${JSON.stringify(domainCode)}`);
  }
  return DOMAIN_CODE_TO_KIND[domainCode];
}
