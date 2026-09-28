# 08 Plan validation

M14 plan validator: pure over the worker plan (`plan.groups.json`) and the run state; shape
errors, path and ID resolution, completeness, identical hunks, placement bans, mode rules,
message lint and scan, `notIncluded` extras and notices, and per-group derived facts (new
files, file lists, attribution flag). Tested at Seam 1 through `check` (exit 2 lint output,
or the validated `groups`/`notIncluded`/`notices`). The confirmation itself is computed by
M15 `computeConfirm` (group RUN), not by M14. Main sources: M14, Q9, Q11, Q16, Q20,
C:worker-plan, C:check.

## PLN-01: Tracer: a file-level worker plan with one group validates

**What to build:** `validatePlan(planBytes, runState)` for the file-level slice: parse
`plan.groups.json`; a missing file, invalid JSON or a wrong shape → one lint error with
`group: null`; resolve each `files` path to its units via the unit table; return `groups`
with `n`, header, body, `fileCount`, `files` (`hunks: null`) and `newFiles` derived from
status `A` or untracked, never from the worker. It builds the thin `check` workflow.

**Blocked by:** CHG-03, RUN-04, RUN-06.

**Status:** ready-for-agent

**Sources:** Q9, Q11, C:worker-plan, C:check, stories 63, 66, M14.

- [ ] Seam 1: a plan with one group naming both modified files → `check` output `groups[0]` with both paths, `new: false`, `hunks: null`, `newFiles: []`.
- [ ] Seam 1: no `plan.groups.json` → exit 2, `error.kind: "lint"`, one error with `group: null`.
- [ ] Seam 1: `plan.groups.json` not valid JSON, and valid JSON missing `groups` → exit 2 shape error, `group: null`.
- [ ] Seam 1: after a failed `check`, no stored group remains in `state.json`.


## PLN-02: Completeness and path resolution in `split`

**What to build:** every unit is placed exactly once, in a group or in `notIncluded` (by ID or
by a `hunks: null` path entry); every path in `files` and `notIncluded` is a real change; a
rename is named by its new path only; `split` accepts zero groups.

**Blocked by:** PLN-01, CHG-05.

**Status:** ready-for-agent

**Sources:** Q11, Q16, C:check (validates), C:worker-plan (file-level slice), stories 66, 69, 97, M14.

