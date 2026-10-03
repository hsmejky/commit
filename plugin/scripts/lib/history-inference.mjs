// M19 History inference (docs/spec/modules-m14-m19.md, C:infer, Q7). Pure: it reads the
// commit messages it is given and nothing else.
//
// INF-01 (tracer) built the `too-few-commits` outcome only. INF-02 adds the Conventional
// Commits share split: `not-conventional` under 50%, else `proposal`. INF-03 fills in the
// proposal's `scope` and `body` fields. INF-04 adds `subjectCase` and `maxSubjectLength`.
// The proposal carries `scope`, `body`, `subjectCase` and `maxSubjectLength` until INF-05
// adds its remaining field (`types`); `wouldFail` stays `null` until INF-06 computes it.

import { headerLineOf, parse, passesLowerCase } from './message-grammar.mjs';

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

/** At or above this share of Conventional Commits descriptions passing M6's lowercase
 * check, `subjectCase: lower` (C:infer). */
export const SUBJECT_CASE_LOWER_THRESHOLD = 0.9;

/** `maxSubjectLength` is 72 up to this p95 header length (C:infer). */
export const MAX_SUBJECT_LENGTH_LOW = 72;

/** `maxSubjectLength` is 100 up to this p95 header length; above it, the value is rounded
 * up to the next multiple of 10 and flagged (C:infer). */
export const MAX_SUBJECT_LENGTH_HIGH = 100;

/** `maxSubjectLength` never proposes a value above this, flagged when clamped (C:infer). */
export const MAX_SUBJECT_LENGTH_CAP = 200;

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
 * Propose `subjectCase` (C:infer): `lower` at `SUBJECT_CASE_LOWER_THRESHOLD` or more of the
 * Conventional Commits descriptions passing M6's `passesLowerCase` (which exempts a leading
 * acronym, such as `API change`), else `any`. The share is reported verbatim in
 * `evidence.lower`.
 *
 * @param {readonly { header: { description: string } }[]} conventional parsed Conventional
 *   Commits messages only.
 * @returns {{ value: 'lower' | 'any', evidence: { lower: number } }}
 */
function proposeSubjectCase(conventional) {
  const lower = conventional.filter((p) => passesLowerCase(p.header.description)).length;
  const share = lower / conventional.length;
  const value = share >= SUBJECT_CASE_LOWER_THRESHOLD ? 'lower' : 'any';
  return { value, evidence: { lower: share } };
}

/**
 * The header line's length in code points: `headerLineOf` (M6), the same split `lint` uses
 * to measure the header against `maxSubjectLength`, counted via `Array.from` so a surrogate
 * pair (an astral character) counts as one code point, not two UTF-16 units.
 *
 * @param {string} message
 * @returns {number}
 */
function headerCodePointLength(message) {
  return Array.from(headerLineOf(message)).length;
}

/**
 * The 95th percentile of `lengths` by the nearest-rank method: sorted ascending, the value
 * at index `ceil(0.95 * n) - 1` (always an observed length, never interpolated). The index
 * is always within `[0, n - 1]` for a non-empty `lengths` (the caller's contract), so no
 * clamp is needed.
 *
 * @param {readonly number[]} lengths non-empty.
 * @returns {number}
 */
function percentile95(lengths) {
  const sorted = [...lengths].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/**
 * Propose `maxSubjectLength` (C:infer): the p95 header length (code points) over the
 * Conventional Commits messages read, rounded up to `MAX_SUBJECT_LENGTH_LOW` or
 * `MAX_SUBJECT_LENGTH_HIGH`; above `MAX_SUBJECT_LENGTH_HIGH`, rounded up to the next
 * multiple of 10 and flagged; clamped to `MAX_SUBJECT_LENGTH_CAP` (still flagged) when that
 * exceeds it. `evidence.p95` carries the raw, unrounded percentile.
 *
 * @param {readonly string[]} conventionalMessages the raw Conventional Commits messages
 *   (not their parses), to measure the whole header line.
 * @returns {{ value: number, evidence: { p95: number, flagged: boolean } }}
 */
function proposeMaxSubjectLength(conventionalMessages) {
  const p95 = percentile95(conventionalMessages.map(headerCodePointLength));
  let value;
  let flagged = false;
  if (p95 <= MAX_SUBJECT_LENGTH_LOW) {
    value = MAX_SUBJECT_LENGTH_LOW;
  } else if (p95 <= MAX_SUBJECT_LENGTH_HIGH) {
    value = MAX_SUBJECT_LENGTH_HIGH;
  } else {
    flagged = true;
    value = Math.min(MAX_SUBJECT_LENGTH_CAP, Math.ceil(p95 / 10) * 10);
  }
  return { value, evidence: { p95, flagged } };
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
 *   `scope`, `body` (INF-03), `subjectCase` and `maxSubjectLength` (INF-04) only until
 *   INF-05 adds its remaining field (`types`). `wouldFail` is `null` for every outcome until
 *   INF-06 computes it.
 */
export function infer(messages) {
  const entries = messages.map((message) => ({ message, parsed: parse(message) }));
  const commitCount = messages.length;
  const conventionalEntries = entries.filter((e) => e.parsed.header !== null);
  const conventional = conventionalEntries.length;
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
    const conventionalParses = conventionalEntries.map((e) => e.parsed);
    const conventionalMessages = conventionalEntries.map((e) => e.message);
    proposal = {
      scope: proposeScope(conventionalParses),
      body: proposeBody(conventionalParses),
      subjectCase: proposeSubjectCase(conventionalParses),
      maxSubjectLength: proposeMaxSubjectLength(conventionalMessages),
    };
  }

  return { outcome, commitCount, ccShare, nonConventional, wouldFail: null, proposal };
}
