# Modules M10-M13

**M10 Change-set engine.** Q11's "one function", the only owner of the pinned diff options
and of the real index.
- `inventory()` → the inventory lists (`stagedNew` and `indexOnly` carry `ignored`;
  `indexOnly` carries the blob ID; every candidate carries its size in bytes and `binary`,
  which M9 `applyCaps` and M13 read; in `staged` mode it also counts `unstagedLeft`, `null`
  in `split` and `reword`, C:plan).
- `snapshot({ mode, storedLists, indexPath })` → units. Builds the temporary index by
  copying the real index and running `git reset -q` on the copy (empty when unborn), then
  `git add -N` of the stored lists, skipping missing paths (Q11 steps 1-3); paths with
  `ignored: true` go in a separate `git add -N -f` call, so no other ignored path is added.
  A non-zero `git add` exit counts as failed even when some paths were added (`git-failed`,
  whichever subcommand ran the snapshot: `plan`, `plan --hunks`, `check` or `commit`). Runs the pinned diff
  (worktree, index versus HEAD, or HEAD's own diff against its parent or the empty tree for
  a root commit) with exactly Q11's pinned options, including `diff.autoRefreshIndex=true`
  and `--submodule=short`; `diff.renameLimit` stays the user's (Q11). Paths and whole-file
  kinds come from a `--raw -z` pass, so no path is ever parsed out
  of patch text; the patch pass supplies only hunk bodies, ranges and the added lines the
  scan reads. A unit carries `addedLines: [{ line, text }]`, where `line` is the 1-based
  line number in the new file and `text` is the lossy UTF-8 decode of the line, without the
  `+` and `\n`. It also carries `size` in bytes for M9 `summaryOnly`'s `size` rule — the new
  content's size, or the old content's for a deletion — each read with a `cat-file -s <blob>`
  call (`inventory` sets the same field on an untracked candidate). The patch pass is one
  `git diff -z --raw -p` call over the whole diff, with no
  pathspecs (a path list would go on argv, and a pathspec narrows rename detection, Q11),
  read as a stream (M2 `onStdout`) keeping only what a later step needs: hunks of
  body-carrying units and, for M8, added lines up to the 1 MB scan limit (then the file is
  skipped, Q10), so memory stays bounded by the Q19 and Q10 caps. The limit is per file: its
  added content is the raw bytes of its added lines, without the `+`, plus one byte per line
  for the `\n`, summed over all its hunks, and over 1 MB (1,048,576 bytes) it stops
  collecting that file's added lines. **Over the scan limit**: every unit of such a file
  carries `overScanLimit: true` (absent otherwise), with `addedLines` cut short or empty, so
  M8 reports the file skipped even when what was collected, or one hunk alone, stays under
  its own measure. Section *i* belongs to raw
  record *i* and takes its path, except that a type-change (`T`) record (file↔symlink,
  file↔submodule) owns two consecutive sections with its path (git prints a delete, then a
  new file) and is one whole-file unit; a section count or path that does not match the raw
  pass under this rule is `internal` (C:plan-hunks). **Raw bytes**: diff output stays a `Buffer` from M2 onward; records split on
  NUL, sections and lines on `\n` bytes, and hunk bodies, unit hashes and built patches use
  the raw bytes, so a Latin-1 file or CRLF content is staged exactly as git showed it. Only
  presentation decodes, lossily: M13 for the worker's body text, M17 for the reply, and M8
  scans a lossy decode (its patterns are ASCII); none of them feeds a hash or a patch. A path
  that is not valid UTF-8 is not a unit: it goes to `notIncluded` ("path is not UTF-8 —
  commit by hand"), since `state.json` and the reply carry paths as strings; its string
  form writes each non-UTF-8 byte as `\xNN`. Whole-file unit categories: new,
  deleted, binary, summary-only via M9, rename, mode, symlink, submodule, filtered: one
  `check-attr --stdin -z` call queries `filter` and `linguist-generated` together, and the
  latter goes in `stats` to M9 `summaryOnly`; hashes with `crypto.createHash`. **Hidden by an attribute**: for a path git
  reports as binary (`-\t-` in `--numstat`), the same `check-attr` call also queries `diff`
  and `binary`; only a path whose attributes hide its diff (`-diff`, `binary`, or a `diff`
  driver) gets the content check: its size is checked against the 1 MB scan limit first
  (over it, the file is skipped, Q10: its unit carries `overScanLimit: true` and no added
  lines), then it is binary when its new content has a NUL byte
  in git's first-8000-bytes window. A path git reports binary without such an attribute
  (NUL content, or over `core.bigFileThreshold`) stays binary with no check (Q10 as
  amended). An attribute-hidden file without a NUL is text: the unit has `kind: "text"`, is one whole-file unit (staged with
  `git add`) whose `body` is like a summary-only file's (no hunk block), and its added lines
  are scanned (story 212). They come from a second whole-diff `git diff -z --raw -p --text`
  pass, run only when such a file exists, streamed like the first and keeping only those
  files' sections: the same rename detection, the same section-to-record pairing (a `T`
  record owns two sections), and no path list on argv. Units come from git's
  diff, which already compares converted content, so `core.autocrlf` and `eol` attributes
  need no handling of their own; conversion warnings on stderr are not errors.
