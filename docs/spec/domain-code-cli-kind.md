# Domain code → CLI kind (owned by M18)

| Domain code | Producer | CLI kind | Exit |
| --- | --- | --- | --- |
| bad argv or flag combination, malformed `planId` | M1 | `usage` | 1 |
| `unconfirmed` (`commit` without `--confirmed` while a confirmation is pending) | M16 | `usage` | 1 |
| `staged-empty` (`--staged` with an empty index) | M15 `resolveMode` via M18 | `usage` | 1 |
| `already-committed` (`check` after a committed group) | M15 `checkGate` | `usage` | 1 |
| `no-groups` (no stored groups, or all committed) | M16 | `usage` | 1 |
| `config` (invalid layer or glob) | M4, M7 | `config` | 1 |
| `env` (git missing, git < 2.34, Node < 22, an install path containing `$`, a backtick, `"`, `\` or a typographic double quote (U+201C-U+201E)) | entry point, M3 | `env` | 1 |
| `not-a-repo`, `bare`, `in-progress` (incl. a pending `merge --squash`), `unmerged`, `unborn` or `merge` HEAD in reword, `encoding` | M3 via M15 | `state` | 6 |
| `run-folder` (`.commit-plan` tracked, a link or not a directory; its filesystem does not support hard links) | M12 | `state` | 6 |
| `killed-leftover` (`--no-user` without `--reword`: a takeover found staging beyond the killed group's paths; lock released, folder deleted, index untouched) | M15 `resolveMode` via M18 | `state` | 6 |
| `signing-locked` | M11 via M15 | `signing` | 6 |
| `pushed` | M3 via M15 | `pushed` | 6 |
| `staged-hit` | M15 | `staged-hit` | 6 |
| `held` (also from `peek` at `plan` step 3), `taken-over` (also a late `ENOENT` on the call's own `call.lock` or run folder), `ended` (also a state `version` mismatch, and `--take-over` of a run that already ended: a rename `ENOENT` whose re-peek finds no lock, or an `ENOENT` on that run's `call.lock`), `busy` (also a live `call.lock`, a lock operation that failed with `EPERM`, `EBUSY` or `EACCES`, or a lock link whose `EPERM`/`EBUSY` persists after retries while the hard-link probe succeeds) | M12 | `lock` | 6 |
| `index-locked` (also a foreign `index.lock` blocking the takeover's index repair at `plan` step 3) | M10 via M16; M10 via M18 (`plan` step 3 takeover repair) | `index-lock` | 6 |
| `unmatched` (hash set differs), `mismatch` (staged ≠ group) | M10 via `plan --hunks` and M16 | `diff-changed` | 6 |
| `index-changed` (index fingerprint changed, HEAD unchanged) | M18 `plan` step 7; M16 before each group | `diff-changed` | 6 |
| `head-moved` | M3 via `plan` (after `acquire`), `plan --hunks` and M16 | `head-moved` | 6 |
| `lint` | M14 | `lint` | 2 |
| `backstop-hit` | M8 via M16 | `scan` | 3 |
| `git-failed` (also a failed `git add` in M10 `snapshot`, in `plan`, `plan --hunks`, `check` and `commit`, and a takeover repair's `git reset -q` failing otherwise at `plan` step 3) | M16, M10 via M18 and M16 | `git` | 4 |
| `stage-failed` (`git apply --cached` or `git add` failed after the reset) | M10 via M16 | `git` | 4 |
| `timed-out` (also `plan` or a separate `plan --hunks` past its 540-second deadline) | M2 via M16 and M18 | `timeout` | 5 |
| unexpected throw | any | `internal` | 1 |
| clean tree (`nothing`; never in `reword`) | M15 `planRefusal` | none: success reply `status: "nothing"`, folder discarded | 0 |

Every step after `acquire` runs inside a `try`/`finally` in M18: when the current group
reached staging (phase (c)), the `finally` unstages it and the output carries `unstaged`;
`internal` then releases the lock and deletes the folder like any other ending refusal, so
the next `/commit` starts fresh (C:cli-and-exit-codes error table). The `finally` and the
reporting calls after a failure or timeout (unstage, HEAD re-read, `treeState`, release) run
against M15 `cleanupDeadline`, never the spent `deadline`. A cleanup call that fails or is
skipped keeps the original cause's kind and adds a notice; when the unstage did not happen,
the lock and folder stay for the next run's takeover repair, with `unstaged: null` (M15
`cleanupDeadline`, C:run-folder). Before an `internal`
reply ends the run, M16 re-reads HEAD, so a commit it already made is reported with its
`sha`.

A killed process (Esc, a session end, a signal) runs no `finally`; the signal handler only
kills the child tree and removes `call.lock`, so a group killed during phase (c) can leave
part of its staging in the index. The run state records `indexReset` before staging
starts, so the evidence survives. A takeover (automatic or `--take-over`, both at M18
`plan` step 3, before step 4) runs in three steps: M12 `acquire` moves the lock and returns
the taken-over run's facts, read from its `state.json` without deleting its folder; M18
repairs the index; M12 `finishTakeover` then deletes the old folder. When those facts show
`indexReset` set and the current group not `committed`, M18 computes M10
`unstagedAfterReset` from their `preStaged` and `indexOnly` lists and repairs the index
before `inventory`: when nothing is staged (index equals HEAD, e.g. a kill in phase (a) of
a later group), it neither resets nor gives the reset notice; when every staged path
(index versus HEAD) belongs to the killed group's paths (the set C:run-folder defines), it
runs `git reset -q` and the takeover notice says the killed group's partial staging was
reset; otherwise (the user staged something else after the kill, so the index holds paths
beyond that set) it leaves the index untouched and sets `killedLeftover` for `resolveMode`
(below): an interactive `split` or `staged` run gets `modeChoice` whatever the flags
(`--staged` included) and the index shape, whose notice names the killed group's paths
still staged; `--no-user` without `--reword` refuses with `killed-leftover` (exit 6
`state`, text naming those paths; the lock is released and the folder deleted); `--reword`
goes on with a notice naming those paths, since `--amend --only` never touches the index.
So the leftover is never committed unasked. A kill during the repair leaves the old folder
and its `indexReset` for the next takeover (C:run-folder: the renamed lock file names the
run to read). A repair whose `git reset -q` fails (a foreign `index.lock` → `index-lock`,
the deadline → `timeout`, another git error → `git-failed`) skips `finishTakeover`: the
taken-over folder and the renamed lock stay as evidence, M18 releases its own lock and
deletes its own folder, and the reply carries the notices so far plus a "repair failed"
notice. `finishTakeover` deletes every chain folder first and the renamed lock files last.
A renamed lock file with no lock in place, or left beside a new holder's lock (a kill
between rename and link, a kept chain, a put-back copy), is an orphan that the next
`acquire` adopts: it walks the chain as for a takeover, and at step 3 M18 repairs and
finishes it; at step 7 an adopted chain that needs the repair refuses `index-changed`
instead and leaves the chain for the next `plan` (C:run-folder). The new run's reply carries the `unstaged` notice either way (stories 210,
227; Q17, Q18 and Q22 as amended).
