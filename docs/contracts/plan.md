# plan

Run by the worker (Q9, Q25). Contains no hunks and no diff content. It mints `planId` and
creates the [run folder](run-folder.md) before the scan; when there is work to do it writes
`state.json` (including the current `HEAD` SHA, or `null` when unborn, the stored lists, the
unit IDs with the `id → hash` map and the scan map, cut from the very diff it scanned, and
the notices for the reply) and takes the run lock (Q22), otherwise it deletes the folder
again (after a takeover at step 3, releasing the lock it took there). Every git call runs from the toplevel (Q9).

Steps, in order. A deadline of 540 seconds from `plan`'s start bounds every git call of
every step, each call taking the time left at its own start; past it `plan` ends with exit 5
`timeout` and deletes the provisional folder (Q9, Q18). After a timeout with the lock held
(past step 7, or past a takeover's `acquire` at step 3), the cleanup (unstage, if any; releasing the lock; deleting the folder) runs
against `cleanupDeadline` = `plan`'s start plus 580 s, never the spent 540-second deadline,
the same rule [`commit`](commit-release.md) follows. Before this deadline governs later
calls, the two start-up `spawnSync` calls of step 1 (`toplevel`, `gitVersion`) each carry
their own fixed short timeout (M2); either one passing it also ends `plan` with exit 5
`timeout` (domain code `timed-out`), before any run folder exists.

1. Probe the repo state (with `--reword` also its unborn, merge-commit, root-commit and
   pushed facts; unmerged index entries; a pending `SQUASH_MSG`), git and Node versions; load
   and validate the config; resolve the attribution. Signing is probed only at step 6.
2. Pre-folder refusals, in order: `env`, `config`, `state` (including `sequencer/`,
   `SQUASH_MSG`, `unmerged` and the encoding), and with `--reword` unborn or merge-commit
   HEAD (`state`) and `pushed`, then `timed-out` (the start-up `spawnSync` calls' own
   timeout, held last among these rows). None of them creates the run folder.
3. Mint `planId`, check `.commit-plan` and create the run folder (provisional); then a
   read-only lock `peek`, before any inventory work: a live lock → `lock`, delete the
   folder; a stale lock → the automatic takeover, here: `acquire` takes it over; no lock
   but an orphan renamed lock file (`lock.<planId>`, a takeover killed before its link) →
   the same path: `acquire` links its own lock and adopts the orphan's chain
   ([run folder](run-folder.md)). A takeover rename that fails with `ENOENT` (another
   takeover won) re-peeks once: a lock in place → `lock` with a fresh handback naming it;
   no lock → the orphan's adoption. `plan --take-over <planId>` skips the `peek`; its
   `acquire` also runs here, taking over the named lock whatever its age; a named lock or
   folder already gone (the run ended while the user decided) → `lock` (`ended`), unless
   the re-peek finds another lock in place (`lock`, `held`, naming it). After either
   takeover's `acquire`, and before step 4's inventory runs, `plan` applies the taken-over
   run's index-repair check (reset, or leave the index for step 4's mode decision), then
   deletes the taken-over run's folder ([run folder](run-folder.md)). A repair whose
   `git reset -q -- .` fails (`index-lock` for a foreign `index.lock`, `timeout`, `git-failed`)
   keeps the taken-over folder and the renamed lock for the next `plan`, releases the lock,
   deletes the folder and ends with the notices so far plus a "repair failed" notice.
   From a step-3 `acquire` on, the run holds the lock: every
   later outcome that takes no lock on the path with no takeover (a clean tree,
   `modeChoice`, `staged-empty`, `staged-hit`, `signing`, `killed-leftover`, `git-failed`,
   `timeout`, …) releases the lock and deletes the folder. The takeover's notices (the
   takeover notice, naming the stale run's `planId` for an automatic takeover: "took over
   the stale /commit run `` `<planId>` `` (idle for 15 minutes or more)", or for a lock with
   no `planId` in the minted form "took over a stale, unreadable /commit lock (idle for 15
   minutes or more)"; the reset
   notice; the `unstaged` report; with `killedLeftover` the killed group's paths still
   staged) are kept from here on and go into the reply's notices of every output `plan`
   ends with, whatever step it ends at: a clean tree, `modeChoice`, `staged-empty`,
   `staged-hit`, `signing`, `killed-leftover`, `git-failed`, `timeout`, `head-moved`,
   `index-changed` and `internal` included. The taken-over run's folder is gone by then, so
   the reply is the only place the user learns of the takeover (Q22, story 210). An orphan
   that appears only after the `peek` is adopted by step 7's `acquire` (below).
