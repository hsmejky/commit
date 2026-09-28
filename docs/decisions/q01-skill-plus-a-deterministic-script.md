# Q1 Skill plus a deterministic script

- **Context.** A prompt-only commit skill does untracked categorisation, regex secret scanning
  and split detection "by eye". On the plugin path, secret scanning is a gate and must not be
  best effort.
- **Decision.** Two thin Node entry points (Node 22+), the commit script and the guard, over
  one shared module library do the deterministic work; the `commit-worker` agent does
  judgement (type, subject, grouping, Q24). No npm dependencies, Node built-ins only,
  nothing vendored. This is a choice, not a platform limit (Claude Code does install a
  plugin's npm dependencies): install latency and failure on first run, offline machines,
  supply-chain exposure of a hook that sees every shell command, and `--ignore-scripts`.
  Data (regex tables) and test cases may be borrowed from permissively licensed sources with
  attribution; code is never copied. Tests use `node:test`. Node is a documented hard
  requirement: the native Claude Code installer does not ship it.
- **Amended.** By spec pass 1 (2026-09-27): named the two entry points (commit script,
  guard) and their layering over the shared library, and split the dependency policy
  (no npm dependencies, licensing for borrowed data and test cases, the CI Node 22 leg)
  into its own spec section.
- **Amended.** By spec pass 5 (2026-09-27): both entry points are written in syntax every
  Node since 12 parses, and check `process.versions.node` first (commit entry point: the
  `env` JSON refusal; guard: silent exit), only then loading the shared library with a
  dynamic `import()`. The dependency policy is why: Claude Code can install a plugin's npm
  dependencies, but only non-blocking, with `--ignore-scripts` and a 60 s timeout, so if
  `commit` relied on npm dependencies the guard could be silently absent on first run.
  `GIT_ADVICE` is rejected because it needs git 2.46, above the project's git-2.34 floor
  (Q15).
- **Amended.** By spec pass 6 (2026-09-27): dated facts behind the dependency policy, as of
  2026-09-27 (moved out of the spec, which keeps only timeless reasons): `util.parseArgs`'s
  `allowNegative` option needs Node 22.4.0+; `path.matchesGlob` / `fs.glob` are stable only
  from Node 22.20.0; the npm alternatives `@conventional-commits/parser` (unreleased since
  2021) and `proper-lockfile` (no release since 2021) are stale; `shell-quote` carries
  advisory GHSA-w7jw-789q-3m8p.
- **Amended.** By the FND-01 review (2026-09-29): the module type is fixed by the file
  extension, never by a `package.json`. The entry points are CommonJS, `commit.cjs` and
  `guard.cjs`; the shared library is ES modules, `lib/*.mjs`; the entry points reach it only
  through the dynamic `import()` above, after the version check (layout in Q15). On Node
  22.0.0 a `.js` file with `export` and no `"type"` in reach throws `SyntaxError`; on Node 24
  it loads but prints `MODULE_TYPELESS_PACKAGE_JSON` to stderr on every guard call; and the
  root `package.json` is likely not shipped with the plugin, so it cannot settle the type.
  The root `package.json` keeps no `"type"` field, and the tests stay CommonJS `.js`.
- **Rejected.** A prompt-only skill with no tests beyond the manifest. A guard written in pure
  shell to survive a missing Node (needs sh and PowerShell twins, doubling the test surface).
- **Consequences.** The scan is testable and repeatable; Claude reads a compact report instead
  of scanning a full diff itself. Without Node the hook fails non-blocking and the guard is
  off; the worker fails loudly on its first `plan`, and its prompt tells it to reply that
  Node is missing and the guard is off too. `plan` reports the Node and git versions and
  whether the guard actually ran (Q23); `COMMIT_GUARD_DEBUG=1` makes the guard log each
  decision to stderr.
