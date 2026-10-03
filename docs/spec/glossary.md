# Glossary

- **run**: one `planId`, from `plan` to release (the lifetime of the lock and run folder).
  **episode**: one user request, from the first commit attempt (a denied `git commit`
  included) to the final reply; it may hold several runs (a takeover, a re-plan after
  `diff-changed`) (Q24).
- **worker**: the `commit:commit-worker` agent (Q24, Q25). **caller**: whoever spawned it
  (main session, subagent, `/commit`, a workflow skill).
- **intent**: optional free text from the caller that scopes a run (public, Q2).
  **interactive**: the caller's statement whether a user can answer: `true` (the default,
  also what an omitted value means), in which case the worker returns handbacks and the
  caller decides, following `ifNoUser` when no user can answer, or `false` (which the worker
  passes to the script as the flag `--no-user`) (Q17). A caller knows no user can answer when
  `AskUserQuestion` is absent from its tool list and
  from its deferred-tool list, with no ToolSearch call (Q17).
- **bucket**: a path-derived grouping hint (M9 `bucketOf`), never a grouping rule (Q11).
- **pass-up**: passing a question the worker's caller cannot answer up to its own caller
  (the `handedBack` handback, Q17, Q25).
- **deny share `d`**: in the dogfood gate, the share of episodes in which the guard denied a
  direct `git commit` (Q24).
- **delivery shape**: how the worker's final report reaches the caller (Q25): the
  **notification shape** (its last message, delivered in the completion notification) or
  the **`SubagentHandback` shape** (a `SubagentHandback` tool call, followed by the
  completion notification). Not to be confused with a **handback** (below).
- **mode**: `split` (group everything), `staged` (the pre-staged set as-is), `reword` (amend
  the last message).
- **unit**: one hunk or whole-file change, ID `h1…hN`, identified by a content **hash**; the
  **unit table** holds each unit's ID, hash, path, old path, status, kind, identity key (the
  hash without the occurrence index, for identical hunks) and summary-only flag.
- **pinned diff options**: the fixed diff flags that define a unit (Q11); private to M10.
- **temporary index**: a copy of the real index in the run folder, `git reset -q -- .` on the copy
  (the pathspec form writes no ref, unlike a bare `git reset -q`) so it matches HEAD while keeping its stat cache and sparse-checkout entries (empty when
  unborn), plus intent-to-add of the stored path lists (Q11 step 1); paths with
  `ignored: true` are added with `-f`. Never built from HEAD alone: out-of-cone
  sparse-checkout paths would then show as deleted.
- **inventory**: candidates, staged-new, `indexOnly`, dirty submodules, tracked directories,
  pre-staged paths, gathered by `plan` before diffing.
- **candidate / hidden / collapsed**: untracked-file categories (C:untracked-files).
  **staged-new**: a path the real index adds versus HEAD. **stagedExcluded**: a staged-new
  path that is hidden, or (in `split` only) inside a collapsed directory. **indexOnly**: an
  index entry that differs from both HEAD and the worktree (kept by blob ID).
- **summary-only**: a file shown as stats only and grouped as one whole-file unit;
  **cap**: the 3000 changed-line body cap (Q19).
- **hit**: a scan match, reported by pattern ID and location. **skipped**: a file whose
  additions exceed 1 MB, not scanned and listed in `scan.skipped` (a confirmation trigger
  when included).
  A binary (see M10) is **not scanned**: not listed and not a trigger.
- **notice**: a one-line fact the reply text must carry, for example guard, signing, config,
  detached HEAD, hits, `indexOnly` paths (the list is not exhaustive).
- **hunk index**: the entries (one per unit: ID, stats, range, `body`, `scan`) that the
  worker groups from, in `plan`'s stdout (spilled to `hunks.json` past the 20 000-character
  budget, pending the tool-output-limits check in Open items). **Hunk bodies**: the
  `hunks.txt` blocks the entries point to, read by line range (M13).
- **worker plan**: `plan.groups.json` (groups plus `notIncluded`, `source: worker|user`).
- **lint**: grammar, config rules, message scan and placement validation, all run by `check`.
- **confirm / humanOnly**: the computed confirmation; an honest worker never answers a
  `humanOnly` one without a user (a forged `ifNoUser` answer is an accepted Q25 gap). **resumed**: set by a separate `plan --hunks`; forces confirmation in an
  interactive run (Q16).
- **reply**: the script-built final JSON (`version`, `status`, `planId`, `text`, `commits`,
  `notices`, `callerRule`, `handback`, C:reply-and-handback). **tree state**: the last line of
  `text`. **handback**: a self-describing question (`confirm`, `modeChoice`, `lock`,
  `lintFailed`, `handedBack`, `continue`) with `run` or `respawn` answers and `ifNoUser`.
  **Other**: `AskUserQuestion`'s free-text option.
- **script call**: a shell segment that runs the commit entry point with a subcommand, in the
  shape C:guard fixes; built and recognised only by S2.
- **blanket rule / script-call exemption**: C:guard step 2; a command that mentions commit
  and holds a construct the tokenizer does not model is denied untokenized, unless it is
  exactly one plain script call.
- **run-folder directory**: `<toplevel>/.commit-plan/`, which holds every run folder and
  the run lock (the `run-folder` refusal is about this directory).
  **run folder / run lock / run state**: per-run working files (`<planId>/`), the single
  lock next to them, and the state file (C:run-folder); the lock's `touched` is its mtime
  (Q22). **`call.lock`**: a per-call lock inside a run folder, held by every call on that
  run so that two calls on one run never overlap (`busy`).
- **backstop**: `commit`'s rescan of the index before `git commit`.
- **heartbeat**: a guard-written file proving the hook ran (Q23).
- **plugin cache**: `<Claude home>/plugins/cache/`, where Claude Code installs marketplace
  plugins; a handback `run` names the script there. Handbacks work only from a marketplace
  install (a local marketplace is fine): with `--plugin-dir` the caller shows the command
  instead of running it (story 61; Q25 as amended; an accepted gap in Out of Scope).
- **Claude home**: `CLAUDE_CONFIG_DIR` when set, else the `.claude` directory in the OS home;
  resolved once by each entry point (story 112).
- **managed directory**: the platform's fixed managed-settings directory (Q5); the script
  reads only its `managed-settings.json` (the drop-in directory is not read in 0.1.0).
- **typed result**: `{ ok: true, … } | { ok: false, code, … }`, where `code` is a domain code
  (never a CLI kind); used by every module that can fail.
