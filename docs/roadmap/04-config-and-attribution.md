# 04 Config and attribution

M4, the config loader (user and repo layers, validation, warnings, defaults, sources,
`scanIgnore` at HEAD compiled through M7, `isRepoConfigPath`), and M5, the attribution
resolver over the Claude settings layers. Both are tested at Seam 1 only, first through
`plan`'s pre-folder `config` refusal, then through `plan`'s `config`, `attribution` and
`warnings` fields. Main sources: M4, M5, Q5, Q6, Q10, C:plan, stories 105-119, 148, 150.
CFG-01 (a human decision) settles the `scanIgnore` open items before CFG-07 and the scan and
commit slices that use the flag.

## CFG-01: Settle the `scanIgnore` open items

**What to build:** a decision pass (human) over the `scanIgnore` items left open in [known
deficiencies](../spec/known-deficiencies.md) (KD-S26 to KD-S29). Record each decision in Q10
(an **Amended** bullet) and fix the contracts and the spec so they agree. The items: (1) the
backstop scan reads `scanIgnore` from HEAD (Q10), while the stored-facts table and M16
recompile the stored patterns; (2) the Q10 row flags only the unit that changes
`scanIgnore`, while C:plan-hunks and M8 flag every unit of the repo config file; (3) how M18
names the repo-config path for `snapshotBlob`, when M4 exports only `isRepoConfigPath`; (4)
the unclear wording "stored as `scan.scanIgnoreChanged`"; (5) a repo config that is invalid
at HEAD while the worktree copy is fixed: a `config` refusal makes the fix uncommittable.

**Decisions (2026-09-29, Q6, Q9, Q10 amended by the CFG-01 decision pass):** (1) the
backstop uses the `scanIgnore` patterns stored at `plan` (Q9 amended); (2) every unit of the
repo config file is flagged when the `scanIgnore` value changed (Q10 row and
C:confirmation-triggers aligned); (3) M4 exports `REPO_CONFIG_PATH` and M18 calls
`snapshotBlob(REPO_CONFIG_PATH)`; (4) M18 step 5 "outputs as" `scan.scanIgnoreChanged`; (5)
an invalid `scanIgnore` at HEAD is `[]` plus a warning (fail-closed), the worktree layer is
validated as usual, and HEAD's `[]` against a fixed copy with patterns counts as a change
(`humanOnly`).

**Blocked by:** None (can start immediately).

**Status:** done

**Sources:** Q6, Q10, M4, M8, M16, M18, C:scanignore-globs, C:plan-hunks, C:commit-release,
stored-facts table.

- [x] Each of the five items has a recorded decision, and decisions, contracts and spec
      agree.
- [x] CFG-07, SCN-14, EXE-13 and INT-16 cite the settled behaviour.


## CFG-02: Unparseable repo config refuses `plan` (tracer)

**What to build:** `plan` step 1 loads the config through a thin M4 (`loadConfig` reading
the repo layer from the worktree), and step 2 refuses an invalid layer: unparseable JSON in
the repo `.claude/commit.json` ends `plan` with exit 1 `config` before any run folder or
lock exists. With no layer present, `plan` goes on with the defaults.

**Blocked by:** FND-04, INT-01, RPL-03, GIT-01.

**Status:** done

**Sources:** M4, M18 `plan` steps 1-2, Q6, C:cli-and-exit-codes, domain-code-cli-kind
(`config`), story 110.

- [x] Seam 1: a repo layer holding `{ "types": [` → one JSON object, `error.kind:
      "config"`, exit 1, the message naming the repo layer.
- [x] Seam 1: after that refusal no `.commit-plan/` directory and no lock exist.
- [x] Seam 1: a repo with no config file gets no `config` refusal.


## CFG-03: Type and range errors stop `plan`

**What to build:** pure `validateLayer(obj, layer)` with the Q6 value domains; every error
case refuses `plan` with `config` before any run starts, naming layer and key.

**Blocked by:** CFG-02.

**Status:** done

**Sources:** Q6 (key table, error list), M4, stories 106, 110.

- [x] Seam 1 table: `maxSubjectLength` `"72"`, `19`, `201`, `0`, `72.5`; `types` `[]`,
      `["Feat"]`, `["1x"]`, `"feat"`; `scope` `3`; `subjectCase` `true` → each exit 1
      `config` naming the key.
- [x] Seam 1: `maxSubjectLength` `20` and `200` are accepted.
- [x] Seam 1: a repo layer whose top level is not a JSON object (`[]`, `null`, `42`, `"x"`) →
      exit 1 `config` naming the repo layer; CFG-02's `loadConfig` accepts it as JSON-parseable
      (review-CFG-02 finding 5).
