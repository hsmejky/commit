# Contracts

Data shapes, grammars and classification rules shared by the script, the skills, the
`commit-worker` agent and the guard. These are the test contract; the reasons behind them are
in [`decisions.md`](decisions.md). All JSON carries `"version": 1`. Paths are repo-relative
with forward slashes. Everything here except the scan pattern IDs and the public
[worker input](#worker-input) fields (`intent`, `interactive`, `reword`) is internal (see
[Public surface](decisions.md#public-surface)).

## Contents

- [CLI and exit codes](#cli-and-exit-codes)
- [Run folder](#run-folder)
- [plan](#plan)
- [plan --hunks](#plan---hunks)
- [Worker input](#worker-input)
- [Worker plan](#worker-plan)
- [check](#check)
- [commit, release](#commit-release)
- [Reply and handback](#reply-and-handback)
- [infer](#infer)
- [Message grammar](#message-grammar)
- [Untracked files](#untracked-files)
- [Summary-only files](#summary-only-files)
- [Scan patterns](#scan-patterns)
- [scanIgnore globs](#scanignore-globs)
- [Confirmation triggers](#confirmation-triggers)
- [Guard](#guard)

## CLI and exit codes

```
commit.js plan    [--reword [--dictated] | --staged | --split] [--take-over <planId>] [--no-user]
                                                  mints planId and unit IDs, takes the run lock
commit.js plan    --hunks --plan <planId>         resets the lint counter, marks the run resumed
commit.js check   --plan <planId> [--commit]      --commit: commits when confirm is null
commit.js commit  --plan <planId> --all           commits the remaining groups in order
commit.js release --plan <planId>
commit.js infer
```

`plan`, `plan --hunks` and `check` are run by the worker (Q24, Q25). A `commit --all` or
`release` comes either from the worker or, verbatim, from a handback's `run` in the caller.
Every subcommand writes exactly one JSON object to stdout, on failure too. stderr carries
debug output only. No subcommand reads stdin. `--staged` with an empty index → exit 1
`usage`. `--dictated` without `--reword` → exit 1 `usage`. `--no-user` together with
`--staged`, `--take-over`, or without `--split` or `--reword` → exit 1 `usage` (a run without a
user never asks for a mode or a takeover, Q17). Every git call runs with
`GIT_LITERAL_PATHSPECS=1`.

| Code | Kinds | Meaning |
| --- | --- | --- |
| 0 | — | ok |
| 1 | `usage`, `internal` | usage or internal error |
| 2 | `lint` | lint (`check`) |
| 3 | `scan` | scan backstop (`commit`, `check --commit`) |
| 4 | `git` | `git commit` failed, cause not parsed (`commit`, `check --commit`) |
| 5 | `timeout` | timeout (`commit`, `check --commit`) |
| 6 | `state`, `signing`, `pushed`, `staged-hit`, `lock`, `index-lock`, `diff-changed`, `head-moved` | refused |

Failure shape, shared by all subcommands:

```json
{ "version": 1, "ok": false, "error": { "kind": "lock", "message": "another /commit run is in progress (started 13:58, last active 40 s ago)",
  "planId": "77c0e2…", "created": "2026-09-26T13:58:02Z", "touched": "2026-09-26T14:02:11Z" } }
```

A lint failure uses the same shape and adds the `errors` array (see [check](#check)). A
`lock` error carries the holder's `planId`, `created` and `touched` (the lock file's mtime),
so the takeover question can say how long ago it was last active and
`plan --take-over <planId>` replaces only that run (Q22). For an empty or unparseable lock
`planId` and `created` are `null` and the message is "another /commit run is starting".

Every output that ends the worker's part of a run, failures included, also carries `reply`
([Reply and handback](#reply-and-handback)); the worker returns it verbatim. A failure the
worker handles itself (a first lint failure) carries none.

| Kind | Raised by | When |
| --- | --- | --- |
| `state` | `plan` | refused repo state (Q21); unborn HEAD or merge-commit HEAD with `--reword` (Q20) |
| `signing` | `plan` | `signing.ready` is `false` (Q18) |
| `pushed` | `plan --reword` | HEAD reachable from a remote-tracking ref (Q20) |
| `staged-hit` | `plan --staged` | the index diff has a pattern hit (Q10), or the index holds a staged-new path the [hidden rule](#untracked-files) excludes (Q11) |
| `lint` | `check` | any lint or validation error; details in `errors`; the second failure since the last `plan --hunks`, or the first of `"source": "user"` text, carries a `lintFailed` handback, or with `--no-user` releases the lock |
| `lock` | `plan`, and every `--plan` subcommand except `release` (a no-op there) | another run holds the lock; `--take-over <planId>` found a lock with another `planId`; this run was taken over (the lock holds another `planId`); this run has already ended (no lock); or a lock operation failed with `EPERM`, `EBUSY` or `EACCES` (Windows: another process has the file open) |
| `index-lock` | `commit` | `index.lock` exists before the index is reset or staged |
| `diff-changed` | `plan --hunks`, `commit` | the hash set differs from the map `plan` stored, or (`commit`) the staged diff is not exactly the group; the message names a repo hook when the previous group's own `git commit` changed the tree ([commit](#commit-release)) |
| `head-moved` | `plan --hunks`, `commit` | HEAD is not the SHA the state file expects |
| `git` | `commit` | `git commit` exited non-zero; output in `gitOutput` |

`diff-changed`, `head-moved`, `index-lock` and exits 3–5 end the run: they release the lock
and delete the run folder. `usage`, `lint` and `lock` do not (the run can go on, or it is
not this run's lock), except a second `lint` failure with `--no-user`, which releases.

## Run folder

`<toplevel>/.commit-plan/`; per worktree. Before creating it the first time, the script
appends a `/.commit-plan/` line to `$(git rev-parse --git-common-dir)/info/exclude` (once;
Node writes it). Not under `.git`: the harness treats every `.git` path as a sensitive
file, so the worker's `Write` would ask on every run (Q9, spike).

`plan` and `plan --hunks` print the folder as `runDir`: absolute, resolved with
`path.resolve` from the toplevel, forward slashes (`C:/Users/<you>/repo/.commit-plan/3f9a1c…`).
Every file path in their output (`hunksFile`, `hunksIndexFile`) is
absolute in the same form, because `Read` and `Write` need absolute paths.

| Path | Written by | Content |
| --- | --- | --- |
| `lock` | `plan` | `{ planId, created }`, written once; its mtime is `touched`, refreshed with `utimes` (Q22) |
| `<planId>/state.json` | `plan`, `plan --hunks`, `check`, `commit` | mode, `interactive` (`false` with `--no-user`), expected `head`, `preStaged`, candidate list, staged-new list (each path with `ignored`), `indexOnly` (path, index blob ID, `ignored`), `id → hash` map and scan map (both by `plan`), `notices` for the reply (by `plan`), `lintFailures` (reset by `plan --hunks`), `resumed` (set by a separate `plan --hunks` call, Q16), validated groups, `indexReset`, `treeChangedDuringCommit` |
| `<planId>/plan.json` | `plan` | the full `plan` output ([plan](#plan)); one entry per line. Always written when the folder is kept; not read by the worker |
| `<planId>/hunks.txt` | `plan --hunks` | hunk bodies, see [plan --hunks](#plan---hunks) |
| `<planId>/hunks.json` | `plan --hunks` | the full hunk index when stdout would exceed the budget; one entry per line |
| `<planId>/git-index` | `plan` (`split` scan), `plan --hunks`, `commit` | temporary index (Q11) |
| `<planId>/plan.groups.json` | the worker (`Write`), also for a dictated reword | [worker plan](#worker-plan) |

- Created by `plan` after the `state` and `signing` checks, and with `--reword` after the
  unborn, merge-commit (`state`) and `pushed` checks, before the scan: `plan` mints the
  `planId` first, because the `split` scan builds the temporary index in the folder. No
  outcome without a lock leaves a folder: the refusals above come before it exists, and
  the rest (`clean`, `modeChoice`, `staged-hit`, `lock`) delete it before `plan` exits. Two
  concurrent `plan`s both build; the one that loses the exclusive create of `lock` gets
  `lock` and deletes its folder.
- Deleted with the lock: by `commit` (or `check --commit`) after the last group or on
  failure, by `check` on zero groups or on a lint failure that ends the worker's part with
  `--no-user`, by `check` on a `humanOnly` confirmation with `--no-user`, by `release`, and by
  a takeover, automatic or `--take-over` (the old run's folder,
  [Q22](decisions.md#q22-concurrent-runs)).
- Only the script creates the folder. A worker whose script call failed writes nothing
  ([worker input](#worker-input)), so its `Write` never re-creates a deleted folder.
- `plan` deletes `<planId>/` folders older than 24 hours that the lock does not name.
- Stdout budgets, each tested on its own (Q24): `plan`'s own fields 1 kB ([plan](#plan));
  a `reply` 2 kB without its `text`, and its `text` 4 kB with every list at its cap
  ([Reply and handback](#reply-and-handback)); `plan --hunks` 20 000 characters, also when
  `plan` carries it under `hunks`. `plan --hunks` output over its budget moves the index to
  `hunks.json`.

## plan

Run by the worker (Q9, Q25). Contains no hunks and no diff content. It mints `planId` and
creates the [run folder](#run-folder) before the scan; when there is work to do it writes
`state.json` (including the current `HEAD` SHA, or `null` when unborn, the stored lists, the
unit IDs with the `id → hash` map and the scan map, cut from the very diff it scanned, and
the notices for the reply) and takes the run lock (Q22), otherwise it deletes the folder
again. Every git call runs from the toplevel (Q9).

Stdout is compact. `plan`'s own fields (and a refusal's `error` object) stay within 1 kB; a
`reply` (≤ 2 kB without its `text`, `text` ≤ 4 kB) or the `hunks` object (≤ 20 000
characters) comes on top, each with its own CI size test (Q24):

```json
{ "version": 1, "ok": true, "planId": "3f9a1c…",
  "runDir": "C:/Users/<you>/repo/.commit-plan/3f9a1c…", "mode": "split", "reply": null,
  "hunks": { "version": 1, "ok": true, "runDir": "…", "hunksFile": "…", "hunks": ["…"] } }
```

`hunks` is the [`plan --hunks`](#plan---hunks) output as a nested JSON object, never a string
(no double escaping), or `null` when `reply` is set. Exactly one of `reply` and `hunks` is
non-null, except with `--dictated` (Q20): the dictated text needs no diff, so `plan` skips
the hunk step and both are `null`. `--dictated` saves the worker up to 20 000 characters
of HEAD's hunk index it would never use.

`reply` is set when the worker's part ends here: a clean tree (`status: "nothing"`), a
`modeChoice` or `lock` handback, or a refusal ([Reply and handback](#reply-and-handback)).
Otherwise `plan` has taken the lock and goes straight on as [`plan --hunks`](#plan---hunks)
in the same process, and `hunks` holds that output. The full output below goes to
`plan.json` in the run folder (for tests and debugging; the worker does not read it). With no folder
kept (clean, `modeChoice`, refusals) there is no `plan.json`, and `reply.text` carries what
the user needs (counts of hidden and collapsed files, `stagedExcluded`, `dirtySubmodules`).

```json
{
  "version": 1,
  "ok": true,
  "planId": "3f9a1c…",
  "runDir": "C:/Users/<you>/repo/.commit-plan/3f9a1c…",
  "mode": "split",
  "state": { "kind": "branch", "branch": "main", "unborn": false },
  "clean": false,
  "preStaged": ["src/a.js"],
  "unstagedLeft": null,
  "tracked": [
    { "path": "src/a.js", "oldPath": null, "status": "M", "bucket": "code", "added": 4, "deleted": 1 },
    { "path": "src/b.js", "oldPath": null, "status": "M", "bucket": "code", "added": 12, "deleted": 3 }
  ],
  "untracked": {
    "candidates": [
      { "path": "docs/new.md", "bucket": "docs", "binary": false }
    ],
    "collapsed": [{ "dir": "dist", "count": 412, "bytes": 5242880 }],
    "hidden": { "count": 3, "sample": [".env", ".idea/workspace.xml", ".DS_Store"] }
  },
  "stagedExcluded": [
    { "path": ".env.local", "reason": "hidden" },
    { "dir": "build", "count": 60, "reason": "collapsed" }
  ],
  "dirtySubmodules": ["libs/x"],
  "config": {
    "values": { "types": ["feat", "fix"], "scope": "forbidden", "body": "forbidden",
                "maxSubjectLength": 72, "subjectCase": "lower", "scanIgnore": [] },
    "sources": { "types": "default", "scope": "repo", "body": "user", "scanIgnore": "repo@HEAD" }
  },
  "attribution": { "trailer": "Co-Authored-By: Claude <noreply@anthropic.com>", "source": "default" },
  "scan": {
    "hits": [{ "path": "src/b.js", "line": 14, "pattern": "github-token" }],
    "skipped": [{ "path": "assets/big.json", "reason": "added content over 1 MB" }],
    "scanIgnoreChanged": false
  },
  "signing": { "enabled": true, "format": "openpgp", "ready": true },
  "env": { "node": "22.11.0", "git": "2.47.1", "guard": "active" },
  "recentSubjects": ["feat: add stage subcommand"],
  "warnings": ["unknown config key 'foo' ignored"]
}
```

- `planId`, `runDir`: random ID and the absolute path of its run folder. Both `null` on a
  clean tree and with `modeChoice` (exit 0, no lock); set whenever `--reword` succeeds.
  Refusals (`state`, `signing`, `pushed`, `staged-hit`, `lock`) take no lock and carry the
  failure shape plus `reply`.
- The unit IDs, the `id → hash` map and the scan map are stored, not printed; `plan --hunks`
  emits the IDs and refuses if its diff differs (Q9, Q10).
- `clean`: `true` when no tracked change and no candidate is left. Hidden-only or
  collapsed-only untracked files, staged-new paths in `stagedExcluded`, and
  `dirtySubmodules` are clean; `plan` still reports them, and the index is left as it is.
- `stagedExcluded`: staged-new paths (added in the real index relative to HEAD, Q11) that
  the [hidden or collapse rule](#untracked-files) excludes. Never planned or scanned; `check`
  adds them to `notIncluded` ("`.env.local` was staged but is hidden — commit by hand;
  committing this plan unstages it"). In `split` mode `commit` resets the real index, so
  they end up untracked. In `staged` mode only the hidden rule applies, and a hidden
  staged-new path refuses the run with `staged-hit` (Q10), so a success output always has
  `[]`; `[]` in `reword` mode.
- `dirtySubmodules`: submodules whose own working tree has changes (edits or untracked
  files) but whose pointer did not change. Not units; `check` adds them to `notIncluded`
  ("libs/x has uncommitted changes inside — commit inside the submodule first"). A
  submodule with a pointer change is a unit whatever its dirt (Q11).
- `mode`: `split`, `staged`, `reword` (`--reword`). Without a flag `plan` never picks
  `staged`: index empty → `split`; index holds every change → `split`; index plus other
  changes (unstaged tracked changes or candidates) → `mode: null`, no `planId`, no lock, and
  a `modeChoice` handback ("3 files are staged, 5 other changes: commit only the staged
  ones, or group all changes within the task?", answers `staged` / `split`, each a
  `respawn`). The handback carries counts only, never file lists. Every `respawn` `plan` builds repeats the flags of
  the call that produced it besides its own answer (`mode`, `takeOver`; `--reword` is the
  caller's own `reword` line): a `modeChoice` under `--take-over <planId>` answers
  `mode: staged` / `mode: split` each with `takeOver: <planId>` (Q9). A worker spawned
  with `interactive: false` runs `plan --split --no-user` (or `--reword --no-user`) and
  never gets a `modeChoice`. Stored in the state file; `plan --hunks` reads it from there.
- `--no-user`: stores `interactive: false` for `check` (Q17, Q25). A `lock` refusal then
  carries a plain reply without a takeover answer.
- `--take-over <planId>`: replaces the lock held by that `planId` (from the `lock` error),
  whatever its age, and deletes that run's folder. Only through the `lock` handback's
  `respawn`, i.e. after the user said yes; that `respawn` also carries the mode flag of the
  refused call (`plan --staged` → `mode: staged`), so the takeover plans the same mode and
  cannot fall back to a `modeChoice`. Uses the same atomic rename as the automatic
  takeover of a stale lock; instead of the staleness check it requires the moved lock to
  hold the given `planId`, else it puts the lock back and refuses with `lock`, carrying the
  new holder's details and a fresh `lock` handback (Q22).
- `state.kind`: `branch`, `detached`. The refused states (merge, cherry-pick, revert, rebase,
  bisect) end `plan` with exit 6 and `error.kind: "state"` (Q21). `unborn: true` on a first
  commit.
- `status`: `A`, `M`, `D`, `R` (rename, `oldPath` set), `T`.
- `bucket`: `code`, `test`, `docs`, `ci`, `build`. Hints only.
- `preStaged`: paths with staged changes. In `staged` mode `tracked` lists only the unstaged
  changes, and `unstagedLeft` counts them. A partially staged file appears in both lists. In
  `split` mode (`--split`, or an index that holds every change), `tracked` lists every
  change against HEAD, `preStaged` is informational and `unstagedLeft` is `null`; `null` in
  `reword` too.
- `attribution`: `null` when no trailer is added. `source`: `managed`, `project-local`,
  `project`, `user`, `default`.
- `config.sources` values: `default`, `user`, `repo`, and `repo@HEAD` (only `scanIgnore`,
  read from `git show HEAD:.claude/commit.json`, Q10).
- Scan hits never carry the matched value. In `split` mode the scan runs over the diff
  against the temporary index (Q11), built in the run folder, so candidates, staged-new
  paths and tracked changes are scanned alike. A file with a `filter` attribute is scanned
  in the cleaned form the diff shows (Q10).
- `signing`: `{ "enabled": false }` when `commit.gpgsign` is not true. `format`: `openpgp`,
  `ssh`, `x509`. `ready`: `true`, `"prompt"` (GUI pinentry will ask during the commit),
  `"unknown"` (x509, or a custom `gpg.program`). A custom `gpg.ssh.program` gives
  `"prompt"`. `ready: false` never appears in a success output: `plan` refuses with exit 6
  `signing` instead (Q18).
- `env.guard`: `active` (a matching heartbeat under 15 minutes old), `not-seen` (Q23).
- Notices stored for the reply: `env.guard: "not-seen"` (Q23), `signing.ready: "prompt"`
  ("a passphrase window may have popped up during the commit", Q18), the detached-HEAD
  warning (Q21) and every entry of `warnings`. The reply of whatever output ends the
  worker's part carries them in `notices`.

## plan --hunks

Run by the worker as `plan --hunks --plan <planId>` on every respawn with `resume`
([worker input](#worker-input)); on the first spawn `plan` runs it in its own process (not
with `--dictated`). Resets `lintFailures` in the state file. Run as a separate call (only a
`resume` does that), it also sets `resumed: true`, so the next `check` in an interactive run
always asks (Q16); the in-process run inside `plan` does not. A hunk index on stdout, plus only
what the worker needs from `plan`: `runDir`, `mode`, `config.values` without `scanIgnore`,
`recentSubjects` and counts. No file lists (`tracked`, `untracked`, `stagedExcluded`): the
index covers every unit. The bodies go to `hunks.txt` in the [run folder](#run-folder):

```json
{
  "version": 1,
  "ok": true,
  "runDir": "C:/Users/<you>/repo/.commit-plan/3f9a1c…",
  "mode": "split",
  "config": { "types": ["feat", "fix"], "scope": "forbidden", "body": "forbidden",
              "maxSubjectLength": 72, "subjectCase": "lower" },
  "recentSubjects": ["feat: add stage subcommand"],
  "counts": { "units": 14, "files": 6 },
  "hunksFile": "C:/Users/<you>/repo/.commit-plan/3f9a1c…/hunks.txt",
  "hunks": [
    { "id": "h1", "path": "src/b.js", "oldPath": null, "status": "M", "kind": "text",
      "range": "-10,4 +10,6", "lines": 7, "offset": 1, "body": "file" },
    { "id": "h12", "path": "tests/z.test.js", "oldPath": null, "status": "M", "kind": "text",
      "range": "-40,3 +40,9", "lines": null, "offset": null, "body": "cap",
      "added": 6, "deleted": 0 }
  ],
  "summaryOnly": [
    { "id": "h7", "path": "package-lock.json", "reason": "lockfile", "added": 812, "deleted": 640 }
  ]
}
```

`hunks.txt`, raw text (no escaping), one block per hunk with a body, in index order:

```
### h1 M text -10,4 +10,6 src/b.js
@@ -10,4 +10,6 @@
 context
-old
+new
+new2
 context
```

- The `###` line is for orientation only: `### <id> <status> <kind> <range> <path>`, with
  `<old> -> <new>` for a rename. The index is authoritative. `offset` is the 1-based line of
  the `###` line and `lines` the block's line count including it, so the worker can
  `Read` one hunk with `offset` / `limit`, or the whole file in pages. Both are `null` for
  a unit without a block (below).
- `body`: `file` (block in `hunks.txt`), `cap` (past the [cap](#summary-only-files): no
  block, but its own ID, range and `added` / `deleted` counts, so the worker can still
  split the file by ranges or `Read` the working-tree file at a range), `none` (binary,
  submodule, summary-only, and every unit with a pattern hit).
- Stdout budget: 20 000 characters for the whole output. When it would be exceeded, the
  full index is written to `hunks.json` (one entry per line) and stdout keeps everything
  else, with the absolute `"hunksIndexFile"` in place of `hunks` and `summaryOnly`.
- Failure: the usual failure shape with `reply`. The worker then writes nothing and
  returns the reply ([worker input](#worker-input)).
- Refuses (exit 6, `lock`) unless the run lock holds this `planId`. Takes no lock itself.
  Refuses with `head-moved` when HEAD differs from the state file.
- What is diffed depends on the state file's `mode`: `split` the worktree against HEAD
  through the temporary index (Q11: real index copied, reset to HEAD, the candidate and
  staged-new lists **stored by `plan`** added with `git add -N`; never recomputed), so a
  new file, staged or not, is an `A` hunk and a plain `mv` or a `git mv` an `R` unit;
  `staged` the index only; `reword` HEAD's own diff against its single parent, or against
  the empty tree for a root commit (merge commits are refused by `plan --reword`; its IDs
  are never staged); `reword` also returns the old message as `oldMessage`. A stored path
  missing from the working tree is not added to the temporary index; the hash match below
  decides.
- Scan map, written by `plan` (Q10): every scan hit and skipped file mapped to the unit that
  holds it (`"scanned": { "h4": ["github-token"], "h9": "skipped" }`), with the unit that
  changes `scanIgnore` (`"scanIgnoreUnit": "h2"`). The hunk index carries the same as
  `"scan": ["github-token"]` or `"scan": "skipped"` per entry, so the worker can put a hit
  in `notIncluded` on the first try.
- Every run for a `planId`, the first one included (then every respawn for `edit` or
  `one`): re-diffs
  and compares with the `id → hash` map `plan` stored. The same hash set → `plan`'s IDs are
  emitted; any difference → exit 6 `diff-changed`, map unchanged. `plan --hunks` never
  writes the map or the scan map.
- `id`: opaque, `h1…hN`, minted by `plan`, valid only for this `planId`. A whole-file unit
  (Q11: new, deleted, binary, renamed, summary-only, mode change, symlink, submodule
  pointer, a file with a `filter` attribute) has exactly one hunk covering the whole file.
- `kind`: `text`, `binary`, `mode` (mode change, with or without content), `symlink`,
  `submodule` (a pointer change only; dirt inside the submodule is ignored by the pinned
  `--ignore-submodules=dirty` and reported in `plan.dirtySubmodules`), `filtered` (a
  `filter` attribute: whole file, body = the cleaned diff, `body: "none"` when that is
  binary; staged with `git add`).
- The unit's `hash` (see [commit](#commit-release)) is kept in the state file, not printed.
- Body in `hunks.txt`: the hunk text as produced by the pinned diff options (Q11); no block
  for binary, submodule and summary-only files, or past the cap (`body: "cap"`). No block
  either for a unit with a pattern hit (`body: "none"`, `"scan": ["github-token"]`): it
  goes to `notIncluded` whatever it holds, so the secret never reaches `hunks.txt` or the
  worker's context (Q10). A whole-file unit with a hit (a new file) loses its whole body;
  the other hunks of a tracked file keep theirs. A new
  file's body is its whole content as `+` lines. `Read` cuts lines over 2000 characters;
  accepted (Q19).
- `summaryOnly[].reason`: `lockfile`, `minified`, `sourcemap`, `generated`, `lines`, `size`.

## Worker input

The Agent prompt that spawns `commit:commit-worker`: `key: value` lines, one per field, every field
optional. `intent`, `interactive` and `reword` and their meaning are public surface (Q25); a
workflow skill spawns the worker with them. `mode`, `takeOver`, `resume` and `edit` are
internal: respawn-only, do not write by hand. They appear only in a handback's `respawn`
and may change in a minor release.

```
intent: Added the stage subcommand and documented it.
interactive: false
```

| Field | Surface | Values | Meaning |
| --- | --- | --- | --- |
| `intent` | public | one to three sentences | what was changed and why; absent when the caller does not know it or the user asked for every change (a bare `/commit`, Q2), the worker then infers it from the diff. `/commit <text>` passes the text as the intent. Also scopes a `split` run (Q16): a unit the intent clearly does not cover goes to `notIncluded` with the reason "not part of the intent"; without `intent` every change is planned. A caller whose user wants every change committed says so here, or omits the field |
| `interactive` | public | `true` (default), `false` | `false`: the caller cannot ask a user (Q17); the worker runs `plan --split --no-user` or `plan --reword --no-user` |
| `reword` | public | `true`, or the dictated text | reword the last commit (Q20); with text, the worker runs `plan --reword --dictated` (no hunk index) and writes the text as `"source": "user"` worker plan. Ignored with `resume` (the mode comes from the state file) |
| `mode` | respawn-only | `staged`, `split` | from a `modeChoice` answer, or repeated from the refused call in a `lock` handback's `respawn` |
| `takeOver` | respawn-only | a `planId` | from a `lock` handback's `take over`, or repeated in a `modeChoice` produced under `--take-over`; the worker runs `plan --take-over <planId>` with the `mode` flag if one is given |
| `resume` | respawn-only | a `planId` | from a `confirm` or `lintFailed` handback's `respawn`; the worker skips `plan` and starts at `plan --hunks --plan <planId>`, which marks the run `resumed`, so its next `check` always asks (Q16) |
| `edit` | respawn-only | free text, or `one` | with `resume`: the user's instruction; `one` means "single group, all included files" (Q16). Applies to the plan in `plan.groups.json` |

Handback `respawn` values are prompts built by the script. Each holds the answer's own
fields plus the flags of the `plan` call that built it (`mode`, `takeOver`; Q9). The caller
passes them verbatim, inserting the user's text for `edit` where the handback says, and adds
the `intent` and `reword` lines of its first spawn (the script never sees them), plus
`interactive: false` when it cannot ask ([Reply and handback](#reply-and-handback)). The
agent type is
`commit:commit-worker` (namespaced by the plugin). The worker's prompt names the script as
`${CLAUDE_PLUGIN_ROOT}/scripts/commit.js`, substituted by the plugin loader; the variable is
not in the worker's shell (Q25, spike). Its tools are `Bash, PowerShell, Read, Write`: it
runs each script call with whichever shell tool it has, since every call is one
`node "<script>" …` command that runs the same in both (Q24).

The worker's steps:

1. Unless `resume`: `plan` with the flags the fields give (`--dictated` for a dictated
   reword); if the output has `reply`, return it. Otherwise its `hunks` is the
   `plan --hunks` output (`null` with `--dictated`).
2. With `resume` only: `plan --hunks --plan <planId>`; on failure return its `reply`.
3. Read `hunks.txt` (with `resume`, only when `edit` changes the grouping; a message-only
   `edit` works from `plan.groups.json` alone) and write `<runDir>/plan.groups.json` with
   `Write`. With `resume`, `Read` `plan.groups.json` before writing it, also on a `retry`
   whose errors are already in the `edit` text: the `Write` tool refuses to overwrite a
   file the agent has not read, and the refusal costs a turn. In `split`, apply the
   intent scope (Q16) when grouping. A dictated reword writes the `"source": "user"` output
   instead. After an
   `edit`, `source` stays `user` only when the worker writes the user's words unchanged.
4. `check --plan <planId> --commit`. On a lint failure without a `reply` (exit 2), fix
   `plan.groups.json` from `errors` and run `check --commit` once more. Return the `reply`.
   A lint failure of `"source": "user"` text always carries a `reply`, so the worker never
   rewrites dictated text on its own (Q20). Never run a handback's commands: the guard
   denies a script call to `commit` or `release` from the worker (Q25).

The worker's final report is the `reply` JSON, verbatim and nothing else: its last message
in the notification delivery shape, the `message` of its `SubagentHandback` call in the
other (Q25). When a script
call fails without output it can parse, it returns
`{ "status": "failed", "planId": <the planId if known>, "text": "<what happened>" }`; the
lock is then left to Q22 (takeover question on the next run). A `Write` after a failed
script call never happens, so a deleted run folder is not re-created.

## Worker plan

The content of `plan.groups.json` in the [run folder](#run-folder):

```json
{
  "version": 1,
  "source": "worker",
  "groups": [
    {
      "header": "feat: add stage subcommand",
      "body": null,
      "files": [],
      "hunks": ["h1", "h4", "h9"],
      "reason": "stage subcommand and its docs"
    }
  ],
  "notIncluded": [
    { "path": "src/b.js", "hunks": ["h5"], "reason": "scan: src/b.js:14 github-token" }
  ]
}
```

- `source`: `worker` (default when absent; the worker's own message) or `user` (dictated
  reword text). Decides the attribution in `reword` (Q20).
- File-level slice: `files` holds whole paths (tracked or untracked) and `hunks` is empty.
  A rename (`R`) is named by its **new** path, in `files` and `notIncluded` alike; `check`
  rejects the old path ("use the new path src/b.js for the rename of src/a.js").
  Hunk-level slice: `hunks` only; a new file is referenced by its single hunk ID.
- `notIncluded[].hunks`: `null` for the whole path (always in the file-level slice), or the
  IDs of single hunks that stay out. Collapsed directories, hidden files,
  `stagedExcluded` paths and `dirtySubmodules` are not units; the worker does not list
  them, `check` adds collapsed directories, `stagedExcluded` paths and `dirtySubmodules` to
  its report.
- `notIncluded[].reason` for a unit outside the `intent` (`split` with an `intent`, Q16):
  "not part of the intent". Not a trigger; the unit stays in the working tree.
- `body`: string, may end in a footer paragraph with allowed tokens only, or `null`.
- `staged` and `reword` modes: exactly one group; `files`, `hunks` and `notIncluded` are
  ignored, and the group holds every unit.
- The worker does not write `confirm`; `check` computes it.
- A reword with dictated text (`reword: <text>` in the [worker input](#worker-input)): the
  worker writes `{ "version": 1, "source": "user", "groups": [{ "header": "…", "body": … }],
  "notIncluded": [] }`, splitting the text at its first blank line, and runs `check`.

## check

`check --plan <planId> [--commit]`. Reads `plan.groups.json` from the
[run folder](#run-folder). Without `--commit` it commits and stages nothing. With
`--commit` (the worker always passes it):

- `confirm` is `null` → it goes straight on as [`commit --all`](#commit-release) in the
  same process, and its output is `commit --all`'s, `groups` added.
- `confirm` is set and the run is interactive → nothing is committed; the output carries a
  `confirm` handback ([Reply and handback](#reply-and-handback)). The lock stays.
- `confirm` is set, `interactive: false`, not `humanOnly` → commits as with `null`: the
  worker's own grouping is confirmed by nobody else (Q17).
- `confirm` is set, `interactive: false`, `humanOnly` → nothing is committed; `check`
  releases the lock and deletes the run folder, and the reply carries a `handedBack`
  handback (information only).

```json
{
  "version": 1,
  "ok": true,
  "groups": [
    { "n": 1, "header": "feat: add stage subcommand", "body": null, "fileCount": 2,
      "files": [
        { "path": "src/stage.js", "status": "M", "new": false, "hunks": 3 },
        { "path": "docs/new.md", "status": "A", "new": true, "hunks": 1 }
      ],
      "newFiles": ["docs/new.md"] },
    { "n": 2, "header": "chore: regenerate asset data", "body": null, "fileCount": 1,
      "files": [
        { "path": "assets/big.json", "status": "M", "new": false, "hunks": 1 }
      ],
      "newFiles": [] }
  ],
  "notIncluded": [
    { "path": "src/b.js", "hunks": ["h5"], "reason": "scan: src/b.js:14 github-token" },
    { "path": "dist", "hunks": null, "reason": "412 untracked files in dist/ — add to .gitignore or commit by hand" },
    { "path": ".env.local", "hunks": null, "reason": ".env.local was staged but is hidden — commit by hand; committing this plan unstages it" },
    { "path": "libs/x", "hunks": null, "reason": "libs/x has uncommitted changes inside — commit inside the submodule first" }
  ],
  "notices": ["src/b.js:14 github-token left out"],
  "confirm": { "reasons": ["2 groups", "new file docs/new.md", "skipped file assets/big.json"], "humanOnly": true }
}
```

Lint failure (exit 2):

```json
{ "version": 1, "ok": false, "error": { "kind": "lint", "message": "2 errors" },
  "errors": [{ "group": 1, "reason": "type 'Feat' not in types" },
             { "group": null, "reason": "h7 (src/c.js) not placed; put it in a group or in notIncluded" }] }
```

- Refuses (exit 6, `lock`) unless the run lock holds this `planId`; refreshes `touched`.
- Refuses (exit 1, `usage`) once any stored group is `committed: true`: a re-plan after a
  partial commit would renumber groups over units already in HEAD.
- Lint failure: increments `lintFailures`. The first failure since the last
  `plan --hunks` carries no `reply`; the worker fixes `plan.groups.json` and runs `check`
  again. The second carries a `reply`, and so does the first when `plan.groups.json` has
  `"source": "user"`: the worker must not rewrite dictated text unseen (Q20). Interactive,
  a `lintFailed` handback (rejected messages and errors in `text`; options `retry` and
  `no`, `edit` through Other, [Reply and handback](#reply-and-handback), Q18); with
  `interactive: false`, `check` releases the lock and the reply is
  `status: "failed"` with the errors.
- Clears the stored groups before it validates, so a failed `check` (after `edit` or
  `one`) leaves no group that `commit` would accept.
- A missing `plan.groups.json`, or one that is not valid JSON of the shape above, is a lint
  error (`group: null`).
- Validates:
  - every group's message against the [grammar](#message-grammar), and against the
    [scan patterns](#scan-patterns) ("message contains `local-path`");
  - every hunk ID exists in the state file and is used at most once;
  - completeness (`split` only): every unit in the state file is placed exactly once, in a
    group or in `notIncluded` (by ID, or by a `hunks: null` path entry). In `staged` and
    `reword` the single group holds every unit implicitly;
  - identical hunks (same path, same `-` / `+` lines) have the same placement: all in one
    group, or all in `notIncluded` ("h3 and h5 are identical; place them together");
  - `files` and `hunks` are not mixed; every path in `files` and `notIncluded` is a real
    change; a rename is named by its new path only;
  - no collapsed directory, no `dirtySubmodules` path and no unit with a scan hit is in a
    group ("h4 has scan hit `github-token`; move it to notIncluded");
  - `staged` and `reword`: exactly one group. `split`: zero groups is valid.
- `errors`: `group` is the group number, or `null` for a run-wide error. Any error → exit 2.
- `groups[].files`: every path in the group, `hunks` = the number of the path's hunks in
  this group (`null` in the file-level slice). The confirmation shows at most 20 per group,
  then "+N more".
- `newFiles`: derived from status `A` or untracked, never from the worker. `split`:
  temporary-index diff (Q11); `staged`: index diff, for the report only; `reword`: always
  `[]`.
- `notIncluded`: the worker's entries plus every collapsed directory, every
  `stagedExcluded` path or directory and every `dirtySubmodules` path (`split` only).
  Unstaging note (`split`, at least one group): a `stagedExcluded` entry, and a worker
  entry for a staged-new unit, gets "committing this plan unstages it", plus "and
  .gitignore then hides it from `git status`" when the stored staged-new list marks it
  `ignored`. The reset happens in `commit`, so the note describes what `yes` will do;
  with zero groups, or after `no`, the index is untouched and there is no note.
- `notices`: pattern hits that were left out (Q10), and (`split`, at least one group) one
  line per `indexOnly` path: "x: the staged version differs from your working tree;
  committing this plan discards it — recover with `git cat-file -p <blob>`" (Q11). Never a
  confirmation trigger.
- `confirm`: `null` when no [trigger](#confirmation-triggers) for the mode applies. In an
  interactive run marked `resumed` (a respawn after `edit`, `one` or `retry`), `confirm` is
  always set, with the reason `edited plan`, in every mode: the user was reviewing this run
  and sees the result before anything is committed (Q16). The
  `confirm` handback's `text` is the one confirmation block (Q16), built from this output.
- On success the state file stores, per group: `n`, the resolved units (hunk IDs, or in the
  file-level slice the paths resolved to units by `check` itself), the normalised message,
  `attribution: true|false` (Q20), and `committed: false`. The group count drives the lock
  release (Q22). A later successful `check` in the same run (after `edit` or `one`) stores
  its own groups; a failed one leaves none.
- Zero groups: `ok: true`, `groups: []`, `confirm: null`; `check` releases the lock and
  deletes the run folder itself; `reply.status: "nothing"` with the reasons.

## commit, release

**commit** `--plan <planId> --all`

Commits every group not yet `committed`, in order, in one process, and stops at the first
failure (Q18). Before each group it refreshes `touched` (Q22). The call has one 540-second
budget: the first group always starts; a later group starts only while at least 480 s of
the budget are left, else the call stops cleanly with a `continue` handback whose `run` is
the same `commit --plan <planId> --all` (the committed groups are recorded, so it resumes
where it stopped). Each group runs the steps below; per group, three phases in `split`, the
real index touched only in (c):

- (a) Refusals, in this order:
  - exit 6 `lock` unless the run lock holds this `planId`; then refreshes `touched`;
  - exit 1 `usage` when `check` has not stored groups or every group is committed;
  - exit 6 `head-moved` when HEAD is not the SHA the state file expects: the one `plan`
    recorded, then the SHA of each group this run committed;
  - exit 6 `index-lock` when `index.lock` exists: `reset` and `apply` take the lock too,
    and would otherwise fail unmapped (exit 1) and could leave the index half staged.
- Units and message come from the state file; nothing is read from stdin.
- (b) Match (`split`), without touching the real index:
  - Rebuilds the temporary index (Q11) from HEAD and the candidate and staged-new lists
    **stored by `plan`** (never recomputed: after group 1's reset no path is staged-new
    any more; stored paths missing from the working tree are skipped) and recomputes the
    diff against it with the pinned options, and each unit's hash: hash of (path, the `-`
    and `+` lines without context, occurrence index among identical hunks in the same
    file). Whole-file units hash as in Q11 (old/new path, mode, symlink target, gitlink
    commit ID, blob IDs for binaries, the cleaned form for filtered files).
  - Every unit's ID is mapped to its hash through the state file and matched against the
    current hunks. A missing hash → exit 6, `diff-changed`. The message is "files changed
    since plan, run /commit again", or, when the state file has
    `treeChangedDuringCommit: n-1`, "files changed during the commit of group n-1 — a repo
    hook (lint-staged, a formatter) likely rewrote them; run /commit again".
- (c) Apply (`split`): sets `indexReset: true` in the state file, runs `git reset -q`,
  builds the patch from the current hunks (current ranges) and applies it to the real
  index with `git apply --cached --whitespace=nowarn`. Whole-file units (filtered files
  included, so git runs the filter) are staged with `git add -A -- <paths>` (both paths
  for a rename). Verify: the index diff against HEAD (pinned options) must hold exactly
  the group's hashes, else exit 6 `diff-changed` (a file changed between (b) and
  `git add`).
- `staged`: no reset, no staging. The index's hash set is recomputed and compared with the
  map; any difference (the user staged more in a terminal) → exit 6 `diff-changed`. Then
  the index is committed as-is.
- `reword`: no match, no reset, no staging, no verify, no scan.
- Then: scan the index (backstop; not in `reword`); append trailers
  ([grammar](#message-grammar)); run `git commit --cleanup=verbatim -F -` (with
  `--amend --only` in `reword`), timed out at what is left of the 540-second budget.
- Hook rewrite detection (`split`, when a later group exists): the worktree diff's hash set
  (temporary index, as above) is computed right before (`before`) and right after
  (`after`) the `git commit` call. If `after` differs from `before` minus group n's own
  hashes, the state file records `treeChangedDuringCommit: n` (Q18). Comparing `before`
  and `after` directly would always differ: the committed units leave the diff.
- After exit 4 or 5: `commit` reads HEAD. If it moved from the expected SHA, git made the
  commit anyway (a hanging `post-commit` hook, a signing prompt answered late): the output
  sets `sha` to the new HEAD and `error.message` to "committed as `<sha>`, but git did not
  exit cleanly" / "… did not exit in time". The exit code stays 4 or 5 and the run ends.
- On failure: `split` runs `git reset -q` only when this call reached (c); a refusal in
  (a) or a `diff-changed` in (b) leaves the real index as it is. `staged` and `reword`
  leave the index as it is.
- Output:

```json
{ "version": 1, "ok": true,
  "commits": [{ "n": 1, "sha": "1a2b3c4", "header": "feat: add stage subcommand" },
              { "n": 2, "sha": "5d6e7f8", "header": "chore: regenerate asset data" }],
  "failed": null, "remaining": [],
  "error": null, "gitOutput": null,
  "unstaged": [{ "path": ".env.local", "ignored": false, "blob": null },
               { "path": "build/config.js", "ignored": true, "blob": null },
               { "path": "src/x.js", "ignored": false, "blob": "9c1e4f2…" }],
  "reply": { "status": "committed", "…": "…" } }
```

- `commits`: the groups this call committed. `failed`: `null`, or the group number whose
  step failed; `error` is then that failure (the exit code is its cause's) and
  `remaining` the groups not committed. A stop on the budget is not a failure: exit 0,
  `failed: null`, `remaining` set, and a `continue` handback in `reply`.
- Exit 4 fills `gitOutput` with git's stdout and stderr verbatim. Exit 3 fills `error` and
  adds `hits`.
- `unstaged`: only in the output that ends a `split` run (last group, or any failure) and
  only when the state file has `indexReset: true`; `null` otherwise, and then the report
  says the index is untouched. It lists the paths of the state file's `preStaged` that
  still differ from HEAD, so the run's reset has unstaged them, plus every `indexOnly`
  path whether or not it differs from HEAD, with its index `blob` (`null` for the others).
  `ignored` marks one that `git status` no longer shows. The report says "your earlier
  staging was reset: …", and per `blob` "staged version discarded, recover with
  `git cat-file -p <blob>`" (Q18).
- Marks the group `committed: true` and stores its SHA as the expected HEAD. Releases the
  lock and deletes the run folder after the last group, and on every failure that ends the
  run ([CLI](#cli-and-exit-codes)).

**release** `--plan <planId>`: removes the lock and deletes the run folder if the lock holds
this `planId`; otherwise a no-op with exit 0 (the run has already ended, or was taken over
and the lock is someone else's, Q22). Output `{ "version": 1, "ok": true, "reply": {
"status": "nothing", "text": "nothing committed", … } }`; after a no-op the `text` says
"nothing to release: the run has already ended or was taken over".

## Reply and handback

Built by the script, never by an agent (Q25). The worker's final message is `reply`,
verbatim; a caller takes the first JSON object in the message, since a worker may put a
sentence in front of it (spike). A caller that runs a handback's `run` gets another output
with its own `reply`, and handles it the same way.

```json
{
  "status": "handback",
  "planId": "3f9a1c…",
  "text": "Proposed commits:
1. feat: add stage subcommand
   src/stage.js (3 hunks), docs/new.md (new)
2. chore: regenerate asset data
   assets/big.json
Not included:
- src/b.js h5: scan: src/b.js:14 github-token
Confirm: 2 groups, new file docs/new.md, skipped file assets/big.json
Notices:
- Guard hook did not run: …
- src/b.js:14 github-token left out",
  "commits": [],
  "notices": ["Guard hook did not run: …", "src/b.js:14 github-token left out"],
  "callerRule": "<the base rule> <the handback rule>",
  "handback": {
    "kind": "confirm",
    "humanOnly": true,
    "question": "Commit as proposed? To change it, type your changes under Other.",
    "answers": [
      { "label": "yes", "run": "node \"C:/Users/<you>/.claude/plugins/cache/commit/commit/0.1.0/scripts/commit.js\" commit --plan 3f9a1c… --all", "timeoutMs": 600000 },
      { "label": "edit", "respawn": "resume: 3f9a1c…
edit: {text}", "needsText": true },
      { "label": "one", "respawn": "resume: 3f9a1c…
edit: one" },
      { "label": "no", "run": "node \"…/commit.js\" release --plan 3f9a1c…", "timeoutMs": 60000 }
    ],
    "ifNoUser": { "answer": "no", "returnToParent": true }
  }
}
```

- `status`: `committed` (at least one commit, no failure), `nothing` (clean tree, zero
  groups, `no`), `handback`, `failed` (a failure, possibly after some commits: `commits`
  lists them).
- `text`: what the user reads, and the only field a caller relays. For `committed` the
  `sha subject` lines, not included, `unstaged` (Q18); for `failed` the failed group, its
  reason and the groups not committed; for `confirm` the confirmation block (Q16); for
  `lintFailed` the rejected messages and the errors. Then a
  `Notices:` block with every entry of `notices`, then
  the trailer line and the tree state (below). So a notice reaches the user on every
  status, also through a subagent that relays only `text`. Every list in `text` holds at
  most 10 entries, then "+N more": commit lines, not included, `unstaged`, lint errors,
  notices and the "N files left" paths; the confirmation block keeps its own cap of 20
  files per group. Messages are never cut: the user has to read a rejected or proposed
  message whole.
- `notices`: scan-hit notices, `indexOnly` notices and the notices `plan` stored. Kept as
  an array for tests; callers do not read it.
- `callerRule`: in **every** reply, fixed text built from two parts, each the same in every
  reply. It is the whole protocol a caller needs, whichever path spawned the worker (Q25).
  - Base rule, always: "Show text to the user verbatim; a subagent puts text verbatim in
    its final report. The reply is final: no git log or git status check."
  - Handback rule, added when `handback` is set: "If question is null, run the only
    answer. Otherwise ask question with AskUserQuestion; the answers without needsText are
    the options, and the user's own words under Other pick the needsText answer ({text} =
    those words). Run a run verbatim with its timeoutMs; its output holds a new reply:
    handle it the same way. For a respawn, spawn commit:commit-worker with it as the
    prompt, plus the intent and reword lines of your first spawn, and interactive: false
    if you cannot ask. An answer with neither
    ends the run. Without a user: take ifNoUser.answer if set; if returnToParent, return
    text verbatim to your parent. Edit no files until the final reply."
- Size (CI size tests, Q24): the `reply` without `text` ≤ 2 kB, `callerRule`, `notices`
  and `handback` included; `text` ≤ 4 kB with every list at its cap, not counting the
  messages a `confirm` block or a `lintFailed` text quotes. Fixtures at the caps: a
  `committed` reply with 11 commits, 11 not-included entries, 11 `unstaged` paths, 11 files
  left and 11 notices; a `lintFailed` with three groups with bodies and 11 errors. The rule
  texts above are part of the
  test fixtures; the prompt slice may shorten them, not drop a clause.
- `handback`: `null` unless `status` is `handback`. Every answer either has a `run`, a
  `respawn`, or neither (it ends the run). `AskUserQuestion` takes 2–4 options and adds
  "Other" itself, so each kind is shaped to fit:

  | Kind | From | `question` | Options | `needsText` (Other) | `ifNoUser` |
  | --- | --- | --- | --- | --- | --- |
  | `confirm` | `check --commit`, interactive | "Commit as proposed? To change it, type your changes under Other." | `yes` → `run commit --all`; `one` → `respawn` (`resume`), only in `split` with more than one group; `no` → `run release` | `edit` → `respawn` (`resume`) | `humanOnly`: `answer: "no"`, `returnToParent: true`; else `answer: "yes"`, `returnToParent: false` |
  | `modeChoice` | `plan` without a mode flag | the counts question (Q9) | `staged`, `split` → `respawn` (`mode`) | — | `answer: "split"` |
  | `lock` | `plan` (live lock), interactive | the takeover question (Q22) | `take over` → `respawn` (`takeOver: <planId>`); `wait` → neither | — | `answer: "wait"`, `returnToParent: true` |
  | `lintFailed` | the lint failure that ends the worker's retries, interactive (Q18) | "Lint failed. Let a new worker fix it, or stop? To dictate the message, type it under Other." | `retry` → `respawn` (`resume`, `edit: fix these lint errors: <errors>`, at most 500 characters); `no` → `run release` | `edit` → `respawn` (`resume`) | `answer: "no"`, `returnToParent: true` |
  | `handedBack` | `check --commit`, `interactive: false`, `humanOnly` | `null` | none; `text` says "nothing committed — run /commit to plan again" | — | `returnToParent: true` |
  | `continue` | `commit --all` out of budget | `null` | `continue` → `run commit --all`, run without asking | — | `answer: "continue"` |

  `humanOnly` is set on `confirm` only. A `question: null` handback is never shown with
  `AskUserQuestion`: `continue` runs its one answer, `handedBack` has none.
- `run`: a single `node "<script>" …` command with the script's own absolute path
  (`process.argv[1]`, forward slashes), so it matches the anchored allow rule (Q16).
  `timeoutMs`: 600000 for `commit`, 60000 otherwise; the caller passes it as the tool
  timeout.
- `respawn`: a [worker input](#worker-input) prompt; `{text}` marks where the user's words
  go (`needsText: true`). The script puts in it the answer's own fields and repeats the
  flags of the `plan` call that built it: `mode` and `takeOver` (Q9). A `lock` handback
  from `plan --staged` answers `take over` with `mode: staged` and `takeOver: <planId>`; a
  `modeChoice` from `plan --take-over <planId>` answers `staged` with `mode: staged` and
  `takeOver: <planId>`. It never holds `intent` or `reword`: the script never sees
  them, since they live only in the caller's first spawn. The caller adds those two lines
  of its first spawn, as given, and `interactive: false` when it cannot ask; nothing
  else. With `resume` the worker takes its mode from the state file, so a copied `reword`
  line only tells it that the run is a reword. Unit tests: each of the two respawns above,
  built from the `plan` call's `argv`.
- The worker never acts on a handback, `continue` included: the guard denies a script call
  to `commit` or `release` when `agent_type` is `commit:commit-worker` (Q25,
  [Guard](#guard)). The caller follows `callerRule` for every kind.
- `text` names the trailer the script appended (or "no trailer", with the attribution
  source) and ends with the tree state ("working tree clean", or "N files left: …"), so the
  caller needs no `git log` / `git status` call and does not add a trailer by hand (Q25).

## infer

Run by `commit-config` (Q7). Read-only, takes no lock.

```json
{
  "version": 1,
  "ok": true,
  "outcome": "proposal",
  "commitCount": 200,
  "ccShare": 0.94,
  "nonConventional": 12,
  "wouldFail": 9,
  "proposal": {
    "types":            { "value": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test", "deps"],
                          "evidence": { "deps": 0.07 } },
    "scope":            { "value": "optional", "evidence": { "withScope": 0.31 } },
    "body":             { "value": "forbidden", "evidence": { "withBody": 0.04 } },
    "subjectCase":      { "value": "lower", "evidence": { "lower": 0.97 } },
    "maxSubjectLength": { "value": 72, "evidence": { "p95": 64, "flagged": false } }
  },
  "droppedTypes": [{ "type": "wip", "count": 3 }]
}
```

- `outcome`: `proposal`; `too-few-commits` (under 20 non-merge commits; `proposal: null`,
  the skill recommends the defaults); `not-conventional` (`ccShare` under 0.5;
  `proposal: null`, the skill points to the opt-out, Q14).
- `commitCount`: non-merge commits read (at most 200). `ccShare` is over all of them; every
  `evidence` share is over the Conventional Commits ones only.
- `types.evidence`: the share of each non-standard type kept (5% or more).
- `wouldFail`: how many of the **Conventional Commits** ones among the commits read fail
  lint under the proposed config (same lint functions), so it measures the threshold loss
  (Q7) only. `nonConventional`: the commits read that are not Conventional Commits (they
  would all fail). `wouldFail` is `null` when there is no proposal.
- `maxSubjectLength.evidence.flagged`: `true` when p95 is over 100 and the value was rounded
  up to the next multiple of 10, or clamped to 200 (the key's maximum).
- `droppedTypes`: non-standard types under 5%, with counts.

## Message grammar

`check` reads the message as bytes (`plan.groups.json`), normalised first:

1. UTF-8 BOM stripped; a UTF-16 LE or BE BOM → decoded as UTF-16.
2. Invalid UTF-8 (U+FFFD after decoding) → lint error `message not UTF-8`.
3. CRLF and lone CR → LF.
4. Trailing blank lines trimmed; exactly one trailing LF.

Structure: header line, blank line, optional body, optional footer paragraph. All regexes use
the `u` flag.

- Header regex: `^([a-z][a-z0-9-]*)(\(([^()\s]+)\))?(!)?: (\S.*)$` → type, scope, breaking
  flag, description.
- `type` must be in `types`; `scope` must obey `scope`.
- `maxSubjectLength` counts the **code points** of the whole header line.
- `subjectCase: lower`: fails only when the first character of the description is an
  uppercase letter (`\p{Lu}`), unless the first word is all uppercase with at least two
  letters (`API`, `CI`). Digits, backticks, quotes and symbols pass. `infer` uses the same
  function.
- Footer paragraph: the last paragraph (not the header), where every line matches
  `^(BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)(.+)$`, or starts with whitespace and
  continues the previous footer. If any line fails, the whole paragraph is body.
- Allowed footer tokens (case-sensitive): `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`,
  `Closes`, `Fixes`. Any other token fails lint with: "`<token>` is not an allowed footer
  token. If this is body text, rephrase it or add a non-footer line to the paragraph."
- `body: forbidden`: no paragraph besides the header and a footer paragraph.
- Trailers, added by `commit` after lint, in this order after the message's own footers:
  1. `reword` only: trailers carried over from the **old** message's footer paragraph. Not
     carried: allowed tokens (the new message owns them) and any
     `Co-Authored-By: … <noreply@anthropic.com>`. Everything else (`Signed-off-by`, a human
     `Co-Authored-By`, `Change-Id`, …) is carried verbatim, in its original order.
  2. The attribution's trailer-shaped lines, when the group's `attribution` is `true`:
     always in `split` and `staged`; in `reword` when `source` is `worker` or the old
     message had a `Co-Authored-By: … <noreply@anthropic.com>` trailer (Q20).

  They go into the footer paragraph when the message ends in one, otherwise into a new
  paragraph. `git commit` runs with `--cleanup=verbatim`, so the committed message is
  exactly the one lint approved plus these trailers.

## Untracked files

Source: `git ls-files --others --exclude-standard` (gitignored files are never seen). In
`split` and `staged` mode the **staged-new** paths go through the same rules: every path the
real index adds relative to HEAD (`git diff --cached --no-renames --name-only --diff-filter=A
-z`; on an unborn HEAD every path in the real index), gitignored or not (a force-added file is
listed). In `split` they count toward the caps together with the untracked candidates, and a
staged-new path that is hidden or falls in a collapsed directory goes to `plan.stagedExcluded`
instead of `untracked`. In `staged` only the hidden rule applies: a hidden staged-new path
refuses the run with `staged-hit`; the count cap does not apply, since the set is not grouped
(Q10, Q11). `plan` runs these rules once and stores the resulting lists in the state file;
later subcommands use the stored lists (Q11).

| Category | Rule | Worker sees it |
| --- | --- | --- |
| hidden | a path segment starts with `.`, unless it is a hidden exception; `.env` and `.env.*` always, except the three templates below | no (count and 5 names in `plan`) |
| candidate | everything else, with `binary: true\|false` | yes |

Hidden exceptions: `.github/**`, `.gitignore`, `.gitattributes`, `.editorconfig`,
`.env.example`, `.env.sample`, `.env.template`, `.claude/commit.json`,
`.claude/settings.json`, `.claude/CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`,
`.claude/commands/**`, `.claude/hooks/**`. Any other path under `.claude/`, including
`settings.local.json`, is hidden.

Count cap (`split`), over candidates and staged-new paths together; a collapsed group is
reported in `untracked.collapsed` (or `stagedExcluded`) and is neither planned nor scanned:

1. A **new directory** is one that holds no path at HEAD (the tracked directories come from
   `git ls-tree -r -d --name-only HEAD`; on an unborn HEAD every directory is new). Each
   new path belongs to its topmost new ancestor directory, if any, else it is **loose**
   (its parent directory exists at HEAD).
2. More than 50 in one topmost new directory → that directory is collapsed.
3. More than 50 loose files directly at the repo root → collapsed as `"dir": "."` ("N
   untracked files at repo root"). Loose files in any other directory are never collapsed
   by this step.
4. Still more than 200 in total → collapse the largest remaining new directories until the
   total is at most 200; if loose files alone still exceed it, collapse them per parent
   directory (`"dir": "src/icons"`, its direct files only), largest first.

Ties break by path (byte-wise). Tests: `packages/new-lib/` with 60 new files next to one new
file in the tracked `packages/app/src/` → only `packages/new-lib` collapsed; 51 new files in
the tracked `db/migrations/` → none collapsed; 51 new root files → `"."`; 300 files staged
into a new `dist/` by `git add -A` → collapsed, in `stagedExcluded`; a 60-file new
directory under `--staged` → no collapse.

All globs and names match case-sensitively on every OS.

## Summary-only files

A file is summary-only when any rule matches, checked in this order:

1. `lockfile`: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`,
   `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`.
2. `minified`: `*.min.*`.
3. `sourcemap`: `*.map`.
4. `generated`: `linguist-generated` set in `.gitattributes`.
5. `lines`: over 1000 changed lines.
6. `size`: over 256 KB.
Body cap (not a summary-only rule): files are visited in path order (byte-wise over UTF-8,
ascending), summing changed lines of the files not summary-only. The first file that would
take the sum over 3000, and every file after it, get no block in `hunks.txt`; each of their
hunks keeps its own ID with `body: "cap"` ([plan --hunks](#plan---hunks), Q19).

The scan ignores summary-only status. It skips a tracked file whose added lines exceed 1 MB
and an untracked file over 1 MB; both are reported in `scan.skipped`.

## Scan patterns

Only added lines are scanned. The IDs are public surface.

| ID | Regex | Not a hit when |
| --- | --- | --- |
| `aws-access-key` | `\b(AKIA\|ASIA)[0-9A-Z]{16}\b` | the value contains `EXAMPLE` |
| `github-token` | `\b(gh[pousr]_[A-Za-z0-9]{36,}\|github_pat_[A-Za-z0-9_]{22,})\b` | — |
| `slack-token` | `\bxox[abposr]-[A-Za-z0-9-]{10,}` | — |
| `anthropic-key` | `\bsk-ant-[A-Za-z0-9_-]{20,}` | — |
| `private-key` | `-----BEGIN ([A-Z]+ )?PRIVATE KEY( BLOCK)?-----` | — |
| `connection-string` | `\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s/@]+@` | the password is `${…}`, `<…>`, `$VAR`, `%VAR%`, `***`, `password`, `pass` or `secret` |
| `generic-secret` | `(?<![A-Za-z0-9])[A-Za-z0-9_]*?(secret\|token\|passw(or)?d\|api[_-]?key\|client[_-]?secret)(?![A-Za-z0-9])\s*[:=]\s*["'][^"'\s]{12,}["']` with flags `iu` | the value has Shannon entropy below 3.5, or contains `example`, `changeme`, `dummy`, `xxx`, `${`, `<`, `process.env` or `os.environ` |
| `local-path` | `\b[a-z]:[\\/]+users[\\/]+[^\\/\s"'<>]+` (flags `iu`), `/Users/[^/\s"'<>]+`, `/home/[^/\s"'<>]+`; plus the current OS user name as a whole path segment (`[\\/]<name>[\\/]`) in any path, only when the name has 4 or more characters and is not a service user (below) | the user segment is a placeholder or service user (below), or contains a character no OS allows in a user name: `[ ] ( ) * + ? \| ^ $ { } < > %` |

`generic-secret` matches `GITHUB_TOKEN = "…"`, `DB_PASSWORD: "…"` and `STRIPE_SECRET_KEY =
"…"`: the key word may follow `_` or other name characters, but not sit inside a longer word
(`tokenizer`).

`local-path` placeholders and service users (case-insensitive): `<…>`, `{…}`, `$USER`,
`%USERNAME%`, `user`, `username`, `you`, `me`, `name`, `example`, `node`, `root`, `ubuntu`,
`admin`, `runner`, `app`, `build`, `dev`, `src`, `docker`, `jenkins`, `vagrant`, `ec2-user`,
`www-data`, `git`, `circleci`, `gitpod`, `vscode`, `codespace`, `public`, `default`. The
illegal-character rule keeps regexes such as `/Users/[^/…]` (this file) from matching
themselves.

Each ID has a positive and a negative fixture under `tests/fixtures/`; `generic-secret` has
one positive per spelling above, and `local-path` a negative for `/home/node/app` and for
this file's regex table.

## scanIgnore globs

Hand-written matcher (zero deps). Patterns are matched against the repo-relative path with
forward slashes, case-sensitively on every OS, and must match the whole path.

| Syntax | Meaning | Example | Matches | Does not match |
| --- | --- | --- | --- | --- |
| `*` | any characters except `/`, including none | `tests/*.json` | `tests/a.json` | `tests/x/a.json` |
| `?` | exactly one character except `/` | `a?.txt` | `ab.txt` | `a/.txt`, `a.txt` |
| `**` | zero or more whole segments; only as a whole segment | `tests/**/key.pem` | `tests/key.pem`, `tests/a/b/key.pem` | `testskey.pem` |
| trailing `/` | everything under that directory, same as `dir/**` | `tests/fixtures/` | `tests/fixtures/a/b.txt` | `tests/fixtures` (a file) |
| leading `/` | stripped; patterns are always relative to the repo root | `/docs/*.md` | `docs/a.md` | `x/docs/a.md` |
| anything else | literal | `a+b.txt` | `a+b.txt` | — |

Config error (Q6): `**` inside a segment (`a**b`), braces `{…}`, classes `[…]`, a leading
`!`, a `\`, an empty pattern, or a `..` segment. Every row, and every error, has a fixture.

## Confirmation triggers

`check` sets `confirm` when any trigger for the run's mode holds:

| Trigger | `split` | `staged` | `reword` |
| --- | --- | --- | --- |
| more than one group | yes | — (one group) | — (one group) |
| a new file (status `A` or untracked) in any group | yes | no | — |
| an **included** skipped file or unit that changes `scanIgnore` → `humanOnly: true` | yes | yes (the whole set is included) | — (no scan) |
| the run is `resumed` (a respawn after `edit`, `one` or `retry`), interactive only | yes | yes | yes |

A pattern hit is never a trigger: `check` keeps its unit out of every group, and `plan`
refuses a staged set with one (`staged-hit`); it shows up in `notices`. A binary new file
only changes the reason text (`new binary file logo.png`).

What each scan item does is fixed in [Q10](decisions.md#q10-secret-and-local-path-scan).

## Guard

**Input:** the `PreToolUse` hook JSON on stdin. Decision inputs: `tool_name` (`Bash`,
`PowerShell`), `tool_input.command`, `cwd`, and `agent_type` (the worker-only rule below).
`agent_id` is for the debug log only.

**Script call:** a segment (parsing step 2) whose first command token, optionally after the
`&` call operator, has the basename `node` or `node.exe`, whose next token has the basename
`commit.js`, and whose token after that is the subcommand (`plan`, `check`, `commit`,
`release`, `infer`). Tokens are compared after the shell's quote removal, so the quoted form
every handback and worker uses (`node "C:/…/commit.js" plan`, Q16) matches like the unquoted
one. Substring matches on the raw command (`commit.js plan`) are not used: the quoted form
never contains them. Fixtures: quoted and unquoted, Bash and PowerShell, `& node …`,
`node.exe` at an absolute path, `cd sub && node …`, and `echo "node commit.js plan"` (not a
script call).

**Output:** exit 0 always.

- Deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<message>"}}`
- Otherwise: no output. The guard never returns `allow`.
- Crash or unreadable input: no output (fail open); a stderr line when `COMMIT_GUARD_DEBUG=1`.
- Heartbeat: when any segment is a script call with subcommand `plan` (below), write
  `<os.homedir()>/.claude/commit-guard/heartbeat.json` =
  `{ "ts": <ms>, "cwd": "<raw cwd>", "command": "<command>" }` before deciding (Q23). `plan`
  counts it when `ts` is under 15 minutes old; it normalises both paths (realpath, `\` →
  `/`, case-folded on Windows and macOS) and counts a match when the hook's `cwd` is inside
  its git toplevel or the toplevel is inside the hook's `cwd`.

**Parsing:**

1. Early exit (no output) when the command does not contain `commit`.
2. Tokenise with the quoting rules of `tool_name`, then split into segments on `&&`, `||`,
   `;`, `|`, `&` and newlines outside quotes:

   | Rule | `Bash` | `PowerShell` |
   | --- | --- | --- |
   | escape character | `\` (outside `'…'`) | `` ` `` (outside `'…'`) |
   | single quotes | literal, no escapes | literal; `''` is one `'` |
   | double quotes | `\"`, `\\`, `\$` escaped | `` `" `` and `""` escaped |
   | here-strings | — (heredoc bodies are not commands) | `@'…'@`, `@"…"@`: one token, from the opening line to a closing `'@` / `"@` at column 0 |

   Fixtures for both, among them `git commit -m "a\"b"` (Bash), ``git commit -m "a`"b"``
   (PowerShell), and a here-string containing `git commit` piped into another command (not
   a commit).
3. In each segment, find a token whose basename is `git` or `git.exe` (optionally after the
   `&` call operator).
4. Skip git global options: `-C <path>`, `-c <k=v>`, `--git-dir[=]<p>`, `--work-tree[=]<p>`,
   `--namespace[=]<n>`, `--no-pager`, `-P`, `-p`, `--paginate`, `--bare`, `--no-replace-objects`,
   `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`,
   `--no-optional-locks`. An unknown option starting with `-` followed later by a `commit`
   token → deny. `-c` and `--config-env` are skipped for other subcommands but remembered:
   if the subcommand is `commit`, deny.
5. If the next token is `commit`, expand its args (`-am` → `-a -m`, `-mfoo` → `-m foo`,
   `--opt=v` → `--opt v`) and apply the allowlist
   ([Q4](decisions.md#q4-hook-allowlist-no-env-switch)).

**Deny messages:** `<route>` stands for `Spawn the commit:commit-worker agent (pass intent:
<what you changed and why>). Edit no files until it replies.` It never names `/commit`: the
reason goes to the model, which cannot invoke `/commit` (`disable-model-invocation`, Q2), and
a `Skill("commit")` call could resolve to a personal commit skill (Q8). Every message
that contains `<route>` ends with the fixed line `If a personal commit skill sent you here,
remove it (see the commit plugin README).` (Q8; nothing is detected).

Worker-only rule: when `agent_type` is `commit:commit-worker` and any segment is a script
call with subcommand `commit` or `release`, deny with `The handback is for your caller:
return the reply verbatim and stop.` (Q25). Everything else the worker runs is left to the
normal rules.

| Case | Message |
| --- | --- |
| bare commit, `-m`, `-F`, `--message`, `--file` | `Direct git commit is blocked. <route>` |
| `--amend` without `--no-edit` | `To reword the last commit: <route> Ask it to reword. To add changes, make a new commit the same way.` |
| `--squash` without `--no-edit` | `git commit --squash opens an editor. <route>` |
| `-n`, `--no-verify`, `--no-gpg-sign` | `<flag> is not allowed. Fix the hook or signing setup instead.` |
| `--fixup=amend:` / `--fixup=reword:` | `--fixup=<kind>: opens an editor. Use plain --fixup=<commit>, or: <route>` |
| any other flag or argument | `git commit <flag> is not allowed here. <route>` |
| `-c` / `--config-env` before `commit` | `git -c … commit is not allowed. <route>` |
| `-C` / `--reuse-message` | `git commit <flag> is not allowed here. <route>` (the generic row) |
| unknown global option | `Could not parse git options before 'commit'. <route>` |
