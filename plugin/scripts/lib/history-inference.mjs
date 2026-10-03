// M19 History inference (docs/spec/modules-m14-m19.md, C:infer, Q7). Pure: it reads the
// commit messages it is given and nothing else.
//
// INF-01 (tracer) built the `too-few-commits` outcome only. INF-02 adds the Conventional
// Commits share split: `not-conventional` under 50%, else `proposal`. The proposal's own
// fields (`types`, `scope`, `body`, `subjectCase`, `maxSubjectLength`) and `wouldFail` are
// built by INF-03 through INF-06; until then a met threshold is marked by a placeholder
// object, not by the fields themselves.

import { parse } from './message-grammar.mjs';

/** Under this many non-merge commits read, `infer` proposes nothing (C:infer). */
export const MIN_COMMITS = 20;

/** At or above this Conventional Commits share, `infer` proposes a config (Q7, C:infer). */
export const PROPOSAL_THRESHOLD = 0.5;

/**
 * Whether a message counts as Conventional Commits: its header matches M6's header grammar
 * (Q7, C:infer). Reuses M6's `parse` so the two never disagree on what a header is (no
 * duplicate header grammar).
 *
 * @param {string} message
 * @returns {boolean}
 */
function isConventional(message) {
  return parse(message).header !== null;
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
 *   `proposal: null`. `proposal`: `ccShare` at or above `PROPOSAL_THRESHOLD`; `proposal` is
 *   a placeholder object until INF-03 through INF-05 fill in its fields. `wouldFail` is
 *   `null` for every outcome until INF-06 computes it.
 */
export function infer(messages) {
  const commitCount = messages.length;
  const conventional = messages.filter(isConventional).length;
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
    proposal = {};
  }

  return { outcome, commitCount, ccShare, nonConventional, wouldFail: null, proposal };
}
