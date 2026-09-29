# 07 Change set

M9 (path classifier), M10 (change-set engine: inventory, temporary index, pinned diff,
units and hashes, real-index staging, index fingerprint, tree state) and M13 (hunk index
renderer). M9's `hideFilter`, `summaryOnly` and `bucketOf` are Seam 3 table tests; M9
`applyCaps`, M10 and M13 are tested at Seam 1 only, through `plan`, `plan --hunks`, `check`
and `commit`, with the `--numstat` parser oracle on every fixture repo. Main sources: Q11
(its Consequences list is the authoritative M10 case list), Q10, Q19, C:plan, C:plan-hunks,
C:untracked-files, C:summary-only-files, testing-modules rows M9, M10, M13.

## CHG-01: Tracer: M9 hidden rule

**What to build:** pure `hideFilter(paths) → { candidates, hidden }` per the hidden rules and
exceptions of C:untracked-files (a dot segment hides unless excepted; `.env`/`.env.*`
always, except the three templates; every other `.claude/` path hidden), case-sensitive on
every OS.

**Blocked by:** FND-01.

**Status:** done

**Sources:** Q10, Q11, Q16, C:untracked-files, testing-seams Seam 3, M9.

- [x] Seam 3: one row per hidden rule and per listed exception (`.github/**`, `.env.example`, `.claude/commit.json`, `.husky/**`, `.eslintrc.json`, `.gitlab-ci.yml`, …) with its expected category.
- [x] Seam 3: `.claude/settings.local.json` and `.env.local` hidden; `.ENV` treated case-sensitively (not the `.env` rule, still hidden by the dot rule).
- [x] Seam 3: a path with a hidden directory segment deeper in the path (`src/.cache/x`) is hidden.


## CHG-02: M9 summary-only reasons and buckets

**What to build:** pure `summaryOnly(path, stats) → reason | null` in C:summary-only-files
order (`lockfile`, `minified`, `sourcemap`, `generated` from the `linguist-generated` stat,
`lines` over 1000 changed, `size` over 256 KB) and `bucketOf(path)` → `code`, `test`,
`docs`, `ci`, `build`.

**Blocked by:** CHG-01.

**Status:** done

**Sources:** Q11, Q19, C:summary-only-files, C:plan (`bucket`), M9.

- [x] Seam 3: one row per lockfile name, `*.min.*`, `*.map`, generated flag, 1000/1001 changed lines, 256 KB / 256 KB + 1 byte; first matching reason wins when several apply.
- [x] Seam 3: `bucketOf` rows for each bucket, with buckets documented as hints only.


## CHG-03: Tracer: modified tracked files become whole-file units

**What to build:** the thinnest end-to-end M10 + M13 path for the first end-to-end commit (INT-02): M10
`inventory` of tracked modifications, a `snapshot` in `split` that runs the pinned diff
(exactly Q11's options) as a `--raw -z` pass for paths plus a patch pass for bodies, one
unit per modified file with a content hash over the raw bytes, `assignIds` (`h1…hN`), the
unit table and `id → hash` map handed to the run state; M13 `renderHunks` emitting the
C:plan-hunks shape with `body: "file"` blocks in `hunks.txt` and M9 `bucketOf` in `tracked`.
CHG-03b takes the run lock and does the ordered `state.json` and `plan.json` writes these
are stored through, so the criteria that read the stored unit table, `plan.json` or the
`hunks` block of `plan`'s stdout are CHG-03b's: `hunks` is non-null only once `plan` has
taken the lock, and a folder with no lock is discarded (C:plan, C:run-folder).

**Blocked by:** CHG-02, GIT-02, INT-01, RUN-05.

**Status:** ready-for-agent

**Sources:** Q9, Q11, C:plan, C:plan-hunks, further-notes "First slice", M10, M13.

- [ ] No path is parsed out of patch text: paths come from the raw pass only.


## CHG-03b: Take the run lock at step 7

**What to build:** step 7's run-lock acquire (M12 `acquire`, no takeover: the lock written
to a temporary file in `.commit-plan/` and hard-linked into place as `.commit-plan/lock`,
beside the run folder, not in it) and the atomic ordered writes, in contract order:
`state.json` first, then the lock, then `plan.json`. The `EEXIST` → `held` mapping and the
step-7 re-reads around the acquire are RUN-06's. It also builds the `internal` cleanup
these writes need: a throw before `acquire` deletes the provisional run folder; a throw
after it releases the lock and deletes the folder. The release and delete are file-system
calls and take no `timeoutMs`; RUN-12 puts the reply's tree-state read on
`cleanupDeadline`, and RUN-27 generalises which endings release the run.

