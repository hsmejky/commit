# Architectural decisions

- **Code split** (Q1, Q15 as amended). Two thin entry points over one shared library. The
  guard entry point loads only G1-G3, S1 and S2; S1 and S2 load nothing else. The commit
  entry point loads M1 (and S1 directly, for `resolveClaudeHome`, GRD-17); layering is CLI
  (M1) → workflows (M18) → run policy and domain modules → adapters (M2 and the filesystem).
  Nothing below M18 calls upward.
- **Typed results and one error table.** Modules return typed results; only M18 maps domain
  codes to CLI kinds (table below); M1 alone owns kind → exit code and the envelope; an
  unexpected throw becomes `internal`.
- **Injected environment.** Each entry point resolves once and passes down: the clock
  (`now()`), the OS home, the Claude home, the managed directory (derived from the platform,
  never from `env`), the project directory (`CLAUDE_PROJECT_DIR` when it sees it, else the
  entry point's own `process.cwd()`; no walk-up to a git toplevel, PRE-11), `osUser` (from
  `os.userInfo()`, falling back to `USER` or `USERNAME`, else `null`, which skips the
  OS-user rule, story 139), the script's own path, `cwd`
  (`process.cwd()`) and `env`. Modules never read these ambiently. The shipped CLI has **no test-only switch**
  (no env knob, no flag): anything reachable from the CLI is reachable by an agent.
- **Asynchronous process adapter.** Every git call, read-only ones included, is spawned
  asynchronously by M2 with a timer from the call's `deadline`, so that a timeout can kill
  the whole tree while git, a hook, a clean filter or fsmonitor still runs (Q18), and the
  event loop is never blocked. `spawnSync` is reserved for M2's named short calls
  (`git --version` and `git rev-parse --show-toplevel` at start-up); the guard loads only
  G1-G3, S1 and S2 and spawns nothing. While a child
  runs, the commit entry point handles `SIGINT`, `SIGTERM` and `SIGHUP` by killing the
  active child's tree (M2) and removing the call's `call.lock` (M12 `run.close()`) before it exits; it neither unstages nor releases
  (a takeover reports the unstaging through `indexReset`, below), so an
  Esc or a session end cannot leave `git commit` running as an orphan that lands a commit
  after the call ended.
- **One script-call shape.** S2 builds every `run` a handback carries and recognises script
  calls in the guard; the README allow rules and the worker prompt's command form follow the
  same shape, checked by the round trip (Testing Decisions).
- **One run owner.** M12 owns the run folder, lock and typed run state, including the folder
  lifecycle: `plan` gets a provisional run whose only exits are `acquire` (kept) or
  `discard` (deleted), so no workflow deletes folders.
- **Stored, not recomputed.** Everything a later call needs is stored by `plan` in the run
  state, so later calls are cheap and see exactly the diff `plan` scanned (Q9).
- **Versioned run state.** The state carries a `version`; every later call refuses a state
  written by another plugin build with `ended` (C:run-folder). The run folder is writable
  without a prompt under the README `Edit` rule (Q16); a tamper digest is deferred past
  0.1.0 (Out of Scope).
