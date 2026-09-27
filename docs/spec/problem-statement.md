# Problem Statement

As a developer working with Claude Code, I let the agent commit its own work many times a
day, and it goes wrong quietly. The agent runs `git add … && git commit` itself: it lumps
unrelated changes together or splits by folder instead of by functionality, sweeps in
scratch files, my half-finished hand edits or a parallel implementer's files, and can commit
a token, a private key or my home path unnoticed. Messages drift from the repo's
Conventional Commits style, the harness's attribution leaks in through the agent, and
multi-line messages break on shell quoting, especially in PowerShell. A prompt-only commit
skill scans and splits "by eye", costs more calls than no skill, and is skipped whenever the
model commits directly. Repo hooks, signing, in-progress merges, huge lockfiles and
concurrent agents add failure modes, and a run that breaks halfway leaves the index in an
unexplained state.