**Blocked by:** CHG-03, FND-10.

**Status:** ready-for-agent

**Sources:** Q9, Q22, C:run-folder (`lock`, `state.json` and `plan.json` rows),
C:cli-and-exit-codes (`internal` row), C:plan (step 7), M12.

- [ ] Seam 1: after a `plan` call that reaches step 7, `.commit-plan/lock` exists (not
      inside the `<planId>/` run folder) holding `{ planId, created }`.
- [ ] Seam 1: two modified tracked files → `plan` stdout `hunks.hunks` lists `h1`, `h2` with path, status `M`, kind `text`, `offset`/`lines` pointing at their `### h<n> M text …` blocks in `hunks.txt`.
- [ ] Seam 1: the stored unit table holds ID, hash, path, status and kind per unit; `plan.json` `tracked` carries `bucket`, `added`, `deleted`.
- [ ] Seam 1 parser oracle: per-file added/deleted counts in `plan.json` `tracked` equal `git diff --numstat -z`.
- [ ] Seam 1: with the fault preload failing `fs.renameSync` with `EIO` for a target
      basename matching `state.json` → exit 1 `internal`, no lock file and no run folder
      left, and the call-order log records no lock link (a lock is never taken without
      `state.json` in place).
- [ ] Seam 1: with the fault preload failing `fs.linkSync` with `EIO` for a target basename
      matching the lock file → exit 1 `internal` (not `held` or `busy`), no lock file and
      no run folder left.
- [ ] Seam 1: with the fault preload failing `fs.renameSync` with `EIO` for a target
      basename matching `plan.json` → exit 1 `internal`, the lock released, no run folder
      left.
- [ ] Seam 1: with the fault preload's call-order log and no fault, the first `state.json`
      rename precedes the lock link, and the lock link precedes the `plan.json` rename;
      later `state.json` rewrites (step 8, the in-process `plan --hunks`) may follow in
      any order.


## CHG-04: Index fingerprint and tree state

**What to build:** M10 `indexFingerprint()` (hash of `git ls-files --stage -z`, read-only, no
index lock) stored by `plan`, re-read at step 7 (changed with HEAD unchanged → exit 6
`diff-changed`, domain `index-changed`), and `treeState()` → `{ clean: true } | { count,
paths }` read after the subcommand's last git call.

**Blocked by:** CHG-03b.

**Status:** ready-for-agent

**Sources:** Q11 (pass 3, 5 amendments), C:plan (step 7), M10, stories 56, 76.

- [ ] Seam 1: an index change triggered by the fixture itself between the inventory and the lock (for example a `clean` filter that, while the inventory diff runs it, stages another path outside the temporary index) with HEAD unchanged → exit 6 `diff-changed`, lock released, folder deleted.
- [ ] Seam 1: `treeState` reports `{ clean: true }` on a clean tree and the count and paths otherwise (cap applied by RPL).
- [ ] The fingerprint call works while an `index.lock` exists and never rewrites the index.


## CHG-05: Temporary index with untracked and staged-new paths

**What to build:** `inventory` gathers candidates (`ls-files --others --exclude-standard`,
after `hideFilter`), staged-new paths (with `ignored` from `check-ignore`) and pre-staged
paths; `snapshot` copies the real index into the run folder, `git reset -q` on the copy
(empty when unborn), then `git add -N` of the stored lists from stdin (ignored ones in a
separate `-f` call, missing paths skipped, any non-zero exit → `git-failed`), and diffs
against it. The real index is never written.

**Blocked by:** CHG-01, CHG-04, PRE-09.

**Status:** ready-for-agent

**Sources:** Q11 steps 1-3, C:plan, C:untracked-files, glossary "temporary index", stories 69, 70, 77, 182, M10.

