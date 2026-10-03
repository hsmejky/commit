# Q5 Configurable rules, inferred from history

- **Context.** The default style (no scope, no body, no footer) suits some repos; others
  require a scope or want a body.
- **Decision.** Rules are configurable, and a separate skill infers a config from git history.
  The attribution trailer follows Claude Code's own settings:
  - Layers, highest first: managed (`managed-settings.json` at the OS path only; its
    drop-in directory is not read in 0.1.0), project `.claude/settings.local.json`,
    project `.claude/settings.json`, user `settings.json` in the Claude home. The first
    layer that defines a key wins. "Project" is the directory the harness reads project
    settings from: `CLAUDE_PROJECT_DIR` when the script sees it, else the git toplevel. The
    two differ when Claude runs in a monorepo subfolder (open verification item).
  - The Claude home is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, resolved once by each
    entry point. It holds the user `commit.json` (Q6), the user Claude settings and the
    guard heartbeat (Q23), so all three follow a relocated Claude home.
  - The managed directory (where `managed-settings.json` lives) is derived by
    the entry point from the platform, never from an environment variable, and injected
    into the resolver. An agent cannot redirect the highest layer through `env`, and tests
    cover that layer only in CI, where the job can write the platform's managed directory;
    elsewhere those cases are skipped, not faked.
  - Not read, since a script cannot reach them: MDM profiles (macOS), registry policy
    (Windows) and server-managed settings. The attribution source `plan` reports shows
    which layer applied, and the README names the gap.
  - Two passes: `attribution.commit` across all layers first, then `includeCoAuthoredBy`
    across all layers. `attribution` wins even when the deprecated key sits in a higher
    layer, matching the harness.
  - `attribution.commit` set: its trailer-shaped lines are used; an empty string means no
    trailer. Other lines (a 🤖 line, blank lines) are dropped with a warning in
    `plan.warnings`, so `body: forbidden` still holds.
  - otherwise `includeCoAuthoredBy: false`: no trailer.
  - otherwise: the fixed trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.

  `plan` reports the trailer and the layer it came from. The script appends it with its own
  footer parser (Q13): into the footer paragraph when the message ends in one, otherwise as
  a new paragraph.
- **Amended.** By spec pass 2 (2026-09-27): the managed layer's drop-in directory is not
  read in 0.1.0; the Claude home resolves via `CLAUDE_CONFIG_DIR` (else `~/.claude`); MDM
  profiles, registry policy and server-managed settings are named as unread policy sources;
  and the managed directory is derived by the entry point from the platform, never from an
  environment variable, and injected into the resolver so a redirected `env` cannot reach
  the highest layer.
- **Amended.** By spec pass 3 (2026-09-27): the managed layer reads
  `managed-settings.json` only; reading its drop-in directory is deferred past 0.1.0 (see
  [Non-goals](non-goals.md)) to keep the first release's resolver small. The drop-in files
  join the policy sources the README names as unread.
- **Amended.** By review-CFG-09 (2026-10-03): a missing `settings.json` in a layer is no
  settings at all, same as a missing `commit.json` layer. When a layer's `settings.json`
  exists but cannot be read, is not valid UTF-8, is not valid JSON, or its top level is not
  a JSON object, it is also treated as no settings from that layer — Claude's own settings
  file is not this script's to validate, and a malformed one is never a `config` refusal —
  but `plan.warnings` gets a line naming the problem, so a layer's `includeCoAuthoredBy:
  false` does not silently give way to a lower layer's (or the fixed) default trailer
  without the user seeing why. `includeCoAuthoredBy: true` defines the key exactly as
  `false` does ("the first layer that defines a key wins"): the layer it is read from is
  the reported `source`, even though the trailer it produces reads the same as the `default`
  source's.
- **Rejected.**
  - Hard-coded opinionated rules; reading `commitlint.config.*` (executes third-party JS).
  - Reproducing the harness default footer: it contains the model name, which the script
    cannot know. Having the worker pass the model name in reopens the path Q13 closes.
  - Appending `attribution.commit` verbatim: a multi-line value becomes body text.
  - `git interpret-trailers --trailer` for appending (Q13).
- **Consequences.** Without an attribution setting the trailer omits the model name. The
  trailer is produced deterministically; no agent-supplied text reaches it. Settings passed
  on the command line (`claude --settings <file>`) are invisible to the script, and so are
  MDM, registry and server-managed policy and the managed drop-in files; the README says
  so. An organisation that sets attribution only through those sources gets the trailer
  the readable layers give.
