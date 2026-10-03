# check

`check --plan <planId>`. Reads `plan.groups.json` from the [run folder](run-folder.md),
validates it, then:

- `confirm` is `null` → it goes straight on as [`commit --all`](commit-release.md) in the
  same process, and its output is `commit --all`'s, with `groups`, `notIncluded` and
  `notices` (this call's own, computed below) merged in; the merged notices, `check`'s and
  `commit`'s alike, land in `reply.notices` ([Reply and handback](reply-and-handback.md)).
- `confirm` is set and the run is interactive → nothing is committed; the output carries a
  `confirm` handback ([Reply and handback](reply-and-handback.md)). The lock stays, and the
  state stores `awaitingConfirm`, so a `commit` without `--confirmed` is refused
  (`unconfirmed`, [commit](commit-release.md)).
- `confirm` is set, `interactive: false`, not `humanOnly` → commits as with `null`: the
  worker's own grouping is confirmed by nobody else (Q17).
- `confirm` is set, `interactive: false`, `humanOnly` → nothing is committed; `check`
  releases the lock and deletes the run folder, and the reply carries a `handedBack`
  handback (information only).

```json
{
  "version": 1,
  "ok": true,
  "groups": [
    { "n": 1, "header": "feat: add stage subcommand", "body": null, "fileCount": 2,
      "files": [
        { "path": "src/stage.js", "status": "M", "new": false, "hunks": 3 },
        { "path": "docs/new.md", "status": "A", "new": true, "hunks": 1 }
      ],
      "newFiles": ["docs/new.md"] },
    { "n": 2, "header": "chore: regenerate asset data", "body": null, "fileCount": 1,
      "files": [
        { "path": "assets/big.json", "status": "M", "new": false, "hunks": 1 }
      ],
      "newFiles": [] }
  ],
  "notIncluded": [
    { "path": "src/b.js", "hunks": ["h5"], "reason": "scan: src/b.js:14 github-token" },
    { "path": "dist", "hunks": null, "reason": "412 untracked files in dist/ — add to .gitignore or commit by hand" },
    { "path": ".env.local", "hunks": null, "reason": ".env.local was staged but is hidden — commit by hand; committing this plan unstages it" },
    { "path": "libs/x", "hunks": null, "reason": "libs/x has uncommitted changes inside — commit inside the submodule first" }
  ],
  "notices": ["src/b.js:14 github-token left out"],
  "confirm": { "reasons": ["2 groups", "new file docs/new.md", "skipped file assets/big.json"], "humanOnly": true }
}
```

Lint failure (exit 2), the first failure, which carries no `reply` (below):

```json
{ "version": 1, "ok": false, "error": { "kind": "lint", "message": "2 errors" },
  "errors": [{ "group": 1, "reason": "type 'wip' not in types" },
             { "group": null, "reason": "h7 (src/c.js) not placed; put it in a group or in notIncluded" }] }
```

- Refuses (exit 6, `lock`) unless the run lock holds this `planId`; refreshes `touched`.
  Holds the run's `call.lock` for the whole call, so a second call on the same run is
  refused with `lock` (`busy`) ([run folder](run-folder.md)).
- Refuses (exit 1, `usage`) once any stored group is `committed: true`: a re-plan after a
  partial commit would renumber groups over units already in HEAD.
- Lint failure: increments `lintFailures`. The first failure since the last
  `plan --hunks` carries no `reply`; the worker fixes `plan.groups.json` and runs `check`
  again. The second carries a `reply`, and so does the first when `plan.groups.json` has
  `"source": "user"`: the worker must not rewrite dictated text unseen (Q20). Interactive,
  a `lintFailed` handback (rejected messages and errors in `text`; options `retry` and
  `no`, `edit` through Other, [Reply and handback](reply-and-handback.md), Q18); with
  `interactive: false`, `check` releases the lock and the reply is
  `status: "failed"` with the errors.
- Clears the stored groups and `awaitingConfirm` before it validates, so a failed `check`
  (after `edit` or `one`) leaves no group that `commit` would accept.
- A missing `plan.groups.json`, or one that is not valid JSON of the shape above, is a lint
  error (`group: null`).
- Validates:
  - every group's message against the [grammar](message-grammar.md), and against the
    [scan patterns](scan-patterns.md): one error per distinct pattern ID, in first-hit order
    ("message contains `local-path`"). A grammar reason that quotes a message fragment (the
    type, the scope, a footer token) overlapping a hit's span quotes `[<pattern-id>]` (the
    first overlapping hit's ID) in its place ("scope '[local-path]' not allowed (scope:
    forbidden)"), so no matched text reaches stdout or a `lintFailed` text;
  - every hunk ID exists in the state file and is used at most once;
  - completeness (`split` only): every unit in the state file is placed exactly once, in a
    group or in `notIncluded` (by ID, or by a `hunks: null` path entry): a unit placed nowhere
    is one error per unit ("h7 (src/c.js) not placed; put it in a group or in notIncluded",
    `group: null`), one placed twice one error per naming, naming both places (`group N` or
    `notIncluded`): "src/a.js is in group 1 and group 2; place it once", "src/a.js is in
    group 1 and notIncluded; place it once", "src/a.js is in notIncluded twice; place it
    once" (the group number of the second naming, `null` for `notIncluded`). In `staged` and
    `reword` the single group holds every unit implicitly;
  - identical hunks (same path, same `-` / `+` lines) have the same placement: all in one
    group, or all in `notIncluded` ("h3 and h5 are identical; place them together");
  - `files` and `hunks` are not mixed; every path in `files` and `notIncluded` is a real
    change; a rename is named by its new path only;
  - no collapsed directory, no `dirtySubmodules` path and no unit with a scan hit is in a
    group ("h4 has scan hit `github-token`; move it to notIncluded");
  - `staged` and `reword`: exactly one group. `split`: zero groups is valid.