- [ ] Seam 1: an untracked file → an `A` unit whose body is its whole content as `+` lines; `plan.json` `untracked.candidates` lists it with `binary`; `hidden` holds count and 5 names.
- [ ] Seam 1: a plain `mv` and a `git mv` each give one `R` unit with `oldPath`.
- [ ] Seam 1: `git add newfile` under `--split`, also on an unborn HEAD → an `A` unit; a force-added gitignored (not hidden) file → a unit, stored with `ignored: true`.
- [ ] Seam 1: on an unborn HEAD, `git add newfile && git mv newfile renamed` → one `A` unit for `renamed` (no old path survives the reset baseline to pair into an `R`, Q11).
- [ ] Seam 1: the real index (`git ls-files --stage`) is byte-identical before and after `plan`.
- [ ] Seam 1: a failing `git add -N` (a stored path made unreadable by a fixture shim) → exit 4 `git`, code `git-failed`, folder deleted.


## CHG-06: Hunk-level units from a streamed patch pass

**What to build:** the patch pass as one `git diff -z --raw -p` call with no pathspecs, read
as a stream through M2 `onStdout`, keeping only body-carrying hunks and added lines; section
*i* paired with raw record *i* (count or path mismatch → `internal`); one unit per hunk with
a hash over path, `-`/`+` lines without context and an occurrence index; identity key
stored; `hunks.txt` one block per hunk.

**Blocked by:** CHG-03b.

**Status:** ready-for-agent

**Sources:** Q11 (pass 4 amendment), C:plan-hunks, glossary "unit", stories 63-65, 67, M10, M13.

- [ ] Seam 1: a file with two separated edits → two units with their own ranges; edits within `-U3` of each other → one unit.
- [ ] Seam 1: two identical hunks in one file → distinct IDs, same identity key in the unit table.
- [ ] Seam 1: `offset`/`lines` let a `Read` of `hunks.txt` return exactly one block; the `###` line shows `<old> -> <new>` for a rename.
- [ ] Seam 1 parser oracle holds on every fixture repo of this slice.


## CHG-07: Units independent of the user's diff config and working directory

**What to build:** confirm the pinned options and `-c` pins make units independent of user
config, the working directory and path characters; case-only renames staged with `git mv`
and sparse-checkout / `skip-worktree` entries handled with no code of their own.

**Blocked by:** CHG-06, CHG-05.

**Status:** ready-for-agent

**Sources:** Q9, Q11 (Consequences, pass 9), other-repo-configurations, stories 74, 78.

- [ ] Seam 1: `diff.relative=true` with `plan` run from a subfolder → changes outside it still listed; `diff.interHunkContext=10`, `diff.noprefix`, `color.diff=always`, an external diff driver → units unchanged.
- [ ] Seam 1: paths `[id].tsx`, one with a space and one with a quote → units with the literal path.
- [ ] Seam 1: a staged case-only `git mv` → one `R` unit.
- [ ] Seam 1: cone-mode sparse checkout with an edit inside the cone, a path outside, and a `--skip-worktree` path whose file is removed → neither of the last two is a unit or in `notIncluded` (the commit-side half is asserted in CHG-20).


## CHG-08: Whole-file units: new, deleted, renamed, mode, binary

**What to build:** whole-file units per the Q11 hash table for new, deleted, renamed (old and
new path in the hash), mode changes (with or without content edits) and git-reported binary
files (path + blob IDs), each with exactly one hunk covering the file.

**Blocked by:** CHG-06, CHG-05.

**Status:** ready-for-agent

**Sources:** Q11 hash table, C:plan-hunks (`kind`), stories 68, 71, M10.

- [ ] Seam 1: `chmod +x` alone and `chmod +x` plus a content edit → one `mode` unit each.
- [ ] Seam 1: a deleted file, a renamed-and-edited file, a new binary → one unit each, `body: "none"` for the binary.
- [ ] Seam 1: the hash of a rename changes when either path changes (two fixture runs compared).


## CHG-09: Symlinks, submodule pointers, type changes and dirty submodules

