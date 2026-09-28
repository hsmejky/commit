# Q23 Guard heartbeat

- **Context.** Without Node on the hook's PATH, with plugin hooks disabled or with
  `disableAllHooks` set, the guard does not run and nothing says so (Q1).
- **Decision.**
  - `plan` itself runs through the Bash or PowerShell tool, so the guard's `PreToolUse` fires
    for it. When a segment of the tokenised command is a script call to `plan` (`node` or
    `node.exe`, then a token whose basename is `commit.cjs`, then `plan`, after quote
    removal; [contracts](../contracts/guard.md)), the guard writes
    `commit-guard/heartbeat.json` under the Claude home (`CLAUDE_CONFIG_DIR` when set, else
    `~/.claude` from `os.homedir()`; Q5) = `{ ts, cwd, command }`. `command` is stored
    redacted: the script-call form only (subcommand and flags), cut to 200 characters, so
    arguments a caller passed on the command line do not persist in the Claude home. The
    file is written to a temporary name carrying the pid and a random part and renamed into
    place, so `plan` never reads a partial one and parallel sessions never share a
    temporary name. The debug log (`COMMIT_GUARD_DEBUG=1`) holds the command in the same
    redacted form (for a `git commit` segment, its matched options only). The guard and
    `plan` resolve the Claude home the same way, so a relocated Claude home moves both
    ends. Not
    `os.tmpdir()`: Claude Code's sandbox gives sandboxed Bash commands their own `TMPDIR`,
    while `HOME` stays the same, and only the unsandboxed hook writes the file.
  - `plan` reads it: a `ts` under 15 minutes old and a `cwd` that matches →
    `env.guard: "active"`, otherwise `"not-seen"`. Matching: both paths are normalised
    (realpath, `\` → `/`, case-folded on Windows and macOS), and the hook's `cwd` must be
    inside `plan`'s git toplevel, or the toplevel inside the hook's `cwd`. This covers
    `cd sub && node …/commit.cjs plan` and `cd repo && …` from a parent directory without a
    git call in the hook.
  - On `not-seen` the reply's `notices` tell the user "Guard hook did not run: `node`
    missing from the hook's PATH, plugin hooks disabled, or `disableAllHooks` set. Direct
    `git commit` is not blocked." The run goes on.
- **Amended.** By spec pass 2 (2026-09-27): the heartbeat file moved under the Claude home
  (honouring `CLAUDE_CONFIG_DIR`); `command` is stored redacted, and the file is written to
  a temporary name and renamed into place.
- **Amended.** By spec pass 3 (2026-09-27): the heartbeat's temporary
  name carries the pid and a random part; the debug log holds the redacted command, never
  message text; the one global heartbeat with parallel sessions is an accepted gap.
- **Rejected.**
  - Inferring the hook's state from settings: managed settings and runtime state are not all
    visible to the script; the heartbeat measures what actually happened.
  - Comparing raw `cwd` strings: `cd sub && …` and Windows path case and slashes make them
    differ although the guard ran.
  - Matching the substring `commit.cjs plan` on the raw command (the design before the
    ninth review): every script call is quoted for the anchored allow rule (Q16), so the
    raw text holds `commit.cjs" plan` and never matched. Every run would have carried a
    false "Guard hook did not run", and Q25's worker-only deny would never have fired.
  - A 10-second window: `PreToolUse` runs **before** the permission prompt, so without the
    README's allow rule a user who takes more than 10 seconds to approve `plan` gets a false
    "guard did not run", on the first run in every new setup, which is when the user decides
    whether to trust the warning. The guard's state rarely changes within a session.
- **Consequences.** Needs the `node *commit.cjs*` entries in the hook `if` condition (Q13).
  Accepted gaps: a session without the guard that runs `plan` in the same repo within 15
  minutes of one with it sees the other's heartbeat and reports `active` (same machine, same
  repo, different hook settings: rare). A guard disabled mid-session is noticed only after
  15 minutes. `cd ../other-repo && …` reports `not-seen` although the guard ran (a false
  warning, never a false all-clear). The heartbeat is one file per Claude home: with
  parallel sessions or worktrees, another session's worker can overwrite it with its own
  `cwd`, so a run can report the guard `not-seen` although it is active. Keying it by repo
  would need a git call on the guard's hot path, where the guard knows only the hook's
  `cwd`.