- `errors`: `group` is the group number, or `null` for a run-wide error. Any error → exit 2.
  A scan error also carries `spans`: that pattern's hits in the group's message, each
  `{ "patternId", "start", "end" }` ([scan patterns](scan-patterns.md): offsets only, never
  the matched value), which the `lintFailed` text uses to redact the message it quotes:
  ``{ "group": 1, "reason": "message contains `local-path`", "spans": [{ "patternId":
  "local-path", "start": 19, "end": 37 }] }``.
- `groups[].files`: every path in the group, `hunks` = the number of the path's hunks in
  this group (`null` in the file-level slice). The confirmation shows at most 20 per group,
  then "+N more".
- `newFiles`: derived from status `A` or untracked, never from the worker. `split`:
  temporary-index diff (Q11); `staged`: index diff, for the report only; `reword`: always
  `[]`.
- `notIncluded`: the worker's entries plus every collapsed directory, every
  `stagedExcluded` path or directory and every `dirtySubmodules` path (`split` only), and
  every `embeddedRepos` path ("nested is an embedded git repository — add it as a
  submodule by hand"), every path that is not valid UTF-8 ("path is not UTF-8 — commit by hand"), each
  non-UTF-8 byte written as `\xNN` ([plan](plan.md)).
  Unstaging note (`split`, at least one group): a `stagedExcluded` entry, and a worker
  entry for a staged-new unit, gets "committing this plan unstages it", plus "and
  .gitignore then hides it from `git status`" when the stored staged-new list marks it
  `ignored`. The reset happens in `commit`, so the note describes what `yes` will do;
  with zero groups, or after `no`, the index is untouched and there is no note.
- `notices`: pattern hits that were left out (Q10), and (`split`, at least one group) one
  line per `indexOnly` path: "x: the staged version differs from your working tree;
  committing this plan discards it — recover with `git cat-file -p <blob>`" (Q11). Never a
  confirmation trigger.
- `confirm`: `null` when no [trigger](confirmation-triggers.md) for the mode applies. In an
  interactive run marked `resumed` (a respawn after `edit`, `one` or `retry`), `confirm` is
  always set, with the reason `edited plan`, in every mode: the user was reviewing this run
  and sees the result before anything is committed (Q16). The
  `confirm` handback's `text` is the one confirmation block (Q16), built from this output.
- On success the state file stores, per group: `n`, the resolved units (hunk IDs, or in the
  file-level slice the paths resolved to units by `check` itself), the normalised message,
  `attribution: true|false` (Q20), and `committed: false`; with a `confirm` handback also
  `awaitingConfirm`. The group count drives the lock
  release (Q22). A later successful `check` in the same run (after `edit` or `one`) stores
  its own groups; a failed one leaves none.
- Zero groups: `ok: true`, `groups: []`, `confirm: null`; `check` releases the lock and
  deletes the run folder itself; `reply.status: "nothing"` with the reasons.
