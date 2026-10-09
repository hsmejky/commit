# commit, release

**commit** `--plan <planId> --all [--confirmed]`

Commits every group not yet `committed`, in order, in one process, and stops at the first
failure (Q18). Before each group it refreshes `touched` (Q22). The call has one 540-second
budget (`deadline`, from the call's start): the first group always starts; a later group
starts only while at least 480 s of the budget are left, else the call stops cleanly with a
`continue` handback whose `run` is the same `commit --plan <planId> --all` (the committed
groups are recorded, so it resumes where it stopped). Every git call of the call (the
snapshot, reset, apply, backstop and `git commit`) takes as its timeout the time left before
`deadline`, computed at its own start, so the budget never goes stale. A second, later
`cleanupDeadline` = the call's start plus 580 s: after a failure or a timeout, the cleanup
and reporting calls (the `finally` unstage, the HEAD re-read, the hook-rewrite tree-state
read, and `release`) take the time left before `cleanupDeadline`, never the spent
`deadline`, so a call that used up its 540 s still reports and releases inside the worker's
600-second tool timeout (`plan`'s own pre-`acquire` calls use only `deadline`, since
nothing has run yet to clean up; [plan --hunks](plan-hunks.md) takes `deadline` for its own
work and `cleanupDeadline` for a refusal's tree-state read and the release; INT-02's `check`
takes it the same way for the `committed` and `continue` replies' tree-state read after the
commit loop, a reporting call that runs whether the run was already released (`committed`)
or is kept (`continue`). A cleanup call
whose `timeoutMs` (`cleanupDeadline` minus the time it starts) is ≤ 0 is not spawned at all
and counts as timed out, the same as a git call that ran out of time. Each group runs the steps
below; per group, three phases in `split`, the real index touched only in (c). Every check
of (a) runs again before each group, so the advanced expected HEAD and an `index.lock`
created between groups are both caught:

- (a) Refusals, in this order:
  - exit 6 `lock` unless the run lock holds this `planId`; the run is opened, with its
    `call.lock` (a second call on the same run → `lock`, `busy`), once per call before the
    first group, and `touched` is refreshed before each group;
  - exit 1 `usage` (`unconfirmed`), first group of the call only, when the state has
    `awaitingConfirm` and `--confirmed` is missing: only the `confirm` handback's `yes`
    answer carries it. The first group of a call with `--confirmed` clears
    `awaitingConfirm`, so a `continue` needs no flag;
  - exit 1 `usage` (`no-groups`) when `check` has not stored groups or every group is
    committed;
  - exit 6 `head-moved` when HEAD is not the SHA the state file expects: the one `plan`
    recorded, then the SHA of each group this run committed;
  - exit 6 `diff-changed` (`index-changed`) when the index fingerprint, re-read fresh
    (`git ls-files --stage -z`, hashed as `plan` does), differs from the one stored in the
    state: staging made between `plan` and `commit`, or between two groups, is refused
    rather than folded into a group or silently lost from the report. A group already
    committed before this check trips stays committed, reported like any other mid-run
    refusal (`commits`, `failed`, `remaining` below). The stored fingerprint is updated to
    the fresh read after each of the run's own `git commit` calls and after an unstage, so
    only a change from outside the run trips it;
  - exit 6 `index-lock` when `index.lock` exists: `reset` and `apply` take the lock too,
    and would otherwise fail unmapped (exit 1) and could leave the index half staged;
  - then the budget check above (a stop → exit 0 with `continue`).
- Units and message come from the state file; nothing is read from stdin.
- (b) Match (`split`), without touching the real index:
  - Rebuilds the temporary index (Q11) as in [plan](plan.md): a copy of the real index,
    reset with `git reset -q -- .` on the copy (the pathspec form writes no ref, Q11), then
    `git add -N` of the candidate and
    staged-new lists **stored by `plan`** (never recomputed: after group 1's reset no path
    is staged-new any more; stored paths missing from the working tree are skipped; paths
    with `ignored: true` in a separate `git add -N -f`); never built from HEAD. It
    recomputes the diff against it with the pinned options, and each unit's hash: hash of
    (path, the `-` and `+` lines without context, occurrence index among identical hunks in
    the same file; a `\` no-newline marker counts toward the hash only when it directly
    follows a `-`/`+` line, not a context line). Whole-file units hash as in Q11 (old/new
    path, mode, symlink target, gitlink commit ID, blob IDs for binaries, the cleaned form
    for filtered files).
  - Every unit's ID is mapped to its hash through the state file and matched against the
    current hunks. A missing hash → exit 6, `diff-changed`. The message is "files changed
    since plan, run /commit again", or, when the state file has
    `treeChangedDuringCommit: n-1`, "files changed during the commit of group n-1 — a repo
    hook (lint-staged, a formatter) likely rewrote them; run /commit again".
  - A `git add -N` that fails while rebuilding the temporary index above (a stored candidate
    that became ignored since `plan`, for example) → exit 4 `git` (`git-failed`), git's
    output verbatim in `gitOutput`; the real index is never touched, since the rebuild runs
    entirely on the temporary one.
- (c) Apply (`split`): sets `indexReset: true` in the state file, runs `git reset -q -- .`
  (the pathspec form: a bare `git reset -q` would move `ORIG_HEAD`, append a HEAD reflog
  entry, fail on `HEAD.lock` and delete `MERGE_MSG`, Q11),
  builds the patch from the current hunks (current ranges) and applies it to the real
  index with `git apply --cached --whitespace=nowarn`. Whole-file units (filtered files
  included, so git runs the filter) are staged with
  `git add -A --pathspec-from-file=- --pathspec-file-nul` (both paths for a rename; paths
  on stdin, NUL-separated, never on argv, Q11); whole-file paths with `ignored: true`, and a
  gitlink whose working-tree `.gitmodules`, or its index copy when the file is missing, sets
  `ignore = all` (git 2.54 skips it without
  `-f`, exit 0 with a hint; git 2.34 and 2.43 stage it regardless, CHG-21), go in a separate
  `git add -A -f` call, so no other ignored path is added. If
  `git apply
  --cached` or `git add` exits non-zero after the reset (`core.safecrlf=true`, a required
  filter that is missing), even when some paths were added, exit 4 `git` (`stage-failed`,
  git's output in `gitOutput`), and the output carries `unstaged`.
  Verify: the index diff against HEAD (pinned options) must hold exactly the group's
  hashes, else exit 6 `diff-changed` (a file changed between (b) and `git add`).
- `staged`: no reset, no staging. The index's hash set is recomputed and compared with the
  map; any difference (the user staged more in a terminal) → exit 6 `diff-changed`. Then
  the index is committed as-is.
- `reword`: no match, no reset, no staging, no verify, no scan.
- Then: scan the index (backstop; not in `reword`): `git write-tree` first records the
  index's tree ID, then the scan reads the tree-to-tree diff of the expected HEAD (the empty
  tree when unborn) against that tree, so the scanned tree is the recorded one. That diff
  is cut like the `plan` diff: the same pinned options, raw and patch passes and the same
  1 MB scan limit, but with no `check-attr` call: every non-deleted binary-rendered unit
  under the limit gets the `--text` content-sniff pass `plan` runs only for a
  `check-attr`-confirmed hidden file (Q10 as amended by EXE-13), so an attribute cannot
  hide a text file from the backstop either. Paths are exempted with the `scanIgnore` patterns
  `plan` stored in `state.json`, recompiled on each call, not a fresh read of HEAD, which
  an earlier group's `scanIgnore` change may have moved (Q9, Q10 as amended by CFG-01);
  append trailers ([grammar](message-grammar.md)); run
  `git commit --cleanup=verbatim -F -` (with `--amend --only` in `reword`), timed out at
  what is left of the 540-second budget. On that timeout the process tree is killed and
  `index.lock` is handled per Q18: in `reword` (`--amend --only` holds the lock until the
  kill) it is removed only when stale by the two-marker rule; in `split` and `staged` (a
  plain commit releases the lock before its hooks run) it is never removed, and when one
  exists a notice says so ("index.lock was left in place — if no git process is running,
  check it and remove it by hand"). After a commit, when `HEAD^{tree}` differs from
  the recorded tree ID (a hook or another process changed the index between the backstop
  and the commit, with no extra commit), a notice names the group ("committed tree differs
  from the scanned index"); the commit is kept. Separately, after each `git commit`, the
  script reads HEAD and checks its first parent against the SHA expected before that
  commit (an unborn branch: HEAD has no parent) — except in `reword`, where `--amend
  --only` gives the new commit the same parent as the one it replaced, so there the check
  instead compares HEAD's first parent against the expected HEAD's own first parent (both
  none, on a root commit). When it matches, HEAD is the group's SHA, stored as the next
  group's expected HEAD. When it does not — a hook or another process committed as well —
  the group is still reported committed, with the SHA HEAD now holds, and a notice names
  the group ("another commit was made during group `n`; later groups refused"); the next
  group's own (a) check then finds HEAD moved from the expected SHA and is refused
  `head-moved`.
- Hook rewrite detection (`split`, when a later group exists): the worktree diff's hash set
  (temporary index, as above) is computed right before (`before`) and right after
  (`after`) the `git commit` call. If `after` differs from `before` minus group n's own
  hashes, the state file records `treeChangedDuringCommit: n` (Q18). Comparing `before`
  and `after` directly would always differ: the committed units leave the diff. `before`
  is not a second snapshot: it reuses the (b) match snapshot taken moments earlier, since
  nothing between (b) and this `git commit` call touches the worktree.
- After exit 4 or 5, and before an `internal` reply: `commit` reads HEAD, timed against
  `cleanupDeadline`. If it moved from the expected SHA, git made the commit anyway (a
  hanging `post-commit` hook, a signing prompt answered late, a throw after `git commit`
  returned): the output sets `sha` to the new HEAD and `error.message` to "committed as
  `<sha>`, but git did not exit cleanly" / "… did not exit in time" / "…, but the script
  failed". The exit code stays 4, 5 or 1 and the run ends. The group counts as committed in the report
  (Q18): it is in `commits` with the new `sha` and out of `remaining`, while `failed` still
  names it as the step whose exit ended the run. When HEAD did not move, a
  `git commit` killed at the deadline (exit 5) has `error.message` "git commit did not
  finish in 9 min — a pre-commit hook or a signing prompt may be waiting" (Q18).
- On failure: `split` runs `git reset -q -- .` only when the failing group itself reached (c)
  (`stage-failed`, a `diff-changed` from the verify, exits 3–5, `internal`); a refusal in
  (a) or a `diff-changed` in (b) leaves the real index as it is, even when an earlier group
  or call set `indexReset`. `staged` and `reword` leave the index as it is. A cleanup call
  that fails or is skipped past `cleanupDeadline` keeps the original cause's exit code and
  kind and adds a notice; when that `git reset -q -- .` did not happen, `unstaged` is `null`, the
  notice says "group `<n>` staging may remain, the next /commit repairs it", and the lock
  and run folder are kept for the next run's takeover repair ([run folder](run-folder.md),
  Q18 as amended by EXE-01).
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

A failed call (group 2 of 3 fails at `git commit`, exit 4):

```json
{ "version": 1, "ok": false,
  "error": { "kind": "git", "message": "git commit failed for group 2" },
  "commits": [{ "n": 1, "sha": "1a2b3c4", "header": "feat: add stage subcommand" }],
  "failed": 2, "remaining": [2, 3],
  "gitOutput": "pre-commit: eslint found 2 problems\n…",
  "unstaged": [],
  "reply": { "status": "failed", "…": "…" } }
```

- `commits`: the groups this call committed. `failed`: `null`, or the group number whose
  step failed; `error` is then that failure (the exit code is its cause's) and
  `remaining` the groups not committed. A stop on the budget is not a failure: exit 0,
  `failed: null`, `remaining` set, and a `continue` handback in `reply`. M16 `commitAll`
  builds this handback itself (EXE-16); `check`'s in-process `commit --all` puts it in
  `reply.handback` (INT-02). A direct `commit --all` that ends without
  a failure carries the same `reply` (INT-09); its failure path has none yet (KD-R73).
- Exit 4 fills `gitOutput` with git's stdout and stderr verbatim (unescaped, uncut); what a
  caller shows through `text` is the capped, escaped copy of it ([Reply and
  handback](reply-and-handback.md)). Exit 3 fills `error` and adds `hits`.
- `notices`: present on every `commit --all` output, `[]` unless this call hit the EXE-06
  "another commit was made during group `n`; later groups refused" case, or the release
  after the last group could not remove the run folder (a cleanup notice, [run
  folder](run-folder.md)). `check`'s in-process `commit --all` merges them with `check`'s own
  into `notices` and `reply.notices` (INT-02, [check](check.md)). A direct `commit --all`'s `reply.notices`
  also lead with the notices `plan` stored (a takeover, [run folder](run-folder.md)); this
  top-level field keeps only the call's own (INT-09). Its failure path has no `reply` yet
  (KD-R73).
- `unstaged`: present on every `commit --all` output, run-ending or mid-run (e.g. a `lock`
  refusal between groups), gated only by the state file's `indexReset: true`; `indexReset`
  decides only this report, never whether to unstage. `[]` once `indexReset` is true (an
  earlier group's own index reset, even if nothing of `preStaged`/`indexOnly` still differs
  from HEAD); `null` only while the index has never been touched (`indexReset` still false),
  and then the report says the index is untouched. It lists the paths of the state file's `preStaged` that
  still differ from HEAD (one that is not UTF-8 is stored in its `\xNN` form, [plan](plan.md),
  so it is matched against the `\xNN` form of the bytes git lists), so the run's reset has unstaged them, plus every `indexOnly`
  path whether or not it differs from HEAD, with its index `blob` (`null` for the others).
  `ignored` marks one that `git status` no longer shows. The report says "your earlier
  staging was reset: …", and per `blob` "staged version discarded, recover with
  `git cat-file -p <blob>`" (Q18).
- Marks the group `committed: true` and stores its SHA as the expected HEAD. Releases the
  lock and deletes the run folder after the last group, and on every failure that ends the
  run ([CLI](cli-and-exit-codes.md)).

**release** `--plan <planId>`: reads the lock first. If it holds this `planId`, `release`
creates the run's `call.lock` like every `--plan` call (another call on this run still
running → exit 6 `lock`, `busy`, and the run is kept, so a folder is never deleted under a
running call; a `<planId>` folder that is missing, a link, or not a plain directory gets no
`call.lock` at all — `release` proceeds straight to removing the run lock,
[contracts](run-folder.md) `call.lock` row), then removes the lock and deletes the run
folder; otherwise a no-op with exit 0 before touching the run folder (the run has already
ended, or was taken over and the lock is someone else's, Q22). Removing the lock uses the
same rename-to-private-name, verify-`planId`, unlink-or-put-back sequence `acquire`'s
takeover uses (RUN-02), not a bare unlink by name: reading the lock and deleting it are two
steps, and a takeover of a now-stale lock could land in between (review-RUN-01 finding 1).
Its private name is `lock.<fresh randomUUID>`, not `lock.<planId>` like `acquire`'s takeover
(review-RUN-02 finding 2): the renaming run (this `release` call) has no run folder of its
own, so on a put-back miss the kept private copy is an orphan whose chain ends at once (its
name resolves to no folder) — adoption finishes it with no facts to check, and the 24-hour
sweep leaves it alone like any other renamed lock file, [contracts](run-folder.md) orphan
paragraph. Outside a working tree (not a repo, a bare repository, or git timing out on its
own fixed timeout), what `release` does is not yet settled (KD-S78). The whole call runs
under M15 `releaseDeadline` (the call's start plus 45 s, below its 60 s tool timeout): every
git call takes the time left before it, and once it is spent (before a step, or by a git
call it ended) `release` ends with exit 5 `timeout` before removing anything, so the run
folder and the lock are kept for the next `plan`'s takeover (user decision on KD-R78);
past the release itself, only the reply's tree-state line is omitted
([reply](reply-and-handback.md)). Output `{ "version": 1, "ok": true, "reply": {
"status": "nothing", "text": "nothing committed", … } }`; after a no-op the `text` says
"nothing to release: the run has already ended or was taken over".
