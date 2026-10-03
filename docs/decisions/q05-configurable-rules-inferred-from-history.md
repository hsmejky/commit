# Q5 Configurable rules, inferred from history

- **Context.** The default style (no scope, no body, no footer) suits some repos; others
  require a scope or want a body.
- **Decision.** Rules are configurable, and a separate skill infers a config from git history.
  The attribution trailer follows Claude Code's own settings:
  - Layers, highest first: managed (`managed-settings.json` at the OS path only; its
    drop-in directory is not read in 0.1.0), project `.claude/settings.local.json`,
    project `.claude/settings.json`, user `settings.json` in the Claude home. The first
    layer that defines a key wins. "Project" is the directory the harness reads project
    settings from: `CLAUDE_PROJECT_DIR` when the script sees it, else the entry point's
    `process.cwd()`. No walk-up to a git toplevel: a cwd without `.claude/` has no project
    layers, matching the harness.
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
- **Amended.** By PRE-11 (2026-10-03): headless `claude -p` probes in a temp git repo whose
  toplevel `.claude/settings.json` and `sub/.claude/settings.json` set different `env`
  values, plus a `bare/` subfolder without `.claude/`. Launched in `sub/`, only `sub`'s
  settings applied (no walk-up, no merge with the toplevel). Launched in `bare/`, no project
  settings applied at all (no walk-up to the toplevel). Launched at the toplevel, the
  toplevel's settings applied. `CLAUDE_PROJECT_DIR` is not set in the main thread's Bash nor
  PowerShell tool environment (checked interactively and in `-p`); a subagent's is unset too
  (already known, re-confirmed). A subagent's Bash starts at the launch directory even after
  the main thread changes directory. Decision: the project directory is `CLAUDE_PROJECT_DIR`
  when the script sees it, else the entry point's `process.cwd()` (the worker's shell starts
  at the launch directory, the directory the harness reads project settings from); no
  walk-up to the git toplevel. The entry point resolves it and injects it into M5 (like the
  Claude home), not the library reading `env`/cwd itself. The worker must invoke
  `commit.cjs` from its starting directory, never after a `cd`.
- **Amended.** By PRE-16 (2026-10-03): the managed directory's fixed path (official docs) is
  macOS `/Library/Application Support/ClaudeCode/managed-settings.json`; Linux and WSL
  `/etc/claude-code/managed-settings.json`; Windows
  `C:\Program Files\ClaudeCode\managed-settings.json`. Claude Code no longer reads the legacy
  Windows path `C:\ProgramData\ClaudeCode\managed-settings.json`, so the script does not
  either. On GitHub-hosted runners, ubuntu-latest and macos-latest carry passwordless sudo,
  windows-latest runs as administrator with UAC disabled, and the `ubuntu:22.04` container
  job runs as root. The CI workflow gets a step before the final managed-layer `node --test`
  invocation, `sudo mkdir -p <managed dir> && sudo chown "$USER" <managed dir>`, on
  ubuntu-latest and macos-latest only; Windows and the container need no such step. That
  final `node --test` run still runs as the normal user, writes `managed-settings.json`
  itself and deletes it afterward, and still skips when the host already has its own file.
- **Rejected.**
  - Hard-coded opinionated rules; reading `commitlint.config.*` (executes third-party JS).
  - Reproducing the harness default footer: it contains the model name, which the script
    cannot know. Having the worker pass the model name in reopens the path Q13 closes.
  - Appending `attribution.commit` verbatim: a multi-line value becomes body text.
  - `git interpret-trailers --trailer` for appending (Q13).
  - Keeping the git toplevel as the project directory fallback (PRE-11): wrong layer in a
    monorepo subfolder, contradicting the spike's findings.
  - The worker passing `--project-dir` on the command line (PRE-11): an agent-chosen layer,
    and an extra CLI flag the script would have to trust.
  - Running the final managed-layer `node --test` invocation under `sudo` (PRE-16):
    root-owned temp repos, git `safe.directory` friction, and `HOME`/env drift from the
    rest of the suite.
  - Dropping the real-path managed-directory test for an injected `managedDir` only
    (PRE-16): loses the real-path check.
- **Consequences.** Without an attribution setting the trailer omits the model name. The
  trailer is produced deterministically; no agent-supplied text reaches it. Settings passed
  on the command line (`claude --settings <file>`) are invisible to the script, and so are
  MDM, registry and server-managed policy and the managed drop-in files; the README says
  so. An organisation that sets attribution only through those sources gets the trailer
  the readable layers give.
