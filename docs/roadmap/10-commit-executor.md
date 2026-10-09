# 10 Commit executor

M16 Commit executor: the per-group loop of `commit --all` (phases (a) refusals, (b) match,
(c) apply, then the backstop, trailers and `git commit`), the reword path through `--amend
--only`, and every failure, hook and signing behaviour at commit time. It uses M15's
`deadline`, `nextStep` and `cleanupDeadline` and M12's `open` and `touch` (group RUN). M16
is observable only at Seam 1, so every slice runs `commit --plan <id> --all` (or `check`,
which commits in-process) against a run that `plan` created. Main sources: M16, M18
`commit`, C:commit-release, C:cli-and-exit-codes, the domain-code table, Q9, Q11, Q18, Q20,
testing seams (end-to-end budget, stepping clock), stories 160-175, 177, 179-180, 208, 215,
217. EXE-01 (a human decision) settles the commit-time and interface open items. EXE-02
builds thin whole-file versions of the M10 operations it needs; CHG-19 to CHG-23 widen them.

## EXE-01: Settle the commit-time and interface open items

**What to build:** a decision pass (human) over the commit-time items left open in [known
deficiencies](../spec/known-deficiencies.md) (KD-S12, KD-S19, KD-S24). Record each decision
in the Q it changes (an **Amended** bullet) and fix the contracts and the spec so they
agree. The items: (1) `osUser` is missing from the M14 `validatePlan` and M16 `commitAll`
interfaces, although both scan with it; (2) what happens when cleanup fails or is skipped
past `cleanupDeadline`; (3) the M16 `internal` path has no Seam 1 trigger: a test-only fault
seam, or an accepted gap; (4) the failure JSON examples (lock, lint) lack a `reply`, and no
failed `commit --all` example exists. (The M16 SHA source is already settled: after each
`git commit`, M16 reads HEAD and checks that HEAD's first parent is the expected pre-commit
HEAD — for an unborn branch, HEAD has no parent; in `reword`, against the expected HEAD's
own first parent — and takes HEAD as the group's SHA when it is; see EXE-06.)

Settled (2026-09-29): (1) `validatePlan(planBytes, runState, { osUser })` and
`commitAll(run, { now, osUser })`, `osUser` passed by M18 and never stored in `state.json`
(Q10 as amended); (2) a cleanup call that fails or is skipped keeps the original cause's exit
code and kind and adds a notice; when the unstage did not happen, the lock and run folder
stay for the next run's takeover repair, with `unstaged: null` and the notice "group `<n>`
staging may remain, the next /commit repairs it" (Q18 as amended, story 45, C:run-folder,
M15, M16); (3) the `internal` path's Seam 1 trigger is the FND-10 fault preload: a
`state.json` rename failing with `EIO` after `git commit` → `internal` with `sha` (testing
seams, EXE-17, INT-31); (4) the lock example carries `reply`, the lint example is marked
"first failure, no reply", and C:commit-release has a failed `commit --all` example.

**Blocked by:** None (can start immediately)

**Status:** done

**Sources:** Q9, Q10, Q18, M14, M16, M18, C:commit-release, C:check, C:cli-and-exit-codes,
C:reply-and-handback.

- [x] Each of the four items has a recorded decision, and decisions, contracts and spec
      agree
- [x] PLN-06, EXE-13, EXE-17, INT-07, INT-15 and INT-31 (the slices it blocks) cite the
      settled behaviour; item (3) is not an accepted gap, so the README of the roadmap no
      longer lists it


## EXE-02: `commit --all` commits one group of whole-file units

