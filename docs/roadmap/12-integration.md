# 12 Integration

M18 subcommand workflows, driven end to end through the commit entry point as a Seam 1
subprocess over temp git repos. INT-01 is the walking skeleton (`plan` on a clean repo
prints a reply): every component tested only at Seam 1 hangs its tracer on it. INT-02 is the
first end-to-end commit (the "First slice" of Further Notes) and closes `plan` → `check` → `commit` for one group, as
thin as the spec draws it: no confirmation, no trailer, no scan wiring and no guard notice
yet; RUN-18 (confirmation routing), MSG-07 (trailers), CHG-16 and SCN-15 (the scan in
`plan`) and INT-27 (guard notice) each widen it. Component slices build their own behaviour
and test it at Seam 1 themselves; INT holds only the wiring for paths nothing else builds —
the end-to-end subcommand flow that later slices widen by one capability, bound to the
component slices that build each capability, and the reply variant or handback kind that
path first emits (RPL holds the cross-cutting reply rules).
Guard + worker + script round trips and the 0.1.0 dogfood and hand-test checks close the
group. Sources: M18 step tables, C:plan, C:check, C:commit-release, C:cli-and-exit-codes,
C:reply-and-handback, Domain code → CLI kind, Testing seams (Seam 1), Story verification.

## INT-01: Walking skeleton: `plan` on a clean repo prints a reply

**What to build:** the thinnest end-to-end path through the script. M1 routes `plan` to an
M18 `plan` workflow, which holds one function per row of its step table so later slices add
a step without touching M1; a thin M2 `run` (toplevel and status only), a thin M3 probe and
a thin tree-state read find a clean tree, so the workflow ends with `nothing`; M17 builds the
minimal reply (`version`, `status`, the base `callerRule`, and `text` ending "working tree
clean"), and M1 prints the envelope. Every component that is tested only at Seam 1 hangs its
tracer on this path; INT-02 (the first end-to-end commit) then closes `plan` → `check` →
`commit`.

**Blocked by:** RPL-01, FND-04.

**Status:** done

**Sources:** Further Notes "First slice", M1, M17, M18 `plan` step table, C:plan,
C:reply-and-handback, C:cli-and-exit-codes, Testing seams (Seam 1).

- [x] Seam 1: bare `plan` on a clean temp repo exits 0 with one JSON object,
      `reply.status: "nothing"`, `callerRule` equal to the base rule text byte for byte
      (C:reply-and-handback), a `text` ending "working tree clean", and no lock or run
      folder left
- [x] The test runs the script as a subprocess through the FND-04 harness, with no worker
      and no hook


## INT-02: First end-to-end commit: plan, check and commit one group of modified tracked files

**What to build:** the thinnest path of Further Notes "First slice". The script, called
directly (no worker), runs `plan --split` on a repo without hooks, signing or filtered files
whose only changes are modified tracked files; the test writes the worker plan with one
file-level group of whole-file units; `check --plan` validates it and commits in the same
process, because no confirmation logic exists yet (RUN-18 adds the routing). The path holds
the run lock, the run folder and the `committed` reply end to end (M18 `plan` steps 1-8 with
the in-process `plan --hunks`, `check` merging the `commit --all` output). The message is
committed as planned, without a trailer (MSG-07 adds it); `plan` runs no scan wiring
(CHG-16, SCN-15) and the reply carries no guard notice (INT-27).

**Blocked by:** PRE-01, PRE-08, PRE-09, INT-01, GIT-02, CFG-02, CHG-04, CHG-05, PLN-01,
RUN-06, EXE-02, RPL-03.

**Status:** done

**Sources:** Further Notes "First slice", M18, C:plan, C:check, C:commit-release,
C:run-folder, C:reply-and-handback, stories 40, 70, 194.

- [x] Seam 1: `plan --split` on two modified tracked files exits 0 with one JSON object
      (`version: 1`), a lowercase UUID v4 `planId`, the hunk index listing two whole-file
      units, and a run folder holding `state.json`, `plan.json` and `hunks.txt` plus the lock
- [x] Seam 1: that `plan`'s `runDir` is absolute, `path.resolve`d from the toplevel, and uses
      forward slashes even on Windows (C:run-folder; RUN-05's criterion, asserted there only
      in-process, KD-R63).
- [x] Parser oracle: per-file added and removed counts in the hunk index equal
      `git diff --numstat -z` on the fixture
- [x] The real index is byte-identical before and after `plan` (story 70)
- [x] `check --plan` with a one-group worker plan exits 0 without a confirmation step; HEAD
      gains exactly one commit whose message is the planned header byte for byte (no
      trailer), holding exactly the two files
- [x] The `check` output carries `groups`, `notIncluded`, `notices` merged into the
      `commit --all` output, and a `reply` with `status: "committed"`, the `sha subject` line,
      the base `callerRule` and "working tree clean"
- [x] After the commit the lock and the run folder are gone (story 194)
- [x] The EXE-16 budget-stop `continue` handback, built by M16 `commitAll` as an interim
      top-level `handback` field (C:commit-release), moves into `reply.handback` here,
      merged the same way `notices` already is


## INT-05: A live lock at `plan` becomes a `lock` handback

**What to build:** `plan` meeting a live lock with a valid `planId` refuses at step 3's `peek`
before any inventory work, with the takeover question as a `lock` handback; a race lost at
`acquire` after `peek` refuses the same way.

**Blocked by:** INT-02, RUN-06, RUN-07.

**Status:** done

**Sources:** M18 `plan` steps 3 and 7, C:run-folder, C:reply-and-handback (`lock` row), Q22,
stories 187, 188.

- [x] Seam 1: a second `plan` while a first run holds the lock → exit 6 `lock` with the
      holder's `planId`, `created` and `touched`, refused before inventory (no temporary
      index written for the refused call)
