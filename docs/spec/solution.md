# Solution

With `commit@commit` installed, agent commits go through one path. A commit request spawns
the `commit:commit-worker` agent, which drives a deterministic Node script with no npm
dependencies: it inventories changes, scans added lines for secrets and local paths, and
shows the worker the changes as units (whole files or hunks). The worker groups units into
atomic commits by functionality, scoped by the caller's `intent`, and writes each message;
the script lints, decides whether a human must confirm, and commits. One group of tracked
files commits with no question; otherwise I see one block and answer `yes`, `one`, `no`, or
type an edit. The diff never enters the main context. A guard hook denies direct
`git commit` from agent tool calls and steers to the worker; the merge-finishing and plain
fixup forms stay allowed. Rules live in a user layer and a repo layer of `commit.json`,
inferable from history by `/commit-config`, which writes only a valid config. Failures stop
cleanly and explain themselves; hooks and signing are never bypassed; a repo opts out
through `enabledPlugins`.
