# Q11 Atomic commits by functionality

- **Context.** Splitting by top-level directory flags almost every change in a layout where
  code, tests and docs live in separate folders. The goal is atomic commits by functionality,
  across folders, which is semantic.
- **Decision.** Grouping is Claude's job. The script supplies buckets (`code`, `test`, `docs`,
  `ci`, `build`) as hints only. Hunk-level staging:
  - `plan` mints opaque unit IDs (`h1…hN`) from the diff it scans (Q9, Q10), and
    `plan --hunks` returns the hunks under those IDs. Each unit has a content `hash` over the
    path, the hunk's `-` / `+` lines without context, and an occurrence index for identical
    hunks in one file. Context is left out on purpose: it changes once a neighbouring hunk is
    committed.
  - Identical hunks (same path, same `-` / `+` lines) must have the same placement: all in
    one group, or all in `notIncluded`. `check` rejects anything else ("h3 and h5 are
    identical; place them together") and the worker's lint retry fixes it. So the
    occurrence index is only used while every copy is uncommitted, and it never shifts.
  - The `id → hash` map is kept in the state file of the run folder (Q9); `planId` is only
    its key.
  - Untracked files go through a **temporary index**, so they diff like tracked ones and the
    user's index is never touched. One function builds the diff for `plan --hunks`, the
    `plan` scan and `commit` in `split` mode:
    1. Copy the real index to `git-index` in the run folder and `git reset -q -- .` the copy
       (`GIT_INDEX_FILE`), so it matches HEAD and keeps its stat cache. The pathspec form
       writes no ref: a bare `git reset -q` would move the user's `ORIG_HEAD`, append a HEAD
       reflog entry, take `HEAD.lock` and delete `MERGE_MSG`/`SQUASH_MSG`, even with
       `GIT_INDEX_FILE` set. Every reset in this plugin, on the real index too, uses this
       form. On an unborn HEAD the copy starts empty.
    2. `git add -N` into the copy: the untracked candidates, and the **staged-new** paths,
       i.e. every path the real index adds relative to HEAD (`git diff --cached
       --ita-visible-in-index --no-renames --name-only --diff-filter=A -z`; on an unborn
       HEAD, every path in the real index). `--ita-visible-in-index` keeps the user's own
       intent-to-add (`git add -N`) entries, which a plain `diff --cached` hides.
       Step 1 dropped the staged-new paths from the copy, and `ls-files --others` does not
       list them because the real index tracks them, so without this they would be in
       neither list and vanish. Staged-new paths go through the same hidden and collapse
       rules as untracked files ([contracts](../contracts/untracked-files.md)), counted
       together with the candidates. Hidden files and collapsed directories are never added,
       and neither is a stored path missing from the working tree (`git add -N` would fail
       on it): the hash match decides what its absence means. Paths stored with
       `ignored: true` go in a separate `git add -N -f` call, so no other ignored path is
       added. A non-zero `git add` exit is a failure (`git-failed`) even when some paths
       were added.
    3. Run the pinned diff (below) against the copy.

    The copy is never built from HEAD alone: it is always the real index, reset, then
    extended with the intent-to-add entries, so it keeps the stat cache and the
    sparse-checkout entries; built from HEAD, out-of-cone sparse-checkout paths would show
    as deleted. A path whose bytes are not valid UTF-8 is not a
    unit: it goes to `notIncluded` ("path is not UTF-8 — commit by hand"), written with
    each non-UTF-8 byte as `\xNN`, since the state file and the reply carry paths as
    strings. `plan` also records an index fingerprint (a hash of `git ls-files --stage -z`,
    read-only, no index lock); when it changes between inventory and the lock while HEAD
    is unchanged, `plan` refuses with `index-changed` (CLI kind `diff-changed`).

    `plan` computes the two lists (candidates, staged-new paths that pass the rules) once and
    stores them in the state file, each staged-new path with an `ignored` flag
    (`git ls-files --cached --ignored --exclude-standard`, which lists index entries an
    ignore rule matches; `git check-ignore` reports a tracked path as not ignored and
    refuses `GIT_LITERAL_PATHSPECS=1`). `plan --hunks` and `commit` rebuild the copy from the **stored**
    lists and never recompute them: `commit` resets the real index first, so afterwards no
    path is staged-new any more, and a force-added gitignored path (`git add -f
    build/config.js`) is not listed by `ls-files --others --exclude-standard` either. It
    would vanish, and every such run would end in `diff-changed`. A stored path deleted
    after `plan` changes the hash set, so it is `diff-changed`; an untracked file created
    after `plan` is in neither list and is left for the next run.

    A new file becomes an ordinary `A` unit with a real hunk and an ordinary hash. A plain
    `mv` (not `git mv`) is paired into one `R` unit by git's own `-M`, with the same rules in
    `plan` and `commit`, so the old and new path cannot land in different groups. A `git mv`
    is the same case: step 1 turns it into a deleted old path, step 2 adds the new path.

    A staged-new path that the hidden or collapse rule excludes (`git add -f .env.local`, an
    agent's `git add -A` over 300 files in `dist/`) is not a unit: the worker never sees it,
    and `check` adds it to `not included` ("`.env.local` was staged but is hidden — commit by
    hand; committing this plan unstages it", "N staged new files in dist/ — commit by hand;
    committing this plan unstages them"). The unstaging happens in `commit`'s reset, so
    `check`'s note says what confirming will do; after `no` or zero groups the index is
    untouched and the path stays staged. A staged-new **unit** that the worker puts in
    `notIncluded` gets the same note, and when it is gitignored (`ignored`) also "…and
    .gitignore then hides it from `git status`". `commit`'s final output lists every
    pre-staged path the run leaves unstaged (Q18). Nothing is dropped silently, and staging a
    file does not get it past the hidden rule (agents stage too, Q16). In `staged` mode a
    hidden staged-new path makes `plan --staged` refuse with `staged-hit` (Q10): a set is
    committed as-is and cannot leave it out. The collapse rule does not apply in `staged`.

    **Index-only content** (`split`): the real index can hold a version that is in neither
    HEAD nor the working tree: `git add x && rm x`, a staged edit later reverted in the
    working tree, or `git add -p` followed by more edits. `commit`'s reset drops it, and it
    survives only as a dangling blob. `plan` stores every path whose index entry differs
    from both HEAD and the working tree (`git diff --cached --name-only` ∩
    `git diff --name-only`, both `-z --no-renames`) and that has an index entry as
    `indexOnly`, with the index blob ID (a `git rm --cached` loses nothing).
    `check` adds a notice per path ("x: the staged version differs from your working tree;
    committing this plan discards it — recover with `git cat-file -p <blob>`"), and
    `commit`'s `unstaged` output lists these paths whether or not they still differ from
    HEAD (Q18). Nothing is refused and nothing is asked: the path reaches `split` only
    through a mode choice or a subagent's `--split` (an index that differs from the working
    tree always means "index plus other changes", Q9), and the blob stays recoverable until
    `git gc` prunes it (two weeks by default). A staged-new path missing from the working
    tree is not a unit (step 2), so it cannot turn every run into a false `diff-changed`.
  - `commit`, for each group, rebuilds the temporary index from the stored lists, recomputes the
    diff and matches the group's hashes, all without touching the real index (the copy is
    a reset copy of the real index plus the lists; the real index itself is only read). A
    missing hash refuses the
    run: "files changed since plan, run /commit again", and the user's index is as they
    left it. Only then does it reset the real index, build the patch from the **current**
    hunks (current ranges) and run `git apply --cached --whitespace=nowarn` on it (Q18).
  - Every diff the script runs uses pinned options: `--no-ext-diff --no-color --no-textconv
    --no-relative -U3 --inter-hunk-context=0 --indent-heuristic -M --diff-algorithm=myers
    --ignore-submodules=dirty --submodule=short --src-prefix=a/ --dst-prefix=b/ --full-index` and
    `-c core.quotePath=false -c diff.suppressBlankEmpty=false -c diff.autoRefreshIndex=true`,
    from the toplevel (Q9). `--whitespace=nowarn` keeps `apply.whitespace=error|fix` from
    rejecting or changing what was planned and scanned. `diff.autoRefreshIndex=true` keeps a
    merely stat-dirty tracked file (mtime touched, content unchanged) from leaving a raw
    record with no patch section once a read-only call cannot refresh the index itself
    (`GIT_OPTIONAL_LOCKS=0`, an `index.lock` held by another process); without the pin a
    user's `diff.autoRefreshIndex=false` turns that into a raw-record/patch-section count
    mismatch (`internal`). `--submodule=short` keeps a user's `diff.submodule=log` or `=diff`
    from changing how a submodule pointer record's patch section renders (and, under `=diff`
    with exactly one changed file inside, from a silent mis-pairing once submodule records
    stop throwing, CHG-09): every record gets exactly one patch section under `short`.
    Left to the user's config because the script does not depend on it: `diff.orderFile`
    (every list is sorted by the script itself, Q19).
  - Path lists never go on argv: staging, attribute and index calls (`git add -N`,
    `git add -A`, `check-attr`, `update-index`) read them from stdin with NUL separators
    (`--pathspec-from-file=- --pathspec-file-nul`, `check-attr --stdin -z`,
    `update-index -z --stdin`). A rename group of a few thousand paths would otherwise exceed
    the Windows command-line limit after the real index was reset, and a `-z` list carries
    any path byte for byte.
  - Whole-file units, staged with `git add -A` (literal pathspecs, Q9; both paths of a
    rename; paths on stdin; ignored paths in a separate `git add -A -f` call, and a non-zero
    exit is `stage-failed` even when some paths were added) and never split across groups:

    | Change | Hash input |
    | --- | --- |
    | new, deleted, binary, summary-only file | path + `-` / `+` lines (binary: path + blob IDs) |
    | **renamed** file | old and new path + `-` / `+` lines |
    | mode change (`chmod +x`), with or without content edits | path + old and new mode + `-` / `+` lines |
    | symlink added, changed or type change (`T`) | path + old and new target |
    | submodule pointer (gitlink) | path + old and new commit ID |
    | file with a `filter` attribute (`git check-attr filter`: LFS, git-crypt, `nbstripout`) | path + `-` / `+` lines of the cleaned form (binary: path + blob IDs) |

    A mode change goes whole-file even with content edits: a hunk patch without the mode
    header drops the mode change silently on `git apply --cached`. A filtered file goes
    whole-file because `git apply --cached` writes the cleaned blob without running the
    filter: for LFS the pointer lands in the index but the object never reaches
    `.git/lfs/objects`, so the push has nothing to upload. `git add` runs the filter, and
    the staged diff then equals the cleaned diff that was hashed and scanned. A symlink
    target is scanned as an added line; a gitlink is not scanned.
    `--ignore-submodules=dirty` keeps a submodule's own working tree (edits, untracked
    build output) out of the diff: a pointer change is a unit whatever the dirt, and
    `git add` stages the pointer only. Dirt without a pointer change is not a unit: `plan`
    lists it in `dirtySubmodules` (the submodule paths that
    `git diff --ignore-submodules=none --name-only` lists and the pinned diff does not),
    and `check` adds it to `not included` ("libs/x has uncommitted changes inside —
    commit inside the submodule first"). Dirt alone leaves the
    tree `clean` (Q16).
  - Changes that `-U3` merges into one hunk stay one unit.
  - Other repo configurations need no code of their own, because units come from git's diff:
    - `core.autocrlf` and `eol` attributes: git's diff already compares the converted
      content, and `git apply --cached` and `git add` stage it in git's converted form, so
      line endings never cause a mismatch. Conversion warnings on stderr are not errors; a
      `core.safecrlf=true` rejection after the reset is a staging failure (Q18).
    - Case-only renames: a staged `git mv` is one `R` unit on a case-sensitive filesystem
      with `core.ignorecase=false`. With `core.ignorecase=true` or on a case-insensitive
      filesystem the temporary index cannot plan it, and `split` refuses (exit 6 `state`,
      `case-rename`) naming each rename, for the user to commit by hand (CHG-07 decision,
      below). An unstaged case-only rename on a case-insensitive filesystem is invisible to
      git and not planned.
    - Sparse-checkout and `skip-worktree` entries never appear in the diff and are never
      units.
  - The worker `Read`s nothing outside the run folder except a working-tree file at a line
    range, when a hunk needs more context (Q19), and never a file that has a scan hit, so
    it cannot recover a unit whose body was withheld for a hit (Q10).
  - Binary is decided by content: a path git reports as binary is binary only when its new
    content has a NUL byte in its first 8000 bytes. Otherwise a `-diff` or `binary`
    attribute hid a text file: it has `kind: "text"`, is one whole-file unit (staged with
    `git add`) with a `body` like a summary-only file's, and its added lines are still
    scanned through a `--text` diff (Q10).

  One `commit --all` call commits the groups in order; per group: reset the index, stage,
  commit. A pre-staged set
  (`staged` mode, Q9) is committed as-is and never regrouped; other unstaged changes are left
  untouched and reported in the reply's tree state ("N files left: …"). In `--split` mode a
  pre-staged set is reset like any other index and planned with the rest; a staged new file
  stays a unit and a `git mv` rename comes back as the same `R` unit through step 2 of the
  temporary index. Delivered in two slices: file-level
  grouping first, hunk-level staging second. In the file-level slice `check` resolves the
  worker's paths to units itself; an `R` unit is named by its **new** path only, in `files`
  and in `notIncluded` alike ("use the new path src/b.js for the rename of src/a.js").
- **Amended.** By spec pass 2 (2026-09-27): path lists on stdin, never on argv;
  line-ending conversion, case-only renames, sparse-checkout and `skip-worktree` entries;
  the worker's `Read` limit; the per-group temporary index recorded as deferred.
- **Amended.** By spec pass 3 (2026-09-27):
  - The temporary index is a reset copy of the real index extended with intent-to-add
    entries, never built from HEAD; the old `commit` note that it was built from HEAD
    plus the lists contradicted step 1.
  - The index fingerprint (`git ls-files --stage -z`) and its `index-changed` refusal
    (CLI kind `diff-changed`) at `plan`'s lock.
  - A path that is not UTF-8 goes to `notIncluded` with `\xNN` escapes (accepted gap:
    such paths are never planned).
  - Binary decided by content; an attribute-binary text file is a whole-file `text` unit
    whose added lines are still scanned (also Q10).
  - Paths with `ignored: true` in separate `git add -N -f` (`snapshot`) and `git add -A -f`
    (`stage`) calls; a non-zero `git add` exit is a failure (`git-failed`, `stage-failed`)
    even when some paths were added, since a partial add would commit a different set.
  - The worker `Read`s nothing outside the run folder except a working-tree file at a line
    range, never a file with a hit.
  - The per-group temporary index stays deferred past 0.1.0 (see [Non-goals](non-goals.md)).
- **Amended.** By spec pass 4 (2026-09-27):
  - The pinned list above is complete: no `--full-index` (text hunks go through
    `git apply --cached`, which needs no full blob IDs; binary files are whole-file adds)
    and no pinned rename limit. `diff.renameLimit` is left to the user's config like
    `diff.orderFile`: `plan` and `commit` read the same limit, so a skipped rename detection
    yields the same delete-plus-add units on both sides.
  - Content keeps its raw bytes: diff output stays a `Buffer`, and hunk bodies, unit hashes
    and built patches use the raw bytes; only presentation (the worker's hunk text, the
    reply) and the scanner decode, lossily, and none of them feeds a hash or a patch. A
    lossy decode in the hash would let a corrupted Latin-1 or CRLF commit pass the match.
  - A `\ No newline at end of file` marker counts toward the hash only when it directly
    follows a `-`/`+` line; the same marker can follow an unchanged context line whose last
    line lacks a trailing newline on both sides, and that occurrence is excluded from the
    hash like the rest of the context.
  - The patch pass is one `git diff -z --raw -p` call; its patch sections pair with its raw
    records by position, checked by counting `diff --git` header lines against the records
    (a mismatch is `internal`), so no path is parsed out of patch text and no call per path
    is needed. It runs over the whole diff with no pathspecs: `git diff` has no
    `--pathspec-from-file`, so a path list would go on argv and could pass the Windows
    command-line limit, and a pathspec narrows rename detection (and what counts against
    `diff.renameLimit`), so its records could differ from the raw pass. The output is read
    as a stream and only what a later step needs is kept: hunks of units that carry a body
    and, for the scan, added lines up to the 1 MB limit (Q10), past which the section is
    dropped. Retained memory is bounded by the existing caps (256 KB and 1000 changed lines
    per body-carrying file, Q19; 1 MB of scanned additions per file); binary and submodule
    sections are one line each; git already computes the same diff for `--numstat`, and the
    call's deadline bounds the time.
    - Rejected: pathspecs batched under an argv byte budget. Batching costs several spawns,
      and every batch would need both paths of a rename and would still see a different
      rename-limit count.
  - The patch for `git apply --cached` reuses git's own per-file header lines verbatim, so
    a path with quotes, tabs, newlines or leading spaces is quoted exactly as git quotes it.
  - Tests add a Latin-1 file and a file with CRLF content under `core.autocrlf=false`, each
    split into two groups and committed byte for byte.
- **Amended.** By spec pass 5 (2026-09-27):
  - `commit` re-reads the index fingerprint (`git ls-files --stage -z`, hashed as `plan`
    does) before each group and refuses with `index-changed` (CLI kind `diff-changed`) when
    it differs from the one stored in the run state, so staging the user made between `plan`
    and `commit`, or between groups, is never silently lost from the report; the stored
    fingerprint is updated after each of the run's own commits and unstages, and groups
    already committed stay committed (Q9 makes the matching per-group check at the same
    point).
  - The index fingerprint sees an intent-to-add entry and a staged empty file alike (both
    hash as the empty blob) — an accepted gap: a switch between the two is not refused as
    `index-changed`.
  - Added lines of a text file that a `-diff` or `binary` attribute (or a custom `diff`
    driver) marks binary are read by a second whole-diff `git diff -z --raw -p --text` pass,
    run only when at least one such file exists; the pass is streamed like the first, keeping
    only those files' sections and discarding the rest as it arrives, with the same rename
    detection as the main diff, and the file list that picks out which sections to keep is
    never passed to git on argv.
- **Amended.** By spec pass 8 (2026-09-27): a type-change (`T`) record (file↔symlink,
  file↔submodule) owns two consecutive patch sections with its path, since git prints a
  delete and then a new file for it (checked with `git diff --cached --raw -p`); it is one
  whole-file unit, in the main and the `--text` pass alike. Pairing one section per record
  would have ended every run with a type change as `internal`.
- **Amended.** By spec pass 9 (2026-09-27): the tests also cover a cone-mode sparse
  checkout with a path outside the cone and a path marked `--skip-worktree` whose
  working-tree file is removed: neither is a unit or in `notIncluded`, and neither is
  committed as a deletion. The pass 2 rule that such entries are never units had no test,
  although out-of-cone paths are the failure a temporary index built from HEAD would show.
- **Amended.** By the CHG-07 decision (2026-10-03): a staged case-only rename (`git mv
  readme.txt README.txt`) is not planned on a case-insensitive filesystem. The temporary
  index loses it: with `core.ignorecase=true`, `git add -N README.txt` matches the reset
  copy's `readme.txt` entry and adds nothing, and the old path still exists for `lstat`,
  so the worktree diff reports no deletion either; `plan` emitted zero units with no error
  and the rename silently vanished. Decision: fail closed. In `split`, when a staged-new
  path (a hidden one included: its old path's deletion would be lost the same way) and a
  tracked path differ only in case (`toLowerCase`), and `core.ignorecase` is
  true or `lstat` of the old path finds the new path's file (same device and inode),
  `plan` refuses at step 4, after the mode decision (only when it resolves to `split`, so
  a mixed index gets its `modeChoice` first) and before the caps, with exit 6 `state`,
  domain code `case-rename`, naming the renames (C:cli-and-exit-codes recorded text).
  Both triggers are checked because each alone breaks the snapshot: `core.ignorecase` is
  what git's own index matching obeys (git sets it at `init` by probing the filesystem,
  and a repo copied across systems keeps a stale value), while the `lstat` identity is the
  filesystem itself, read on the pair's own paths with nothing written. On a
  case-sensitive filesystem with `core.ignorecase=false` the rename stays one `R` unit.
  `staged` mode commits the index as-is and `reword` takes no snapshot, so neither needs
  the check. Full support (planning the rename through the temporary index) may come
  later ([out of scope](../spec/out-of-scope.md)).
- **Amended.** By the CHG-08 decision (2026-10-03):
  - `--full-index` joins the pinned list above: a binary unit hashes its path and blob IDs,
    which come from the patch's `index` line (the raw record shows zeros for a worktree
    side), and only full IDs keep that hash stable, since an abbreviation lengthens as the
    object count grows (`gc --auto` after a group's commit) and depends on `core.abbrev`.
  - The whole-file hash (the table above) opens with the unit's one-letter status (`A`, `D`,
    `M` or `R`) and a NUL, before any path, mode or blob bytes. Without it, a pure rename
    hashes `old path, NUL, new path, NUL`, which can read byte for byte the same as another
    status's own framing when a path happens to be spelled like that framing's marker — for
    example a rename to a path literally named `mode 100644 100755` hashes the same as a
    `chmod` of the unchanged path, and a rename to `blob <id> <id>` the same as a binary
    edit. The status tag, fixed and never containing NUL, rules this out for every pair of
    statuses, not only the one found.
  - A git-reported-binary file with a mode change is still `kind: "binary"`, hashing its
    mode and its blob IDs; its body is `none` either way, like any binary unit with no
    hunks. A unit with no hunk at all (mode-only, binary, empty new/deleted, pure rename)
    has range `-0,0 +0,0`.