- [x] The reply is a `lock` handback: `take over` → `respawn` with `takeOver: <planId>` and
      the refused call's mode flag, `wait` → neither, `ifNoUser` `wait` with
      `returnToParent: true`
- [x] The refused run's provisional folder is deleted; the holder's lock and folder are
      untouched
- [x] The `lock` handback's `callerRule` equals the base rule plus the handback rule, byte
      for byte, matching the C:reply-and-handback fixture text; a reply from this run's other
      endings that carries no handback (INT-01's `nothing`, INT-02's `committed`) holds only
      the base rule


## INT-07: A first lint failure goes back to the worker

**What to build:** `check` with a message or placement error returns exit 2 with the `errors`
array and no `reply`, keeps the run, and a corrected worker plan passes on the next `check`.

**Blocked by:** INT-02, MSG-05, PLN-04, RUN-16, EXE-01.

**Status:** done

**Sources:** M18 `check`, C:check, C:cli-and-exit-codes (`lint`), Q18, stories 122, 127.

- [x] Seam 1: a header with an unknown type → exit 2 `lint`, `errors` names the group, no
      `reply` (C:check's lint example, "first failure, no reply", EXE-01 item 4), lock and
      folder kept
- [x] An unplaced unit → an error naming its ID and path; the old path of a rename → the
      "use the new path" error
- [x] Lint runs over every group before the first commit: a plan whose second group fails
      commits nothing (story 122)
- [x] A corrected plan then commits through the same run


## INT-09: Several groups need confirmation; `yes` commits with `--confirmed`

**What to build:** a `split` run with more than one group gets a `confirm` handback from
`check`, which stores `awaitingConfirm`; the `yes` answer's `run` (`commit --all
--confirmed`) commits every group in order; `commit --all` without `--confirmed` while a
confirmation is pending is refused.

**Blocked by:** EXE-04, EXE-22, INT-02, RUN-18.

**Status:** done

**Sources:** Q16, C:confirmation-triggers, C:check, C:commit-release, C:reply-and-handback
(`confirm` row), architectural decision "Confirmation is bound to its answer", stories 87,
91, 92, 208.

- [x] Seam 1: two groups → `check` exits 0 with a `confirm` handback: `yes` (`run` with
      `--confirmed`, `timeoutMs` 600000), `edit`, `one`, `no`; `ifNoUser` `yes` without
      `humanOnly`
- [x] The question text is exactly "Commit as proposed? To change it, type your changes under
      Other."; `edit` is the `needsText` (`Other`) answer, its `respawn` `resume` plus the
      user's words as `{text}`; `one` is offered only in `split` with more than one group and
      its `respawn` holds `resume: <id>` then `edit: one`
- [x] The confirm block shows each group's header, body and files (cap 20 per group) (story
      91)
- [x] Running the `yes` command verbatim commits both groups in order and replies
      `committed`
- [x] `commit --plan <id> --all` without `--confirmed` → exit 1 `usage` `unconfirmed`, run
      kept (story 208)
- [x] Running the `no` answer's `release` command verbatim → exit 0, `status: "nothing"`,
      the lock and folder gone, the real index unchanged (story 92)
- [x] The `staged` mode's skipped/`scanIgnore` and resumed confirm rows move from pure-unit
      to Seam 1 through this slice's confirm route (KD-R94); `tests/plan-attribution-flag.test.js`'s
      `staged` case is rebuilt at Seam 1 through the same trigger (KD-R95)
- [x] Once this slice's `commit --confirmed` reply exists, assert RUN-21's takeover notice
      in it on a tree needing confirmation after a takeover; closes KD-R102's INT-09 half
      (docs/roadmap/known-deficiencies.md)


## INT-10: A new file in `split` triggers confirmation

**What to build:** untracked candidates join the plan as whole-file units; a `split` run that
adds a new file confirms even with one group.

**Blocked by:** INT-09, CHG-05, CHG-13.

**Status:** done

**Sources:** Further Notes "First slice" (new file needs confirmation), Q16, C:untracked-files,
stories 88, 152, 153.

- [x] Seam 1: one modified file plus one new file in one group → `confirm` handback naming
      the new file; `yes` commits both
- [x] Gitignored and hidden files are not units and are not in `notIncluded`
- [x] KD-R104: rebuild the forged-`awaitingConfirm` three-group case in `tests/commit-all.test.js`
      over a real `check` confirm handback, and add the zero-stored-groups `unconfirmed` vs
      `no-groups` pair


## INT-12: Resumed runs always confirm; `one` re-plans as one group

**What to build:** CHG-19 already builds the separate `plan --hunks --plan` call that
re-renders the hunk index, resets the lint counter and marks the run `resumed`; INT-12 asserts
that end to end (Seam 1 below) and builds the consumer, so the next `check` confirms even a
single tracked group; the `one` answer's respawn is offered only in `split` with several
groups.

**Blocked by:** CHG-19, INT-09, RUN-16, PLN-05.

**Status:** ready-for-agent

**Sources:** M18 `plan --hunks`, Q16, C:worker-input (`resume`, `edit`), stories 47, 93, 94,
95, 181, 222.

- [ ] Seam 1: `plan --hunks --plan` as a separate call keeps the unit IDs and every stored
      notice, and resets the lint counter; a bad `check` after it → exit 2 with no `reply`
      (RUN-16)
- [ ] A following `check` with one tracked group returns a `confirm` whose reason is the edited
      plan (story 95)
- [ ] The `one` answer is absent from a single-group and from a `staged` confirmation (story
      94); a one-group plan written after `one` commits all included files (story 222)
- [ ] An edit to a known path between `plan` and `plan --hunks` → `diff-changed`, run ended
- [ ] Seam 1: `resumed` alone triggers `confirm` (no `humanOnly`) in `split` and in `staged`,
      even with one group and no other trigger, per C:confirmation-triggers' `resumed` row
- [ ] Seam 1: `resumed` triggers `confirm` in a `reword` run (story 181); under `--no-user`
      the row gives no `confirm`


## INT-13: Mixed index asks `modeChoice`; an all-staged index plans `split`

**What to build:** `plan` without a mode flag on a mixed index returns a `modeChoice` handback
with counts only and releases its lock; an index holding every change plans `split`.

**Blocked by:** INT-10, RUN-13, CHG-14, RUN-20.

**Status:** ready-for-agent

**Sources:** Q9, Q16, M18 `plan` step 4, C:plan, C:reply-and-handback (`modeChoice`), stories
81, 82.

- [ ] Seam 1: some files staged, others not → `modeChoice` with the counts question, answers
      `staged` and `split` as respawns with `mode`, `ifNoUser` `split`; no lock or folder left;
      each respawn holds the answer's `mode` only (RUN-20 item 6: the answer replaces the
      call's mode flag)
- [ ] Hidden files are not counted (story 81)
- [ ] Every change staged (as after `git add -A`) → plans `split` with no question (story 82)


## INT-14: `staged` mode commits the pre-staged set as-is

**What to build:** `plan --staged` plans the index as one group, commits exactly the staged
content with the written message and reports the rest; an empty index and a staged set with a
hit or a hidden staged-new path are refused.

**Blocked by:** INT-13, CHG-14, SCN-15, EXE-19, PLN-05.

**Status:** ready-for-agent

**Sources:** Q11, Q16, C:plan, C:cli-and-exit-codes (`staged-hit`, `usage`), stories 83, 84,
85, 142, 225.

- [ ] Seam 1: a staged subset → one commit of exactly the staged content, unstaged changes
      left and reported in the tree state (story 83)
- [ ] A staged new directory of 60 files commits whole under `--staged` (story 84)
- [ ] `--staged` with an empty index → exit 1 `usage` `staged-empty` (story 225)
- [ ] A staged hit or a hidden staged-new path → exit 6 `staged-hit`, lock and folder gone
      (story 142)


## INT-15: Scan hits in `split` leave their unit out

**What to build:** a unit with a hit is withheld from `hunks.txt`, listed by pattern ID and
location, placed by the worker in `notIncluded`, and named in the reply's notices; a message
hit fails lint in `check`.

**Blocked by:** INT-07, INT-10, SCN-15, PLN-06, EXE-01.

**Status:** ready-for-agent

**Sources:** Q10, C:scan-patterns, C:plan-hunks, C:reply-and-handback, stories 96, 135-141.

- [ ] Seam 1: a file adding a GitHub token → its unit's body withheld, the hit reported by
      pattern ID and `path:line` only, never the value, in any output or file of the run
- [ ] The worker plan with that unit in `notIncluded` commits the rest; the reply notice names
      `path:line pattern-id left out`
- [ ] A hit alone is not a confirmation trigger (story 96)
- [ ] A commit message containing a token → exit 2 `lint` naming the pattern ID (M14 scans
      with the `osUser` M18 passes, EXE-01 item 1)


## INT-16: Size-skipped files and `scanIgnore` changes need a human

**What to build:** including a file skipped for size, or a change to the repo config's
`scanIgnore`, makes the confirmation `humanOnly` in every mode; `ifNoUser` is `no` with
`returnToParent`.

**Blocked by:** INT-09, INT-15, SCN-14, CFG-07, RUN-17, CFG-01.

**Status:** ready-for-agent

**Sources:** Q10, Q16, Q17, C:confirmation-triggers, stories 89, 90, 149.

- [ ] Seam 1: an included over-1 MB file → `confirm` with
      `humanOnly: true`, `ifNoUser` `no` plus `returnToParent`
- [ ] An edited `scanIgnore` in the repo config → `humanOnly` confirm; an edit to another key
      of that file alone → no trigger; both in one diff, with only the other key's hunk
      included → still `humanOnly`, since every unit of the file is flagged (CFG-01 item 2)


## INT-17: Runs without a user (`--no-user`)

**What to build:** `plan --split --no-user` and its `check` commit plain confirmations without
a handback, turn a `humanOnly` confirmation into a `handedBack` handback with the lock
released, and commit the rest when a size-skipped file is left out.

**Blocked by:** INT-16, RPL-02, PRE-15.

**Status:** ready-for-agent

**Sources:** Q17, C:reply-and-handback (`handedBack` row), stories 100, 102, 103, 104.

- [ ] Seam 1: two groups under `--no-user` → both committed, no handback (story 100)
- [ ] A `humanOnly` trigger under `--no-user` → `handedBack` with `question: null`, text
      "nothing committed — run /commit to plan again", lock and folder released, `ifNoUser`
      `returnToParent: true` (story 102 as settled by PRE-15: an honest worker never
      answers it; the forged-answer gap is Q25's and not asserted here)
- [ ] A size-skipped file in `notIncluded` with its reason → the rest commits, the notice is in
      the text (story 103)


## INT-18: Hunk-level groups end to end

**What to build:** a modified file's hunks are split across two groups; each commit holds
exactly its planned hunks, identical hunks stay together.

**Blocked by:** INT-09, CHG-06, PLN-03, CHG-20.

**Status:** ready-for-agent

**Sources:** Q11, C:plan-hunks, C:worker-plan, stories 63, 64, 67.

- [ ] Seam 1: one file with two distant hunks in two groups → two commits, each diff equal to
      its planned hunk
- [ ] The confirm block shows a hunk count per file for a hunk plan (story 91)
- [ ] Identical hunks of one file split across groups → lint error (story 67)
- [ ] The commits' blobs equal the working-tree bytes after the last group
- [ ] The INT-02 whole-file gate in `commitCheckedGroups` (any group with a hunk-level file
      entry keeps the run instead of committing, KD-R83) is removed: a hunk-level `check`
      commits in-process the same way a whole-file one does


## INT-19: Large change sets stay fully planned

**What to build:** a change set larger than the stdout budget spills the hunk index to
`hunks.json`, summary-only files and files past the 3000-line cap keep every unit ID, and
`plan`'s stdout stays within budget.

**Blocked by:** INT-18, CHG-17, CHG-18.

**Status:** ready-for-agent

**Sources:** Q19, C:plan-hunks, C:summary-only-files, stories 65, 157, 158, 159.

- [ ] Seam 1 size fixture at each hunk-index cap: `plan --hunks` stdout ≤ 20 000 characters,
      the index spilled to `hunks.json` past it
- [ ] A lockfile and a file over 1000 changed lines appear as stats-only whole-file units
- [ ] A file past the cap keeps each hunk's ID; every unit placed commits


## INT-20: Filtered files stage through their filter

**What to build:** a file under a clean filter is planned, scanned and committed in its
cleaned form; with the LFS check settled, an LFS file commits its pointer and stores the
object.

**Blocked by:** INT-09, PRE-10, CHG-21.

**Status:** ready-for-agent

**Sources:** Q11, Further Notes "First slice" widenings, stories 72, 144.

- [ ] Seam 1: a `sed` clean filter → the committed blob is the cleaned content; the scan saw
      the cleaned lines (story 144)
- [ ] If `git-lfs` is on the runner: the staged diff matches the planned hash and the object is
      under `.git/lfs/objects`; skipped otherwise, never faked


## INT-24: Reword workflow

**What to build:** `plan --reword` (and `--dictated`, which skips the hunk index) → `check` →
the amend, with repo-state refusals specific to reword.

**Blocked by:** EXE-20, GIT-09, MSG-08, RUN-16.

**Status:** done

**Sources:** Q20, C:commit-release, C:worker-plan (dictated reword), stories 175-181.

- [x] Seam 1: `plan --reword` on a clean tree → exit 0 with the lock taken; `check` amends
      the message, staged changes untouched (story 175)
- [x] `--dictated` → no hunk index; a `source: user` plan commits its text as given (story
      178)
- [x] Pushed, unborn and merge-commit HEAD → exit 6 (`pushed`, `state`); a root commit rewords
      (stories 176, 177)
- [x] A first reword never confirms (story 181)


## INT-27: Guard heartbeat round trip

**What to build:** the guard, fed the worker's `plan` script call, writes the heartbeat, and
the next `plan` in that repo reports the guard active; without a heartbeat under 15 minutes
the reply carries the "guard did not run" notice.

**Blocked by:** INT-02, GRD-13, GRD-15, GRD-17.

**Status:** done

**Sources:** Q23, Testing seams "ScriptCall round trip", stories 34, 36, 37.

- [x] Seam 2 then Seam 1: the guard process fed the exact `plan` command in Bash and in
      PowerShell form writes the heartbeat; the following `plan` has no guard notice (the
      `env.guard` state and its `not-seen` cases are GRD-17's `guardState`/`samePathTree`
      tests, not repeated here)
- [x] Seam 1: the INT-02 First-slice run with no heartbeat in the Claude home → the
      `committed` reply's `notices` hold the exact text "Guard hook did not run: `node`
      missing from the hook's PATH, plugin hooks disabled, or `disableAllHooks` set. Direct
      `git commit` is not blocked." (Q23, `q23-guard-heartbeat.md`)


## INT-28: ScriptCall round trip and the worker-only rule

**What to build:** every `run` string M17 can build goes through G1 `runHook` as Bash and as
PowerShell and is recognised with the same subcommand and arguments; as
`commit:commit-worker` a `commit` or `release` call is denied, from the main session it
passes.

**Blocked by:** GRD-13, GRD-14, INT-05, INT-09, INT-13, INT-17, RPL-08.

**Status:** ready-for-agent

**Sources:** Testing seams "ScriptCall round trip", Q23, Q25, stories 38, 39.

- [ ] Seam 3 via `runHook`: each handback kind's `run`, with paths holding spaces and drive
      letters, parses to the same subcommand and arguments in both shells
- [ ] Seam 2: the same `commit` and `release` commands with `agent_type:
      commit:commit-worker` → deny; without it → no output (story 39, 38)


## INT-29: Hand-test: a direct `git commit` is redirected to the worker

**What to build:** on a local-marketplace install, a session told to commit with
`git commit -m` is denied by the guard, spawns `commit:commit-worker` with an intent, and the
commit lands through the script with the reply shown verbatim.

**Blocked by:** INT-27, INT-28, WRK-06, REL-01, GRD-12, GRD-18, MSG-07.

**Status:** needs-human

**Sources:** Q3, Q24, Q25, Story verification (guard, worker protocol), stories 10, 11, 12.

- [ ] The deny text routes to `commit:commit-worker` and never mentions `/commit` (story 11)
- [ ] The session spawns the worker with an intent, and the commit lands with the default
      trailer
- [ ] The main thread shows `text` verbatim and runs no `git log` or `git status`
- [ ] A commit typed in a terminal and a `!` command are not denied (story 19)


## INT-30: Dogfood check for 0.1.0

**What to build:** this repo commits its own 0.1.0 work through the installed plugin for a
stretch of real work, with issues recorded; this is the 0.1.0 dogfood, not the 1.0.0 gate.

**Blocked by:** INT-29, WRK-07, WRK-08, REL-02.

**Status:** needs-human

**Sources:** Further Notes "Other notes" (dogfooding), Story verification (dogfood rows), Q10,
Q15.

- [ ] Any personal commit skill removed from the Claude home first
- [ ] A set of real commits of this repo made only through the plugin, with the repo's
      `.claude/commit.json` rules applied
- [ ] Every failure, unexpected question or deny recorded as an issue before REL-05
- [ ] Grouping quality (story 63) is assessed over the dogfood commits and recorded as an
      issue when a group is wrong-sized or misses an atomic boundary (Story verification:
      grouping quality is a hand-test-plus-dogfood row)


## INT-31: Domain-code → CLI-kind row coverage

**What to build:** the completeness test moved out of RPL-03: a test walks every (row,
producer) pair of Domain code → CLI kind — `index-changed`, `head-moved`, `git-failed` and
`config` each have several producers — and checks that at least one Seam 1 case asserts each
pair's kind and exit code. Rows named as accepted gaps in `docs/roadmap/README.md` are listed
explicitly in the test, never skipped silently.

**Blocked by:** CFG-07, CHG-05, CHG-19, CHG-20, EXE-01, EXE-05, EXE-06, EXE-07, EXE-08,
EXE-10, EXE-11, EXE-12, EXE-13, EXE-16, EXE-17, EXE-22, GIT-09, GIT-12, INT-01, INT-07,
INT-09, INT-14, INT-15, INT-24, RPL-01, RPL-02, RPL-08, RUN-02, RUN-04, RUN-05, RUN-06,
RUN-07, RUN-12, RUN-13, RUN-14, RUN-15, RUN-19, RUN-24, RUN-25, EXE-19, FND-10.

**Status:** ready-for-agent

**Sources:** Domain code → CLI kind, C:cli-and-exit-codes, M1, M17.

- [ ] A test walks every (row, producer) pair of `docs/spec/domain-code-cli-kind.md` and maps
      it to the Seam 1 case that reaches it, failing on any pair with none
- [ ] The unexpected-throw row (`internal`) maps to this Seam 1 case (EXE-01 item 3), not to
      the accepted-gap list: the FND-10 preload failing `fs.renameSync` on `state.json` with
      `EIO`, on a `staged` run whose `commit --all` writes no `state.json` before `git
      commit` (the stored group written by the fixture, no `awaitingConfirm`) → exit 1
      `internal`, `sha` set to the new HEAD, "committed as `<sha>`, but the script failed"
      (EXE-17), the run released
- [ ] Adding a row to the table without a case makes the test fail