- [x] Seam 1: after each of those `config` refusals no `.commit-plan/` directory and no lock
      exist (story 110).
- [x] A static test asserts `validateLayer` is exported, pure (no file reads in its
      source).


## CFG-04: User layer in the Claude home

**What to build:** M4 reads the user `commit.json` from the Claude home, which the entry
point resolves once (`CLAUDE_CONFIG_DIR`, else `.claude` in the OS home) and injects; an
error in the user layer refuses like a repo-layer error, naming the user layer.

**Blocked by:** CFG-03.

**Status:** done

**Sources:** Q5 (Claude home), Q6, M4, architectural-decisions (injected environment),
story 112.

- [x] Seam 1: an invalid user layer under `CLAUDE_CONFIG_DIR` → exit 1 `config` naming the
      user layer; the same file in the OS-home `.claude` is ignored while the variable is
      set.
- [x] Seam 1: without `CLAUDE_CONFIG_DIR`, the OS-home `.claude/commit.json` is read.


## CFG-05: Effective values and sources in `plan`'s output

**What to build:** per-key override (repo over user over default, arrays replaced, never
merged) and `plan`'s `config.values` and `config.sources` (`default`, `user`, `repo`).

**Blocked by:** CFG-04, RUN-06, PLN-06.

**Status:** ready-for-agent

**Sources:** Q6, C:plan (`config`), M4, stories 105, 108, 111.

- [ ] Seam 1: no layers → the 11 standard types, `scope: forbidden`, `body: forbidden`, 72,
      `lower`, every source `default`.
- [ ] Seam 1: user `types: ["feat","fix","deps"]`, repo `types: ["feat"]` → `["feat"]`,
      source `repo`; a key only in the user layer shows source `user`.
- [ ] Seam 1: the effective values reach `check`'s lint (a type allowed only by the repo
      layer passes, a type the repo layer removed fails).


## CFG-06: Warnings for unknown and misplaced keys

**What to build:** unknown key → warning, ignored; unknown value of a known key → warning
and fall back to the next layer, then the default; a key in the wrong layer (`scanIgnore` in
the user layer) → warning, ignored. Warnings go to `plan.warnings` and stderr.

**Forward note (review-CFG-03 finding 3):** `validateLayer`'s `layer` parameter is a
free-form display string (e.g. `repo config (.claude/commit.json)`), not a layer identity.
Telling a key "in the wrong layer" needs to discriminate repo from user, so this slice has
to give `validateLayer` (or its caller) a real identity to check against, not just a label
to print.

**Blocked by:** CFG-05.

**Status:** ready-for-agent

**Sources:** Q6, Q10, M4, stories 107, 109, 113.

- [ ] Seam 1: repo `body: "required"` with user `body: "optional"` → effective `optional`,
      source `user`, one warning naming the value.
- [ ] Seam 1: `workerModel: "haiku"` in the repo layer → an unknown-key warning, no effect
      (story 113).
- [ ] Seam 1: `scanIgnore` in the user layer → wrong-layer warning, effective `scanIgnore`
      unaffected.
- [ ] Seam 1: no warning makes `plan` fail.
- [ ] Seam 1: a warning case also writes the same warning text to stderr.


## CFG-07: `scanIgnore` read at HEAD and compiled

