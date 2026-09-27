# Worker plan

The content of `plan.groups.json` in the [run folder](run-folder.md):

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
  "not part of the intent". Not a trigger; the unit stays in the working tree. For a file
  in `scan.skipped` that a worker without a user (`interactive: false` or `--no-user`)
  leaves out (Q17): "over 1 MB, not scanned: commit by hand".
- `body`: string, may end in a footer paragraph with allowed tokens only, or `null`.
- `staged` and `reword` modes: exactly one group; `files`, `hunks` and `notIncluded` are
  ignored, and the group holds every unit.
- The worker does not write `confirm`; `check` computes it.
- A reword with dictated text (`reword: <text>` in the [worker input](worker-input.md)): the
  worker writes `{ "version": 1, "source": "user", "groups": [{ "header": "…", "body": … }],
  "notIncluded": [] }`, splitting the text at its first blank line, and runs `check`.
