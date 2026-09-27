# Constraints

- **No npm dependencies, Node built-ins only, nothing vendored** (Q1; see Dependency policy).
- **Processes**: git, plus `ssh-add` for the signing probe and, on Windows, `taskkill` for
  the tree kill (resolved from `%SystemRoot%\System32`, never from `PATH`), all spawned
  through M2. Minimum git 2.34, Node 22 (Q15).
- **The guard runs on every shell tool call** (Q13): it exits early when the command lacks
  `commit` and never loads the commit machinery.
