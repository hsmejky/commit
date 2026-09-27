# Q15 Repository layout

- **Context.** The layout must keep one shared module library behind both entry points, keep
  the guard's load small (Q13), and let the plugin dogfood its own rules.
- **Decision.**

  ```
  .claude-plugin/marketplace.json
  .claude/CLAUDE.md
  .claude/commit.json                 repo config; scanIgnore: tests/fixtures/**
  .github/workflows/test.yml          ubuntu + windows + macos × Node 22/24, + git 2.34 container job
  plugin/.claude-plugin/plugin.json
  plugin/scripts/commit.js            commit entry point: thin, subcommands for worker and skills
  plugin/scripts/guard.js             guard entry point: thin, the PreToolUse hook
  plugin/scripts/lib/                 shared module library; the guard loads only its modules
                                      plus heartbeat and script call
  plugin/hooks/hooks.json
  plugin/agents/commit-worker.md       the run (Q24, Q25)
  plugin/skills/commit/SKILL.md       /commit: spawn only
  plugin/skills/commit-config/SKILL.md
  docs/contracts/, decisions/, spec/  one file per topic, README.md index in each
  tools/                              episode analysis (Q24), not packaged
  tests/*.test.js, tests/fixtures/
  LICENSE (MIT), README.md
  ```

  Neither entry point holds domain logic; module boundaries are in [spec](../spec/README.md).

  Tests build git repos in temp directories at run time (fixed author and dates via env).
  Minimum git version 2.34 (SSH signing, Q18). The script spawns only git, plus `ssh-add`
  for the signing probe (Q18) and, on Windows, `taskkill` for the tree kill (Q9, Q18;
  resolved from the system directory, never from `PATH`), all through one process adapter. The main CI matrix
  (ubuntu, windows, macos × Node 22, oldest and latest, and Node 24) tests whatever git the runners ship. One extra
  job tests the minimum in an `ubuntu:22.04` container with the distribution's git (2.34.1);
  its first step asserts that `git --version` is 2.34.x, since the hosted `ubuntu-22.04`
  runner image ships a newer git and a job on it would not test the minimum. A
  privacy-guard test keeps local paths and usernames out of docs, README,
  manifests and test sources (Q10): `local-path` over all four, matching a home-directory
  path with any user name on every OS, and the CI runner's user name as a path segment. A
  bare user name outside a home path is not caught (accepted). Design review reports stay out of history: they quote
  the bugs they found, local paths included, and the decisions already record what they
  changed. They are written next to the docs (`docs/design-review*.md`, where the review
  skill puts them) and kept out by a `docs/design-review*.md` line in the clone's
  `.git/info/exclude`, so a `git add docs` or a `split` run never sees them and later
  rounds are covered without a new rule. Start at version 0.1.0.
- **Amended.** By spec pass 1 (2026-09-27): added the shared module library path, the
  unpackaged `tools/` directory for episode analysis, and the `docs/` list (`contracts.md`,
  `decisions.md`, `spec.md`) to the layout. By spec pass 2 (2026-09-27): the git 2.34 job
  runs in an `ubuntu:22.04` container, and the main CI matrix tests Node 22 oldest and
  latest plus Node 24. By the docs split (2026-09-27): `contracts.md`, `decisions.md` and
  `spec.md` became the directories `docs/contracts/`, `docs/decisions/` and `docs/spec/`,
  one file per topic with a `README.md` index each, to cut the tokens a lookup reads.
- **Amended.** By spec pass 3 (2026-09-27): the privacy-guard test does not
  catch a bare user name outside a home path, an accepted gap; the process list is git plus `ssh-add` for the signing probe, since the
  openpgp `gpg` / `gpgconf` probes are deferred (Q18).
- **Amended.** By spec pass 5 (2026-09-27): the guard is supported and tested on both
  Windows PowerShell 5.1 and PowerShell 7+ (Q3): the windows CI runner ships both, and the
  guard's PowerShell tests, including the PowerShell parser oracle, run under each
  (`powershell.exe` and `pwsh`). Other PowerShell editions are not supported. The process
  list adds `taskkill` on Windows for the tree kill (Q9 spec pass 4, Q18).
- **Amended.** By spec pass 9 (2026-09-27): the privacy-guard test matches the CI runner's
  user name only as a path segment (between `/` or `\` separators, as in `/home/<name>/`,
  `/Users/<name>/` or `C:\Users\<name>\`, the OS-user segment rule of Q10), never as a bare
  word, and without Q10's service-user and length exemptions, so `/home/<runner name>/` is still
  caught. Matching it anywhere failed by construction: the runner's name is `runner` on
  ubuntu and macos and `root` in the container, and both are ordinary words in the docs.
- **Amended.** By spec pass 10 (2026-09-27): the pass-9 amendment quoted a runner path
  literally, which the test itself flags on ubuntu and macos; it now writes the runner's
  name as a placeholder. A self-test runs the segment check over the repo's tracked files with
  the user name set to `runner` and to `root`, so such a literal fails locally too.
- **Rejected.**
  - Node 18 or 20 as the minimum: both are end-of-life, and Claude Code's npm install
    already requires Node 22.
  - Git 2.23 as the minimum: untested in CI, and SSH signing needs 2.34.
  - The hosted `ubuntu-22.04` runner for the minimum-git job: its image ships a newer git,
    so the job would pass without ever running 2.34.
  - Committing the review reports under `docs/`: every report would have to pass the
    privacy guard, and each round's quotes of old bugs would need rewriting.
  - Moving the reports out of the working tree: the next round writes into `docs/` again.
    A `.gitignore` entry: it would publish a rule about files nobody else has.
- **Consequences.** The plugin applies its own rules to itself. macOS in CI covers the
  case-insensitive filesystem against case-sensitive glob matching (Q10).