- `snapshotBlob(path) → Buffer | null`: the repo config's content on the snapshot side of
  the last `snapshot` (the working-tree file in `split`, the index entry in `staged`;
  `null` when the path is absent there), which M18 passes to M4 `scanIgnoreChanged`. M18
  always passes M4's `REPO_CONFIG_PATH`, never a unit's path, so a rename away from the repo
  config reads `null` (no patterns) at that path.
- `assignIds(units)`, `matchIds(idMap, units)` (typed, `unmatched`).
- Backstop reads (M16): `writeTree() → treeId` records the real index's tree
  (`git write-tree`); `treeDiffUnits(fromTree, toTree) → units` diffs two trees (`fromTree` the
  expected HEAD, or `null` for the empty tree when unborn) with the same pinned options,
  the same `--raw -z` pass, streamed patch pass and section-to-record pairing, the same
  `check-attr` call and attribute-hidden `--text` pass (story 212), and the same 1 MB
  streaming scan limit and `overScanLimit` flag as `snapshot`, keeping only what the scan reads. So the backstop
  scans the tree it recorded exactly as `plan` scanned the snapshot, and no other module
  holds a diff option.
- Path lists never go on argv: staging, attribute and index calls pass them on stdin,
  NUL-separated, so a large rename group cannot hit the Windows command-line limit (Q11,
  C:commit-release).
- Real index: `stage(groupUnits)` (reset, apply the patch built from current ranges with
  `git apply --cached --whitespace=nowarn`, whole-file adds, then verify the staged hash
  set; typed: `mismatch`, or `stage-failed` when `apply` or `add` fails after the reset;
  ignored whole-file paths go in a separate `git add -A -f` call, and a non-zero `git add`
  exit counts as `stage-failed` even when some paths were added). The built patch reuses,
  per file, git's own header lines from the current diff verbatim (`diff --git`, mode,
  rename, `index`, `---` and `+++` lines), followed by the group's hunks as raw bytes, so a
  path with quotes, tabs, newlines or leading spaces is quoted exactly as git quotes it and
  `git apply` parses it back; the builder never formats a path itself.
  `verifyIndex(groupUnits)` for `staged`; `unstage()`; `indexLockExists()`;
  `commitGuarded({ args, input, timeoutMs, partial }) → { code, stdout, stderr, timedOut,
  lockRemoved, lockLeft }`: the whole stale-`index.lock` mechanism, so no other module
  writes a marker or touches the lock. It resolves the lock path through M2
  `gitPath('index.lock')` (the per-worktree git directory), brackets the `git commit` spawn
  and a timeout's tree kill with two marker files next to it. With `partial` (reword's
  `--amend --only`, where git holds the lock until the kill) it removes a leftover
  `index.lock` only when its mtime lies between the markers, so it never removes a foreign
  lock; without it (a plain commit, `split` and `staged`, where git released the lock before
  the hooks ran) it never removes the lock and sets `lockLeft` when one exists, which M16
  turns into the notice "index.lock was left in place — if no git process is running, check
  it and remove it by hand". A lock it keeps is also reported by the next `index-lock`
  refusal (story 166; the mtime rule is in Q18). The stale-lock case is covered by a
  fixture with a real `git commit` timeout, shortened by a clock step that holds at start
  (Clock at Seam 1);
  `unstagedAfterReset(preStaged, indexOnly)`; `indexFingerprint()` (a hash of
  `git ls-files --stage -z`: read-only, takes no index lock, works while an `index.lock`
  exists and never rewrites the index; an intent-to-add entry and a staged empty file look
  alike, both the empty blob, which is accepted; used by `plan` step 7 and by M16 before each
  group); `treeState() → { clean: true } | { count, paths }`
  (paths capped at 10 plus "+N more" by M17), read after the subcommand's last git call by
  every M18 workflow that builds a reply (`plan`, `plan --hunks`, `check`, `commit`,
  `release`).
Sources: Q9, Q10, Q11, Q18, C:plan-hunks, C:commit-release.

