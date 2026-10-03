// M19 History inference (docs/spec/modules-m14-m19.md, C:infer, Q7). Pure: it reads the
// commit messages it is given and nothing else.
//
// INF-01 (tracer) builds the `too-few-commits` outcome only: a history of 20 or more
// non-merge commits needs the `not-conventional` and `proposal` outcomes (INF-02 onwards),
// which are not built yet.

import { parse } from './message-grammar.mjs';

/** Under this many non-merge commits read, `infer` proposes nothing (C:infer). */
export const MIN_COMMITS = 20;

/**
 * Whether a message counts as Conventional Commits: its header matches M6's header grammar
 * (Q7, C:infer).
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
 * @returns {{ outcome: 'too-few-commits', commitCount: number, ccShare: number | null,
 *   nonConventional: number, wouldFail: null, proposal: null }}
 *   `ccShare` is over every message read, `null` when none was read.
 * @throws {Error} for 20 or more messages, whose outcomes are not built yet (INF-02).
 */
export function infer(messages) {
  const commitCount = messages.length;
  const conventional = messages.filter(isConventional).length;
  if (commitCount >= MIN_COMMITS) {
    throw new Error('infer over 20 or more commits is not built yet (INF-02)');
  }
  return {
    outcome: 'too-few-commits',
    commitCount,
    ccShare: commitCount === 0 ? null : conventional / commitCount,
    nonConventional: commitCount - conventional,
    wouldFail: null,
    proposal: null,
  };
}