- [ ] Seam 1: a unit in no group and not in `notIncluded` → exit 2, "h7 (src/c.js) not placed; put it in a group or in notIncluded" (`group: null`).
- [ ] Seam 1: a path in two groups → error naming it; a path that is not a change → error.
- [ ] Seam 1: a rename named by its old path → "use the new path src/b.js for the rename of src/a.js".
- [ ] Seam 1: all units in `notIncluded`, zero groups → `ok: true`, `groups: []` (the release and `nothing` reply are RUN-18's).


## PLN-03: Hunk-level plans and identical hunks

**What to build:** hunk IDs must exist in the state, be used once and not be mixed with
`files` in one plan; identical hunks (same identity key) have the same placement, all in one
group or all in `notIncluded`; `files[].hunks` counts the path's hunks in the group.

**Blocked by:** PLN-02, CHG-06, PRE-15.

**Status:** ready-for-agent

**Sources:** Q11, C:check, C:worker-plan (hunk-level slice), stories 64, 67, M14.

- [ ] Seam 1: an unknown ID and an ID used twice → one error each with the group number.
- [ ] Seam 1: `files` and `hunks` mixed → error.
- [ ] Seam 1: identical hunks h3 and h5 split across groups, or one in `notIncluded` → "h3 and h5 are identical; place them together"; both in one group → valid.
- [ ] Seam 1: a group holding two of a file's three hunks → `files[].hunks: 2`.


## PLN-04: Placement bans, `notIncluded` extras and notices

**What to build:** reject a unit with a scan hit, a collapsed-directory path or a
`dirtySubmodules` path in a group; add the extras to `notIncluded` (collapsed directories,
`stagedExcluded` paths and directories, `dirtySubmodules`, non-UTF-8 paths with `\xNN`), the
unstaging note (`split`, at least one group) for `stagedExcluded` entries and staged-new
units left out, with the `.gitignore` clause when `ignored`; notices for hits left out and one
per `indexOnly` path.

**Blocked by:** PLN-02, CHG-13, CHG-14, CHG-16, CHG-12.

**Status:** ready-for-agent

**Sources:** Q10, Q11, C:check (`notIncluded`, `notices`), C:worker-plan, stories 66, 80, 85, 96, M14.

- [ ] Seam 1: a hit unit placed in a group → "h4 has scan hit `github-token`; move it to notIncluded"; left out → notice "src/b.js:14 github-token left out".
- [ ] Seam 1: a collapsed `dist` → `notIncluded` entry "412 untracked files in dist/ — …"; a hidden staged-new `.env.local` → "… was staged but is hidden — commit by hand; committing this plan unstages it".
- [ ] Seam 1: a gitignored staged-new unit left out → note plus "and .gitignore then hides it from `git status`"; with zero groups → no unstaging note.
- [ ] Seam 1: a dirty submodule → "libs/x has uncommitted changes inside — …"; an `indexOnly` path → notice with `git cat-file -p <blob>`.
- [ ] Seam 1 (POSIX): a non-UTF-8 path → "path is not UTF-8 — commit by hand" with `\xNN`.


## PLN-05: `staged` and `reword`: exactly one group holding every unit

**What to build:** in `staged` and `reword` exactly one group is required; `files`, `hunks`
and `notIncluded` are ignored and the group holds every unit; `newFiles` from the index diff
in `staged`, always `[]` in `reword`; no `split`-only extras.

**Blocked by:** PLN-01, CHG-14, CHG-15.

**Status:** ready-for-agent

**Sources:** Q9, Q20, C:check, C:worker-plan, stories 83, 175, M14.

- [ ] Seam 1: `staged` with two groups, or zero → exit 2 error; with one group listing only some files → the group holds every staged unit.
- [ ] Seam 1: a staged new file → listed in `newFiles` (report only); `reword` → `newFiles: []`.
- [ ] Seam 1: `split`-only extras (collapsed, unstaging notes, `indexOnly` notices) absent in `staged`.


## PLN-06: Message lint and message scan per group

**What to build:** each group's message runs through M6 lint against the stored config and
M8 `scanText`; errors carry the group number, and a scan error carries the `scanText` spans
(never the matched value) for M17's redaction.

**Blocked by:** PLN-01, MSG-05, SCN-05, EXE-01.

**Status:** ready-for-agent

**Sources:** Q5, Q10, Q13, C:check, C:message-grammar, stories 178, M6, M8, M14.

- [ ] Seam 1: header `Feat: x` → shape error "header is not 'type(scope)!: description'" with `group: 1`, no type check run.
- [ ] Seam 1: header `wip: x` → "type 'wip' not in types" with `group: 1`.
- [ ] Seam 1: a body holding a home-directory path → "message contains `local-path`", with spans stored for the reply; the matched text never appears in stdout.
- [ ] Seam 1: a body footer with a disallowed token → lint error; allowed tokens pass.
- [ ] A static test asserts M14's module imports `lint` from M6.
- [ ] A static test asserts `validatePlan`'s exported signature accepts `osUser` and passes
      it through to `scanText`, since the current signature omits it (a gap this slice
      closes).


## PLN-07: Attribution flag and stored group facts

**What to build:** per group, the attribution flag (`false` when the stored trailer is
`null`; in `reword`, `true` when the worker wrote the message or the old message had one,
`false` for dictated `source: "user"` text otherwise) and the normalised message, returned
for `check` to store with `committed: false`.

**Blocked by:** PLN-05, PLN-06, CFG-08, MSG-06.

**Status:** ready-for-agent

**Sources:** Q5, Q20, C:check (stored per group), C:worker-plan (`source`), stories 55, 178, 180, M14.

- [ ] Seam 1: attribution resolved to `null` → stored flag `false` on every group.
- [ ] Seam 1: `reword` with `source: "user"` and an old message without the trailer → `false`; with the worker's own message → `true`.
- [ ] Seam 1: the stored group message is the M6-normalised text (CRLF and trailing blank lines normalised).