**M11 Signing probe.** When `commit.gpgsign` is true (read with `--type=bool`): SSH format →
`true` when the key is listed by `ssh-add -L`, or when the private key file has no
passphrase, decided by parsing its header with no extra process; a key with a passphrase not
loaded in the agent → `false` (`signing-locked`); anything the probe cannot decide →
`"unknown"`. Every case, in order, is per the SSH readiness table of C:plan, which is
exhaustive; `~/` expands against the injected OS home, and `ssh-add` is taken only from the
directory of the `ssh-keygen` git runs. openpgp → `"prompt"`, with the note "signing enabled; a passphrase prompt may appear" (a
locked openpgp key is not detected; Out of Scope). x509 or custom `gpg.program` →
`"unknown"`; custom `gpg.ssh.program` → `"prompt"`. Never pops up a prompt. The probe runs
only git and `ssh-add`, each under a fixed timeout; a timeout ends as `"unknown"` instead of
stalling `plan`. It runs after clean-tree and `staged-hit` detection (M18 `plan` step 6), so
a clean tree on a locked key reports "nothing to commit". `probeSigning({ home, toplevel, execPath, deadline })
 → { enabled, format?, ready }`. The `signing-locked` refusal text and the openpgp note are the recorded-texts table of C:cli-and-exit-codes, verbatim. Sources: Q18, C:plan, C:cli-and-exit-codes.

