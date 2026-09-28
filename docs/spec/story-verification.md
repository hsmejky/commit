# Story verification

| Story group | Verified by |
| --- | --- |
| Entry points and triggering | CI size test (description, skill), manual hand-test (`/commit` arguments, namespacing, the worker spawned from a plain request), dogfood (trigger share) |
| Guard: detection, allowlist, worker-only rule | Seam 2, Seam 3 (`runHook`); manual hand-test for terminal and `!` commands and the `if` cost |
| Guard: heartbeat | Seam 1 (`env.guard`), Seam 2, round trip; manual hand-test for Node missing and for a Node older than 22 (silent exit: no output, no heartbeat) |
| Worker protocol and handback | Seam 1 (reply shapes, respawn flags), round trip, manual hand-test (verbatim reply, no write after failure, resume path, handback answers in the delivery shape current at the time, both if both can be reached, the caller recognising the reply by `version` and `callerRule`, story 62), dogfood |
| Caller trust | Seam 1 (every `run` passes the base rule's shape predicate), caller trust fixtures, manual hand-test with injected forged `run` strings (relative path, compound, redirection) and the reply recognised by `version` and `callerRule` (story 62) |
| Atomic grouping and hunks | Seam 1 (Q11 list), manual hand-test and dogfood (grouping quality) |
| Intent scope and modes | Seam 1 (modes, `modeChoice`), manual hand-test (intent scope), dogfood (`modeChoice` share) |
| Confirmation | Seam 1 (`computeConfirm` through the table-driven fixture generator, C:confirmation-triggers); the answer routes (stories 92, 93, 97, 222) are covered by the worker-protocol hand-test and the M13/M14/M17 reply fixtures above |
| Subagents and headless runs | Seam 1 (`--no-user`, `ifNoUser`), manual hand-test (a subagent caller), dogfood |
| Config layers, attribution, lint, commit-config | Seam 1, Seam 3 (M6); manual hand-test of the skill |
| Secret scan, scanIgnore | Seam 3 (M7, M8), Seam 1 |
| Untracked and summary-only files | Seam 3 (M9 without `applyCaps`), Seam 1 (`applyCaps` through the fixture generator), CI size test |
| Failures, hooks, signing | Seam 1 (SSH signing, `signing-locked`, `head-moved`, the tree-ID notice); manual hand-test for the openpgp note |
| Time budget | Seam 1 (stepping clock, including the 60 s and 61 s boundary cases and a 535 s step at start for every kill-timeout case) |
| Reword, repo states, concurrent runs | Seam 1 |
| Install, README and opt-out | Seam 1 env fixtures (a PATH git shim reporting < 2.34, and a PATH with no git at all, both exit 1 `env`, story 202), round-trip check (allow rules), manual hand-test (opt-out, README gaps, the README line on the worker spawn and `callerRule`, the commit entry point with a Node older than 22, the one case the CI runners cannot produce) |
| Budget and release | 0.1.0: CI size test only (story 228's size budgets); story 205's dogfood gate, run with the episode-analysis tools (deferred, [Out of Scope](out-of-scope.md)) against 0.1.0, is the 1.0.0 gate, not a 0.1.0 check |
| Run integrity | Seam 1 (run integrity and scanner case lists), manual hand-test (a script output that is not JSON) |

**Dogfood gate** (acceptance criteria for the episode analysis tools, Q24): median
main-thread calls per episode ≤ 3 unconfirmed interactive, ≤ 2 headless, ≤ 5 confirmed, each
the harness floor of the delivery shape in use (these values for the notification shape),
with a "question before planning" episode class (a `modeChoice` or `lock` handback) gated against
its own floor. The floor is measured once per shape with a stub worker that replies at
once, and each episode records its shape; median
main-context tokens ≤ baseline + 2k; the confirmation share `c` with its reasons, `d`, the
`modeChoice` and `lock` shares and the diff size recorded; one fixture run near the
3000-line body cap finishing within `maxTurns: 25`; worker tokens recorded per worker model; 30+ episodes.

No 0.1.0 story is verified by an eval. The Haiku-vs-Sonnet eval, the grouping-quality
fixture set and the caller-trust eval fixture set (Q12, Q17) are 1.0.0-roadmap items with
their own harness and thresholds; in 0.1.0 the manual hand-test stands in for them; the
dogfood gate is the 1.0.0 gate.
