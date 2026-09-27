# Non-goals

- Pushing and pull requests.
- Setting up commit signing (the plugin only coexists with it, Q18).
- Repos that do not use Conventional Commits (use the opt-out, Q14).
- Making the commit that finishes a merge, rebase, cherry-pick or revert (Q21).
- Folding new changes into an existing commit ("add this fix to the last commit"): the worker
  makes a new commit instead (Q4). Roadmap: a scanned amend mode with Q20's pushed check.
- Rewording a merge commit (Q20).
- Generating issue references; `Refs` / `Closes` / `Fixes` footers are written only when the
  user supplies them.
- Inferring monorepo scopes.
- Enforcing a message language: messages follow the language of recent history.

Deferred past 0.1.0 (roadmap; 0.1.0 is designed without them, spec Out of Scope):

- The 1.0.0 gate: 30+ dogfood episodes and the Haiku-vs-Sonnet eval (Q12, Q24).
- The caller-trust eval fixture set, which the manual hand-test stands in for in 0.1.0 (Q17).
- The scanned amend mode and the object form of `scanIgnore` (Q4, Q10).
- A per-group temporary index (Q11).
- A home-based run folder under the Claude home; 0.1.0 keeps `<toplevel>/.commit-plan/`
  (Q9).
- A tamper digest for run state; 0.1.0 checks only the state `version` (Q16).
- Reading the managed settings drop-in directory; 0.1.0 reads `managed-settings.json` only
  (Q5).
- Classifying openpgp pinentry programs (`gpg` / `gpgconf` probes) at `plan` (Q18).
- `module.enableCompileCache` for the guard's cold start (Q13), and a concurrent-runs stress
  test (Q22).
- Moving the caller protocol into trusted, skill-like text if callers do not follow
  `callerRule` (Q25).
