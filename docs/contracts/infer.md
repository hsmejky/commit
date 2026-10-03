# infer

Run by `commit-config` (Q7). Read-only, takes no lock. Refuses (exit 6, `state`) outside a
git repository or in a bare repository, the same text family as `plan`
([CLI](cli-and-exit-codes.md)).

```json
{
  "version": 1,
  "ok": true,
  "outcome": "proposal",
  "commitCount": 200,
  "ccShare": 0.94,
  "nonConventional": 12,
  "wouldFail": 9,
  "proposal": {
    "types":            { "value": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test", "deps"],
                          "evidence": { "deps": 0.07 } },
    "scope":            { "value": "optional", "evidence": { "withScope": 0.31 } },
    "body":             { "value": "forbidden", "evidence": { "withBody": 0.04 } },
    "subjectCase":      { "value": "lower", "evidence": { "lower": 0.97 } },
    "maxSubjectLength": { "value": 72, "evidence": { "p95": 64, "flagged": false } }
  },
  "droppedTypes": [{ "type": "wip", "count": 3 }],
  "configJson": {
    "repo": { "text": "{\n  \"scope\": \"optional\",\n  …\n}\n" },
    "user": { "errors": ["maxSubjectLength: 300 is above 200"] }
  }
}
```

- `outcome`: `proposal`; `too-few-commits` (under 20 non-merge commits; `proposal: null`,
  `droppedTypes: null`, the skill recommends the defaults; `ccShare` is still reported over
  the commits read); `not-conventional` (`ccShare` under 0.5; `proposal: null`,
  `droppedTypes: null`, the skill points to the opt-out, Q14).
- `commitCount`: non-merge commits read (at most 200). `ccShare` is over all of them, `null`
  when `commitCount` is 0, unrounded; every `evidence` share is over the Conventional Commits
  ones only.
- `types.value`: the 11 standard types in default order, always, plus each kept non-standard
  type (5% or more) appended in ascending order.
- `types.evidence`: the share of each non-standard type kept (5% or more).
- `wouldFail`: how many of the **Conventional Commits** ones among the commits read fail
  lint under the proposed config (same lint functions), so it measures the threshold loss
  (Q7) only. `nonConventional`: the commits read that are not Conventional Commits (they
  would all fail). `wouldFail` is `null` when there is no proposal.
- `maxSubjectLength.evidence.p95`: the 95th percentile of the Conventional Commits header
  lengths (code points) read, by the nearest-rank method: sorted ascending, the element at
  position `ceil(0.95n)` (1-indexed) — always one of the observed lengths, never
  interpolated, so it stays an integer.
- `maxSubjectLength.evidence.flagged`: `true` when p95 is over 100 and the value was rounded
  up to the next multiple of 10, or clamped to 200 (the key's maximum).
- `droppedTypes`: non-standard types under 5%, with counts, in ascending order by `type`;
  `null` when there is no proposal (same as `proposal`).
- `configJson`: per layer (`repo`, `user`), the current raw layer with the proposal's keys
  replaced and every other key (such as `scanIgnore`) kept, serialised as `{ "text" }`. The
  text is validated by `validateLayer` (Q6) before it is returned; a layer that
  already fails validation gets `{ "errors" }` instead of text. The `commit-config` skill
  writes the chosen layer's text verbatim and never composes JSON itself (Q7). `null` when
  there is no proposal.