**M12 Run.** Everything under the run folder. Check `.commit-plan` (Run-folder directory
check above); add the exclude line once (path from `gitPath`, `info/exclude`, which git
resolves to the common dir, so every worktree shares the one entry; only the run folder and
its lock are per worktree, Q9); mint `planId`
(`randomUUID`); provisional folder, then `acquire` (the lock `{ planId, created }` is
written to a temporary file in `.commit-plan/` and hard-linked into place, which fails
when a lock exists, so no reader ever sees a lock without its content: an existing lock →
`held`; on Windows `EPERM` and `EBUSY` are retried like the state rename, and one that
persists falls back to a hard-link probe of a temporary file in `.commit-plan/`: the probe
succeeds → `busy` (the file is in use, story 193), the probe fails → `run-folder` ("the run
folder's filesystem does not support hard links"); `ENOTSUP` or `ENOSYS` is `run-folder` at
once, without a probe; the errno mapping is in C:run-folder) or `discard`; a read-only `peek()` reports a live lock without
acquiring anything (M18 skips it under `--take-over`);
verify-and-touch on `open` and before each group (`touch()`); the per-call `call.lock`
(`{ pid, host }`) on `open`, removed when the call ends by `run.close()`, stale at once when its owner pid is dead
on this host, else like the lock at 15 minutes, and replaced with the same atomic takeover; staleness at 15 minutes by mtime against the injected
clock, including for an unparseable lock or one whose `planId` is not in the minted form,
which is never taken over by `--take-over`; atomic takeover by renaming to a private name, verifying bytes plus mtime
(automatic) or `planId` (`--take-over`), putting a mismatched lock back with a hard link (a
put-back that fails with `EEXIST` keeps the private copy, which the new holder adopts as
an orphan, and refuses `held` naming the lock now in place; the moved run meets
`taken-over` at its next step; a rename that fails with `ENOENT` re-peeks once: a lock in
place → `held` naming it, no lock → the automatic takeover adopts the orphan while
`--take-over` refuses `ended`; a rename that succeeded followed by a link that fails with
`EEXIST` deletes nothing of the takeover, discards the provisional folder and refuses
`held`), then linking its own lock and reading the taken-over run's facts for the index
repair from its `state.json` (following the renamed lock files of a takeover killed
mid-repair back to the first folder with a `state.json`, C:run-folder), without deleting
anything; an `ENOENT` on the `--take-over` run's `call.lock` (its folder is gone) →
`ended`, after deleting the renamed lock and releasing its own; every `acquire`, after its
link succeeds, adopts each orphan renamed lock (`lock.<planId>` not on its own chain) by
walking its chain the same way (a chain ending at a missing folder has no facts); the
repair itself is M18's (the killed-process paragraph under the error table above), and
`finishTakeover` afterwards deletes every folder on the chains first, then the renamed
lock files; after a failed repair M18 does not call it, so the chain stays for the next
adopter; an automatic takeover adds a notice naming the stale
`planId`; a file-in-use error on any other operation → `busy` (C:run-folder);
`release` a no-op on mismatch, and on a match it takes the `call.lock` (`busy`) before
deleting the run folder; it removes the lock itself through the same rename-to-private-name,
verify-`planId`, unlink-or-put-back sequence `acquire`'s takeover uses (RUN-02), closing the
TOCTOU window between reading the lock and deleting it that a same-instant takeover of a
stale lock could otherwise hit; 24-hour sweep of `<planId>/` folders (minted form only, never
following a link) the lock does not name, and of leftover takeover and lock temp files,
never of a renamed lock file (`lock.<planId>`) or a folder on its chain (adoption owns
them).
Every write of `state.json` and `plan.json` goes to a temporary name, then a rename; on Windows a rename
that fails as file-in-use is retried briefly before it counts as a failure (C:run-folder). A cleanup error after
a successful commit (for example a Windows file lock on a temp file) never changes the
outcome: it becomes a notice and the sweep removes the leftovers later. Typed state
(C:run-folder plus the stored-facts rows above), written atomically with a `version` field
(Versioned run state); `open` refuses `ended` on a `version` mismatch. Paths absolute with
forward slashes.
- `Run.create({ toplevel, excludePath, tracked }) → provisional` or `run-folder`
  (`excludePath` from M2 `gitPath`, `tracked` from M3 `isTracked`: M12 spawns nothing); `provisional.peek()` (typed, `held` with holder, or
  ok when no live lock, carrying the stale holder when there is one, and the orphan
  renamed locks when there is no lock, which M18 treats like a stale lock; read-only);
  `provisional.acquire({ takeOver? })` (typed, `held` with holder, `busy`, `taken-over`,
  `ended` (a `--take-over` run already gone), `run-folder`) or `provisional.discard()` (never
  throws and never removes through a `.commit-plan` that became a link: `null`, or the notice
  for a folder it could not remove, left for the sweep).
  `takeOver` is the stale holder `peek` reported (automatic, or the orphans alone when there
  is no lock) or the `--take-over` `planId`; without it `acquire` only links the lock
  (step 7) and adopts any orphan. Success: `{ run, takeover }`, `takeover` `null` when it
  took nothing over and adopted no orphan, else `{ planId, notice, killedRun }` (`planId`: the
  taken-over run's, or the first adopted one's), where `killedRun` is `null` when no chain
  reaches a readable `state.json`, else `{ groupPaths, preStaged, indexOnly, indexReset,
  groupStatus }` (`groupPaths`: the current group's unit paths, both halves of a rename
  included), united over every chain whose run has `indexReset` and a group not
  `committed` when there are several.
- `run.finishTakeover()`: after M18's repair, deletes every folder on the chains first,
  then the renamed lock files; a no-op without a takeover; not called after a failed
  repair.
- `open(planId, { toplevel, now, pid, host, isAlive })` (typed: `taken-over`, `ended`,
  `busy`), returning `{ ok: true, run: { toplevel, planId, callLockPath } }` on success —
  a plain function, not a method on a run object.
- `close({ toplevel, planId, pid, host })`: a free function (not a method), removing the
  call's own `call.lock` only when it still holds this call's `{ pid, host }`; idempotent
  and `ENOENT`-tolerant (a folder already deleted by `release` or a takeover is not an
  error). Called from M18's `finally` for every call with `--plan` and from the entry
  point's signal handler (once GIT-08 builds it).
- `run.state`, `run.write(name, data)`, `run.readWorkerPlan()`, `run.touch()`,
  `run.release()`, `Run.releaseById({ toplevel, planId }) → { ok: true, released }` (`released:
  false` for the no-op when the lock does not hold `planId`; `{ ok: false, code: 'busy' }`
  on a live `call.lock`, RUN-02), `Run.sweep(now)`. Every M12 static entry takes `toplevel`
  explicitly, alongside its own arguments, since M18 already holds it from the probe (Q9).
Sources: Q9, Q22, C:run-folder.

**M13 Hunk index renderer.** Presentation only: the summary-only reason per unit; the body
cap per C:summary-only-files (files past the 3000-line cap keep each hunk's own ID and range
with `body: "cap"`); `hunks.txt` blocks; `body` per C:plan-hunks, one of three values:
`"file"` (a block in `hunks.txt`), `"cap"` (past the cap), and `"none"` (no block: a binary,
a submodule, a summary-only file, an attribute-binary text file, a filtered file whose cleaned
diff is binary, and a unit with a pattern hit); per-entry `scan`; the 20 000 character stdout
budget with spill to `hunks.json`; `config.values` without `scanIgnore`, `recentSubjects` and
`oldMessage` from the run state.
Returns texts; M18 writes them through M12. `renderHunks(runState, units) → { stdoutObj,
hunksTxt, hunksJson? }`, where `stdoutObj` is exactly the C:plan-hunks output shape (with
`runDir`, `mode`, `counts`, `hunksFile`, `hunksIndexFile` on a spill, and per entry `range`,
`lines`, `offset`, and `added`/`deleted` on `body: "cap"`), where `units` are the snapshot units `plan --hunks` matched (the
stored unit table holds no bodies or ranges). Sources: Q10, Q19, C:plan-hunks,
C:summary-only-files.