**What to build:** the M16 tracer bullet. `commitAll` for one stored group of whole-file
modified units in `split`: (a) M12 `open` with its `call.lock` and `touch`; (b) M10
`matchIds` on the temporary index; (c) set `indexReset`, M10 `stage` (reset, `git add -A`
over stdin paths, verify); the backstop with no hits; `git commit --cleanup=verbatim -F -`
through a plain M10 `commitGuarded`; mark the group committed, store its SHA as the expected HEAD, and release after the last group.
The outcome holds exactly the C:commit-release output fields. The test makes the run with
`plan --split` and writes one stored group into the run state as `check` would, so this
slice does not wait for `check`. It builds thin whole-file versions of M10 `matchIds`,
`stage`, `writeTree`, `treeDiffUnits` and a plain `commitGuarded` (CHG-19 to CHG-23 widen
them), commits the message verbatim (MSG-07 adds the trailers), and writes the stored group
as `check` would.

**Blocked by:** RUN-04, RUN-06, CHG-05, SCN-05, RPL-02.

**Status:** done

**Sources:** M16, M18 `commit`, C:commit-release, C:run-folder, Q11, Q18, stories 160, 162.

- [x] Seam 1: two modified tracked files in one stored group → exit 0, `commits` holds one
      entry `{ n: 1, sha, header }`, `failed: null`, `remaining: []`, `error: null`,
      `gitOutput: null`.
- [x] Seam 1: the new commit's tree holds exactly the two files' working-tree content, its
      message is the stored message byte for byte (no trailer yet), and HEAD is `sha`.
- [x] Seam 1: after the call, the lock and the run folder are gone and `call.lock` is absent.
- [x] Seam 1: with no pre-staging, `unstaged` is `[]`, not `null` (the run set
      `indexReset`, C:commit-release).


## EXE-03: the message reaches git exactly as approved

**What to build:** the message is passed on stdin with `--cleanup=verbatim`, so the repo's
`commit.cleanup` and comment character never change it.

**Blocked by:** EXE-02.

**Status:** done

**Sources:** Q18, C:commit-release, stories 126, 162.

- [x] Seam 1: repo config `commit.cleanup=strip` and a stored body line starting with `#`
      → the committed message holds that line and trailing whitespace as stored, ending in
      exactly one LF (C:message-grammar, `messageOf`).
- [x] Seam 1: a stored message whose body has a line such as `--amend` or `-n` is
      committed as text and changes no git behaviour (the message never reaches argv).


## EXE-04: several groups in order

**What to build:** the loop over every uncommitted group in order, one process. Phase (a)
runs again before each group (`touch`, expected HEAD advanced to the previous group's SHA),
and the release comes only after the last group.

**Blocked by:** EXE-02.

**Status:** done

**Sources:** M16, C:commit-release, Q18, Q22, story 160.

- [x] Seam 1: three stored groups → three commits in group order, each parent the previous
      one, `commits` lists `n` 1-3.
- [x] Seam 1: the lock mtime advances before each group (a fixture `pre-commit` hook
      records the lock mtime per group).
- [x] Seam 1: a run state with group 1 already `committed` and the expected HEAD set to its
      SHA → the call commits groups 2 and 3 only.
- [x] Seam 1: a fixture `pre-commit` hook of group 1 rewrites the run lock to hold another
      `planId` → group 1 kept, group 2's `touch` refuses `taken-over` (review-EXE-02 finding
      4: EXE-02's own `touch` throw cited `EXE-06`, which is `head-moved`; no slice asserted
      a `taken-over`/`busy` refusal from `touch` between groups until this one).

review-EXE-04 Medium-1: the mid-run `lock` refusal above is C:commit-release-conformant
(`commits`/`failed`/`remaining`/`unstaged` and the group-1 commit stay real) but EXE-04 itself
only asserts the CLI shape documented by EXE-02 (`error.kind`, one commit, the other lock and
run folder untouched); EXE-06 adds the AC that extends this same scenario to the full
mid-run-refusal output fields.


## EXE-05: `no-groups` after the lock check

**What to build:** the `no-groups` refusal (exit 1 `usage`) when `check` stored no groups or
every group is committed, placed after `lock` in phase (a). EXE-22 later inserts
`unconfirmed` before it, matching C:commit-release's phase (a) order.

**Blocked by:** EXE-02.

