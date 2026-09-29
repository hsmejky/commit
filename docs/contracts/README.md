# Contracts

Data shapes, grammars and classification rules shared by the script, the skills, the
`commit-worker` agent and the guard. These are the test contract; the reasons behind them are
in [decisions](../decisions/README.md). All JSON carries `"version": 1`, except the user and
repo `commit.json` configs: Q6 defines no `version` key for either config layer, since
additive keys and values plus warnings already cover forward compatibility. Paths are repo-relative
with forward slashes. Everything here except the scan pattern IDs and the public
[worker input](worker-input.md) fields (`intent`, `interactive`, `reword`) is internal (see
[Public surface](../decisions/public-surface.md)).

## Contents

- [CLI and exit codes](cli-and-exit-codes.md): Lists the CLI subcommands, flags, and exit codes, and the failure JSON with every error kind and its cause
- [Run folder](run-folder.md): Lays out `.commit-plan/`: the lock and state files, their content, and when the folder is created or deleted
- [plan](plan.md): Specifies the `plan` subcommand's step-by-step flow, refusals, and its JSON output shape
- [plan --hunks](plan-hunks.md): Specifies `plan --hunks`: the hunk index JSON, the `hunks.txt` block format, and hunk kinds
- [Worker input](worker-input.md): Specifies the fields (`intent`, `interactive`, `reword`, etc.) in the Agent prompt that spawns the commit worker
- [Worker plan](worker-plan.md): Specifies `plan.groups.json`, the worker's grouping of hunks or files into commit groups and notIncluded reasons
- [check](check.md): Specifies the `check` subcommand: validation rules, its groups/notIncluded JSON output, and when confirm is set
- [commit, release](commit-release.md): Specifies `commit --all` (phased staging and commit per group) and `release`, with their JSON outputs
- [Reply and handback](reply-and-handback.md): Specifies the `reply` JSON (status, text, callerRule) and the handback kinds a caller can act on
- [infer](infer.md): Specifies `infer`: the commit-history-based config proposal JSON used by commit-config
- [Message grammar](message-grammar.md): Specifies the commit message grammar: header, body and footer rules, and the trailers commit appends
- [Untracked files](untracked-files.md): Specifies how untracked and staged-new paths are classified as hidden or candidate, and collapsed above caps
- [Summary-only files](summary-only-files.md): Specifies the rules that make a file summary-only (lockfile, minified, etc.) and the diff body line cap
- [Scan patterns](scan-patterns.md): Specifies the secret and local-path scan patterns: their regexes, exclusions, and sources
- [scanIgnore globs](scanignore-globs.md): Specifies the scanIgnore glob syntax (a hand-written matcher) and which patterns are config errors
- [Confirmation triggers](confirmation-triggers.md): Specifies which conditions make check set confirm, per mode (split, staged, reword)
- [Guard](guard.md): Specifies the guard hook: how it parses commands to detect a git commit or script call, and its deny messages
