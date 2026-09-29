# CLI and exit codes

```
commit.cjs plan    [--reword [--dictated] | --staged | --split] [--take-over <planId>] [--no-user]
                                                   mints planId and unit IDs, takes the run lock
commit.cjs plan    --hunks --plan <planId>         resets the lint counter; as a separate call (not
                                                   the in-process run inside plan) marks the run resumed
commit.cjs check   --plan <planId>                 validates; commits when confirm is null
commit.cjs commit  --plan <planId> --all [--confirmed]
                                                   commits the remaining groups in order
commit.cjs release --plan <planId>
commit.cjs infer
```

`plan`, `plan --hunks` and `check` are run by the worker (Q24, Q25). A `commit --all` or
`release` comes only, verbatim, from a handback's `run` in the caller, never from the
worker: the guard denies both from `commit:commit-worker` (Q25, [Guard](guard.md)).
Every subcommand writes exactly one JSON object to stdout, on failure too. stderr carries
debug output only. No subcommand reads stdin. `--staged` with an empty index → exit 1
`usage`. `--dictated` without `--reword` → exit 1 `usage`. `--no-user` together with
`--staged`, `--take-over`, or without `--split` or `--reword` → exit 1 `usage` (a run without a
user never asks for a mode or a takeover, Q17). A `planId` (`--plan`, `--take-over`) must
be a lowercase UUID v4, the form `crypto.randomUUID()` mints; any other value → exit 1
`usage` ([run folder](run-folder.md)). `--confirmed` belongs on a `confirm` handback's `yes`
answer only ([commit](commit-release.md)). Every git call except `git commit` runs with
`GIT_LITERAL_PATHSPECS=1` and the `-c` pins (`core.quotePath=false`,
`diff.suppressBlankEmpty=false`), and with every inherited `GIT_*` variable removed except
`GIT_EXEC_PATH`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_SSH`,
`GIT_SSH_COMMAND` and `GIT_ASKPASS`, so `GIT_ATTR_SOURCE`, `GIT_TRACE*` and the
object-directory variables cannot reach the scan, while every call reads the config files
`git commit` reads (Q9). `git commit` takes no pathspec and runs with neither the pins nor
`GIT_LITERAL_PATHSPECS`; it removes only `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_COMMON_DIR`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`, `GIT_CONFIG_PARAMETERS`,
`GIT_ATTR_SOURCE`, `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so repo
hooks inherit the rest of the user's own git environment (story 147). Path lists go to git
on stdin, NUL-separated, never on argv (Q11).

| Code | Kinds | Meaning |
| --- | --- | --- |
| 0 | — | ok |
| 1 | `usage`, `config`, `env`, `internal` | usage, invalid config, unsupported environment, or internal error |
| 2 | `lint` | lint (`check`) |
| 3 | `scan` | scan backstop (`commit`, `check`) |
| 4 | `git` | `git commit` failed, cause not parsed, or staging failed after the reset (`stage-failed`) (`commit`, `check`); a `git add` of the temporary index failed (`plan`, `plan --hunks`) |
| 5 | `timeout` | timeout (`plan`, `plan --hunks`, `commit`, `check`) |
| 6 | `state`, `signing`, `pushed`, `staged-hit`, `lock`, `index-lock`, `diff-changed`, `head-moved` | refused |

Failure shape, shared by all subcommands:

```json
{ "version": 1, "ok": false, "error": { "kind": "lock", "message": "another /commit run is in progress (started 13:58, last active 40 s ago)",
  "planId": "77c0e2…", "created": "2026-09-26T13:58:02Z", "touched": "2026-09-26T14:02:11Z" },
  "reply": { "status": "handback", "handback": { "kind": "lock", "…": "…" }, "…": "…" } }
