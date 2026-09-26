# commit

Claude Code plugin `commit` (install: `commit@commit`): a skill plus a deterministic script
plus a guard hook against direct `git commit`. Status: design done, no code yet. Start at
version 0.1.0.

## Language

Everything in this repo is written in English: docs, code, comments, commit messages, tests,
README, manifests.

## Source of truth

- `docs/decisions.md`: decisions Q1-Q25 (why).
- `docs/contracts.md`: data shapes, grammars, classification tables.
- Read the relevant Q before changing behavior. On conflict, fix docs and code together.

## Layout (Q15)

- `plugin/scripts/commit.js` is shared by the skills, the agent and the hook. Do not
  duplicate its logic elsewhere.
- `plugin/scripts/guard.js` and `plugin/hooks/hooks.json`: the guard hook.
- `plugin/agents/commit-worker.md` runs the commit (Q24, Q25). `plugin/skills/commit/SKILL.md`
  (`/commit`) only spawns the worker.
- `plugin/skills/commit-config/SKILL.md`: config skill (Q7).
- `tests/*.test.js`, `tests/fixtures/`.

## Rules

- Minimum git 2.34, Node 22/24. CI: ubuntu, windows, macos, plus ubuntu-22.04 (git 2.34).
- Tests build git repos in temp directories at run time, with fixed author and dates via env.
- No local paths or usernames in docs, README, manifests or test sources (privacy-guard
  test, Q10).
- Commits: Conventional Commits. The repo dogfoods its own rules via `.claude/commit.json`
  (`scanIgnore: tests/fixtures/**`).

## Token economy

- Never continue an agent with `SendMessage`: a resume carries its whole history. Follow-up
  work (review findings, fixes, next step, agent that hit its `maxTurns`) goes to a new agent
  with a brief of links, not content, plus the previous report (≤ 300 words) and `git log`.
- CI status: one `gh pr checks <n> --watch` call. No polling loops over check-runs or
  `actions/runs`, no REST calls via `curl` or `git credential fill`.
- Codebase lookups and markdown reads that produce more than a few lines of output
  go to the Explore agent with model haiku, not inline reads.
