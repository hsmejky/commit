# Q8 Naming

- **Context.** The plugin replaces the harness's commit flow; the name should say so.
- **Decision.** `commit` everywhere: repository, marketplace, plugin and the main skill; the
  second skill is `commit-config`. Install with `commit@commit`.
- **Rejected.** A distinctive plugin name such as `commit-guard`; `conventional-commit`.
- **Consequences.** A clash with another plugin's `/commit` resolves through namespacing
  (`/commit:commit`). `commit@commit` is public surface. A personal
  `~/.claude/skills/commit` (verified visible alongside the plugin in subagents) is, after
  Q24, the only resident commit **skill**, so it takes every "commit this" ahead of the
  worker's agent description. Removing it is a **required** README install step, with that
  reason. Nothing detects it: the guard's deny messages end with a fixed line ("If a
  personal commit skill sent you here, remove it (see the commit plugin README)",
  [contracts](../contracts/guard.md)), and `plan` has no warning for it (it runs inside the
  worker, so it would warn only after the costly deny path). The author removes their own
  before implementation; the commit-worker spike and the 1.0.0 dogfood gate (Q24) run on a
  machine without one, or the trigger measurements are contaminated.
