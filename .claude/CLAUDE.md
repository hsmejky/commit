# commit

Claude Code plugin `commit` (install: `commit@commit`): a `/commit` skill that spawns a
commit worker agent, a `/commit-config` skill, a deterministic script over a shared module
library, and a guard hook against direct `git commit`. Zero npm dependencies. Status: design
and spec done, no code yet. Start at version 0.1.0.

## Language

Everything in this repo is written in English: docs, code, comments, commit messages, tests,
README, manifests.

## Source of truth

- `docs/decisions/`: decisions Q1-Q25 (why), one file each (`q15-*.md` is Q15).
- `docs/contracts/`: data shapes, grammars, classification tables (`C:guard` is `guard.md`).
- `docs/spec/`: user stories, module map and interfaces, test seams (how).
- `docs/roadmap/`: 0.1.0 implementation plan, vertical slices per group with blocking edges
  (what to build next). Work the frontier; tick criteria and set `Status: done` when finished.
- Each directory has a `README.md` index with a one-line gist per file: read the index,
  then only the files you need.
- Read the relevant Q before changing behavior. On conflict, fix docs and code together.

## Layout (Q15)

- `plugin/scripts/commit.js` and `plugin/scripts/guard.js` are thin entry points over the
  shared module library `plugin/scripts/lib/`; neither holds domain logic. Do not duplicate
  library logic elsewhere. The guard loads only its own modules plus heartbeat and script
  call (`docs/spec/architectural-decisions.md`).
- `plugin/hooks/hooks.json`: registers the guard hook.
- `plugin/agents/commit-worker.md` runs the commit (Q24, Q25). `plugin/skills/commit/SKILL.md`
  (`/commit`) only spawns the worker.
- `plugin/skills/commit-config/SKILL.md`: config skill (Q7).
- `tests/*.test.js`, `tests/fixtures/`.
- `tools/`: episode analysis (Q24), not packaged.
- `docs/`: `contracts/`, `decisions/`, `spec/`, `roadmap/`, one file per topic plus a `README.md` index.

## Rules

- Minimum git 2.34, Node 22/24. CI: ubuntu, windows, macos, plus a git-2.34 job in an
  `ubuntu:22.04` container.
- Tests build git repos in temp directories at run time, with fixed author and dates via env.
- No local paths or usernames in docs, README, manifests or test sources (privacy-guard
  test, Q15).
- Commits: Conventional Commits. The repo dogfoods its own rules via `.claude/commit.json`
  (`scanIgnore: tests/fixtures/**`).