```

A lint failure uses the same shape and adds the `errors` array (see [check](check.md)). A
`lock` error carries the holder's `planId`, `created` and `touched` (the lock file's mtime),
so the takeover question can say how long ago it was last active and
`plan --take-over <planId>` replaces only that run (Q22). For an unparseable lock, or one
whose `planId` is not in the minted form, `planId` and `created` are `null` and the `reply`
carries no handback: a run's own lock is never seen without its content (it is linked into
place fully written), so such a lock is corrupt or foreign, and there is no `planId` to take
over. The message is "the /commit lock is unreadable (corrupt or not written by /commit)",
and the `text` says it is waited out: it is taken over automatically once it has been idle
for 15 minutes, at the time `touched` plus 15 minutes, which the text names.

Every output that ends the worker's part of a run, failures included, also carries `reply`
([Reply and handback](reply-and-handback.md)); the worker returns it verbatim. A failure the
worker handles itself (a first lint failure) carries none.

| Kind | Raised by | When |
| --- | --- | --- |
| `config` | `plan` | a config layer is invalid: unparseable JSON, a wrong type, an out-of-range number, bad `types`, a `scanIgnore` glob that does not compile (Q6), or a `scanIgnore` pattern with no literal character ([scanIgnore globs](scanignore-globs.md), Q10); checked before the run folder exists. The repo config at HEAD is not a layer here: an invalid `scanIgnore` there is `[]` plus a warning (Q6 as amended by CFG-01) |
| `env` | any subcommand | git is missing, git is older than 2.34, or Node is older than 22 (Q1, Q15); the commit entry point's install path contains `$`, a backtick, `"`, `\`, or U+201C–U+201E (the typographic double quotes PowerShell reads as `"`), checked before any work on the path with Windows separators converted to `/` ([guard](guard.md)) (Q16, [Reply and handback](reply-and-handback.md)) |
| `state` | `plan`; `infer` (only the first clause below: not a git repository, or a bare repository) | not a git repository, or a bare repository; refused repo state: merge, cherry-pick, revert, rebase, bisect, or a paused sequence (`sequencer/`) in progress, or a pending `merge --squash` (`SQUASH_MSG`, its own text) (Q21); `unmerged`: unmerged index entries without an in-progress marker, such as a conflicted `stash pop` ("resolve the conflicts first"); `i18n.commitEncoding` other than UTF-8 (compared case-insensitively with `utf-8` and `utf8`); unborn HEAD or merge-commit HEAD with `--reword` (Q20); `run-folder`: `.commit-plan` is tracked, a link or not a directory, or its filesystem does not support hard links ([run folder](run-folder.md)); `killed-leftover`: with `--no-user` and without `--reword`, a takeover found staging beyond the killed group's paths (text names the killed group's paths still staged; index untouched; [run folder](run-folder.md)) |
| `signing` | `plan` | `signing-locked`: `signing.ready` is `false`, checked only after the clean-tree and `staged-hit` checks (Q18 as amended by PRE-15; text below) |
| `pushed` | `plan --reword` | HEAD reachable from a remote-tracking ref (Q20) |
| `staged-hit` | `plan --staged` | the index diff has a pattern hit (Q10), or the index holds a staged-new path the [hidden rule](untracked-files.md) excludes (Q11) |
| `lint` | `check` | any lint or validation error; details in `errors`; the second failure since the last `plan --hunks`, or the first of `"source": "user"` text, carries a `lintFailed` handback, or with `--no-user` releases the lock |
| `lock` | `plan`, and every `--plan` subcommand; `release` raises only `busy` (a lock that is not its own is a no-op there) | `held`: another run holds the lock (for `plan` found by the read-only `peek` at step 3, skipped with `--take-over`, or a race lost at `acquire`), or `--take-over <planId>` found a lock with another `planId`; `taken-over`: this run was taken over (the lock holds another `planId`); `ended`: this run has already ended (no lock, or a state `version` mismatch, [run folder](run-folder.md)); `busy`: another call on this run still holds its `call.lock`, or a lock operation failed with `EPERM`, `EBUSY` or `EACCES` (Windows: another process has the file open; for the lock link, an `EPERM`/`EBUSY` that persists after retries while the hard-link probe succeeds, [run folder](run-folder.md)) |
| `index-lock` | `commit` | `index.lock` exists before the index is reset or staged |
| `diff-changed` | `plan` (step 7, `index-changed`), `plan --hunks`, `commit` (`index-changed`, and the hash-mismatch checks below) | the hash set differs from the map `plan` stored, or (`commit`) the staged diff is not exactly the group; the message names a repo hook when the previous group's own `git commit` changed the tree ([commit](commit-release.md)); for `plan`, the index fingerprint changed between the inventory and taking the lock while HEAD did not ([plan](plan.md)); for `commit`, the index fingerprint re-read before a group differs from the one stored in the state, domain code `index-changed` ([commit](commit-release.md)) |
| `head-moved` | `plan` (after `acquire`), `plan --hunks`, `commit` | HEAD is not the SHA the state file expects; for `plan`, HEAD changed between the inventory and taking the lock ([plan](plan.md)) |
| `git` | `plan`, `plan --hunks`, `commit`, `check` (through `commit --all`) | `git-failed`: `git commit` exited non-zero, output in `gitOutput` (`commit`, `check`); or `stage-failed`: `git apply --cached` or `git add` failed after the reset in phase (c), output with `unstaged` ([commit](commit-release.md)); or `git-failed`: a `git add` building the temporary index exited non-zero, even when some paths were added — for `plan`'s own temporary index ([plan](plan.md)), and the same way for `commit`'s phase-(b) `git add -N` rebuild of it |
| `timeout` | `plan`, `plan --hunks`, `commit` (also through `check`) | `plan` or a separate `plan --hunks` passed its 540-second deadline; a git call of `commit` ran out of the call's 540-second budget ([commit](commit-release.md)) |
| `usage` | any subcommand | bad argv or flag combination; a `planId` that is not a lowercase UUID v4; `staged-empty` (`plan --staged` with an empty index); `already-committed` (`check` after a group of this run was committed); `no-groups` (`commit` with no stored groups, or every group committed); `unconfirmed` (`commit` without `--confirmed` while a confirmation is pending) |
| `internal` | any subcommand | an unexpected throw; after `acquire` it unstages the current group if that group reached phase (c) (output with `unstaged`), then releases the lock and deletes the run folder, all timed against `cleanupDeadline`, never the spent `deadline`; an unstage that fails or is skipped keeps the lock and the folder instead, with `unstaged: null` and a notice ([run folder](run-folder.md)); in `commit` it first re-reads HEAD, and a HEAD moved from the expected SHA sets `sha` to the new HEAD, so a commit already made is reported ([commit](commit-release.md)) |

`diff-changed`, `head-moved`, `index-lock`, `internal` (after `acquire`) and exits 3–5 end
the run: they release the lock and delete the run folder, so the next `/commit` starts
fresh. `usage`, `lint` and `lock` do not (the run can go on, or it is
not this run's lock), except a second `lint` failure with `--no-user`, which releases.
`env`, `config`, `state` (except `run-folder` and `killed-leftover`) and `pushed` come
before a run folder exists and take no lock ([plan](plan.md) steps 1-2). `run-folder` comes
from the directory check at step 3, before anything is written into `.commit-plan`, or
from a lock link that fails at step 7 (or at a takeover's `acquire` at step 3).
`killed-leftover` comes only after a takeover at step 3. Every other outcome of `plan`
that takes no lock (`lock` from `peek` or a lost `acquire`, `staged-empty`, `staged-hit`,
`signing`, `git-failed`, `timeout`, a `run-folder` lock link, a clean tree, `modeChoice`)
deletes the provisional folder before `plan` exits; after a takeover's `acquire` at step 3
the lock is held, and each of them, `killed-leftover` included, also releases it.

## Recorded texts

The exact texts tests assert, recorded here by the PRE-15 decision pass (2026-09-29) from
the decisions that set them. A refusal's text is its `message`; a notice's text is one entry
of the reply's `notices`. States with no recorded text (`bisect` in progress, `encoding`,
`unborn` HEAD in reword, `not-a-repo`, `bare`) get a message that names the state; tests
assert the domain code and that the state is named, not an exact text.

| Domain code (kind) | Emitted by | Text | Source |
| --- | --- | --- | --- |
| `head-moved` (`head-moved`) | M3 (`plan` after `acquire`, `plan --hunks`), M16 (`commit`) | HEAD moved since plan (commit made elsewhere?), run /commit again | Q18 |
| `signing-locked` (`signing`) | M11 via M15 (`plan`) | signing key locked — unlock it (e.g. sign once in a terminal), then `/commit` | Q18 |
| `merge` (`state`), reword only | M3 via M15 (`plan --reword`) | HEAD is a merge commit; reword it by hand | Q20 |
| `in-progress` (`state`): merge, cherry-pick or revert | M3 via M15 (`plan`) | finish it with `git commit --no-edit`, or abort it | Q21 |
| `in-progress` (`state`): rebase, `edit` and `reword` stops included | M3 via M15 (`plan`) | continue the rebase by hand | Q21 |
| `in-progress` (`state`): paused sequence (`sequencer/`) | M3 via M15 (`plan`) | continue or abort it by hand | Q21 |
| `in-progress` (`state`): pending `merge --squash` (`SQUASH_MSG`) | M3 via M15 (`plan`) | a squashed merge is staged: commit it by hand, or drop it with `git reset --merge` | Q21 |
| `unmerged` (`state`) | M3 via M15 (`plan`) | resolve the conflicts first | Q21 |
| guard notice (no kind; `env.guard: "not-seen"`, the run goes on) | M18 (`plan`, stored as a notice) | Guard hook did not run: `node` missing from the hook's PATH, plugin hooks disabled, or `disableAllHooks` set. Direct `git commit` is not blocked. | Q23 |
| signing prompt notice (no kind; `signing.ready: "prompt"`, the run goes on) | M18 (`plan`, stored as a notice) | signing enabled; a passphrase prompt may appear | Q18 |

Texts already fixed in their own contract stay there: the unreadable-lock message (above),
the `run-folder` and `killed-leftover` texts ([run folder](run-folder.md)) and the `timeout`
text of `git commit` ([commit](commit-release.md)).