**Status:** done

**Sources:** C:commit-release phase (a), C:cli-and-exit-codes, M16.

- [x] Seam 1: `commit --plan <id> --all` after `plan`, before `check` has stored any groups
      → exit 1 `usage` (`no-groups`), the run kept per M15 `runEnd`, and `call.lock` absent
      after the refusal.
- [x] Seam 1: every group committed → `no-groups`.
- [x] Seam 1: the lock holds another `planId` and no groups are stored → `lock`
      (`taken-over`), not `no-groups`.


## EXE-06: `head-moved` refuses a moved HEAD

**What to build:** M3 `head()` against the current expected HEAD before each group. After
each `git commit`, M16 reads HEAD and checks that HEAD's first parent is the expected
pre-commit HEAD (for an unborn branch, HEAD has no parent). If it is, HEAD is the group's
SHA. If not, a hook or another process committed as well: the group is reported committed
with the SHA HEAD holds, plus a notice ("another commit was made during group `<n>`; later
groups refused"), and the next group is refused `head-moved`. `reword` (EXE-20) is the
exception: there the new HEAD is `--amend --only` of the old one, so it always keeps the old
commit's own parent; the check compares the amended HEAD's first parent against the
*expected* HEAD's own first parent (both `null` on a root commit), not against the expected
HEAD itself.

**Blocked by:** EXE-04.

**Status:** done

**Sources:** Q18, C:commit-release, C:cli-and-exit-codes, story 168.

- [x] Seam 1: a manual commit between `plan` and `commit` → exit 6 `head-moved`, no new
      commit, the index byte-identical to before the call, `unstaged: null`, the text "HEAD
      moved since plan (commit made elsewhere?), run /commit again" (Q18).
- [x] Seam 1: a fixture `post-commit` hook that commits again during group 1 (of three
      stored groups) → group 1 reported committed with the SHA HEAD holds and the "another
      commit was made during group 1; later groups refused" notice, group 2 refused
      `head-moved`, `failed: 2`, `remaining: [2, 3]`.
- [x] Seam 1: every mid-run refusal output of `commit --all` — including a `lock`
      (`taken-over`/`busy`) refusal from `touch` between groups (EXE-04) — carries `commits`
      (the groups already committed), `failed`, `remaining` and `unstaged` per
      C:commit-release, not only `head-moved`'s; extend EXE-04's takeover test to assert
      `commits: [{ n: 1, … }]`, `failed: 2`, `remaining: [2, 3]`, `unstaged: []` on that same
      scenario (review-EXE-04 Medium-1).

review-EXE-04 Low-2: `workflows.mjs`'s stale comments predate this slice and should be
updated when this file is next touched (not here — it belongs to another in-flight slice):
the `commitGroups` comment at ~641-646 ("EXE-02") and the `commit` JSDoc at ~781-789
(`taken-over` "refused before any group-commit work") should both mention that `touch`
before a later group can also refuse `taken-over`/`busy` with earlier groups kept and the
run not released (EXE-04).


## EXE-07: `index-changed` refuses staging from outside the run

**What to build:** M10 `indexFingerprint` against the stored fingerprint before each group
(`split` and `staged`), with the stored fingerprint updated after each of the run's own
commits and unstages, so only an outside change trips it.

**Blocked by:** EXE-04.

**Status:** done

**Sources:** Q18, Q20, C:commit-release phase (a), M16, story 162.

- [x] Seam 1: `git add` of another file between `plan` and `commit` → exit 6
      `diff-changed` (`index-changed`), nothing committed, that staging still in the index.
- [x] Seam 1: three groups with no outside change → all commit (the run's own staging never
      trips the check).


## EXE-08: `index-lock` before each group

**What to build:** M10's `index.lock` check as the last refusal of phase (a), before each
group touches the index. It builds M10 `indexLockExists()`, which CHG-23 reuses without
building it again.

**Blocked by:** EXE-04.

**Status:** done

**Sources:** Q18, C:commit-release, story 166.

- [x] Seam 1: an `index.lock` created before the call → exit 6 `index-lock`, the lock file
      untouched, the index unchanged, the text "another git process is running in this
      repo" (Q18).
- [x] Seam 1: a `post-commit` hook of group 1 creates `index.lock` → group 1 kept, group 2
      refused `index-lock`, no reset ran (`unstaged` reflects only group 1's reset).


## EXE-09: failures in the match phase leave the real index alone

**What to build:** (b) failures: a missing unit hash → `diff-changed` with "files changed
since plan, run /commit again"; a failed `git add -N` while rebuilding the temporary index
→ `git-failed` (exit 4). Neither touches the real index.

**Blocked by:** EXE-02.

**Status:** done

**Sources:** Q11, C:commit-release (b), M16, story 161.

- [x] Seam 1: a planned file edited after `plan` → exit 6 `diff-changed` with that text,
      the real index byte-identical, `unstaged: null`.
- [x] Seam 1: a stored candidate path that makes `git add -N` fail on the temporary index
      (the fixture technique is chosen in the slice; the spec names the case, not the
      mechanism) → exit 4 `git-failed`, `gitOutput` set, real index untouched.
- [x] Seam 1: a stored path missing from the working tree is skipped by the rebuild, not an
      error.


## EXE-10: failures in the apply phase unstage and report

**What to build:** (c) failures: a non-zero `git apply --cached` or `git add` after the
reset → exit 4 `stage-failed` with git's output in `gitOutput`; a verify mismatch → exit 6
`diff-changed`. Both run M10 `unstage`, because the failing group reached (c).

**Blocked by:** EXE-02, CHG-21.

**Status:** done

**Sources:** Q18, C:commit-release (c), M16, stories 161, 163.

- [x] Seam 1: a non-zero `git apply --cached` or `git add` in phase (c) (any trigger) →
      exit 4 `stage-failed`,
      `gitOutput` holds git's output verbatim, M10 `unstage` runs so the index is reset, and
      `unstaged` is present.
- [x] Seam 1: `core.safecrlf=true` rejection and a required filter that is missing (moved
      from CHG-21, KD-R97) → `stage-failed`, index unstaged, run released.
- [x] Seam 1: a verify mismatch (a file changed between (b) and `git add`) → exit 6
      `diff-changed`, index reset. No hook runs in that window, so the slice settles a
      fixture technique first; if none exists at Seam 1, the slice records the case as
      uncovered instead of adding a test switch to the shipped CLI.
- [x] Seam 1: after an exit 4 `stage-failed`, the lock and the run folder are gone.


## EXE-11: the `unstaged` report

**What to build:** M10 `unstagedAfterReset(preStaged, indexOnly)`, and `unstaged` on the
output that ends a `split` run from it, present only when the run state has `indexReset`.

**Blocked by:** EXE-10, CHG-20.

**Status:** done

**Sources:** Q18, C:commit-release (`unstaged`), C:run-folder, story 161.

KD-R69: `unstaged` is built only from `preStaged` and `indexOnly`; a reset path's
intent-to-add mark, dropped by `git reset -q -- .`, is not named here if its group never
commits (it is only in the stored `stagedNew`).

- [x] Seam 1: a pre-staged file outside the planned groups → after a successful run it is
      listed with `blob: null` and the report text "your earlier staging was reset".
- [x] Seam 1: an index-only version (staged, then the working file changed back) → listed
      with its `blob`, and `git cat-file -p <blob>` returns the discarded content.
- [x] Seam 1: a pre-staged ignored path that `git status` no longer shows → `ignored: true`.
- [x] Seam 1: a force-added gitignored file committed in group 2 (moved from CHG-21,
      KD-R97).
- [x] Seam 1: a refusal before any group reached (c) → `unstaged: null` and the report
      says the index is untouched. (`unstaged: null` and the untouched index are asserted; the
      report text is deferred to KD-R106.)
- [x] Seam 1: group 1 sets `indexReset`, then group 2 hits a refusal in (a) or a
      `diff-changed` in (b) → the real index is left exactly as it is, and `unstaged` (from
      group 1's reset) is still listed in the output that ends the run. (The (b) arm is
      tested; the (a) arm has no Seam 1 trigger, KD-R108.)
- [x] Seam 1: a budget stop (EXE-16) after a group that set `indexReset` → the `continue`
      output still carries `unstaged` as an array (the reset paths, `[]` when none), never
      `null`: `indexReset` alone gates it, never whether the output ends the run
      (C:commit-release).


## EXE-12: a failing `git commit` stops the run, no retry

**What to build:** a non-zero `git commit` (a rejecting hook) → exit 4 with `gitOutput`
verbatim; no retry, never `--no-verify`; earlier groups kept; `failed` and `remaining`
set; the index unstaged; HEAD re-read within `cleanupDeadline` (unmoved → no `sha`).

**Blocked by:** EXE-04, EXE-10.

**Status:** done

**Sources:** Q18, C:commit-release, C:cli-and-exit-codes, stories 160, 163, 165.

- [x] Seam 1: a `pre-commit` hook that rejects group 2 and appends to a counter file →
      exit 4, `commits` holds group 1, `failed: 2`, `remaining: [2, 3]`, the counter shows
      exactly one run (so the hook was neither skipped nor retried), `gitOutput` holds the
      hook's output with control characters as sent.
- [x] Seam 1: the run is released after the failure (lock and folder gone), and the
      `failed` reply's `text` names the committed group 1, the failed group 2 and the
      remaining group 3 (story 160). Lock and folder half done; the reply-text half
      is deferred via KD-R107.
- [x] Seam 1: a `pre-commit` hook that itself makes a commit then exits 1 → exit 4, `sha`
      set to the new HEAD, error text "committed as `<sha>`, but git did not exit cleanly"
      (`commit-release.md`).


## EXE-13: the backstop scan refuses a secret in the recorded tree

**What to build:** before each commit (not `reword`): M10 `writeTree` records the tree,
M8 `scanUnits` (with the `osUser` M18 passes to `commitAll(run, { now, osUser })`, EXE-01
item 1) with matchers recompiled by M7 from the patterns stored at `plan` (not
HEAD, CFG-01 item 1) runs over
`treeDiffUnits(expected HEAD, recorded tree)`; a hit → exit 3 `scan` with `hits`, the group
unstaged.

**Blocked by:** EXE-10, SCN-13, CHG-11, EXE-01, CFG-01, CHG-16.

**Status:** done

**Sources:** Q10, Q18, C:commit-release, M16, C:scan-patterns, stories 143, 162.

- [x] Seam 1: a fixture writes into the stored group a unit of a file holding a test secret
      that `plan` did not scan (state edited after `plan`) → exit 3, `hits` names the file,
      nothing committed, `unstaged` present.
- [x] Seam 1: the same secret in a path the stored `scanIgnore` covers → committed; in a
      path only a `scanIgnore` pattern committed by an earlier group of the run covers →
      still exit 3 (CFG-01 item 1).
- [x] Seam 1: a text file hidden by `-diff` in `.gitattributes` holding the secret → still
      exit 3.
- [x] Seam 1, unborn HEAD: the backstop diffs against the empty tree.
- [x] A static test asserts `commitAll`'s exported signature takes `{ now, osUser }` and
      passes `osUser` to `scanUnits`; no run-folder file holds the OS user name (EXE-01
      item 1).
- [x] Seam 1: after an exit 3 `scan` refusal, the lock and the run folder are gone.


## EXE-14: notice when the committed tree differs from the scanned one

**What to build:** after a commit, M3 `headTree()` against the recorded tree ID; on a
difference (with no extra commit; an extra commit is EXE-06's case, whose notice
replaces this one) a notice names the group ("committed tree differs from the scanned
index"), and the commit is kept.

**Blocked by:** EXE-13.

**Status:** done

**Sources:** Q18, C:commit-release, story 167.

- [x] Seam 1: a `pre-commit` hook that `git add`s another file → exit 0, the commit holds
      that file, the reply notice names group 1.
- [x] Seam 1: no hook → no notice.


## EXE-15: hook-rewrite detection names the likely cause

**What to build:** in `split` with a later group, the worktree hash sets `before` and
`after` the `git commit` call; when `after` differs from `before` minus group n's hashes the
run state records `treeChangedDuringCommit: n`, and group n+1's `diff-changed` says "files
changed during the commit of group n — a repo hook (lint-staged, a formatter) likely
rewrote them; run /commit again".

**Blocked by:** EXE-09, EXE-04.

**Status:** done

**Sources:** Q18, C:commit-release, story 164.

- [x] Seam 1: a `pre-commit` hook that rewrites a file of group 2 while group 1 commits →
      group 1 kept, group 2 exit 6 `diff-changed` with that text naming group 1.
- [x] Seam 1: two groups and no hook → `treeChangedDuringCommit` never set.
- [x] Seam 1: the last group → the worktree-hash git calls are not spawned before or after
      `git commit`, observed through the PATH git shim that logs its argv
      (`docs/spec/testing-modules.md`).


## EXE-16: budget stop with `continue`

**What to build:** M15 `nextStep` as the last step of phase (a): the first group always
starts; a later one only while at least 480 s remain before `deadline`; else exit 0 with
`failed: null`, a non-empty `remaining` and a `continue` handback whose `run` is the same
`commit --plan <id> --all`. It builds the `continue` handback.

**Blocked by:** EXE-04, EXE-07, FND-05.

**Status:** done

**Sources:** Q18, M15 `nextStep`, C:commit-release, testing seams (stepping clock), stories
172, 173.

- [x] Seam 1, stepping clock at 61 s elapsed after group 1 → exit 0, `commits` [1],
      `remaining` [2, 3], a `continue` handback, the run kept.
- [x] Seam 1: the `continue` call commits groups 2 and 3 and releases.
- [x] Seam 1: at exactly 60 s elapsed (480 s left) group 2 starts.
- [x] Seam 1: a budget stop after group 1 followed by a manual `git add` of another file
      before the `continue` call → group 1 kept, group 2 refused `index-changed` (EXE-07),
      `failed: 2`.
- [x] Seam 1: the first group starts even at 539 s elapsed.
- [x] Seam 1: the `continue` handback carries `ifNoUser: { answer: "continue" }`
      (`reply-and-handback.md`), so a `--no-user` caller runs it without asking.


## EXE-17: a hung `git commit` is killed at the deadline

**What to build:** `git commit` takes `deadline - now()`; on timeout M2 kills the process
tree and the call ends exit 5 with "git commit did not finish in 9 min — a pre-commit hook or
a signing prompt may be waiting". Cleanup and reporting (unstage, HEAD re-read, tree state,
release) take `cleanupDeadline - now()`; a cleanup call whose budget is at or below 0 is not
spawned and counts as timed out; a skipped or failed cleanup call keeps the exit code and
kind of the original cause and adds a notice, and a skipped unstage keeps the lock and run
folder for the next run's takeover repair (EXE-01 item 2). A commit git made anyway is
reported with `sha` and "committed as `<sha>`, but git did not exit in time"; an `internal`
throw after `git commit` is reported the same way, with "…, but the script failed" (EXE-01
item 3; its Seam 1 case, which needs `staged` mode and the FND-10 preload, is INT-31's).

**Blocked by:** EXE-12, GIT-07, FND-05, EXE-01.

**Status:** done

**Sources:** Q18, M15 `deadline`/`cleanupDeadline`, C:commit-release, stories 165, 174.

KD-R103: EXE-10's own two `unstage` calls (commit-executor.mjs:448, :515) ignore a failed
`git reset` outright — this slice's "a skipped or failed cleanup call keeps ... a notice"
has no criterion for the *failed* (not skipped) case, and no seam reaches it yet.

- [x] Seam 1, clock at 535 s elapsed at the start and a `pre-commit` hook that sleeps →
      exit 5 with that text, the hook's process tree gone, no commit, the run released.
- [x] Seam 1: a `post-commit` hook that sleeps → exit 5, `sha` set to the new HEAD, the
      "did not exit in time" text.
- [x] Seam 1: the clock stepped past 580 s before cleanup → the cleanup git calls are not
      spawned, observed through the PATH git shim that logs its argv
      (`docs/spec/testing-modules.md`), and the reply still comes: exit 5 `timeout`,
      `unstaged: null`, the notice "group 1 staging may remain, the next /commit repairs
      it", the lock and run folder kept with `indexReset` set, `call.lock` gone; the next
      `plan --take-over <planId>` resets the staging (EXE-01 item 2).
- [x] Seam 1, through `check --plan`: once `commitAll` can end a group `timed-out` with an
      earlier group already committed, INT-02's `checkRefusalEnding` keeps the run (lock and
      folder kept) instead of releasing it out from under that kept staging (review-INT-02
      N2, KD-R86).


## EXE-18: `index.lock` after a timed-out plain commit is left with a notice

**What to build:** in `split` and `staged`, when M10 `commitGuarded` returns `lockLeft`
after a killed commit, the lock is kept and a notice says "index.lock was left in place — if
no git process is running, check it and remove it by hand".

**Blocked by:** EXE-17, CHG-23.

**Status:** ready-for-agent

**Sources:** Q18, M10 `commitGuarded`, C:commit-release, story 215.

- [ ] Seam 1: a sleeping `pre-commit` hook that creates `index.lock` before it sleeps,
      killed at the deadline → exit 5 (EXE-17); the lock's survival and the notice text
      follow CHG-23's `lockLeft` case.
- [ ] Seam 1: no lock left after a killed commit → the reply carries no `index.lock`
      notice.


## EXE-19: `staged` mode commits the index as it is

**What to build:** in `staged`, M10 `verifyIndex` replaces (b) and (c): no reset and no
staging; any difference from the stored hash map → `diff-changed`, the index left as is. It
builds M10 `verifyIndex`.

**Blocked by:** EXE-07, EXE-13, RUN-13, PLN-05, CHG-14.

**Status:** done

**Sources:** Q18, C:commit-release (`staged`), M16, story 162.

- [x] Seam 1: `plan --staged` with a partly staged file → the commit holds the staged
      version only, the unstaged edit stays in the working tree.
- [x] Seam 1: a hunk staged by `git add -p` after `plan` → exit 6 (`index-changed` or
      `diff-changed`), the index unchanged, `unstaged: null`.
- [x] Seam 1: a staged 60-file new directory, committed as the index holds it (moved from
      CHG-21, KD-R97).
- [x] Seam 1: the backstop runs in `staged` too.


## EXE-20: reword through `--amend --only`

**What to build:** in `reword`: no match, no reset, no staging, no verify, no scan ((b), (c)
and the backstop are skipped, `commit-release.md`) and `index-changed` is not checked;
`head-moved` still is. `git commit --amend --only --cleanup=verbatim -F -` with
trailers from M6's reword carry-over; a root commit is reworded like any other. The
carry-over of foreign trailers belongs to MSG-08.

**Blocked by:** EXE-06, CHG-15, PLN-05, GIT-09.

**Status:** done

**Sources:** Q20, C:commit-release (`reword`), M16, stories 175, 177, 179, 180, 181.

- [x] Seam 1: reword skips (b), (c) and the backstop entirely — no match, no reset, no
      staging, no verify, no scan (story 181); `index-changed` is not checked, but
      `head-moved` still is.
- [x] Seam 1: a staged file during reword → the amended commit has the old tree, the file
      still staged.
- [x] Seam 1: extra staging between `plan` and `commit` → not refused; a manual commit in
      between → `head-moved`.
- [x] Seam 1: the root commit reworded → new message, same tree, still a root commit.
- [x] Seam 1: a foreign trailer in the old message survives; an Anthropic
      `Co-Authored-By` is dropped (per MSG's carry-over).
- [x] Seam 1: reword gives no "another commit was made during group `n`" notice — the
      first-parent check compares the amended HEAD's first parent against the expected
      HEAD's own first parent, not against the expected HEAD itself.
- [x] Seam 1: reword of a root commit gives no such notice either — both the amended HEAD
      and the expected HEAD have no first parent, so the check still matches.


## EXE-21: reword timeout removes only its own `index.lock`

**What to build:** in `reword`, `commitGuarded` with `partial` set: after a killed
`--amend --only`, the plugin's own leftover `index.lock` is removed by the two-marker rule;
a lock another process created is kept.

**Blocked by:** EXE-20, EXE-17, CHG-23.

**Status:** ready-for-agent

**Sources:** Q18, Q20, M10 `commitGuarded`, story 215.

- [ ] Seam 1: reword, clock stepped to 535 s elapsed at start, a sleeping `pre-commit`
      hook that first records that `index.lock` exists, then is killed at the deadline →
      exit 5 (EXE-17), the record is present; the lock's removal and the foreign-lock case
      follow CHG-23's two-marker rule.


## EXE-22: `unconfirmed` without `--confirmed`

**What to build:** on the first group of the call, `awaitingConfirm` in the run state and no
`--confirmed` → exit 1 `usage` (`unconfirmed`), checked before EXE-05's `no-groups` in phase
(a)'s final order. The first group of a call with `--confirmed` clears `awaitingConfirm`, so
a later `continue` needs no flag.

**Blocked by:** EXE-16, RUN-18.

**Status:** done

**Sources:** C:commit-release phase (a), C:check, M16, story 208.

- [x] Seam 1: a run left in `confirm` → `commit --plan X --all` exits 1 `unconfirmed`,
      nothing committed, the run kept.
- [x] Seam 1: `--confirmed` → commits; the state no longer has `awaitingConfirm`.
- [x] Seam 1: a budget stop after a confirmed group 1 → the `continue` `run` has no
      `--confirmed` and succeeds.


## EXE-23: signing at commit time is never disabled

**What to build:** `git commit` runs with the repo's signing config untouched (no
`-c commit.gpgsign=false`, no `--no-gpg-sign`).

**Blocked by:** EXE-02, GIT-06.

**Status:** done

**Sources:** Q18, story 169.

- [x] Seam 1 (skipped where `ssh-keygen` is missing): `gpg.format=ssh`, a fixture key
      without passphrase, `commit.gpgsign=true` → the commit is signed and verifies against
      an `allowedSignersFile`.
- [x] Seam 1: the same repo with `commit.gpgsign=true` set only in a `GIT_CONFIG_SYSTEM`
      file → still signed (the M2 scrub keeps signing config).


## EXE-24: Esc or session end stops the commit's processes

**What to build:** a termination signal during `commit` kills the git and hook process tree
and releases `call.lock`, so no commit lands after the user stopped the run. GIT-08 builds
the signal handler; this slice tests it at commit time.

**Blocked by:** EXE-17, PRE-13, GIT-08.

**Status:** ready-for-agent

**Sources:** Q9, Q18, M2, story 217.

- [ ] Seam 1 (POSIX): SIGTERM to the script while a `pre-commit` hook sleeps → no new
      commit, checked again after the hook's sleep would have ended (no commit lands after
      the kill), the hook process gone, `call.lock` absent.
- [ ] Seam 1 (Windows): the behaviour the spike records for tool-call termination, asserted
      the same way.
- [ ] Seam 1 (POSIX): a kill during phase (c) staging → the run state shows `indexReset`
      set, so a takeover can repair it.
