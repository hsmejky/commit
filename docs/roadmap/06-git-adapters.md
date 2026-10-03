# 06 Git adapters

M2 (process adapter: the only module that spawns processes, with the environment, timeout
and tree-kill rules), M3 (repo-state probe: HEAD, in-progress states, encoding, reword facts,
history reads) and M11 (signing probe). The spec tests all three at Seam 1 only, through the
subcommands, so every slice here is checked by a fixture repo run through `plan` (or
`commit` for the `git commit` environment and the kill). Main sources: M2, M3, M11,
Q9, Q18, Q21, C:plan (steps 1, 2 and 6, `state`, `signing`), testing-modules rows M2/M3 and M11.

## GIT-01: Tracer: `plan` refuses outside a usable repo and on an old git

**What to build:** the thinnest M2 (`toplevel`, `gitVersion` under their fixed short
`spawnSync` timeouts, and an asynchronous `run` returning `{ code, stdout: Buffer, stderr,
timedOut, spawnedAt }` with `windowsHide`) and M3 (not a repo, bare repo, git and Node
versions as typed results), wired into `plan` step 1-2 so that `plan` refuses before any run
folder exists. It builds the first M15 `planRefusal` rows (`env`, `state`); RUN-14 completes
their order.

**Blocked by:** INT-01, RPL-03.

**Status:** done

**Sources:** Q9, Q15, Q21, C:plan (steps 1-2), C:cli-and-exit-codes, stories 185, 202, M2, M3.

- [x] Seam 1: `plan` in a directory that is not a repository → exit 6, `error.kind: "state"`, no `.commit-plan` created.
- [x] Seam 1: `plan` in a bare repository → exit 6 `state`.
- [x] Seam 1: a PATH git shim reporting a version below 2.34 → `env` (story 202).
- [x] Seam 1: a PATH containing no git binary at all → exit 1 `env` (produced in CI through PATH manipulation, not only by hand).
- [x] M2 returns `stdout` as a `Buffer` and never decodes it; every spawn sets `windowsHide`, both asserted from the fixture's recorded call.
- [x] A static test greps every source file outside M2 for `child_process`, `spawn`, `execFile` or `exec` and fails when one is found (the architecture rule "M2 is the only spawner" holds for the code written so far).


## GIT-02: M3 HEAD state: branch, detached, unborn, expected HEAD

**What to build:** M3 reads branch, detached and unborn HEAD from one porcelain v2 `--branch`
status call pinned with `--untracked-files=no --ignore-submodules=all --no-ahead-behind`,
plus `head()` and `headTree()`; `plan` stores `state` and the expected HEAD (`null` when
unborn) and adds the detached-HEAD notice.

**Blocked by:** GIT-01, RUN-05.

**Status:** done

**Sources:** Q21, C:plan (`state.kind`, notices), stories 182, 183, M3.

KD-R65 (retired by CHG-03b): this slice first asserted the first two criteria below against
`plan`'s stdout `state`/`expectedHead`, a Seam-1 stand-in; CHG-03b moved them to `plan.json`
`state` and `state.json` `head` and dropped the stdout fields. The third criterion (unborn
HEAD) is narrowed to KD-R66: an unborn repo cannot reach step 7 until a later slice lets its
inventory take an added file. KD-R67 tracks the detached-HEAD notice in the second criterion
going unobserved on `plan`'s hunks path until a later slice stores notices in `state.json`.

