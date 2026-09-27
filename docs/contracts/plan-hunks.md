# plan --hunks

Run by the worker as `plan --hunks --plan <planId>` on every respawn with `resume`
([worker input](worker-input.md)); on the first spawn `plan` runs it in its own process (not
with `--dictated`). Resets `lintFailures` in the state file. Run as a separate call (only a
`resume` does that), it also sets `resumed: true`, so the next `check` in an interactive run
always asks (Q16); the in-process run inside `plan` does not. The in-process run reuses the
units `plan` just built and scanned instead of taking the diff again; only a separate call
snapshots again and matches the stored `id → hash` map. A hunk index on stdout, plus only
what the worker needs from `plan`: `runDir`, `mode`, `config.values` without `scanIgnore`,
`recentSubjects` and counts. No file lists (`tracked`, `untracked`, `stagedExcluded`): the
index covers every unit. The bodies go to `hunks.txt` in the [run folder](run-folder.md):

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
- `body`: `file` (block in `hunks.txt`), `cap` (past the [cap](summary-only-files.md): no
  block, but its own ID, range and `added` / `deleted` counts, so the worker can still
  split the file by ranges or `Read` the working-tree file at a range), `none` (binary,
  submodule, summary-only, an attribute-binary text file, and every unit with a pattern
  hit).
- Stdout budget: 20 000 characters for the whole output. When it would be exceeded, the
  full index is written to `hunks.json` (one entry per line) and stdout keeps everything
  else, with the absolute `"hunksIndexFile"` in place of `hunks` and `summaryOnly`.
- Failure: the usual failure shape with `reply`. The worker then writes nothing and
  returns the reply ([worker input](worker-input.md)).
- Refuses (exit 6, `lock`) unless the run lock holds this `planId`. Takes no lock itself.
  Refuses with `head-moved` when HEAD differs from the state file.
- What is diffed depends on the state file's `mode`: `split` the worktree against HEAD
  through the temporary index (Q11: real index copied and reset, the candidate and
  staged-new lists **stored by `plan`** added with `git add -N`; never recomputed), so a
  new file, staged or not, is an `A` hunk and a plain `mv` or a `git mv` an `R` unit;
  `staged` the index only; `reword` HEAD's own diff against its single parent, or against
  the empty tree for a root commit (merge commits are refused by `plan --reword`; its IDs
  are never staged); `reword` also returns the old message as `oldMessage`. A stored path
  missing from the working tree is not added to the temporary index; the hash match below
  decides.
- Scan map, written by `plan` (Q10): every scan hit and skipped file mapped to the unit that
  holds it (`"scanned": { "h4": ["github-token"], "h9": "skipped" }`), with the units flagged
  for a `scanIgnore` change (`"scanIgnoreUnits": ["h2", "h3"]`). The test compares the
  `scanIgnore` patterns read at HEAD with the ones parsed from the repo config on the
  snapshot side (a missing file or key is no patterns; compared in order; content that is
  not valid JSON, or a `scanIgnore` that is not an array of strings, counts as changed).
  When they differ, every unit of the repo config file (its path or old path) is flagged,
  since a whole-file comparison cannot tell which hunk carries the change; when they are
  equal, as when only another repo-config key (e.g. `maxSubjectLength`) was edited, the list
  is empty. The hunk index carries the same as
  `"scan": ["github-token"]` or `"scan": "skipped"` per entry, so the worker can put a hit
  in `notIncluded` on the first try.
- Every run for a `planId`, the first one included (then every respawn for `edit` or
  `one`): re-diffs
  and compares with the `id → hash` map `plan` stored. The same hash set → `plan`'s IDs are
  emitted; any difference → exit 6 `diff-changed`, map unchanged. `plan --hunks` never
  writes the map or the scan map.
- `id`: opaque, `h1…hN`, minted by `plan`, valid only for this `planId`. A whole-file unit
  (Q11: new, deleted, binary, renamed, summary-only, mode change, symlink, submodule
  pointer, a file with a `filter` attribute, an attribute-binary text file) has exactly one
  hunk covering the whole file.
- `kind`: `text`, `binary`, `mode` (mode change, with or without content), `symlink`,
  `submodule` (a pointer change only; dirt inside the submodule is ignored by the pinned
  `--ignore-submodules=dirty` and reported in `plan.dirtySubmodules`), `filtered` (a
  `filter` attribute: whole file, body = the cleaned diff, `body: "none"` when that is
  binary; staged with `git add`). An attribute-binary text file (git reports it as binary
  through a `-diff` or `binary` attribute or a custom `diff` driver, but its new content has no NUL byte in the first
  8000 bytes, [plan](plan.md)) has `kind: "text"`: one whole-file unit staged with `git add`,
  `body: "none"` like a summary-only file (no block), its added lines still scanned, read
  from the second whole-diff `git diff -z --raw -p --text` pass ([plan](plan.md)) that
  supplies them.
- The patch sections of a diff pass are matched to its raw records by position: section *i*
  belongs to raw record *i* and takes its path. A type-change (`T`) record (file↔symlink,
  file↔submodule) is the exception: git prints a delete and then a new-file section for
  it, so it owns two consecutive sections with its path and is one whole-file unit. The
  same rule holds for the `--text` pass. A section count or a path that does not match the
  raw pass under this rule is `internal` (exit 1), never a guess.
- The unit's `hash` (see [commit](commit-release.md)) is kept in the state file, not printed.
- Body in `hunks.txt`: the hunk text as produced by the pinned diff options (Q11); no block
  for binary, submodule and summary-only files, or past the cap (`body: "cap"`). No block
  either for a unit with a pattern hit (`body: "none"`, `"scan": ["github-token"]`): it
  goes to `notIncluded` whatever it holds, so the secret never reaches `hunks.txt` or the
  worker's context (Q10). A whole-file unit with a hit (a new file) loses its whole body;
  the other hunks of a tracked file keep theirs. A new
  file's body is its whole content as `+` lines. `Read` cuts lines over 2000 characters;
  accepted (Q19).
- `summaryOnly[].reason`: `lockfile`, `minified`, `sourcemap`, `generated`, `lines`, `size`.
