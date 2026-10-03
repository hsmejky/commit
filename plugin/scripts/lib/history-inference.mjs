// M19 History inference (docs/spec/modules-m14-m19.md, C:infer, Q7). Pure: it reads the
// commit messages it is given and nothing else.
//
// INF-01 (tracer) built the `too-few-commits` outcome only. INF-02 adds the Conventional
// Commits share split: `not-conventional` under 50%, else `proposal`. INF-03 fills in the
// proposal's `scope` and `body` fields. The proposal carries only `scope` and `body` until
// INF-04 and INF-05 add its remaining fields (`types`, `subjectCase`, `maxSubjectLength`);
// `wouldFail` stays `null` until INF-06 computes it.

import { parse } from './message-grammar.mjs';

/** Under this many non-merge commits read, `infer` proposes nothing (C:infer). */
export const MIN_COMMITS = 20;

/** At or above this Conventional Commits share, `infer` proposes a config (Q7, C:infer). */
export const PROPOSAL_THRESHOLD = 0.5;

/** At or above this share of Conventional Commits headers with a scope, `scope: required` (C:infer). */
export const SCOPE_REQUIRED_THRESHOLD = 0.9;

/** At or above this share of Conventional Commits headers with a scope, `scope: optional` (C:infer). */
export const SCOPE_OPTIONAL_THRESHOLD = 0.1;

/** At or above this share of Conventional Commits messages with a body, `body: optional` (C:infer). */
export const BODY_OPTIONAL_THRESHOLD = 0.1;

/**
 * Propose `scope` (C:infer): `required` at `SCOPE_REQUIRED_THRESHOLD` or more of the
 * Conventional Commits headers carrying a scope, `optional` at `SCOPE_OPTIONAL_THRESHOLD` or
 * more, else `forbidden`. The share is reported verbatim in `evidence.withScope`.
 *
 * @param {readonly { header: { scope: string | null } }[]} conventional parsed Conventional
 *   Commits messages only.
 * @returns {{ value: 'required' | 'optional' | 'forbidden', evidence: { withScope: number } }}
 */
function proposeScope(conventional) {
  const withScope = conventional.filter((p) => p.header.scope !== null).length;
  const share = withScope / conventional.length;
  let value;
  if (share >= SCOPE_REQUIRED_THRESHOLD) {
    value = 'required';
  } else if (share >= SCOPE_OPTIONAL_THRESHOLD) {
    value = 'optional';
  } else {
    value = 'forbidden';
  }
  return { value, evidence: { withScope: share } };
}

/**
 * Propose `body` (C:infer): `optional` at `BODY_OPTIONAL_THRESHOLD` or more of the
 * Conventional Commits messages carrying a body paragraph, else `forbidden`. `parse`'s own
 * footer detection already keeps a footer-only last paragraph (such as a lone `Closes #n`)
 * out of `body`, so that case is excluded here too without extra logic. The share is
 * reported verbatim in `evidence.withBody`.
 *
 * @param {readonly { body: readonly string[] }[]} conventional parsed Conventional Commits
 *   messages only.
 * @returns {{ value: 'optional' | 'forbidden', evidence: { withBody: number } }}
 */
function proposeBody(conventional) {
  const withBody = conventional.filter((p) => p.body.length > 0).length;
  const share = withBody / conventional.length;
  const value = share >= BODY_OPTIONAL_THRESHOLD ? 'optional' : 'forbidden';
  return { value, evidence: { withBody: share } };
}

/**
 * M19 `infer(messages)`: the history facts and outcome of C:infer for the non-merge
 * messages read (at most 200, newest first).
 *
 * @param {readonly string[]} messages
 * @returns {{ outcome: 'too-few-commits' | 'not-conventional' | 'proposal', commitCount:
 *   number, ccShare: number | null, nonConventional: number, wouldFail: null,
 *   proposal: null | object }}
 *   `ccShare` is over every message read, `null` only when `commitCount` is 0.
 *   `too-few-commits`: under `MIN_COMMITS` non-merge commits read; `proposal: null`.
 *   `not-conventional`: `MIN_COMMITS` or more read, `ccShare` under `PROPOSAL_THRESHOLD`;
 *   `proposal: null`. `proposal`: `ccShare` at or above `PROPOSAL_THRESHOLD`; `proposal` has
 *   `scope` and `body` (INF-03) only until INF-04 and INF-05 add its remaining fields
 *   (`types`, `subjectCase`, `maxSubjectLength`). `wouldFail` is `null` for every outcome
 *   until INF-06 computes it.
 */
export function infer(messages) {
  const parsed = messages.map((message) => parse(message));
  const commitCount = messages.length;
  const conventionalParses = parsed.filter((p) => p.header !== null);
  const conventional = conventionalParses.length;
  const ccShare = commitCount === 0 ? null : conventional / commitCount;
  const nonConventional = commitCount - conventional;

  let outcome;
  let proposal;
  if (commitCount < MIN_COMMITS) {
    outcome = 'too-few-commits';
    proposal = null;
  } else if (ccShare < PROPOSAL_THRESHOLD) {
    outcome = 'not-conventional';
    proposal = null;
  } else {
    outcome = 'proposal';
    proposal = {
      scope: proposeScope(conventionalParses),
      body: proposeBody(conventionalParses),
    };
  }

  return { outcome, commitCount, ccShare, nonConventional, wouldFail: null, proposal };
}