- [x] Seam 1: on a branch → `plan.json` `state: { kind: "branch", branch, unborn: false }` and the stored expected HEAD equals `git rev-parse HEAD`.
- [x] Seam 1: detached HEAD → `state.kind: "detached"` and the detached-HEAD notice in the stored notices (reply `notices` once RPL renders them).
- [x] Seam 1: unborn HEAD → `unborn: true`, expected HEAD `null`, no failing `git show HEAD:` call (config at HEAD skipped, story 182).
- [x] Exactly one status call supplies branch, HEAD and (for GIT-04) the unmerged lines; `headTree()` returns `HEAD^{tree}` (consumed by EXE's backstop tree comparison).


## GIT-03: M3 in-progress operations refused

**What to build:** detection of merge, cherry-pick, revert, rebase (`rebase-merge`,
`rebase-apply`), bisect, a paused sequence (`sequencer/`) and a pending `merge --squash`
(`SQUASH_MSG`) through one M2 `gitPath` call, each refused by `plan` as `state` with the Q21
text, before the run folder is created.

**Blocked by:** GIT-02.

**Status:** done

**Sources:** Q21, C:plan (step 2, `state.kind`), story 184, M3.

- [x] Seam 1, one fixture each: merge with a conflict, cherry-pick, revert, rebase stopped at `edit`, bisect, a multi-pick cherry-pick paused after a conflicted pick was committed by hand (no `CHERRY_PICK_HEAD`, only `sequencer/`) → exit 6 `state` with the Q21 text for that row.
- [x] Seam 1: `git merge --squash` pending → `state` with "a squashed merge is staged: commit it by hand, or drop it with `git reset --merge`".
- [x] The `git-path` lookups use one `rev-parse --git-path` call (M2 `gitPath(names)`), so linked worktrees resolve their own paths.
- [x] No run folder exists after any of these refusals.


## GIT-04: Unmerged entries and non-UTF-8 commit encoding refused

**What to build:** M3 reads any `u` line of the same porcelain v2 status as `unmerged`
("resolve the conflicts first"), and reads `i18n.commitEncoding`, accepting `utf-8`/`utf8`
case-insensitively; both refuse `plan` as `state`.

**Blocked by:** GIT-02.

**Status:** done

**Sources:** Q21, C:plan (`i18n.commitEncoding`), stories 186, 211, M3, testing-modules Q11 case list.

- [x] Seam 1: a conflicting `git stash pop` (no in-progress marker) → exit 6 `state`, text "resolve the conflicts first".
- [x] Seam 1: `i18n.commitEncoding` set to `utf8` and to `UTF-8` → accepted; set to `ISO-8859-1` → exit 6 `state`.
- [x] The encoding check is refused in the `state` slot of the refusal order (after `env` and `config`).


## GIT-05: M2 environment hygiene for read-only and staging calls

**What to build:** on every git call except `git commit`: every inherited `GIT_*` variable is
removed except the keep-set, `GIT_LITERAL_PATHSPECS=1`, `core.quotePath=false`,
`diff.suppressBlankEmpty=false`, `GIT_OPTIONAL_LOCKS=0` on read-only calls only, optional
alternate index; history reads additionally pin `log.showSignature=false` and
`i18n.logOutputEncoding=UTF-8`; stdin for message input and path lists.

**Blocked by:** GIT-02, CHG-03b.

**Status:** done

**Sources:** Q9, Q18, M2, stories 74, 147, testing-modules row M2/M3.

- [x] Seam 1: decoy `GIT_DIR` and `GIT_INDEX_FILE` exported to the entry point → `plan` inventories and diffs the real repo (units as without the decoys). The `GIT_ATTR_SOURCE` decoy is checked in CHG-10, once `check-attr` is wired.
- [x] Seam 1: `GIT_CONFIG_SYSTEM` pointing at a file that sets a key is honoured (the keep-set survives; the signing-probe case is in GIT-10).
- [x] Seam 1: a path containing `[id]` and `*` is inventoried literally (literal pathspecs).
- [x] Seam 1: decoy `GIT_ICASE_PATHSPECS`, `GIT_GLOB_PATHSPECS` and `GIT_NOGLOB_PATHSPECS`
      exported to the entry point are removed (not in the keep-set), and a tracked
      `.commit-plan` still refuses `plan` with the pinned `GIT_LITERAL_PATHSPECS=1` (M3
      `isTracked` reads the index without a pathspec, review-RUN-05 finding 6).
- [x] `GIT_OPTIONAL_LOCKS=0` is set on read-only calls and never on staging calls (observable by the spawn-record preload's `gitEnv` record).


## GIT-06: M2 `git commit` environment for user hooks

**What to build:** the `commit` spawn mode of M2: removes only `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`,
`GIT_CONFIG_PARAMETERS`, `GIT_ATTR_SOURCE`, `GIT_OBJECT_DIRECTORY` and
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, sets neither `GIT_LITERAL_PATHSPECS` nor the `-c`
pins, and keeps every other variable for the user's hooks.

**Blocked by:** GIT-05, EXE-02.

**Status:** ready-for-agent

**Sources:** Q9, Q18, M2, stories 147, 163, testing-modules row M2/M3.

- [ ] Seam 1: a pre-commit hook records its environment → `GIT_AUTHOR_NAME` and a custom `GIT_FOO` exported to the entry point are present; `GIT_LITERAL_PATHSPECS` is absent; a decoy `GIT_INDEX_FILE` is absent.
- [ ] Seam 1: the commit lands in the real repo despite a decoy `GIT_DIR`.


## GIT-07: M2 timeout and process-tree kill from the call deadline

**What to build:** every M2 call takes `timeoutMs` from the call's `deadline` (or
`cleanupDeadline` for cleanup calls) at its own start; on expiry it kills the tree (POSIX:
`SIGTERM` to the process group, `SIGKILL` after 5 s; Windows: `taskkill /T`, then
`/T /F` after 5 s, `taskkill` resolved from the system directory) and returns `timedOut`;
`plan` past its deadline ends `timeout` and discards its provisional run.

**Blocked by:** GIT-05, FND-05, RUN-12.

**Status:** ready-for-agent

**Sources:** Q9, Q18, M2, M15 `deadline`, testing-seams "Clock at Seam 1", story 43.

- [ ] Seam 1: a clean filter that sleeps, with the clock stepped to 535 s elapsed at start → `plan` ends exit 5 `timeout` within about 10 s, no run folder left, no lock left.
- [ ] Seam 1 (POSIX and Windows): the sleeping filter's child process is gone after the call returns (tree kill, not only the direct child).
- [ ] A cleanup call whose `timeoutMs` is at or below 0 is not spawned and reports `timed-out`.
- [ ] Seam 1: `release`'s M10 `treeState` read (M18 `finalReply`, `workflows.mjs`) takes its
      `timeoutMs` from M15 `releaseDeadline` (RUN-03), not a fixed short timeout; with the
      clock near 45 s elapsed since the call's start and a slow `git status`, the read times
      out and the reply omits the tree-state line (`treeState: undefined`), the same as a read
      skipped outright past the deadline — `release` exits 0, never `internal` (review-RUN-03
      finding 1).
- [ ] `callStarted` (RUN-03) is read once at dispatch (`cli.mjs`'s `main`) and threaded through
      `injected`/`ctx`, rather than each M18 workflow reading it itself (review-RUN-03
      finding 3).


## GIT-08: Signal handler: Esc or session end kills the active git tree

**What to build:** M2 tracks its active child and exposes `killActive()`; the commit entry
point's `SIGINT`/`SIGTERM`/`SIGHUP` handler calls it and removes the call's `call.lock`
through M12 `run.close()` (idempotent, `ENOENT`-tolerant; RUN-20 item 10), without
unstaging or releasing.

**Blocked by:** GIT-07, PRE-13, RUN-04, RUN-20, INT-02.

**Status:** ready-for-agent

**Sources:** Q9, Q18, architectural-decisions "Asynchronous process adapter", story 217.

- [ ] Seam 1 (POSIX): `SIGTERM` sent to a `commit` call during a slow pre-commit hook → `killActive()` kills the hook's process tree (the hook's own sleep never reaches its marker file) and `call.lock` is gone; whether a commit lands from that call is EXE-24's assertion, not this slice's.
- [ ] The lock and run folder are left for the takeover (not released).


## GIT-09: M3 history reads and reword facts

**What to build:** `recentSubjects` (last 10), `oldMessage` and, with `--reword`, the
unborn, merge-commit, root-commit and pushed facts (one `for-each-ref --contains` over
remote-tracking refs, skipped when unborn), with `plan --reword` refusing unborn and merge
HEAD (`state`) and a pushed HEAD (`pushed`); also the last 200 non-merge messages for
`infer`. It adds the reword rows of M15 `planRefusal`.

**Blocked by:** GIT-02, CHG-03b.

**Status:** ready-for-agent

**Sources:** Q18, Q20, Q21, C:plan (step 2), C:plan-hunks (`recentSubjects`, `oldMessage`), stories 176, 177, M3.

- [ ] Seam 1: `plan` → `recentSubjects` holds the last 10 subjects, newest first, with `log.showSignature=true` set in the repo config not leaking signature lines.
- [ ] Seam 1: `plan --reword` on an unborn HEAD and on a merge commit → exit 6 `state` (the merge-commit text is "HEAD is a merge commit; reword it by hand", confirmed in Q20); on a HEAD contained in a remote-tracking ref → `pushed`; on a root commit → accepted (root-commit fact stored for CHG-15).
- [ ] Seam 1: `plan --reword` on a clean tree → `oldMessage` stored in the run state byte-exact (UTF-8) (the lock-taken criterion is RUN-06's).


## GIT-10: Signing probe tracer: enabled flag and non-SSH formats

**What to build:** M11 `probeSigning` reading `commit.gpgsign` with `--type=bool` and
`gpg.format`: off → `{ enabled: false }`; openpgp → `"prompt"` with the note "signing
enabled; a passphrase prompt may appear"; x509 or a custom `gpg.program` → `"unknown"`; a
custom `gpg.ssh.program` → `"prompt"`; wired into `plan` step 6, after `staged-hit` and
clean-tree detection. It adds the `signing` row of M15 `planRefusal`; RUN-15 asserts its
place in the order.

**Blocked by:** GIT-05, RUN-06.

**Status:** ready-for-agent

**Sources:** Q18, C:plan (`signing`, notices), stories 169, 171, M11, testing-modules row M11.

- [ ] Seam 1: `commit.gpgsign` unset or `false` → `plan.json` `signing: { enabled: false }`.
- [ ] Seam 1: openpgp enabled → `ready: "prompt"` and the note in the stored notices and in the `plan` reply's notices (story 171); the run goes ahead.
- [ ] Seam 1: `gpg.format=x509`, and separately a custom `gpg.program` → `ready: "unknown"`, run goes ahead.
- [ ] Seam 1: `gpg.format=ssh` with a custom `gpg.ssh.program` → `"prompt"` with the note.
- [ ] Seam 1: `commit.gpgsign=true` set only through an exported `GIT_CONFIG_SYSTEM` file is seen by the probe.
- [ ] The probe spawns only git (and, from GIT-12, `ssh-add`), never shows a prompt.


## GIT-11: SSH readiness from the key file

**What to build:** the key-source table of C:plan (unset key, literal key, `.pub` path, other
path with `<path>.pub` or the public part of an `openssh-key-v1` file; `~/` against the
injected OS home, `~user/` → unknown, relative against the toplevel) and the header rows:
OpenSSH cipher `none` or PEM without `ENCRYPTED` → `true`; a cipher or PEM `ENCRYPTED`, and no
private key file, both give `false`; an unreadable header gives `"unknown"` outright. With no
`ssh-add -L` check wired yet, every `false` here is untrusted, so this slice reports it as
`ready: "unknown"` (the table's last row) rather than refusing. `plan` does not refuse
`signing` from a locked key at this slice — GIT-12 turns a confirmed-unloaded key into that
refusal ("signing key locked — unlock it …") once `ssh-add -L` is wired.

**Blocked by:** GIT-10.

**Status:** ready-for-agent

**Sources:** Q18, C:plan (SSH readiness tables), stories 170, M11, testing-modules row M11.

- [ ] Seam 1: an unencrypted OpenSSH key and an unencrypted PEM key → `ready: true` (no agent involved).
- [ ] Seam 1: a passphrase-protected key file, with no `ssh-add` check yet available → `ready: "unknown"` (last table row: an untrusted `false` becomes `"unknown"`; the `signing` refusal is GIT-12's, once `ssh-add -L` is wired).
- [ ] Seam 1: `user.signingKey` set to a `.pub` path reads the private file beside it; a `~/` path expands against the temp OS home; a `.pub` without its private file → `"unknown"` when no agent check ran (last table row).
- [ ] Seam 1: `user.signingKey` unset with `gpg.ssh.defaultKeyCommand` set, and unset without it → `"unknown"`.


## GIT-12: SSH readiness through the agent (`ssh-add -L`)

**What to build:** `ssh-add` located in the directory of the `ssh-keygen` git runs (on Windows
Git for Windows' `usr/bin` from `git --exec-path` first; a `PATH` `ssh-add` elsewhere never
used), `-L` compared by key type and base64 blob, exit 1/2 as an empty list, any other exit or
a timeout as "not run", and the last table row turning an untrusted `false` into `"unknown"`.

**Blocked by:** GIT-11, PRE-15.

**Status:** ready-for-agent

**Sources:** Q18, C:plan (SSH readiness), M11, testing-modules row M11.

- [ ] Seam 1 (POSIX, fixture starts its own `ssh-agent`): a passphrase key loaded in the agent → `true`; a literal `key::` key in the agent → `true`, not in it → exit 6 `signing`.
- [ ] Seam 1: no `ssh-add` next to git's `ssh-keygen` (git shim directory without one) → a passphrase key or a literal key → `"unknown"`, an unencrypted key file → `true`.
- [ ] Seam 1: an `ssh-add` stub that sleeps past the fixed timeout → `"unknown"`, `plan` not stalled.
- [ ] Seam 1: an `ssh-add` stub exiting 2 (no agent) with a passphrase key → exit 6 `signing` (empty list is trusted).
- [ ] Seam 1: a passphrase-protected key file not in any agent → exit 6 `signing` (domain code `signing-locked`, Q18 as amended by PRE-15) with the `signing-locked` text verbatim from the C:cli-and-exit-codes recorded-texts table.
- [ ] Seam 1: a locked key on a clean tree → "nothing to commit", not `signing` (probe after clean-tree detection).