- **Run IDs are validated, deletions contained.** A `planId` is `crypto.randomUUID()` output;
  every `planId` the script reads (`--plan`, `--take-over`, a lock's content) must match that
  form exactly (lowercase UUID v4). M12 owns the form (`isValidPlanId`); M1 imports that pure
  export and applies it, refusing a malformed flag value as `usage`. M12 treats a
  lock with a malformed `planId` like an unparseable one (story 191). Every folder or file M12
  deletes is resolved and checked to lie strictly inside `<toplevel>/.commit-plan/` (no `..`,
  not absolute, not the directory itself), and the sweep considers only entries named in the
  minted form, never following a link. The reply's shape check names the form too
  (story 206).
- **The run-folder directory is checked before use.** Before its first write, M12 `lstat`s
  `<toplevel>/.commit-plan`: a symlink, a junction, a non-directory, or a path tracked in the
  index refuses `plan` with `state` ("`.commit-plan` is tracked or not a plain directory;
  remove it by hand"); after `mkdir` it checks again, and once more after creating
  `<planId>/` (story 207). The tracked check ignores ASCII case, so a tracked
  `.Commit-Plan/` refuses on a case-insensitive filesystem too, naming that actual variant.
- **One call per run at a time.** Every call with `--plan` creates `<planId>/call.lock`
  exclusively, and `plan --take-over` creates the `call.lock` of the old run it takes over
  (the old run's `planId`), so a call still running on that run and the takeover end in
  `busy` whichever comes first; a call whose `call.lock` or run folder vanishes under it
  (`ENOENT` after a takeover) ends as `taken-over`. Each removes it on exit; a second call on the same run while
  it exists is refused with `busy` (a call backgrounded by a tool timeout and then retried
  must not share the temporary index). The `call.lock` holds `{ pid, host }`: one whose host
  is this host and whose pid is dead (`process.kill(pid, 0)` → `ESRCH`) was left by a killed
  call and is stale at once, so a `--take-over` of that run is not refused `busy` (stories
  190, 210); any other `call.lock` is stale when older than the run's own staleness limit
  (15 minutes). A stale one is replaced with the lock's atomic takeover (story 209).
  `release` takes the `call.lock` only after reading a lock that holds its `planId`, so
  `busy` is the only `lock` refusal it can raise.
- **Confirmation is bound to its answer.** When `check` returns a `confirm` handback it stores
  `awaitingConfirm` in the run state; the `yes` answer's `run` carries `--confirmed`, which no
  other handback carries. `commit` refuses without `--confirmed` while `awaitingConfirm` is
  set (`unconfirmed`), and clears it on its first group. The base `callerRule` tells callers
  to run a command with `--confirmed` only as the answer the user picked, or as
  `ifNoUser.answer` without a user (story 208).
- **Entry points survive an old Node.** Both entry points are written in syntax every Node
  since 12 parses, check `process.versions.node` first (commit entry point: the `env` JSON
  refusal; guard: silent exit), and only then load the library with a dynamic `import()`.
- **Module type fixed by extension** (Q1, Q15 as amended). The entry points are CommonJS
  (`plugin/scripts/commit.cjs`, `plugin/scripts/guard.cjs`); every library module is an ES
  module (`plugin/scripts/lib/*.mjs`). The entry points reach the library only through the
  dynamic `import()` above; no library module is `require`d. The extension settles the
  type without any `package.json`: the root one is likely not shipped with the plugin and
  keeps no `"type"` field. The test command runs only `tests/*.test.js`, which stay
  CommonJS and load the library via `await import()`; CommonJS cannot `require` a `.mjs` on
  Node 22.0-22.11 (unflagged `require(esm)` starts at 22.12). Only non-test helpers and
  stubs in the test tree that use ES module syntax are named `.mjs`. A typeless `.js` with
  `export` throws `SyntaxError` on
  Node 22.0.0 and prints `MODULE_TYPELESS_PACKAGE_JSON` to stderr on every guard call on
  Node 24.

| Fact | Produced by (at `plan`) | Read by |
| --- | --- | --- |
| state `version` | M12 | M12 `open` |
| paths that are not UTF-8 (each non-UTF-8 byte written as `\xNN`) | M10 | M14 (`notIncluded` extras), M17 |
| unit table, `id → hash` map, scan map | M10, M8 | M13 (index), M14 (paths, renames, new files, identical hunks), M15 (confirm), M16 (match), M12 `acquire` (takeover: the killed group's unit paths) |
| candidate, staged-new, `indexOnly`, `preStaged` lists | M10 inventory, M9 | M10 temporary index, M16 `unstaged`, M17 notices, M12 `acquire` (takeover: `preStaged`, `indexOnly`) |
| collapsed directories, `stagedExcluded`, `dirtySubmodules` | M9, M10 | M13, M14 (`notIncluded` extras), M17 |
| effective config values and `scanIgnore` at HEAD | M4 | M13 (`config.values` without `scanIgnore`), M14 lint, M16 backstop (recompiled through M7 on each call) |
| attribution trailer text and source | M5 | M14 (attribution flag), M16 trailers, M17 trailer line |
| `recentSubjects` (the last 10, non-merge), `oldMessage` (reword) | M3 history query | M13 (`plan --hunks` output), M6 carry-over |
| expected HEAD, notices, `interactive`, mode | M3, M18 | M15, M16, M17 |
| index fingerprint (updated after each of the run's own commits) | M10 `indexFingerprint` | M16 `index-changed` check |
| `lintFailures`, `resumed`, `awaitingConfirm`, validated groups, `indexReset`, `treeChangedDuringCommit` | later calls | M12 `acquire` (takeover: validated groups, `indexReset`, current group status), M15, M16, M17 |
