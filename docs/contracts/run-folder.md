# Run folder

`<toplevel>/.commit-plan/`; per worktree. Before creating it the first time, the script
appends a `/.commit-plan/` line to `$(git rev-parse --git-common-dir)/info/exclude` (once;
Node writes it). Not under `.git`: the harness treats every `.git` path as a sensitive
file, so the worker's `Write` would ask on every run (Q9, spike).

Before its first write the script `lstat`s `<toplevel>/.commit-plan`: a symlink, a
junction, a non-directory, or a path tracked in the index refuses `plan` with exit 6
`state` (`run-folder`: "`.commit-plan` is tracked or not a plain directory; remove it by
hand"); after `mkdir` it checks again (Q22).

`planId` is `crypto.randomUUID()` output. Every `planId` the script reads (`--plan`,
`--take-over`, a lock's content) must be exactly that form (lowercase UUID v4): a malformed
flag value is exit 1 `usage`, and a lock with a malformed `planId` counts as unparseable
(never taken over by `--take-over`). Every folder or file the script deletes is resolved
and checked to lie strictly inside `<toplevel>/.commit-plan/` (no `..`, not absolute, not
the directory itself).

`plan` and `plan --hunks` print the folder as `runDir`: absolute, resolved with
`path.resolve` from the toplevel, forward slashes (`C:/Users/<you>/repo/.commit-plan/3f9a1c…`).
Every file path in their output (`hunksFile`, `hunksIndexFile`) is
absolute in the same form, because `Read` and `Write` need absolute paths.

| Path | Written by | Content |
| --- | --- | --- |
| `lock` | `plan` | `{ planId, created }`, written once to a temporary file in `.commit-plan/` and linked into place with a hard link (`linkSync`), which fails when a lock exists, so no reader sees a lock without its content: `EEXIST` → the normal held-lock handling (`lock`, `held`); on Windows an `EPERM` or `EBUSY` is retried a few times over about a second, like the `state.json` rename below, and one still failing after the retries falls back to a hard-link probe (a temporary file hard-linked once more in `.commit-plan/`): the probe succeeds → `lock` (`busy`, another process genuinely has the file in use), the probe fails → exit 6 `state` (`run-folder`, "the run folder's filesystem does not support hard links"); `ENOTSUP` or `ENOSYS` → `run-folder` at once, without a probe; its mtime is `touched`, refreshed with `utimes` (Q22) |
| `<planId>/call.lock` | every call with `--plan` (`release` only after reading a lock that holds its `planId`), and `plan --take-over` | `{ pid, host }` (`process.pid`, `os.hostname()`); created exclusively when the call starts, removed when it ends; while a live one exists a second call on the same run is refused with `lock` (`busy`), so two calls never share the temporary index. Stale, and replaced with the lock's atomic takeover (rename to a private name, verify, put back on a mismatch): at once when `host` is this host and `process.kill(pid, 0)` fails with `ESRCH` (a killed call); otherwise (another host, unreadable content, a pid that answers or `EPERM`) when older than 15 minutes by mtime (Q22). The `call.lock` that `plan --take-over` creates during its `acquire` belongs to the **old** run's `planId` (inside the folder about to be deleted), not the new run's; a late `ENOENT` on it (the old run ended or was cleaned up concurrently) maps to the `taken-over` lock code, not `internal` |
| `<planId>/state.json` | `plan`, `plan --hunks`, `check`, `commit` | `version` (the plugin build's state format), mode, `interactive` (`false` with `--no-user`), expected `head`, the index fingerprint (a hash of `git ls-files --stage -z`, updated after each of the run's own commits and unstages, [commit](commit-release.md)), `preStaged`, candidate list, staged-new list (each path with `ignored`), `indexOnly` (path, index blob ID, `ignored`), collapsed directories, `stagedExcluded`, `dirtySubmodules`, the unit table (per unit: ID, hash, path, old path, status, kind, identity key, summary-only flag) with the `id → hash` map and scan map, the effective config values and the source patterns of the `scanIgnore` matchers read at HEAD, the attribution trailer text and source, `recentSubjects`, `oldMessage` (`reword` only), the paths that are not UTF-8 (each non-UTF-8 byte written as `\xNN`), `notices` for the reply (all by `plan`), `lintFailures` (reset by `plan --hunks`), `resumed` (set by a separate `plan --hunks` call, Q16), validated groups, `awaitingConfirm` (set by `check` with a `confirm` handback, cleared by `check` and by `commit`'s first group), `indexReset`, `treeChangedDuringCommit` |
| `<planId>/plan.json` | `plan` | the full `plan` output ([plan](plan.md)); one entry per line. Always written when the folder is kept, after the lock is taken, to a temporary name and renamed into place like `state.json`; not read by the worker |
| `<planId>/hunks.txt` | `plan --hunks` | hunk bodies, see [plan --hunks](plan-hunks.md) |
| `<planId>/hunks.json` | `plan --hunks` | the full hunk index when stdout would exceed the budget; one entry per line |
| `<planId>/git-index` | `plan` (`split` scan), `plan --hunks`, `commit` | temporary index (Q11) |
| `<planId>/plan.groups.json` | the worker (`Write`), also for a dictated reword | [worker plan](worker-plan.md) |

- Stored, not recomputed (Q9): everything a later call needs is in `state.json`, written by
  `plan`. `plan --hunks`, `check` and `commit` read the stored facts (config values,
  recompiled `scanIgnore` matchers, attribution, unit table, lists) and never re-read a
  config layer, the Claude settings or the history, so they see exactly what `plan` scanned.
- Versioned (Q16): every write of `state.json` goes to a temporary name and is renamed into
  place; on Windows a rename that fails with `EPERM` or `EBUSY` is retried a few times over
  about a second before it counts as a failure. Every later call checks the `version`
  before it trusts the state; a `version` other than this build's (a run started by
  another plugin build) is refused with exit 6 `lock` (`ended`), as a run that has already
  ended.
  The run folder is writable without a prompt under the README `Edit` rule; a tamper
  digest is deferred past 0.1.0 (an accepted gap).
- Created by `plan` after the pre-folder refusals (`env`, `config`, `state`, and with
  `--reword` unborn, merge-commit and `pushed`; [plan](plan.md) steps), before the scan:
  `plan` mints the `planId` first, because the `split` scan builds the temporary index in
  the folder. No
  outcome without a lock leaves a folder: the refusals above come before it exists, and
  the rest (`clean`, `modeChoice`, `staged-empty`, `staged-hit`, `signing`, `lock`,
  `git-failed`, `timeout`, a `run-folder` lock link, and a `head-moved` or `index-changed`
  after the lock) delete it before `plan` exits; after a takeover at [`plan`](plan.md)
  step 3 they (and `killed-leftover`) release the lock and delete the folder. Two
  concurrent `plan`s both build; the one that loses the exclusive create of `lock` gets
  `lock` and deletes its folder.
- Deleted with the lock: by `commit` or `check` after the last group or on
  failure (unless the failed group's unstage did not happen, below), by `check` on zero groups or on a lint failure that ends the worker's part with
  `--no-user`, by `check` on a `humanOnly` confirmation with `--no-user`, by `release`, and by
  a takeover, automatic or `--take-over` (the old run's folder, after the index-repair
  check below, [Q22](../decisions/q22-concurrent-runs.md)).
- Only the script creates the folder. A worker whose script call failed writes nothing
  ([worker input](worker-input.md)), so its `Write` never re-creates a deleted folder.
- A takeover (automatic or `--take-over`), at [`plan`](plan.md) step 3, of a run whose state has
  `indexReset` set and a group not `committed` (a call killed mid-staging runs no cleanup; a
failed call whose unstage did not happen keeps its run, below):
  after `acquire` has moved the lock and before the new run's own inventory / mode-decision
  step (step 4) runs, it compares the index with HEAD. The takeover runs in three steps:
  `acquire` moves the lock (rename, verify, link its own lock) and reads the facts the check
  needs from the taken-over run's `state.json` (the killed group's paths below, `indexReset`,
  the current group's status), leaving that run's folder and the renamed lock file in place;
  the check below; then the taken-over run's folder and the renamed lock file are deleted.
  The same three steps run when the check does not apply (no `indexReset`, or the group
  committed), with nothing to check in between.
  - **The killed group's paths**, defined once here (cited elsewhere, never redefined): the
    current group's unit paths, taken from the stored validated groups (both halves of a
    rename included), union the stored `preStaged` list, union the stored `indexOnly` list.
  - Nothing staged (the index equals HEAD, e.g. a kill in phase (a) of a group after an
    earlier group committed) → no reset and no reset notice; the new run's reply still
    carries the `unstaged` notice (Q18).
  - Some path staged, and every staged path belongs to the killed group's paths → `git reset -q`; the takeover
    notice says the killed group's partial staging was reset. This also covers a kill before
    an in-progress reset finished: the compare above, not phase (c)'s own reset, is what
    clears it.
  - Otherwise (the user staged something beyond the killed group's paths after the kill,
    `killedLeftover`) → the index is left untouched (never auto-committed in `staged` mode,
    whatever the mode flags — `--staged` included — and the index shape, [`mode`](plan.md)).
    The new run's own mode-decision step (step 4) then decides by the run's flags:
    - interactive (`split` or `staged`) → an ordinary `modeChoice` handback (index plus
      other changes), whose notice/question additionally names the killed group's paths
      still staged;
    - `--no-user` without `--reword` (no user can answer a `modeChoice`) → exit 6 `state`,
      domain code `killed-leftover`: "a killed /commit run left staging behind, and more
      was staged since: <the killed group's paths still staged>; unstage them or commit by
      hand, then run /commit again"; the index stays untouched, and the lock is released
      and the folder deleted;
    - `--reword` (with or without `--no-user`) → no forced `modeChoice`: `--amend --only`
      never touches the index, so the leftover cannot be committed; the run goes on, and a
      notice names the killed group's paths still staged.
  - This is checked, and either branch taken, before the taken-over run's folder is deleted.
    A kill between `acquire` and that deletion leaves the taken-over run's folder, with its
    `indexReset`, in place, and keeps the renamed lock file (`lock.<planId>`, named by the
    killed takeover's own `planId`, holding the taken-over run's lock), which is deleted only
    with that folder. The next takeover of the killed takeover's lock finds that renamed
    file beside it, while the killed takeover's own folder has no `state.json` (it died at
    step 3): it reads the check's facts from the run the renamed file names, following such
    files back to the first run folder with a `state.json`, and deletes every folder on
    that chain after the check.
- A cleanup error after a successful commit (for example a Windows file lock on a temporary
  file) never changes the outcome: it becomes a notice, and the sweep removes the leftovers.
- After a failed run, too, a cleanup call (the unstage, the HEAD re-read, the tree-state
  read, the release) that fails or is skipped past `cleanupDeadline` never changes the
  outcome: the exit code and kind come from the original cause, and the cleanup error
  becomes a notice ([Q18](../decisions/q18-failures-repo-hooks-and-signing.md) as amended by
  EXE-01). When the unstage of a group that reached phase (c) did not happen, the lock and
  the run folder are kept: the state already holds `indexReset` and the group not
  `committed`, so the next `/commit` takes the run over ([Q22](../decisions/q22-concurrent-runs.md))
  and the takeover repair above resets the group's staging. The output has `unstaged: null`
  and the notice "group `<n>` staging may remain, the next /commit repairs it"; only the
  call's own `call.lock` is removed.
- `plan` deletes `<planId>/` folders older than 24 hours that the lock does not name, and
  leftover takeover and lock temporary files. The sweep considers only entries named in the
  minted form and never follows a link.
- Stdout budgets, each tested on its own (Q24): `plan`'s own fields 1 kB ([plan](plan.md));
  a `reply` 2 kB without its `text`, and its `text` 4 kB with every list at its cap
  ([Reply and handback](reply-and-handback.md)); `plan --hunks` 20 000 characters, also when
  `plan` carries it under `hunks`. `plan --hunks` output over its budget moves the index to
  `hunks.json`.
