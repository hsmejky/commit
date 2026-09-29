# Modules M1-M9

**M1 CLI and envelope.** Peel the subcommand off argv, then one strict `parseArgs` per
subcommand (`no-user` declared literally, never `allowNegative`); reject illegal flag
combinations as `usage`; route to M18; print exactly one JSON object (`version: 1`) on
success and failure; kind → exit code 0-6; debug to stderr only; no subcommand reads stdin.
`main(argv, env) → { stdoutJson, exitCode }`. Sources: Q9, C:cli-and-exit-codes.

**M2 Process adapter.** The only module that spawns processes. Mechanism only: for git,
working directory = toplevel; on every call except `git commit`, every inherited `GIT_*`
variable is removed except a keep-set (`GIT_EXEC_PATH`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`), so
`GIT_ATTR_SOURCE`, `GIT_TRACE*` and the object-directory variables cannot reach the scan, and
the signing probe reads the same config files `git commit` does; `git commit` removes
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
`GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`, `GIT_CONFIG_PARAMETERS`, `GIT_ATTR_SOURCE`,
`GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` and keeps the rest for the
user's hooks; `GIT_OPTIONAL_LOCKS=0` on read-only calls
(never on staging or commit); optional alternate index; `GIT_LITERAL_PATHSPECS=1`,
`core.quotePath=false` and `diff.suppressBlankEmpty=false` on every call except `git commit`,
which takes no pathspec and runs with neither, so hooks inherit the user's own git
environment (stories 147 and 163, Q9); history reads also pin
`log.showSignature=false` and `i18n.logOutputEncoding=UTF-8`; NUL-separated output where git
offers `-z`; stdin for message input and path lists; `windowsHide` on every spawn; a timeout
that kills the process tree: on POSIX `SIGTERM` to the process group, then `SIGKILL` after a
5-second grace; on Windows `taskkill /T`, then `taskkill /T /F` after the same grace (the grace is
intended: bounded, and inside the cleanup window). The
`timeoutMs` of every M2 call, in `plan` as in later subcommands, is computed from the call's
`deadline` (M15), or from `cleanupDeadline` for the cleanup and reporting calls after a
failure or timeout, so `plan`'s calls before `acquire` are bounded too. Every call is
asynchronous except `toplevel` and `gitVersion`, which use `spawnSync` under a fixed short
timeout and decode their output as UTF-8 text (KD-S53: a non-UTF-8 toplevel path is mangled
to U+FFFD, which then fails as a later call's `cwd`). `run`'s `stdout` is returned as a
`Buffer`, never decoded by M2, so diff output keeps its raw bytes; with an `onStdout(chunk)` consumer (M10's patch pass only) each chunk goes to it
as it arrives and nothing is buffered. M2 tracks the child it is running; `killActive()`
kills that child's tree the same way, for the entry point's `SIGINT`/`SIGTERM`/`SIGHUP`
handler.

`run(cmd, args, { cwd, env, now, index?, input?, timeoutMs, readOnly?, commit?, onStdout? }) →
{ code, stdout: Buffer, stderr, timedOut, spawnedAt }` (`stdout` empty with `onStdout`);
`toplevel(fromCwd, { env })`; `gitVersion({ cwd, env })`; `gitPath(names)` (one
`rev-parse --git-path` call); `killActive()`. Sources: Q9, Q18.

**M3 Repo-state probe.** Every question about repository state, as typed results: not a
repo or bare; unborn, detached and current HEAD from one porcelain v2 `--branch` status
(pinned `--untracked-files=no --ignore-submodules=all`);

unmerged entries (any `u` line of that same status, such as a conflicted `stash pop` that
left no in-progress marker) → `unmerged` ("resolve the conflicts first"); in-progress merge,
cherry-pick, revert, rebase, bisect or `sequencer/` via `gitPath`; a pending
`merge --squash`, detected by `SQUASH_MSG`, with its own text ("a squashed merge is staged:
commit it by hand, or drop it with `git reset --merge`"); `i18n.commitEncoding` not UTF-8,
compared case-insensitively with `utf-8` and `utf8` (story 186); git and Node versions; for
`reword`, unborn, merge commit, root commit and pushed (one `for-each-ref --contains` over
remote-tracking refs, skipped when unborn); `head()`; `headTree()` (the tree ID of
`HEAD^{tree}`, which M16 compares with the tree its backstop scanned); history reads (`recentSubjects`,
`oldMessage`, and the last 200 non-merge messages for `infer`). Its refusal texts (`head-moved`, the merge-commit reword, the in-progress states, `unmerged`) are the recorded-texts table of C:cli-and-exit-codes, verbatim. Sources: Q18, Q20, Q21, C:plan, C:commit-release, C:cli-and-exit-codes.

**M4 Config loader.** Read the user layer from the Claude home and the repo layer from the
worktree, plus `scanIgnore` from the repo layer at HEAD (none when unborn); validate types
and ranges (`types`: non-empty array of `^[a-z][a-z0-9-]*$`; `scope`: `forbidden | optional
| required`; `body`: `forbidden | optional`; `maxSubjectLength`: integer 20-200; `subjectCase`:
`lower | any`; `scanIgnore`: array of path globs, repo only, Q6); per-key override; warnings
(unknown key or value, wrong layer) versus errors;
defaults; `sources` per key. Every `scanIgnore` pattern is compiled by M7 `compileGlob`
inside `validateLayer` itself (not only via `loadConfig`), whose `config` errors (including a
pattern with no literal character) M4 reports as layer errors, so a caller that validates a
layer's text directly (M19 `configFor`) also catches a bad glob. The repo layer at HEAD is
not validated as a layer: only its `scanIgnore` is read, and when it is invalid (the file at
HEAD is not valid JSON, the value is not an array of strings, or a pattern fails M7
`compileGlob`) `loadConfig` uses `[]` and adds a warning naming the repo config at HEAD, not
a `config` error (fail-closed: `[]` exempts nothing); the worktree layer, its `scanIgnore`
included, is validated as usual, so a copy still invalid there is a `config` error and a
fixed copy is committable (Q6, Q10 as amended by CFG-01). Returns compiled
`scanIgnore` matchers (via M7) and exports
`isRepoConfigPath(path)` and the constant `REPO_CONFIG_PATH` (`.claude/commit.json`), so M8
compiles nothing and knows no config file names and M18 spells no path. It also
owns the `scanIgnore` change test, pure so that no other module parses the config: pure
`scanIgnoreChanged(headPatterns, snapshotBlob) → boolean` compares the `scanIgnore` patterns
`loadConfig` read at HEAD (`[]` when the value there was invalid) with the `scanIgnore`
parsed from the repo config's content on the snapshot side (M10
`snapshotBlob(REPO_CONFIG_PATH)`). A missing file or key counts as no patterns; the two
lists are compared in order, element by element, so an edit to another key never counts;
a snapshot blob that is not valid JSON, or whose `scanIgnore` is not an array of strings,
counts as changed. HEAD's `[]` after an invalid value is compared like any other: a fixed
copy that carries patterns counts as changed, so its units are flagged (`humanOnly`).
`loadConfig({ claudeHome, toplevel, unborn })`, `readLayers(…)`, pure
`validateLayer(obj, layer)`, all typed. Sources: Q6, Q10, C:plan, C:plan-hunks.

**M5 Attribution resolver.** Resolve the trailer from the Claude settings layers, highest
first: managed (`managed-settings.json` only; the drop-in directory is not read, Out of
Scope), project-local, project (project directory = `CLAUDE_PROJECT_DIR`, else the
toplevel), user (in the Claude home). Two passes: `attribution.commit` (empty string = no
trailer), then `includeCoAuthoredBy`; otherwise the fixed trailer `Co-Authored-By: Claude
<noreply@anthropic.com>`, source `default`. Keep trailer-shaped lines only, warn on dropped
lines. MDM profiles, registry policy and server-managed settings are not read; the source
is reported and the README names the gap (story 116). `managedDir` is the injected managed
directory. `plan` outputs `attribution: null` when the resolution yields no trailer (an
empty `attribution.commit` or `includeCoAuthoredBy: false`); the source is known at `plan`
and stored for M16 and M17 (C:plan).
`resolveAttribution({ env, claudeHome, toplevel, managedDir }) → { trailer | null, source,
warnings }`. Sources: Q5, C:plan.

**M6 Message grammar.** Byte normalisation (BOM, UTF-16, invalid UTF-8, CRLF and lone CR,
trailing blank lines) with `TextDecoder` `fatal`; one parser for header, body and footers
(Conventional Commits footer grammar), shared by lint, `infer`, attribution and append;
lint against config (`maxSubjectLength` in code points); allowed agent footer tokens;
reword carry-over (foreign trailers kept verbatim, allowed tokens not carried, every
`Co-Authored-By: … <noreply@anthropic.com>` dropped); append in the order new footers,
carried trailers, attribution, into the footer paragraph when the message ends in one,
otherwise as a new last paragraph (Q5). `normalise`, `parse`, `lint`, `carryOver`,
`appendTrailers`, `passesLowerCase(description) → boolean`.
Sources: Q5, Q7, Q13, Q20, C:message-grammar.

**M7 Glob matcher.** Compile and validate `scanIgnore` patterns per C:scanignore-globs;
case-sensitive whole-path match on every OS; linear time. A pattern with no literal
character (only `*`, `?`, `**` and `/`, such as `**`, `**/*`, `**/?*` or `*/**`) is a
`config` error, so one amended line cannot switch the scan off; a broad literal pattern
(`src/**`) stays legal, an accepted gap (Out of Scope).
`compileGlob(pattern) → { ok: true, matcher } | { ok: false, code: "config", … }` (`matcher` is opaque; only `matches` reads it), `matches(matcher, path) → boolean`. Sources: Q10, C:scanignore-globs.

**M8 Scanner.** The pattern table of C:scan-patterns as data (ID, regex with whole-regex
flags only, false-positive rule, source) with its false-positive rules; added lines only;
binaries not scanned; files with more than 1 MB added, tracked or untracked, skipped and
reported: a unit is over the limit when M10 set `overScanLimit: true` on it (M10 stops
collecting a file's added lines at the limit, so a cut-short `addedLines` alone may not
show it) or when M8's own measure of its `addedLines` (UTF-8 bytes plus one byte per line
for the `\n`) exceeds 1 MB; the flag is checked before the binary kind, and a path gets one
`skipped` entry however many of its units are over; honours `scanIgnore` matchers; when passed `scanIgnoreChanged: true` (M4's
pure test, run by M18), flags every unit whose path or old path is the repo config
(`isRepoConfigPath`), since a whole-file comparison cannot tell which hunk carries the
change; with `false`, as when only another repo-config key was edited, it flags none, and
M8 itself parses no config; never returns a
matched value; the same patterns run over messages. A false-positive rule sees its match
plus the scanned lines of the same unit's added lines (or of the message) and its line's
index among them, which `private-key`'s body rule reads; the hit stays on the header's line.
A symlink's target is scanned as one added line of its unit (Q11; Q10 as amended). The
regexes and false-positive rules (among them the one-line `private-key` form, the RFC 1421
header lines and the `generic-secret` spellings) are C:scan-patterns' and are not restated
here. Every regex runs on a line cut to its first 4096
characters (C:scan-patterns), so scanning stays linear in the input; the cut is an accepted gap (Out of
Scope). Binaries (M10) and credential containers are not scanned (Out of Scope).
`scanUnits(units, { scanIgnore, osUser, scanIgnoreChanged, isRepoConfigPath }) → { hits,
skipped, scanIgnoreUnits }` (the last two options only from `plan`; the backstop passes
neither and gets an empty `scanIgnoreUnits`);
`hits: [{ patternId, path, line }]`, one per pattern and line; M18 maps `patternId` to C:plan's `pattern`.
`scanText(text, { osUser }) → [{ patternId, start, end }]` (UTF-16
offsets into `text`, `end` exclusive, never the matched value), the spans M14 passes on with
its lint errors so M17 can replace the union of the spans with `[<pattern-id>]` (the first
hit's ID where spans overlap). Sources: Q10, Q19,
C:scan-patterns.

**M9 Path classifier.** Pure classification of paths, in two mode-aware steps so that mode
can be resolved in between: `hideFilter(paths) → { candidates, hidden }` (hidden rules,
`.env*`, mode-free; a `/`-exception is anchored at the repo root and `dir/**` excepts
everything below it, a name-only exception matches the last segment at any depth and does
not reach through a dot-directory above it, and the `.env` rule applies inside excepted
directories too, C:untracked-files) and, in `split` only, `applyCaps(candidates: {path,
size, binary}[], stagedNew: {path, ignored}[], trackedDirs: string[]) → { candidates,
stagedNew, collapsed, stagedExcluded }` (topmost new directory, root as `"."`,
loose files per parent only when they alone exceed 200, ties by byte order; the caps count
both inputs together). The returned `candidates` and `stagedNew` are the survivors, outside
every collapsed directory. Per collapsed directory, its untracked candidates become a
`collapsed` entry `{ dir, count, bytes }` and its staged-new paths a `stagedExcluded` entry
`{ dir, count, reason: "collapsed" }`, each counting only its own kind: a directory holding
only staged-new paths appears in `stagedExcluded` alone, one holding both appears in both. Also `bucketOf(path)` and
`summaryOnly(path, stats) → reason | null` in C:summary-only-files order. `stats` is
`{ added, deleted, generated, size }`: `added`/`deleted` are the file's changed-line counts
(their sum is the `lines` rule's input; a binary unit carries `added: 0, deleted: 0`, since
`--numstat` reports `-` for it), `generated` is the `linguist-generated` `.gitattributes`
flag (the `generated` rule), and `size` is the byte size of the file's new content, or the
old content's for a deletion (the `size` rule; M10 `inventory` sets the same field on an
untracked candidate together with `binary`, and M10 `snapshot` sets it on a tracked unit from
a `cat-file -s` of the new or old blob), matching the field names `plan --hunks` and
`applyCaps` already use for the same values. `applyCaps` sums the `bytes` of each collapsed
directory from the candidates' sizes. `bucketOf` classifies by path alone, checked in this
order: `test` (a `test`, `tests` or `__tests__` path segment, or a `*.test.*`, `*.spec.*`,
`*_spec.rb`, `*_test.go` or `test_*.py` name — `spec`/`specs` alone is not a segment rule,
since it also names non-test directories; the RSpec, Go and pytest conventions are caught by
name, not the segment), `ci` (a `.github/workflows/`, `.circleci/`, `.gitlab/`, `.buildkite/`,
`.gitea/workflows/`, `.forgejo/workflows/` or `.woodpecker/` path, or a `.gitlab-ci.yml`,
`.travis.yml`, `.drone.yml` or `Jenkinsfile` name), `docs` (under `docs/`, or a `.md`/`.mdx`
name), `build` (a known manifest, lockfile or build-tool config name, e.g. `package.json`,
`Cargo.toml`, `Dockerfile`, `*.config.{js,mjs,cjs,ts}`), else `code`. Sources: Q11, Q16,
Q19, C:untracked-files, C:summary-only-files.