- **Rejected.**
  - A top-level-directory split rule; dropping split detection.
  - Hunk IDs of the form `file#n`: they collide with paths containing `#`, spaces or commas.
  - A whole-diff check per group: the diff changes after the first group is
    committed, so every multi-group run would refuse.
  - Splitting a rename across groups (rename in one, later edits in another): much more code
    for a rare case.
  - Matching identical hunks without the occurrence index ("take the first k remaining"):
    can stage the copy at the wrong place, so an intermediate commit changes the wrong
    function without any error.
  - Refusing mode-only changes, symlinks or submodule pointers: all are ordinary commits.
  - Hashing new files straight from their content, outside git's diff: a plain `mv` stays
    `D` plus a new file, and the worker could put the halves in different groups.
  - `git add -N` on the real index: changes the user's index, and an aborted run leaves
    intent-to-add entries that make the next run a pre-staged set.
  - Listing new paths with `ls-files --others --exclude-standard` against the reset copy
    (one rule for staged and untracked): a force-added gitignored file is excluded by
    `--exclude-standard`, so it would still vanish silently.
  - Letting staged-new paths bypass the hidden and collapse rules because someone staged
    them: an agent's `git add -A` would push `.idea/` or `dist/` into the grouping.
  - Recomputing the candidate and staged-new lists in `commit`: its own reset has already
    unstaged the staged-new paths.
  - Resetting the real index before the hash match: the most likely `diff-changed` (a typo
    fixed while reading the confirmation) threw away the user's staging with nothing
    committed.
  - Turning index-only content into a `modeChoice` or a refusal under `--split`: the common
    case is `git add -p` plus more edits, where nothing of value is lost, and the user or
    subagent already chose to plan everything. The blob ID makes the rare real loss
    recoverable.
  - Relying on `diff.interHunkContext` and `diff.indentHeuristic` being shared by every call
    in one run: true, but they decide what a unit is, and pinning them makes the tests
    independent of the runner's config.
  - Requiring a submodule with a dirty working tree in `not included`: `git diff` also calls
    a submodule dirty when it only holds untracked files, so a pointer update next to build
    output inside could never be committed, although `git add <submodule>` commits the
    pointer fine.
  - Deferred, not spiked: committing each group from its own temporary index (built from
    HEAD plus the group's units, committed with `GIT_INDEX_FILE`) instead of resetting and
    restaging the shared real index. It would leave the user's index alone during a run;
    recorded as considered and deferred, since it has not been spiked (how repo hooks and
    filters behave against an alternate index is unverified).
- **Consequences.** Tests must cover a multi-group run where later hunks of a partly committed
  file shift, changes merged into one hunk, identical hunks in one file (same group, and
  split or one copy in `notIncluded` → `check` error), new, deleted and renamed files, a
  plain `mv` paired into `R`, a new file committed in a later group, a `git mv` and a
  `git add newfile` under `--split` (and on an unborn HEAD), a force-added hidden file and a
  staged collapsed directory under `--split` (→ `not included`), a force-added hidden file
  under `--staged` (→ `staged-hit`) and a staged 60-file new directory under `--staged`
  (→ scanned and committed), a force-added gitignored file that is not hidden committed in
  group 2 (stored lists), a staged-new unit left in `notIncluded` (unstaged note),
  index-only content under `--split` (`git add x && rm x` → no unit, no `diff-changed`,
  notice and `unstaged` entry with the blob; a staged edit reverted in the working tree →
  the same; `git add -p` plus more edits → the same), a file edited between `plan` and the
  first `plan --hunks` (→ `diff-changed`, nothing committed), `diff-changed` on group 1
  (→ the real index untouched, `unstaged: null`), binary files (whole file only), mode-only
  and mode-plus-content changes, symlinks, a file→symlink and a file→submodule type change
  (`T`: one whole-file unit), submodule pointers, a pointer change in a
  submodule with untracked files inside (committed), dirt without a pointer change (report
  line, tree `clean`), a trailing-whitespace hunk under `apply.whitespace=error`, a file
  with a clean filter (a `sed`-based `filter.<x>.clean` in the test repo: whole-file unit,
  staged with the filter applied, scanned in its cleaned form), `diff.relative=true` with
  `plan` run from a subfolder (changes outside it still listed),
  `diff.interHunkContext=10` (units unchanged), CRLF content with `core.autocrlf=true` and
  a `.gitattributes` `eol=crlf` file (no mismatch), a staged case-only `git mv` (one `R`
  unit on a case-sensitive filesystem, the `case-rename` refusal otherwise), and on
  Windows a rename group of a few thousand paths that would exceed the command-line limit
  on argv (committed).