4. The index fingerprint (a hash of `git ls-files --stage -z`: read-only, takes no index
   lock), read first, so step 7's re-read also sees an index change made while the
   inventory's own git calls run; then the inventory; hidden rule; mode (`modeChoice`,
   `staged-empty` for `--staged` with an empty index, or after a takeover `killed-leftover`
   ([run folder](run-folder.md)) → delete the folder, after a takeover releasing the lock
   too). Candidates for the mode decision are counted after the hidden rule and before the
   caps. Then, only when the resolved mode is `split` (a `split` flag, an index that
   resolves to `split`, or the respawn of a `modeChoice` answered `split`), a staged
   case-only rename on a case-insensitive filesystem or with `core.ignorecase=true` (a
   staged-new path, hidden ones included, and a tracked path that differ only in case,
   Q11) → exit 6 `state`, code `case-rename`, delete the folder, naming the renames ([CLI
   and exit codes](cli-and-exit-codes.md)). `staged` and `reword` are never refused for
   it, and a mixed index gets its `modeChoice` first.
5. Caps (`split` only), snapshot (a failed `git add` → exit 4 `git`, code `git-failed`, delete the
   folder), unit IDs, scan (not in `reword`, Q20).
6. Post-scan refusals: `staged-hit` (`--staged` only: a staged-new path the hidden rule
   excludes, a scan hit in the index diff, or a staged path that is not UTF-8, each named in
   the message, the last as "path is not UTF-8 — unstage it or commit by hand"); a clean tree → `nothing`, except with `--reword`, which
   takes the lock on a clean tree too (Q9, Q20); then the signing probe
   (`ready: false` → `signing`). Each deletes the folder, so a clean tree on a locked key
   reports "nothing to commit".
7. Write `state.json` with every stored fact except `notices` ([run folder](run-folder.md));
   on the path with no takeover, take the lock here (a race lost after the `peek` →
   `lock`, delete the folder); that `acquire` adopts an orphan renamed lock that appeared
   after the `peek`: one whose chain calls for the index-repair check leaves the chain for
   the next `plan`, releases the lock, deletes the folder and refuses `diff-changed`
   (`index-changed`) with a notice, since the inventory is already taken
   ([run folder](run-folder.md)); after a takeover the lock is already held from step 3 and
   no `acquire` runs; then re-read HEAD and the index
   fingerprint, on both paths, against what step 4's inventory recorded (Q22 as amended by
   the RUN-20 decision pass). A moved HEAD (another run committed since the inventory)
   releases the lock, deletes the folder and refuses with exit 6 `head-moved`; a changed
   fingerprint with an unchanged HEAD does the same with exit 6 `diff-changed` (domain code
   `index-changed`, not checked in `reword` mode, which `--amend --only` never touches;
   Q18, Q20). Then S1 `guardState` (read here, ahead of the sweep, so `plan.json` carries
   `env.guard`; the order against the sweep is not observable), write `plan.json` (the full
   `plan` output), then sweep old folders.
8. The notices (`env.guard: "not-seen"` from step 7, the takeover's notices kept since
   step 3, already in the reply of any earlier ending, and the sweep's cleanup errors) are
   added to `state.json` in one more atomic write; then
   [`plan --hunks`](plan-hunks.md) in the same process, unless `--dictated`. Like every
   later writer, that in-process `plan --hunks` rewrites `state.json` from the state it
   read, changing only its own fields (`lintFailures`), so the notices survive.

Stdout is compact. `plan`'s own fields (and a refusal's `error` object) stay within 1 kB; a
`reply` (≤ 2 kB without its `text`, `text` ≤ 4 kB) or the `hunks` object (≤ 20 000
characters) comes on top, each with its own CI size test (Q24):

```json
{ "version": 1, "ok": true, "planId": "3f9a1c…",
  "runDir": "C:/Users/<you>/repo/.commit-plan/3f9a1c…", "mode": "split", "reply": null,
  "hunks": { "version": 1, "ok": true, "runDir": "…", "hunksFile": "…", "hunks": ["…"] } }
```

