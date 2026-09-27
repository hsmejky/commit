# Q7 commit-config skill

- **Context.** Writing a config by hand means guessing at a team's conventions; the history
  already records them.
- **Decision.** A separate skill `commit-config`, `disable-model-invocation: true`. The script's
  `infer` subcommand reads the last 200 non-merge commits. A commit counts as Conventional
  Commits only when its header matches the lint's header grammar (lowercase type, so `WIP:`
  and `Update:` do not count). The Conventional Commits share is taken over all 200; every
  other share is taken over the Conventional Commits ones only. A footer paragraph (Q13
  grammar) does not count as a body. Thresholds:
  - scope `required` at 90% or more, `optional` at 10% or more, else `forbidden`
  - body `optional` at 10% or more, else `forbidden`
  - `subjectCase` `lower` when 90% or more of descriptions pass the lint's `lower` rule,
    else `any`
  - `maxSubjectLength` = p95 header length in code points, rounded up to 72 or 100; above
    100, rounded up to the next multiple of 10 and flagged in the proposal; clamped to 200
    (the key's maximum, Q6) and flagged
  - `types` = all 11 standard types, plus non-standard ones at 5% or more. Non-standard types
    under 5% are dropped and listed with their counts (`wip: 3`), so the user can add them.

  `infer` lints the commits it read against the proposed config and reports `wouldFail`
  (N of the Conventional Commits ones among the last 200, so it shows the threshold loss
  only; the non-Conventional-Commits count is reported next to it). Claude shows the proposal
  with the numbers ([contracts](../contracts/infer.md)), asks whether to write it at repo or user
  level, and writes only after confirmation. The skill never composes JSON: `infer` returns
  `configJson` per layer, the current layer with the proposal's keys replaced and other keys
  (such as `scanIgnore`) kept, validated by the config loader's rules (Q6), and the skill
  writes the chosen layer's text verbatim. When the chosen layer is already invalid (the
  current file fails validation, so `configJson` for it carries `errors` instead of text),
  the skill shows those errors and writes nothing: a broken file is fixed by hand first.
  Below 20 commits it proposes nothing and
  recommends the defaults. Below 50% Conventional Commits it proposes nothing, says the repo is
  out of scope, and points to the opt-out (Q14).
- **Amended.** By spec pass 1 (2026-09-27): `infer` returns `configJson` per layer (the
  current layer with the proposal's keys replaced and other keys kept) instead of the skill
  composing JSON itself. By spec pass 2 (2026-09-27): when the chosen layer is already
  invalid, `configJson` for it carries `errors` instead of text and the skill writes
  nothing.
- **Rejected.**
  - A `/commit init` subcommand (mixes two modes in one prompt and enlarges the auto-loaded
    description).
  - Only the standard types that were used: a repo that never had a `revert` or `perf` commit
    would fail lint on its first one, although the type is standard.
- **Consequences.** Non-Conventional-Commits repos are explicitly unsupported (see
  [Non-goals](non-goals.md)). `infer` and lint share the header, case and footer functions, so
  they agree on what each rule means. The thresholds are lossy on purpose: up to 5% of
  headers exceed a p95 length, up to 10% break a 90% `lower` or `required` rule, and
  non-standard types under 5% are dropped. `wouldFail` shows that cost before the config is
  written.
