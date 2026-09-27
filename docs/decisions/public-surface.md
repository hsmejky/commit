# Public surface

Hard to change once released; changes need a major version or a migration path:

- Config paths `commit.json` in the Claude home (`CLAUDE_CONFIG_DIR` when set, else
  `~/.claude`) and `.claude/commit.json`, the key names, their layers and values (Q6).
- Plugin and marketplace identity `commit@commit`, the skill names and the agent name
  `commit:commit-worker` (Q8, Q25).
- The worker input fields `intent` (including that it scopes a `split` run, Q16),
  `interactive` and `reword` and their meaning (Q25), and that the caller follows a reply's
  `callerRule`.
- Scan pattern IDs (`github-token`, `local-path`, …): users see them in reports, and the
  roadmap's `scanIgnore` object form will name them (Q10).
- The env variable `COMMIT_GUARD_DEBUG` (Q1).

Internal, versioned with `version: 1` for the plugin's own tests and free to change in a minor
release: the script CLI and exit codes, the `plan`, `check`, `commit` and worker-plan JSON, the
`reply` and `handback` shapes, the respawn-only worker input fields `mode`, `takeOver`,
`resume` and `edit`, the run folder (state file, `plan.json`, `hunks.txt`,
`plan.groups.json`, temporary index) and lock, and the heartbeat file. Only the plugin's own
skills, agent and hook use them.
