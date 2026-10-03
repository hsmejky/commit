# Q18 Failures, repo hooks and signing

- **Context.** A multi-group run can fail halfway: the scan backstop, the repo's own git hooks
  (pre-commit, a commitlint `commit-msg` with different rules), or commit signing, where a
  TTY pinentry hangs a non-interactive `child_process` call.
- **Decision.**
  - `check` lints every group before the first commit, so a lint failure never leaves a run
    half done.
  - Stop at the first failing group. Commits already made stay; they are local and the user
    can `git reset HEAD~n`. `commit --all` (and `check`, which runs it) reports the
    groups it committed, the failed group and the ones not committed, and exits with the
    failed group's cause (Q9).
  - `split`: each group runs in three phases: (a) the refusals (`lock`, `usage`,
    `head-moved`, `index-lock`, and `diff-changed` for `index-changed`); (b) rebuild the
    temporary index, diff and match the group's hashes (`diff-changed`), which never
    touches the real index; (c) reset the real index,
    stage, verify, scan, commit. A failure in (a) or (b) leaves the real index exactly as it
    was. A failure in (c) runs `git reset -q -- .` (index only), so the remaining changes are
    unstaged again and the working tree is untouched. The state file records
    `indexReset: true` the first time (c) starts. Once set, the output that ends the run
    (last group, or any failure, including (b) of a later group) lists as `unstaged` the
    pre-staged paths still not in HEAD, and every `indexOnly` path (Q11) with its blob,
    each with its `ignored` flag; the report says "your earlier staging was reset: …" (a
    gitignored one "…is no longer shown by `git status`", an index-only one "…staged
    version discarded, recover with `git cat-file -p <blob>`"). Before that, `unstaged` is
    `null` and the report says the index is untouched. `staged` and `reword`: the index is
    left as it is (a reword never touches the user's staged changes, Q20). The run lock is
    released and the run folder deleted.
  - Verify (c): after staging, the index diff against HEAD (pinned options) must hold
    exactly the group's hashes. Otherwise (a whole-file unit or a filtered file changed
    between the match and `git add`) → reset, exit 6 `diff-changed`. It replaces the old
    empty-index check: the commit holds what was confirmed, byte for byte.
  - Report (the reply's `text`, Q25): the committed groups as `sha subject`, the failed
    group and its reason, the groups not committed, and the files left out by pattern hits
    (Q10).
  - Per cause (exit code, Q9):
    - Lint → the worker fixes `plan.groups.json` from the errors and runs `check` once more,
      inside the same spawn (Q24). `check` counts the failures in the state file, and
      `plan --hunks`, which every spawn runs first, resets the count; so the second failure
      in one spawn is decided by the script, not by the worker's prompt. On it `check`
      returns a `lintFailed` handback (Q25): the rejected messages and the errors, with
      the options `retry` (a respawn with `resume` and `edit: fix these lint errors: …`, so
      a fresh worker sees the errors) and `no` (release), and `edit <free text>` typed
      under Other (a respawn with `resume`; repeatable; also covers dictated text such as
      "subject of 1: …"). `yes` and `one` are not offered: neither fixes a lint error.
      `AskUserQuestion` needs at least two options, which `retry` and `no` give. With
      `--no-user`, `check` releases the lock and the reply carries the errors.
    - Lint on dictated text (`"source": "user"`, Q20): the **first** failure already ends
      the worker's part, with the same handback (or, with `--no-user`, the same failed
      reply). The script knows `source`, so no prompt rule is needed: the worker never
      rewrites the user's words unseen and commits them unattributed.
    - Scan backstop → stop and show the hits.
    - `git commit` failed (exit 4) → stop, show git's output, no retry, never
      `--no-verify`. A `prepare-commit-msg` hook that adds trailers is accepted: lint runs
      before git.
    - Exit 4 or timeout (exit 5), but git made the commit anyway (a hanging `post-commit`
      hook, a signing prompt answered at the last second): after either, `commit` reads
      HEAD. If it moved from the expected SHA, the output carries the new `sha` and the
      report says "committed as `<sha>`, but git did not exit cleanly / in time". The run
      still ends there; the group counts as committed in the report.
    - `diff-changed` on group n+1 after the repo's own hooks rewrote files during group n's
      `git commit` (husky + lint-staged + prettier): `commit` computes the diff's hash set
      right before and right after its `git commit` call and records in the state file
      whether "after" differs from "before" minus group n's own hashes (a successful commit
      always takes those out of the diff, so comparing the raw sets would flag every
      multi-group run). The next group's `diff-changed` then says "files changed during
      the commit of group n — a repo hook (lint-staged, a formatter) likely rewrote them;
      run /commit again" instead of "files changed since plan". Supporting such hooks
      mid-run (re-planning automatically) is out of scope.
    - `head-moved` → stop: "HEAD moved since plan (commit made elsewhere?), run /commit
      again". `commit` compares HEAD with the SHA the state file expects (recorded by `plan`,
      updated after each committed group), so neither a reword's `--amend` nor a group lands
      on a commit the run never saw.
  - Exit 4 does not name a cause. `git commit` exits 1 for a hook rejection, a signing
    failure, an `index.lock` collision and "nothing to commit" alike, and its stderr is
    localised, so the script does not parse it. The causes it can know are checked before
    git runs: an existing `index.lock` → exit 6 `index-lock` ("another git process is running
    in this repo"), checked before the index is reset or staged, since `reset` and `apply`
    take the lock too and would otherwise fail unmapped and leave the index half staged; a
    staged diff that is not exactly the group (not checked in `reword`, which usually runs
    on a clean tree; `staged` compares the index with the map instead) → exit 6
    `diff-changed`; a locked signing key → caught by `plan`.
  - `git commit` always runs with `--cleanup=verbatim`: the script has already normalised
    the message, and a user's `commit.cleanup=strip` would otherwise delete body lines that
    start with `#` (or `core.commentChar`), so the committed message would differ from the
    one lint approved.
  - Signing: never disabled. When `commit.gpgsign` is true, `plan` probes it
    (`plan.signing.ready`), after the clean-tree and `staged-hit` checks, so a clean tree
    on a locked key reports "nothing to commit" (Q9):
    - `openpgp`: `"prompt"`, with the note "signing enabled; a passphrase prompt may
      appear". A locked openpgp key is not detected at `plan` (an accepted gap); classifying
      the pinentry program with `gpg` and `gpgconf` probes is deferred past 0.1.0 (see
      [Non-goals](non-goals.md)).
    - `ssh`: the key is in `ssh-add -L`, or the private key file (`user.signingKey` minus a
      `.pub` suffix) has no passphrase, decided from its header with no extra process
      (OpenSSH `openssh-key-v1` with cipher `none`; PEM without `ENCRYPTED`) → `true`,
      else `false`; `"unknown"` when the key source cannot be checked
      (`gpg.ssh.defaultKeyCommand` or no key, a `~user/` path, a private key file whose
      header is neither form) or when a `false` rests on an `ssh-add -L` check that was not
      run or not trusted (the case table in [contracts](../contracts/plan.md)).
    - `x509`: `"unknown"`.
    - A custom signing program is outside the probe's view and never maps to `false`: a
      `gpg.ssh.program` other than the default (1Password's `op-ssh-sign` asks with Touch ID
      or a window, and its key is usually not in the default agent's `ssh-add -L`) →
      `"prompt"`; a custom `gpg.program` → `"unknown"`.
    - The probe runs only git and `ssh-add` (Q15), each under a fixed timeout; a timeout
      yields `"unknown"`, so a wedged agent cannot stall `plan`, and a probe that could not
      finish never maps to `false`.

    `false` → `plan` refuses with exit 6 `signing`, before any grouping: "signing key
    locked — unlock it (e.g. sign once in a terminal), then `/commit`". `"prompt"` (openpgp
    or a custom `gpg.ssh.program`) → the run goes ahead and the reply's `notices` carry the
    plan's note "signing enabled; a passphrase prompt may appear". The worker commits through `check` before anyone reads a notice,
    so the window itself is the first sign; the notice explains it afterwards. `"unknown"`
    → the run goes ahead.
  - Timeouts: every script call the worker itself makes (`plan`, `plan --hunks`, `check`)
    runs with a 600-second (600 000 ms) tool timeout (the Bash tool's maximum; the worker's
    prompt says so; Q9). `commit --all` and `release` never run from the worker (G3, Q25):
    they run only from a handback's `run` in the caller, which carries its own `timeoutMs`
    (Q25 pass 5). `plan` has its own 540-second deadline from its start, bounding
    all its git calls (`timeout`, Q9). The script's own budget is 540 seconds per call, not per group: the first
    group always starts, a later one only while at least 480 s are left; otherwise the call
    stops cleanly with a `continue` handback that runs the same command, and the run goes on
    where it stopped (the handback goes to the caller, which follows `callerRule`; the
    guard denies the worker's own `commit` call, Q25). Each
    `git commit` is timed out at what is left of the budget. On timeout it kills the process
    tree (on POSIX `SIGTERM` to the process group, then `SIGKILL` after a 5-second grace; on
    Windows `taskkill /T`, then `taskkill /T /F` after the same grace), and reports "git
    commit did not finish in 9 min — a pre-commit hook or a signing prompt may be waiting".
    On a partial commit (reword's `--amend --only`), where git holds `index.lock` across its
    hooks until the kill, it removes `index.lock` only when it is stale by the two-marker
    rule. On a plain commit (`split`, `staged`) it never removes `index.lock`: git released
    it before the hooks ran, so a lock present after the kill may belong to another process;
    the report says `index.lock` was left and should be checked and removed by hand if no
    git process is running. The two-marker rule: a marker file is written next to
    `index.lock` (both resolved through `git rev-parse --git-path index.lock`, the
    per-worktree git directory) right before the `git commit` spawn and a second one right
    before the tree kill starts; after the child has ended, `index.lock` is removed only when
    its mtime is at least the first marker's minus 2 seconds (mtime resolution) and strictly
    below the second marker's. Only the lower bound is widened: on a partial commit the
    running `git commit` holds the lock until the kill, so a lock another process creates
    after the kill has an mtime at or above the second marker's and is kept. All three times
    come from the same filesystem, so a skewed clock cannot lead to removing a foreign lock.
    One module (M10) owns the markers, the spawn and the removal.
- **Amended.** By spec pass 2 (2026-09-27): the signing probe (git and `ssh-add` only, Q15)
  runs each process under a fixed timeout, and a timeout yields `"unknown"` rather than
  failing the run.
- **Amended.** By spec pass 3 (2026-09-27):
  - The kill sequence: `SIGTERM` to the process group, then `SIGKILL` after a 5-second
    grace (Windows: `taskkill /T`, then `/T /F`), instead of an immediate hard kill.
  - The two-marker stale `index.lock` rule replaces "newer than the spawn", which compared
    the lock's filesystem mtime with the local clock.
  - Signing probe: SSH readiness by `ssh-add -L` or the key file's header; openpgp enabled
    → `"prompt"` with a note; the probe runs only git and `ssh-add`. The openpgp pinentry
    classification (`--pinentry-mode error`, `gpgconf`) is deferred past 0.1.0.
  - `plan` refuses on signing only after the clean-tree and `staged-hit` checks (Q9).
  - `plan`'s 540-second deadline and the 600 000 ms tool timeout for `plan` and `check`
    (Q9).
- **Amended.** By spec pass 4 (2026-09-27):
  - Two-marker rule: the second marker is written before the tree kill and only the lower
    bound is widened (a 2-second widening after the kill could remove a lock another
    process created right after it); markers and lock resolve through the `--git-path` of
    `index.lock`; M10 owns the whole mechanism.
  - SSH readiness follows an explicit case table (contracts, `plan`): a literal key is
    matched against `ssh-add -L` only; `gpg.ssh.defaultKeyCommand` or no key → `"unknown"`;
    a private-key path reads its `.pub`; `~/` expands against the OS home; `ssh-add` is the
    one next to the `ssh-keygen` git runs (on Windows a `PATH` `ssh-add` may talk to another
    agent), and a `false` that rests on an agent check that could not run is `"unknown"`.
  - The backstop runs `git write-tree` first and scans the tree-to-tree diff of the
    expected HEAD against that tree, so the tree recorded is the tree scanned.
- **Amended.** By spec pass 5 (2026-09-27): `cleanupDeadline` = the call's start plus 590 s;
  after a failure or a timeout, the cleanup and reporting calls (the `finally` unstage, the
  HEAD re-read, the tree-state read, and the release) take the time left before
  `cleanupDeadline`, never the spent 540-second `deadline`, so a call that used up its 540 s
  budget still reports and releases inside the worker's tool timeout.
- **Amended.** By spec pass 6 (2026-09-27):
  - Phase (a)'s `index-changed` refusal (exit 6 `diff-changed`) is skipped in `reword` mode:
    `--amend --only` never touches the index, so staging a file during a reword must not end
    the run with `diff-changed` (Q20 rejects refusing a reword over a non-empty index for the
    same reason).
  - What a caller shows through `text` for git or hook output is capped and escaped, not
    shown verbatim: `text` carries at most the last 2000 characters of that output, prefixed
    with a "[… N characters cut]" marker when cut, while the full output stays in
    `gitOutput`. Control characters (C0/C1, ESC included, so ANSI is neutralised) are escaped
    as `\xNN` the same way the path rule escapes them; `\n` and `\t` are kept. Accepted gap:
    hook output can still hold forged plain-text lines or echo a secret — the cap and escape
    only bound size and terminal/rendering damage. (The contracts-side shape of `text` /
    `gitOutput` carries the rest of this rule.)
  - On a takeover of a run whose `indexReset` was set and whose current group was not
    committed, the new run resets the index or asks via `modeChoice` before its own
    inventory step runs, instead of only reporting `unstaged` — see Q22's pass-6 amendment
    for the full mechanism.
- **Amended.** By spec pass 7 (2026-09-27): `cleanupDeadline` lowered to the call's start plus
  580 s (was 590 s, pass 5): 590 s left too little margin once the 5-second kill grace and
  Node's own start-up (the 600 s tool timer starts before Node does) are subtracted. A
  cleanup or reporting call (the `finally` unstage, the HEAD re-read, the tree-state read, the
  release) whose `timeoutMs` (= `cleanupDeadline - now()`) is ≤ 0 is not spawned at all and
  counts as timed out, the same outcome as one that started but did not finish in time.
- **Amended.** By spec pass 8 (2026-09-27):
  - A plain `git commit` (as in `split` and `staged`) releases `index.lock` before its
    hooks run; only a partial commit, such as reword's `--amend --only`, holds it across
    the hooks. The stale-lock test (story 215) is therefore built on the `reword` path with
    a sleeping hook that records that `index.lock` exists, and asserts that record, so the
    lock existed when the tree was killed.
  - After a timeout kill, `index.lock` is removed by the two-marker rule only on a path
    where git holds the lock until the kill (a partial commit). On a plain commit it is
    never removed: a lock another process created while a hook hung would fall between the
    markers and be deleted. The report instead says `index.lock` was left and should be
    checked and removed by hand if no git process is running. The earlier rationale ("the
    running `git commit` holds the lock until the kill") held only for partial commits.
- **Amended.** By spec pass 9 (2026-09-27): after each `git commit`, the script reads HEAD
  and checks its first parent against the SHA expected before that commit (an unborn branch:
  HEAD has no parent). A match: HEAD is the group's SHA, stored as the next group's expected
  HEAD. A mismatch (a hook or another process committed as well): the group is still
  reported committed, with the SHA HEAD now holds, plus a notice naming the group ("another
  commit was made during group `<n>`; later groups refused"); the expected HEAD is not
  advanced past the mismatch, so the next group's own (a) check finds HEAD moved from the
  expected SHA and is refused `head-moved`. Except in `reword`: `--amend --only` gives the
  new commit the same parent as the one it replaced, not the old HEAD, so there the check
  instead compares HEAD's first parent against the expected HEAD's own first parent (both
  none, on a root commit); otherwise every reword would report a false "another commit"
  notice.
- **Amended.** By the EXE-01 decision pass (2026-09-29), settling KD-S12 and the `internal`
  test gap:
  - A cleanup call after a failed run (the `finally` unstage, the HEAD re-read, the
    tree-state read, the release) that fails (a Windows file lock) or is skipped past
    `cleanupDeadline` never changes the outcome: the exit code and kind come from the
    original cause, and the cleanup error becomes a notice. When the unstage of a group that
    reached phase (c) did not happen, the run is not released: the lock and the run folder
    stay, with `indexReset` and the unfinished group in the state, so the next run's
    takeover repair resets the index (Q22's pass-6 mechanism). The output then has
    `unstaged: null` and the notice "group `<n>` staging may remain, the next /commit
    repairs it". This supersedes, for this case, "a failed run leaves a clean, explainable
    state" (Consequences); the contracts' release on every failure that ends the run gets
    the same exception.
  - The `internal` path after `git commit` (the HEAD re-read that reports a commit made
    before the throw) is tested at Seam 1 through the test-tree fault-injection preload, not
    a shipped switch: a `state.json` rename failing with `EIO` after `git commit` → exit 1
    `internal` with `sha` set. It is no longer an accepted gap.
- **Amended.** By the PRE-15 decision pass (2026-09-29), settling KD-S16 and KD-S17: the
  locked-key refusal keeps its own domain code, `signing-locked` (kind `signing`, exit 6),
  so tests tell it apart from other `signing` causes; it is the only `signing` code in
  0.1.0. Its text ("signing key locked — …"), the `head-moved` text and the openpgp note
  above are recorded verbatim, with Q20's merge-commit text and Q21's repo-state texts, in
  the recorded-texts table of [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md#recorded-texts), which tests assert.
- **Rejected.**
  - Rolling back committed groups (destroys work the user may want); retrying on a repo hook
    failure (the hook's rules are not the plugin's to guess); `-c commit.gpgsign=false`.
  - `GIT_TERMINAL_PROMPT=0` as the signing guard: it governs credential prompts, not pinentry.
  - A 120-second timeout with a signing-specific message: the Bash tool's own default kills
    the script first, and a slow pre-commit hook is indistinguishable from a signing prompt.
  - Treating every uncached openpgp key as not ready: gpg-agent's default cache lasts
    10 minutes, so a GUI pinentry user would be sent to a terminal on most runs, although the
    real commit would have shown the passphrase window.
  - Telling hook, signing and lock failures apart by parsing git's stderr: localised and
    mixed with arbitrary hook output.
  - Reporting a moved HEAD as `diff-changed`: its message ("files changed") names the wrong
    cause when only HEAD moved.
  - A literal `message: <text>` answer after two failed lints that skips the worker: a
    third input path in the prompt, and `edit` already carries dictated text.
  - A 540-second timeout per group inside `--all`: two groups behind a slow hook pass the
    600-second tool maximum, and three can pass the 15-minute lock window (Q22).
  - Counting lint attempts in the worker's prompt: a prompt rule, where the script can
    count deterministically.
  - An unconditional `git reset -q -- .` on every `split` failure: after a refusal in (a) or
    (b) it reset an index the run never touched, and after `index-lock` it ran into the
    same `index.lock` and failed unmapped.
- **Consequences.** A failed run leaves a clean, explainable state (amended by the EXE-01
  decision pass, above: a failed or skipped unstage keeps the run for the next takeover).
  A GUI pinentry prompts for the passphrase during the commit, within the 540-second timeout; SSH signing through an
  agent works without interaction, and a locked SSH key is caught before any grouping. A
  locked openpgp key behind a TTY pinentry is not caught at `plan`: the plan notes that
  signing is enabled, and the commit fails or times out at `git commit` (an accepted gap
  until the pinentry classification lands).