**What to build:** M4 reads `scanIgnore` from the repo config at HEAD (none when unborn),
every other repo key from the worktree; reports source `repo@HEAD`; compiles each pattern
with M7 `compileGlob` inside `validateLayer` itself (not only via `loadConfig`, so a caller
that validates a layer's text directly also catches a bad glob) and reports its `config`
errors as repo-layer errors; returns compiled matchers and exports `isRepoConfigPath(path)`
and `REPO_CONFIG_PATH`. An invalid `scanIgnore` at HEAD is `[]` plus a warning, not a
`config` refusal; the worktree layer, its `scanIgnore` included, is validated as usual
(CFG-01 item 5).

**Blocked by:** CFG-06, SCN-03, CFG-01.

**Status:** ready-for-agent

**Sources:** Q10 (read at HEAD; amended by CFG-01), Q6 (amended by CFG-01), M4, C:plan
(`config.sources`), C:scanignore-globs, stories 107, 148, 150.

- [ ] Seam 1: `scanIgnore` added in the worktree only → effective `[]`; after it is
      committed → effective patterns with source `repo@HEAD`.
- [ ] Seam 1: on an unborn repo `scanIgnore` is `[]` while other worktree repo keys apply.
- [ ] Seam 1: a pattern `**/*` and one with braces, at HEAD and unchanged in the worktree
      → exit 1 `config` naming the pattern (the worktree layer).
- [ ] Seam 1: `scanIgnore` given as a string, and as an array with a non-string entry, at
      HEAD and unchanged in the worktree, each → exit 1 `config` naming the key.
- [ ] Seam 1: each of those values (and unparseable JSON) at HEAD only, with a valid copy in
      the worktree → no refusal, `config.values.scanIgnore` is `[]` and `warnings` names the
      repo config at HEAD (CFG-01 item 5).
- [ ] `validateLayer`, called directly (not through `loadConfig`) on a repo layer with
      `scanIgnore: ["**"]`, returns a `config` error naming the pattern.
- [ ] `isRepoConfigPath` is true for `.claude/commit.json` and false for
      `sub/.claude/commit.json` and `.claude/commit.JSON`; `REPO_CONFIG_PATH` is
      `.claude/commit.json`.


## CFG-08: Default attribution trailer (M5 tracer)

**What to build:** thin M5 `resolveAttribution` with no settings files: the fixed trailer
`Co-Authored-By: Claude <noreply@anthropic.com>`, source `default`, reported in `plan`'s
`attribution` and stored in the run state for M16 and M17.

**Blocked by:** CFG-04, RUN-06.

**Status:** ready-for-agent

**Sources:** Q5, M5, C:plan (`attribution`), story 118.

- [ ] Seam 1: no Claude settings → `attribution: { trailer: "Co-Authored-By: Claude
      <noreply@anthropic.com>", source: "default" }`.
- [ ] The trailer holds no model name and comes from no agent input (no flag or file the
      worker writes can change it).
- [ ] The resolved trailer and source are in the state file, read by later calls instead
      of re-reading settings.


## CFG-09: `attribution.commit` and `includeCoAuthoredBy`

**What to build:** in the user settings layer: `attribution.commit` set → its trailer-shaped
lines (M6 footer grammar), an empty string → `null`; non-trailer lines dropped with a
warning; else `includeCoAuthoredBy: false` → `null`.

**Blocked by:** CFG-08, MSG-04.

**Status:** ready-for-agent

**Sources:** Q5, M5, stories 115, 117.

- [ ] Seam 1: `attribution.commit: ""` → `attribution: null`.
- [ ] Seam 1: `attribution.commit` = a 🤖 line, a blank line and `Co-Authored-By: X <x@y>`
      → trailer is the last line only, the dropped lines reported with a warning in
      `plan.warnings` (Q5, M4: "dropped with a warning"; no source fixes the warning count).
- [ ] Seam 1: `includeCoAuthoredBy: false` → `attribution: null` in the output; the source `user` is stored in the run state for M16 and M17.
- [ ] A static test asserts M5's module imports M6's `parse` (footer grammar) and not
      `lint`, which M5 never uses.


## CFG-10: Settings layer precedence and the project directory

**What to build:** M5 over project-local, project and user layers (project directory =
`CLAUDE_PROJECT_DIR`, else the toplevel), first layer defining a key wins, two passes
(`attribution.commit` across all layers, then `includeCoAuthoredBy`).

**Blocked by:** CFG-09, PRE-11.

**Status:** ready-for-agent

**Sources:** Q5, M5, open verification items (project directory), story 114.

- [ ] Seam 1: `settings.local.json` beats `settings.json` beats user settings for
      `attribution.commit`; `source` names the layer (`project-local`, `project`, `user`).
- [ ] Seam 1: `includeCoAuthoredBy: false` in project-local with `attribution.commit` set in
      user → the user trailer applies (two passes).
- [ ] Seam 1: `CLAUDE_PROJECT_DIR` pointing at a subfolder is read instead of the
      toplevel; the behaviour matches the spike's finding, recorded in Q5.
- [ ] Seam 1: with `CLAUDE_CONFIG_DIR` set, the user settings layer is read from
      `$CLAUDE_CONFIG_DIR/settings.json`, not the OS-home default (story 112).


## CFG-11: Managed settings layer (CI only)

**What to build:** M5 reads `managed-settings.json` from the managed directory the entry
point derives from the platform (never from `env`) as the highest layer; its drop-in
directory is not read.

**Blocked by:** CFG-09, PRE-16.

**Status:** ready-for-agent

**Sources:** Q5, M5, testing-seams (Seam 1 managed layer), story 116.

- [ ] Seam 1 (CI only): managed `attribution.commit` beats every other layer, source
      `managed`; a drop-in file beside it has no effect.
- [ ] The managed cases run in a separate, final `node --test` invocation that removes the
      file it wrote; those cases are skipped (not faked) outside CI.
- [ ] Every attribution case, not only the managed ones, is skipped (not faked) when the
      host already has its own `managed-settings.json`, whatever the CI status.
- [ ] No env variable changes the managed directory (a test sets a candidate variable and
      sees no effect).
- [ ] The managed-settings directory's fixed path and CI write permissions are the ones
      PRE-16 recorded.
