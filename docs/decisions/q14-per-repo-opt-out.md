# Q14 Per-repo opt-out

- **Context.** Some repos have their own commit conventions or tooling, and the plugin should
  stay out of them.
- **Decision.** Use Claude Code's built-in `enabledPlugins` (`"commit@commit": false` in a
  project's `.claude/settings.local.json`). No code, a README section only.
- **Rejected.** A `guard` config key with a local config layer; path-based excludes in the user
  config.
- **Consequences.** Opting out disables the whole plugin in that repo, worker and skills
  included. It is the recommended path for non-Conventional-Commits repos (Q7).