**What to build:** `symlink` units (hash over old and new target), `submodule` units for a
pointer change whatever the dirt, a type change (`T`) owning two consecutive patch sections as
one whole-file unit (main and `--text` pass), and `dirtySubmodules` from
`--ignore-submodules=none --name-only` minus the pinned diff; dirt alone counts as clean.

**Blocked by:** CHG-08.

**Status:** ready-for-agent

**Sources:** Q11 (pass 8 amendment), C:plan (`dirtySubmodules`, `clean`), stories 68, 73, M10.

- [ ] Seam 1: a new symlink and a changed target → `symlink` units.
- [ ] Seam 1: a file→symlink and a file→submodule change → one `T` unit each, no `internal`.
- [ ] Seam 1: a pointer change in a submodule with untracked files inside → one `submodule` unit.
- [ ] Seam 1: dirt without a pointer change → `dirtySubmodules: ["libs/x"]`, no unit, tree clean (`nothing` once RUN's clean-tree rule is wired).


## CHG-10: Filtered files and `linguist-generated`

**What to build:** one `check-attr --stdin -z` call querying `filter` and
`linguist-generated`; a path with a `filter` attribute is a `filtered` whole-file unit hashed
and scanned in its cleaned form (`body: "none"` when the cleaned diff is binary);
`linguist-generated` goes into `stats` for M9 `summaryOnly`.

**Blocked by:** CHG-08, CHG-02, PRE-10, GIT-05.

**Status:** ready-for-agent

**Sources:** Q10, Q11, C:plan-hunks (`kind: filtered`), stories 72, M10.

- [ ] Seam 1: a `sed`-based `filter.<x>.clean` in the fixture → one `filtered` unit whose body is the cleaned diff.
- [ ] Seam 1: a path marked `linguist-generated` → `summaryOnly` reason `generated` (entry rendered by CHG-17).
- [ ] The attribute call reads paths from stdin, never argv.
- [ ] Seam 1: a decoy `GIT_ATTR_SOURCE` exported to the entry point → `check-attr` still reads the real `.gitattributes` (a `filter`-attributed path is still a `filtered` unit, GIT-05's environment hygiene holds for this call too).


## CHG-11: Attribute-hidden text files and size limits

**What to build:** for a path git reports as binary, query `diff` and `binary` in the same
`check-attr` call; only an attribute-hidden path gets the 1 MB size check (over →
`overScanLimit: true`, skipped) then the NUL check in the first 8000 bytes; a NUL-free one is a `kind: "text"` whole-file unit
with no block whose added lines come from a second streamed `git diff -z --raw -p --text`
pass, run only when such a file exists; a file over `core.bigFileThreshold` without a hiding
attribute stays binary.

**Blocked by:** CHG-10.

**Status:** ready-for-agent

**Sources:** Q10 (as amended), Q11 (pass 5), C:plan (binary rule), story 212, M10.

- [ ] Seam 1: a text file marked `-diff` in `.gitattributes` → one `kind: "text"` unit, `body: "none"`, its added lines passed to the scan (secret found once CHG-16 is wired).
- [ ] Seam 1: an attribute-hidden file over 1 MB → `scan.skipped` entry with the size reason.
- [ ] Seam 1: a NUL-free file over a lowered `core.bigFileThreshold` with no attribute → stays binary, no `--text` pass run.
- [ ] Seam 1: an attribute-hidden text file and a file→symlink change (CHG-09's `T` unit), both in the same inventory so they share the one `--text` pass → each still gets exactly one unit, no `internal` (Q11).


## CHG-12: Raw bytes and non-UTF-8 paths

**What to build:** diff output stays a `Buffer` end to end; records split on NUL, lines on
`\n` bytes; hashes over raw bytes; presentation decodes lossily. A path that is not valid
UTF-8 is not a unit; it is stored for `notIncluded` with each bad byte as `\xNN` (story 219).

**Blocked by:** CHG-06.

**Status:** ready-for-agent

**Sources:** Q11 (pass 3, 4 amendments), C:plan, M10.

- [ ] Seam 1: a Latin-1 file and a CRLF file under `core.autocrlf=false` → units whose stored hashes equal hashes of the raw bytes (a lossy decode would change them).
- [ ] Seam 1 (POSIX): a path with a non-UTF-8 byte → no unit; stored non-UTF-8 path list holds it with `\xNN` (reported in `notIncluded` by PLN-04).


## CHG-13: Count caps and collapsed directories (`split`)

**What to build:** M9 `applyCaps(candidates: {path, size, binary}[], stagedNew: {path,
ignored}[], trackedDirs: string[])` per C:untracked-files
(topmost new directory, root as `"."`, the 200 total with loose files per parent, ties by
byte order), fed by `ls-tree -r -d` for tracked directories and M10 sizes for `bytes`;
`plan.json` `untracked.collapsed` and `stagedExcluded`; collapsed paths never added to the
temporary index or scanned. It builds the table-driven fixture generator (FND has none);
RUN-17 and INT-16 reuse it.

**Blocked by:** CHG-05.

**Status:** ready-for-agent

**Sources:** Q11, Q16, Q19, C:untracked-files, testing-seams (table-driven generator), M9,
stories 154, 155.

- [ ] Seam 1 generator: directory shapes at, below and above each cap (50 per new directory, 50 root files, 200 total), asserting `collapsed` and `stagedExcluded`.
- [ ] Seam 1: the five named tests of C:untracked-files (`packages/new-lib` with 60 files, 51 in tracked `db/migrations/`, 51 root files → `"."`, 300 staged into `dist/` → `stagedExcluded`, a 60-file directory under `--staged` → no collapse).
- [ ] Seam 1: a force-added hidden staged-new file under `--split` → `stagedExcluded` with `reason: "hidden"`.


## CHG-14: Mode-aware inventory: `staged`, `indexOnly`, `unstagedLeft`

**What to build:** in `staged` the snapshot diffs the index only, `tracked` lists only
unstaged changes and `unstagedLeft` counts them (`null` in `split`/`reword`); `preStaged`
recorded; `indexOnly` paths (differing from both HEAD and the worktree) stored with their
blob ID; a hidden staged-new path under `--staged` is the `staged-hit` fact.

**Blocked by:** CHG-05, CHG-13, RUN-13.

**Status:** ready-for-agent

**Sources:** Q9, Q10, Q11 (index-only content), C:plan (`preStaged`, `unstagedLeft`), stories 83-85, 225, M10.

- [ ] Seam 1: `plan --staged` with a partial `git add -p` → units from the index only, `unstagedLeft` = count of unstaged changes, the file in both `preStaged` and `tracked`.
- [ ] Seam 1: `git add x && rm x`, a staged edit reverted in the worktree, and `git add -p` plus more edits under `--split` → `indexOnly` stored with the blob ID, no unit, no `diff-changed`.
- [ ] Seam 1: a force-added hidden file under `--staged` → `staged-hit` (exit 6); a staged 60-file new directory under `--staged` → scanned units, no collapse.


## CHG-15: `reword` snapshot

**What to build:** in `reword` the snapshot diffs HEAD against its single parent, or the
empty tree for a root commit, with the same pinned options; IDs are never staged.

**Blocked by:** CHG-06, GIT-09.

**Status:** ready-for-agent

**Sources:** Q20, C:plan-hunks (what is diffed), story 177, M10.

- [ ] Seam 1: `plan --reword` → hunk index of HEAD's own changes; on a root commit, against the empty tree.
- [ ] Seam 1: staged changes present during `plan --reword` → not in the units; real index untouched.


## CHG-16: Scan map wiring and withheld bodies

**What to build:** M8 `scanUnits` over the snapshot units (added lines up to 1 MB per file from
the stream, then every unit of the file flagged `overScanLimit: true` and skipped), the scan
map (`scanned` per unit) stored, per entry `scan` in the hunk index, `body: "none"` and no `hunks.txt` block for any unit with a hit. (`scanIgnoreUnits`,
`snapshotBlob` and the `scanIgnoreChanged` wiring move to SCN-14.)

**Blocked by:** CHG-05, CHG-06, SCN-13b.

**Status:** ready-for-agent

**Sources:** Q10, C:plan (`scan`), C:plan-hunks (scan map, body), stories 65, 89, M8, M10, M13.

- [ ] Seam 1: a hunk with a `github-token` → entry `scan: ["github-token"]`, `body: "none"`, the token absent from `hunks.txt` and stdout; the file's other hunks keep their blocks.
- [ ] Seam 1: a new file with a hit loses its whole body. (The 1 MB skip rule is SCN-13's; SCN-15 asserts `scan.skipped` at Seam 1.)
- [ ] Seam 1: a tracked file with two hunks of about 600 KB added each (over 1 MB together,
      each under it) → M10 stops collecting at the limit and flags both units
      `overScanLimit: true`; `scan.skipped` has one entry for the path with the reason
      `"added content over 1 MB"`, and a token in either hunk gives no hit. A file whose added
      content is exactly 1,048,576 bytes (raw bytes plus one per `\n`) → no flag, scanned;
      one byte more → flagged and skipped.


## CHG-17: Summary-only entries and the 3000-line body cap

**What to build:** M13 marks summary-only units (one whole-file unit, `summaryOnly[]` with
`reason`, `added`, `deleted`, no block) and applies the body cap in byte-wise path order:
the first file crossing 3000 changed lines and every later file keep per-hunk IDs with
`body: "cap"`, `range`, `added`, `deleted`, `lines`/`offset` `null`.

**Blocked by:** CHG-16, CHG-02, PRE-15.

**Gates:** Story 65's wording (summary-only entries carry no kind or range) is settled first.

**Status:** ready-for-agent

**Sources:** Q19, C:summary-only-files, C:plan-hunks, story 65, M13.

- [ ] Seam 1: a `package-lock.json` change → one `summaryOnly` entry with reason `lockfile`; its content still scanned.
- [ ] Seam 1: the 3000-line cap sums changed lines of the files that are not summary-only only; a lockfile of 2000 or more changed lines (summary-only, sorting before the code files in byte-wise path order) does not count toward the cap.
- [ ] Seam 1: fixtures at 3000 and 3001 cumulative changed lines of non-summary-only files → the crossing file and all later files `body: "cap"` with their own IDs and ranges; earlier files keep blocks.


## CHG-18: Stdout budget and spill to `hunks.json`

**What to build:** M13 keeps `plan --hunks` stdout within 20 000 characters; past it the full
index goes to `hunks.json` (one entry per line) and stdout carries `hunksIndexFile` instead of
`hunks` and `summaryOnly`; `config` carries `values` without `scanIgnore`.

**Blocked by:** CHG-17, PRE-08.

**Status:** ready-for-agent

**Sources:** Q9, Q19, Q24, C:plan-hunks, story 228, testing-modules "Other checks" size fixtures.

- [ ] Seam 1 size fixture: a diff whose index would exceed the budget → stdout ≤ 20 000 characters, `hunksIndexFile` absolute, `hunks.json` holds every entry.
- [ ] Seam 1: `plan --hunks` stdout has no `scanIgnore` key in `config`.
- [ ] Seam 1 size fixture: `plan`'s own fields ≤ 1 kB excluding `hunks` and `reply`.


## CHG-19: Re-snapshot from stored lists and ID matching

**What to build:** a separate `plan --hunks` (and later `check`/`commit`) rebuilds the
temporary index from the **stored** lists, re-diffs and runs `matchIds(idMap, units)`
(typed, `unmatched`): the same hash set → `plan`'s IDs, any difference → `diff-changed` with
the map unchanged. It builds the separate `plan --hunks --plan <id>` workflow.

**Blocked by:** CHG-05, CHG-06, RUN-04, RUN-06.

**Status:** ready-for-agent

**Sources:** Q9, Q11, C:plan-hunks, stories 58, 64, 76, M10.

- [ ] Seam 1: a file edited between `plan` and a separate `plan --hunks` → exit 6 `diff-changed`, map unchanged, nothing committed.
- [ ] Seam 1: a manual commit between `plan` and a separate `plan --hunks` → exit 6 `head-moved`, run ended.
- [ ] Seam 1: a stored untracked path deleted after `plan` → `diff-changed`; a new untracked file created after `plan` → ignored (same IDs).
- [ ] Seam 1: a force-added gitignored file is still a unit on the re-snapshot (stored lists, not recomputed).


## CHG-20: Hunk staging into the real index

**What to build:** M10 `stage(groupUnits)`: reset the real index, build a patch from the
**current** ranges reusing git's own per-file header lines verbatim followed by the group's
raw hunk bytes, `git apply --cached --whitespace=nowarn`, then verify the staged hash set
(`mismatch`); `unstagedAfterReset(preStaged, indexOnly)`.

**Blocked by:** CHG-06, CHG-19, INT-02, EXE-04, GIT-05, CHG-07.

**Status:** ready-for-agent

**Sources:** Q11, Q18, C:commit-release, stories 64, 67, 162, M10.

- [ ] Seam 1: three hunks of one file in two groups → group 2's hunks staged at their shifted ranges after group 1 committed; each commit holds exactly its hunks.
- [ ] Seam 1: a trailing-whitespace hunk under `apply.whitespace=error` → committed as planned.
- [ ] Seam 1: paths with quotes, tabs and (POSIX) newlines split into two groups → committed through the built patch.
- [ ] Seam 1: the sparse-checkout fixture of CHG-07 committed → the out-of-cone and `skip-worktree` paths keep their HEAD content.


## CHG-21: Whole-file staging edge cases and `stage-failed`

**What to build:** whole-file units staged with `git add -A` from stdin (both paths of a
rename; ignored paths in a separate `-f` call; a non-zero exit → `stage-failed` even when some
paths were added); `stage-failed` after the reset leaves the index unstaged and the run
released.

**Blocked by:** CHG-20, CHG-10, PRE-10.

**Status:** ready-for-agent

**Sources:** Q11, Q18, C:commit-release, stories 72, 77, M10.

- [ ] Seam 1: a `sed` clean filter file committed → the staged blob is the cleaned form and its hash matches the plan.
- [ ] Seam 1: a force-added gitignored file committed in group 2.
- [ ] Seam 1: `core.safecrlf=true` rejection and a required filter that is missing → `stage-failed`, index unstaged, run released.
- [ ] Seam 1 (Windows): a rename group of a few thousand paths that would exceed the command-line limit on argv → committed.
- [ ] Seam 1: a pointer change in a submodule with untracked files inside (CHG-09), and a staged 60-file new directory under `--staged` (CHG-14), each committed (Q11).


## CHG-22: Byte-exact commits across line-ending settings

**What to build:** proof that raw-byte hashing and staging commit exactly the working-tree
bytes, and that git's converted form is used with `core.autocrlf` and `eol` attributes.

**Blocked by:** CHG-20, CHG-12.

**Status:** ready-for-agent

**Sources:** Q11 (pass 4 amendment), stories 75, testing-modules Q11 case list.

- [ ] Seam 1: a Latin-1 file and a CRLF file under `core.autocrlf=false`, each split into two groups → committed blobs equal the working-tree bytes.
- [ ] Seam 1: CRLF content with `core.autocrlf=true` and a `.gitattributes` `eol=crlf` file → no mismatch, committed.


## CHG-23: Guarded `git commit` and the stale `index.lock`

**What to build:** M10 `commitGuarded({ args, input, timeoutMs, partial })`: resolves
`index.lock` through M2 `gitPath`, brackets the spawn and a timeout's tree kill with two
marker files; with `partial` removes a leftover lock only when its mtime lies between the
markers; without it never removes the lock and reports `lockLeft`; reuses `indexLockExists()`
(built in EXE-08) for the `index-lock` refusal.

**Blocked by:** CHG-20, GIT-07, GIT-06, EXE-08, EXE-17, EXE-20, FND-05.

**Status:** ready-for-agent

**Sources:** Q18, C:commit-release, story 166, 215, M10, testing-modules Q11 case list.

- [ ] Seam 1 (reword): a sleeping hook that records that `index.lock` exists, clock stepped to 535 s → after the kill the lock is removed; a lock another process created after the kill is kept.
- [ ] Seam 1: a lock whose mtime lies at or after the first marker's mtime minus 2 seconds and strictly below the second marker's is removed as stale; one just before that lower bound is kept (Q18).
- [ ] Seam 1 (split): a sleeping hook that creates `index.lock` → after the kill the lock is still there and the notices carry "index.lock was left in place — …".
- [ ] Static: a grep over the source tree finds no reference to a marker file or to `index.lock` outside M10's own source file.