`hunks` is the [`plan --hunks`](plan-hunks.md) output as a nested JSON object, never a string
(no double escaping), or `null` when `reply` is set. Exactly one of `reply` and `hunks` is
non-null, except with `--dictated` (Q20): the dictated text needs no diff, so `plan` skips
the hunk step and both are `null`. `--dictated` saves the worker up to 20 000 characters
of HEAD's hunk index it would never use.

`reply` is set when the worker's part ends here: a clean tree (`status: "nothing"`), a
`modeChoice` or `lock` handback, or a refusal ([Reply and handback](reply-and-handback.md)).
Otherwise `plan` has taken the lock and goes straight on as [`plan --hunks`](plan-hunks.md)
in the same process, and `hunks` holds that output. The full output below goes to
`plan.json` in the run folder (for tests and debugging; the worker does not read it). With no folder
kept (clean, `modeChoice`, refusals) there is no `plan.json`, and `reply.text` carries what
the user needs (counts of hidden and collapsed files, `stagedExcluded`, `dirtySubmodules`,
`embeddedRepos`).

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
  "signing": { "enabled": true, "format": "openpgp", "ready": "prompt" },
  "env": { "node": "22.11.0", "git": "2.47.1", "guard": "active" },
  "recentSubjects": ["feat: add stage subcommand"],
  "warnings": ["the repo config (.claude/commit.json) key 'foo' is unknown; ignored"]
}
```

- `planId`, `runDir`: a lowercase UUID v4 and the absolute path of its run folder. Both `null` on a
  clean tree and with `modeChoice` (exit 0, no lock left: a takeover's lock from step 3 is
  released); set whenever `--reword` succeeds. Refusals (`env`, `config`, `state`,
  `signing`, `pushed`, `staged-hit`, `lock`) leave no lock (after a takeover at step 3 they
  release it) and carry the failure shape plus `reply`.
- The unit IDs, the `id → hash` map and the scan map are stored, not printed; `plan --hunks`
  emits the IDs and refuses if its diff differs (Q9, Q10).
- `clean`: `true` when no tracked change and no candidate is left. Hidden-only or
  collapsed-only untracked files, staged-new paths in `stagedExcluded`, paths that are not
  valid UTF-8, `dirtySubmodules` and `embeddedRepos` are clean; `plan` still reports them (the `nothing`
  reply names them), and the index is left as it is.
  The `nothing` reply's `text` (RUN-15, M15 `planRefusal`) is "nothing to commit" alone when
  none of these apply, else "nothing to commit: " followed by one part per reason that
  applies, joined with "; ", in this order (paths escaped as in `text` generally, M17
  `escapePath`; `notUtf8`'s bad-byte `\xNN` escapes, M10 `escapeNonUtf8`, are themselves
  escaped again for any remaining control character, since `escapePath` is idempotent on
  `\xNN` text):
  - hidden: "N hidden file: `` `a` ``" / "N hidden files: `` `a`, `b` ``" (first 5, plus
    ", +N more" past that, M10's `hidden.sample` cap);
  - collapsed: "`` `dir` `` (N collapsed)", one per directory, joined with ", ";
  - `stagedExcluded` reason `hidden`: "`` `a` `` is staged but hidden — commit by hand" /
    "`` `a`, `b` `` are staged but hidden — commit by hand" (Q16; a clean tree's staged-new
    hidden path is reported here, never refused: `staged-hit`'s own "is/are staged but
    hidden — unstage it/them or commit by hand" wording,
    [cli-and-exit-codes.md](cli-and-exit-codes.md), only fires under `--staged`);
  - `stagedExcluded` reason `collapsed`: "`` `dir` `` (N staged, collapsed)", one per
    directory, joined with ", ";
  - `dirtySubmodules`: "dirty submodule: `` `a` ``" / "dirty submodules: `` `a`, `b` ``";
  - `notUtf8`: "path not UTF-8: `` `a` ``" / "paths not UTF-8: `` `a`, `b` ``";
  - `embeddedRepos`: "embedded repository: `` `a` ``" / "embedded repositories:
    `` `a`, `b` ``".
  The inventory's tracked-change read is `git status --porcelain -z --untracked-files=no
  --no-renames`: a rename's old path is its own deletion there, so a tracked file renamed
  (`git mv`, or `mv` plus `git add -N`) to a hidden path in `stagedExcluded` still leaves
  the tree dirty. This affects only `clean`; `tracked` still shows a rename as one `R`
  entry, from the snapshot.
- `stagedExcluded`: staged-new paths (added in the real index relative to HEAD, Q11) that
  the [hidden or collapse rule](untracked-files.md) excludes. Never planned or scanned; `check`
  adds them to `notIncluded` ("`.env.local` was staged but is hidden — commit by hand;
  committing this plan unstages it"). In `split` mode `commit` resets the real index, so
  they end up untracked. In `staged` mode only the hidden rule applies, and a hidden
  staged-new path refuses the run with `staged-hit` (Q10), so a success output always has
  `[]`; `[]` in `reword` mode.
- `dirtySubmodules`: submodules whose own working tree has changes (edits or untracked
  files) but whose pointer did not change. Not units; `check` adds them to `notIncluded`
  ("libs/x has uncommitted changes inside — commit inside the submodule first"). A
  submodule with a pointer change is a unit whatever its dirt (Q11). Computed only when
  the worktree has a `.gitmodules` file (the dirt of a gitlink added without one is not
  reported); a non-UTF-8 path is written as `\xNN`. The inventory's status read pins
  `--ignore-submodules=dirty` too, so a `submodule.<name>.ignore=all` setting hides no
  pointer change from `clean`. The dirt read itself pins `--ignore-submodules=none`, so a
  submodule's own `ignore` setting does not suppress its `dirtySubmodules` report either,
  like every pinned option (config-independent output).
- `embeddedRepos` (`state.json` only): untracked embedded repositories (C:untracked-files),
  never candidates or units; `check` adds them to `notIncluded` ("nested is an embedded
  git repository — add it as a submodule by hand"). They leave the tree clean, and the
  `nothing` reply names them. `[]` in `reword`.
- `mode`: `split`, `staged`, `reword` (`--reword`). Without a flag `plan` never picks
  `staged`: index empty → `split`; index holds every change → `split`; index plus other
  changes (unstaged tracked changes or candidates) → `mode: null`, no `planId`, no lock left
  (a takeover's step-3 lock is released), and a `modeChoice` handback ("3 files are staged, 5 other changes: commit only the staged
  ones, or group all changes within the task?", answers `staged` / `split`, each a
  `respawn`). The handback carries counts only, never file lists. Every `respawn` `plan` builds carries its own answer
  plus the `mode` flag of the call that produced it (`--reword` is the caller's own
  `reword` line), except that a `modeChoice` answer replaces that flag: its respawn
  carries the answer's `mode` alone, so a forced `modeChoice` (below) from
  `plan --take-over <planId> --staged` answered `split` respawns with `mode: split` only
  (Q9 as amended by the RUN-20 decision pass). `takeOver` appears only in a `lock` handback's `take over` answer: a
  `modeChoice` never carries it, also under `--take-over <planId>`, because a takeover
  finishes at step 3, before the mode decision, and the `modeChoice` releases the lock it
  took, so the respawned `plan --staged` / `plan --split` meets no lock of the taken-over
  run and starts fresh (Q9, Q22). A worker spawned
  with `interactive: false` runs `plan --split --no-user` (or `--reword --no-user`) and
  never gets a `modeChoice`. Stored in the state file; `plan --hunks` reads it from there.
  A takeover with `killedLeftover` (the user staged something beyond the killed group's
  paths after the kill, [run folder](run-folder.md)) forces `modeChoice` in an interactive
  `split` or `staged` run, whatever the mode flags — `--staged` included — and whatever the
  index shape: the one case where `--staged` does not pick `staged` outright. With
  `--no-user` and without `--reword` it refuses instead (exit 6 `state`, `killed-leftover`,
  lock released, folder deleted), so a run without a user still never gets a `modeChoice`;
  with `--reword` nothing is forced, the run goes on, and a notice names the killed group's
  paths still staged.
- `--no-user`: stores `interactive: false` for `check` (Q17, Q25). A `lock` refusal then
  carries a plain reply without a takeover answer.
- `--take-over <planId>`: replaces the lock held by that `planId` (from the `lock` error),
  whatever its age, and deletes that run's folder after the index-repair check
  ([run folder](run-folder.md)). Only through the `lock` handback's
  `respawn`, i.e. after the user said yes; that `respawn` also carries the mode flag of the
  refused call, if it had one (`plan --staged` → `mode: staged`), so, when the refused call
  had a mode flag, the takeover plans the same mode and cannot fall back to a `modeChoice`
  (except with `killedLeftover`, above, whose answers carry no `takeOver`); a bare
  first-spawn `plan`'s takeover respawn has no mode and can get an ordinary `modeChoice`
  (the [reply and handback](reply-and-handback.md) fixture `plan --take-over <planId>` on a
  mixed index). Uses the same atomic rename as the automatic
  takeover of a stale lock; instead of the staleness check it requires the moved lock to
  hold the given `planId`, else it puts the lock back and refuses with `lock`, carrying the
  new holder's details and a fresh `lock` handback (Q22). When the put-back link fails with
  `EEXIST` (a third `plan` locked in the gap), it keeps its private copy, which the new
  holder adopts as an orphan ([run folder](run-folder.md)), and refuses with `lock`
  (`held`) naming the lock now in place; the moved run is refused `taken-over` at its next
  step. A rename that fails with `ENOENT`, or an `ENOENT` on the named run's `call.lock`
  (its folder is gone), means the run already ended: `lock` (`ended`, "that run has
  already ended; run /commit again"), unless a re-peek finds another lock in place
  (`held`, with a fresh handback naming it). It skips `plan`'s read-only `peek` (step 3).
- `state.kind`: `branch`, `detached`. The refused states (not a repository, a bare
  repository, and an in-progress merge, cherry-pick, revert, rebase, bisect or paused
  sequence, i.e. a `sequencer/` directory found via `git rev-parse --git-path`; a pending
  `merge --squash`, detected by `SQUASH_MSG` ("a squashed merge is staged: commit it by
  hand, or drop it with `git reset --merge`"); unmerged index entries without an in-progress
  marker, such as a conflicted `stash pop`, i.e. any `u` line of the status (`unmerged`,
  "resolve the conflicts first")) end `plan` with exit 6 and `error.kind: "state"` (Q21).
  `unborn: true` on a first commit. The state comes from one porcelain v2 `--branch` status
  call pinned with `--untracked-files=no --ignore-submodules=all --no-ahead-behind` (the
  last avoids the upstream ahead/behind revision walk `--branch` would otherwise do,
  review-GIT-02 finding 8).
- `i18n.commitEncoding` set to anything other than UTF-8 (compared case-insensitively with
  `utf-8` and `utf8`) ends `plan` with exit 6 `state`: the script writes UTF-8 messages, and
  git would label them with the configured encoding.
- `status`: `A`, `M`, `D`, `R` (rename, `oldPath` set), `T`.
- `bucket`: `code`, `test`, `docs`, `ci`, `build`. Hints only.
- `untracked.candidates`: the untracked candidates whose unit is not listed in `tracked`.
  A plain `mv` (no `git mv`) makes the target an untracked candidate whose unit is an `R`
  with `oldPath`; it is listed once, in `tracked`, and left out here. `state.json` keeps it
  in its candidate list, which the temporary index is rebuilt from.
- `preStaged`: paths with staged changes. An intent-to-add entry (`git add -N`) stages no
  content (a commit leaves it out of the tree), so it is not listed here; it is in
  `stagedNew` (or `stagedExcluded`), and an index holding only such entries is not
  pre-staged. A staged path that is not valid UTF-8 is listed in its `\xNN` form: it is no
  unit, but its staged content counts for the mode decision and the `unstaged` report. In `staged` mode `tracked` lists only the unstaged changes, and
  `unstagedLeft` counts them. A partially staged file appears in both lists. In `split`
  mode (`--split`, or an index that holds every change), `tracked` lists every change
  against HEAD, `preStaged` is informational and `unstagedLeft` is `null`; `null` in
  `reword` too. In `reword` (CHG-15), `tracked` is HEAD's own diff (its single parent, or
  the empty tree for a root commit), not the working tree: `preStaged`, `clean` and
  `untracked.candidates` keep describing the working tree exactly as in other modes;
  `reword` commits none of it (`--amend --only`, Q20).
- `attribution`: `null` when no trailer is added. `source`: `managed`, `project-local`,
  `project`, `user`, `default`.
- `config.sources` values: `default`, `user`, `repo`, and `repo@HEAD` (only `scanIgnore`,
  read from the `.claude/commit.json` blob in HEAD's tree, Q10). A `scanIgnore` that is
  invalid at HEAD (not a regular file, oversized or unreadable, not valid JSON, not an
  array of strings, or a glob error) is not a `config` refusal: `config.values.scanIgnore`
  is `[]` and `warnings` names the repo config at HEAD (Q6, Q10 as amended by CFG-01); the
  worktree layer is still validated. `scanIgnore`'s source is `default` whenever no valid
  value was read at HEAD (the file or key absent there, an unborn HEAD, or an invalid value,
  with the warning).
- `scan.scanIgnoreChanged`: the result of the `scanIgnore` change test
  ([scan map](plan-hunks.md)); an output field, the scan map carries the flagged units.
- Scan hits never carry the matched value. In `split` mode the scan runs over the diff
  against the temporary index (Q11), built in the run folder, so candidates, staged-new
  paths and tracked changes are scanned alike. A file with a `filter` attribute is scanned
  in the cleaned form the diff shows (Q10).
- Temporary index (Q11): a copy of the real index that keeps its mtime (floored to the
  second, so racy-git detection still sees a same-size edit made in the second of the last
  index write), reset with `git reset -q -- .` on the copy (the pathspec form writes no
  ref, so the user's `ORIG_HEAD` and HEAD reflog stay as they were; empty when unborn), then extended with `git add -N` of the stored candidate and
  staged-new lists, skipping missing paths; it is never built from HEAD. Paths with
  `ignored: true` go in a separate `git add -N -f` call, so no other ignored path is added.
  A non-zero `git add` exit is a failure (exit 4 `git`, code `git-failed`) even when some paths were
  added.
- A path that is not valid UTF-8 is not a unit: `check` adds it to `notIncluded` ("path is
  not UTF-8 — commit by hand"), with each non-UTF-8 byte written as `\xNN`, since
  `state.json` and the reply carry paths as strings. The hidden rule matches an untracked
  one in that `\xNN` form, and a hidden one is counted as hidden instead. The collapse rule
  does not apply: each such path needs the user's hand, so each is named. A staged one (not
  intent-to-add) is also in `preStaged`, since the index holds its content. The hidden rule
  matches a staged-new one in the same `\xNN` form: a hidden one is in `stagedExcluded` as
  hidden, not in this report. `plan --staged` refuses a staged one that is not hidden with
  `staged-hit` ("path is not UTF-8 — unstage it or commit by hand"). A rename from a
  non-UTF-8 path to a UTF-8 one is split: the old path is reported as above, and the new
  path is an `A` unit, taken from a second pinned diff with `--no-renames` (still no pathspecs).
- Binary is decided by attributes first, then content (Q10, Q11): for a path git reports as
  binary (`-\t-` in `--numstat`), only a path whose attributes hide its diff (`-diff`,
  `binary`, or a custom `diff` driver) gets the content check — its size is checked against
  the 1 MB scan limit first (over it, the file is skipped, Q10), then it is binary when its
  new content has a NUL byte in its first 8000 bytes; without a NUL, the attribute hid a text
  file, and it is a text unit (see [`plan --hunks`](plan-hunks.md)) whose added lines are
  scanned. A path git reports as binary without such an attribute (a NUL byte, or over
  `core.bigFileThreshold` alone) stays binary with no check (Q10 as amended): a NUL-free file
  over the threshold does not become an attribute-hidden text unit. When at least one
  attribute-hidden text file exists, a second whole-diff pass, `git diff -z --raw -p
  --text`, supplies their added lines; it is not run otherwise. The pass is streamed and
  read for these files' sections only, discarding the rest as it arrives; rename detection
  is the same as the main diff (including its `--no-renames` re-diff for a rename from a
  non-UTF-8 path), and the file list that picks out which sections to keep is never passed
  to git on argv. A deleted path gets no content check (it has no new content) and stays
  binary.
- `signing`: `{ "enabled": false }` when `commit.gpgsign` is not true (read with
  `--type=bool`). `format`: `openpgp`, `ssh`, `x509`; `format` is left out for a `gpg.format`
  git does not know (`ready: "unknown"`, and git refuses to sign with that value itself). A
  `commit.gpgsign` value that is not a boolean is also a case the probe cannot decide:
  `{ "enabled": true, "ready": "unknown" }` (`git commit` reports git's own error).
  `ready` (Q18). A configured program
  counts as custom when it is not git's default: for openpgp (`gpg.program` or
  `gpg.openpgp.program`), by basename, case-insensitive, with any `.exe` suffix stripped,
  compared against `gpg` or `gpg2`; for ssh (`gpg.ssh.program`), by a literal compare
  against `ssh-keygen`.
  - `ssh`: `true` when the key is listed by `ssh-add -L`, or when the private key file (from
    `user.signingKey`, minus a `.pub` suffix) has no passphrase, decided from its header
    (OpenSSH `openssh-key-v1` with cipher `none`; PEM without `ENCRYPTED`); a key with a
    passphrase that is not loaded in the agent gives `false`. A custom `gpg.ssh.program`
    gives `"prompt"`. With the default program, the SSH readiness table below decides.
  - `openpgp`: always `"prompt"`; a locked openpgp key is not detected.
  - `x509`, or a custom `gpg.program`: `"unknown"`.

  SSH readiness (default `gpg.ssh.program`). Key source, from `user.signingKey`:

  | `user.signingKey` | Public key | Private key file |
  | --- | --- | --- |
  | unset, `gpg.ssh.defaultKeyCommand` set | not run: `ready: "unknown"` | — |
  | unset, no `gpg.ssh.defaultKeyCommand` | none: `ready: "unknown"` (`git commit` reports git's own error) | — |
  | a literal key (`key::` prefix, or starting with `ssh-`) | the literal value | none |
  | a path ending in `.pub` | that file | the path without `.pub` |
  | any other path | `<path>.pub` when it exists, else the public part of an `openssh-key-v1` private file | the path itself |

  A path starting with `~/` is expanded against the injected OS home; `~user/` gives
  `"unknown"`; a relative path is resolved against the toplevel, git's working directory.
  Then, in order:

  | Case | `ready` |
  | --- | --- |
  | the public key's type and base64 blob match a line of `ssh-add -L` | `true` |
  | the private key file is `openssh-key-v1` with cipher `none`, or PEM without `ENCRYPTED` | `true` |
  | the private key file has a cipher other than `none`, or PEM `ENCRYPTED` | `false` |
  | the private key file exists but its header is neither form | `"unknown"` |
  | no private key file (a literal key, or a `.pub` without its private file) | `false` |
  | a `false` above while the `ssh-add -L` check was not run or not trusted (next row) | `"unknown"` |

  With no public key to compare, the `ssh-add -L` check counts as not run.

  `ssh-add` is the one in the directory of the `ssh-keygen` git runs (the first on git's
  `PATH`; on Windows, Git for Windows' own `usr/bin`, located from `git --exec-path`, comes
  first), so it talks to the same agent; a `PATH` `ssh-add` elsewhere (such as Windows
  OpenSSH, which talks to another agent) is never used. When no `ssh-add` sits next to that
  `ssh-keygen`, or it times out, the check is not run. Exit 1 (no identities) and exit 2 (no
  agent reachable) count as an empty list; any other non-zero exit means the check was not
  run.

  The probe never pops up a prompt and runs only git and `ssh-add`, each under a fixed
  5-second timeout (every git read and `ssh-add -L` alike, capped by the time left before
  the deadline); a timeout gives `"unknown"` and `plan` goes on. Only a probe call the
  deadline itself ended ends `plan` as `timeout`. The private key file is `stat`ed before it is
  opened: anything but a regular file, or one over a 64 KiB cap, gives `"unknown"` without
  being read, and only a bounded prefix within the cap is read for the ones that qualify,
  so a FIFO, a device file or an oversized file can never block or cost unbounded work.
  `ready: false` never appears in a success output: `plan` refuses with exit 6 `signing`
  instead, at step 6.
- `env.guard`: `active` (a matching heartbeat under 15 minutes old), `not-seen` (Q23).
- Notices stored for the reply: `env.guard: "not-seen"` (Q23; text in the recorded-texts
  table of [CLI and exit codes](cli-and-exit-codes.md#recorded-texts)), `signing.ready: "prompt"`
  ("signing enabled; a passphrase prompt may appear", Q18), the detached-HEAD
  warning (Q21) and every entry of `warnings`. The reply of whatever output ends the
  worker's part carries them in `notices`.
