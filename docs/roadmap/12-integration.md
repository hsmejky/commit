# 12 Integration

M18 subcommand workflows, driven end to end through the commit entry point as a Seam 1
subprocess over temp git repos. INT-01 is the walking skeleton (`plan` on a clean repo
prints a reply): every component tested only at Seam 1 hangs its tracer on it. INT-02 is the
first end-to-end commit (the "First slice" of Further Notes) and closes `plan` → `check` → `commit` for one group, as
thin as the spec draws it: no confirmation, no trailer, no scan wiring and no guard notice
yet; RUN-18 (confirmation routing), MSG-07 (trailers), CHG-16 and SCN-15 (the scan in
`plan`) and INT-27 (guard notice) each widen it. Component slices own behaviour; INT slices own the wiring: every later INT slice widens the
path by one capability, binds to the component slices that build it, and builds the reply
variant or handback kind its path first emits (RPL holds the cross-cutting reply rules).
Guard + worker + script round trips and the 0.1.0 dogfood and hand-test checks close the
group. Sources: M18 step tables, C:plan, C:check, C:commit-release, C:cli-and-exit-codes,
C:reply-and-handback, Domain code → CLI kind, Testing seams (Seam 1), Story verification.

## INT-01: Walking skeleton: `plan` on a clean repo prints a reply

**What to build:** the thinnest end-to-end path through the script. M1 routes `plan` to an
M18 `plan` workflow; a thin M2 `run` (toplevel and status only), a thin M3 probe and a thin
tree-state read find a clean tree, so the workflow ends with `nothing`; M17 builds the
minimal reply (`version`, `status`, and `text` ending "working tree clean"), and M1 prints
the envelope. Every component that is tested only at Seam 1 hangs its tracer on this path;
INT-02 (the first end-to-end commit) then closes `plan` → `check` → `commit`.

**Blocked by:** RPL-01, FND-04.

**Status:** ready-for-agent

**Sources:** Further Notes "First slice", M1, M17, M18 `plan` step table, C:plan,
C:reply-and-handback, C:cli-and-exit-codes, Testing seams (Seam 1).

- [ ] Seam 1: `plan --split` on a clean temp repo exits 0 with one JSON object,
      `reply.status: "nothing"`, a `text` ending "working tree clean", and no lock or run
      folder left
- [ ] The test runs the script as a subprocess through the FND-04 harness, with no worker
      and no hook
- [ ] M18 `plan` holds one function per row of its step table, so later slices add a step
      without touching M1


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
RUN-06, EXE-02, RPL-03, RPL-04.

**Status:** ready-for-agent

**Sources:** Further Notes "First slice", M18, C:plan, C:check, C:commit-release,
C:run-folder, C:reply-and-handback, stories 40, 70, 194.

- [ ] Seam 1: `plan --split` on two modified tracked files exits 0 with one JSON object
      (`version: 1`), a lowercase UUID v4 `planId`, the hunk index listing two whole-file
      units, and a run folder holding `state.json`, `plan.json` and `hunks.txt` plus the lock
- [ ] Parser oracle: per-file added and removed counts in the hunk index equal
      `git diff --numstat -z` on the fixture
- [ ] The real index is byte-identical before and after `plan` (story 70)
- [ ] `check --plan` with a one-group worker plan exits 0 without a confirmation step; HEAD
      gains exactly one commit whose message is the planned header byte for byte (no
      trailer), holding exactly the two files
- [ ] The `check` output carries `groups`, `notIncluded`, `notices` merged into the
      `commit --all` output, and a `reply` with `status: "committed"`, the `sha subject` line,
      the base `callerRule` and "working tree clean"
- [ ] After the commit the lock and the run folder are gone (story 194)


## INT-03: Hidden-only changes and zero groups end as `nothing`

**What to build:** `plan` on a tree whose only changes are hidden or collapsed counts it as
clean and replies `nothing`, naming the hidden changes; `check` on a worker plan whose units
all sit in `notIncluded` ends the run as "nothing committed" with the reasons. The plain
clean-tree case is the walking skeleton (INT-01).

**Blocked by:** INT-02, CHG-01, CHG-13, RUN-18.

**Status:** ready-for-agent

**Sources:** M18 `plan` step 6, M15 `planRefusal`, C:check, Domain code → CLI kind (clean
row), stories 97, 156.

- [ ] Hidden-only changes count as clean and are still named in the `nothing` reply (story
      156)
- [ ] `check` with every unit in `notIncluded` exits 0, `status: "nothing"`, the text lists
      each reason, and the lock and folder are released (story 97)


## INT-04: Pre-folder refusals from `plan` steps 1-2

**What to build:** every refusal M18 raises before a run folder exists maps through the error
table to its CLI kind and exit code, with a `failed` reply, no lock and no `.commit-plan`
directory created.

**Blocked by:** INT-02, GIT-03, GIT-04, CFG-03, RUN-14.

**Status:** ready-for-agent

**Sources:** M18 `plan` steps 1-2, C:cli-and-exit-codes (`state`, `config`, `env` rows),
Q21, stories 110, 184, 185, 186, 202, 211.

- [ ] Seam 1: outside a repo and in a bare repo → exit 6 `state`, no `.commit-plan`
- [ ] Each in-progress state, a pending `merge --squash` (its own text) and unmerged entries
      from a conflicted `stash pop` → exit 6 `state` (stories 184, 211)
- [ ] `i18n.commitEncoding` `utf8` and `UTF-8` accepted, another encoding → exit 6 `state`
      (story 186)
- [ ] An unparseable or mistyped repo layer → exit 1 `config` before any folder (story 110)
- [ ] A PATH git shim reporting a version below 2.34 → exit 1 `env` (story 202); a PATH
      without git → exit 1 `env` (see the notes on the entry-point env cases)
- [ ] Every refusal carries a `failed` reply with the base `callerRule` and no handback


## INT-05: A live lock at `plan` becomes a `lock` handback

**What to build:** `plan` meeting a live lock with a valid `planId` refuses at step 3's `peek`
before any inventory work, with the takeover question as a `lock` handback; a race lost at
`acquire` after `peek` refuses the same way.

**Blocked by:** INT-02, RUN-06, RUN-07.

**Status:** ready-for-agent

**Sources:** M18 `plan` steps 3 and 7, C:run-folder, C:reply-and-handback (`lock` row), Q22,
stories 187, 188.

- [ ] Seam 1: a second `plan` while a first run holds the lock → exit 6 `lock` with the
      holder's `planId`, `created` and `touched`, refused before inventory (no temporary
      index written for the refused call)
- [ ] The reply is a `lock` handback: `take over` → `respawn` with `takeOver: <planId>` and
      the refused call's mode flag, `wait` → neither, `ifNoUser` `wait` with
      `returnToParent: true`
- [ ] The refused run's provisional folder is deleted; the holder's lock and folder are
      untouched


## INT-06: One call per run: `busy`, `ended`, `taken-over`, `already-committed`, `no-groups`

**What to build:** every `--plan` call holds the run's `call.lock` for its whole duration, and
the per-run refusals a later call can meet map to their kinds without ending the run where the
table says they do not.

**Blocked by:** INT-02, RUN-02, RUN-04, RUN-19, RUN-20.

**Status:** ready-for-agent

**Sources:** M18 "Every call with `--plan`", C:run-folder, C:cli-and-exit-codes (`lock`,
`usage` rows), stories 192, 209, 224.

- [ ] Seam 1: a second call on a `planId` whose `call.lock` is held by a live process →
      exit 6 `lock` `busy`, the run kept
- [ ] A call after the run ended → `ended`; a state with another `version` → `ended` (story
      224); a run whose lock names another `planId` → `taken-over` (story 192)
- [ ] `check` after a group of the run committed → exit 1 `usage` `already-committed`;
      `commit --all` with every group committed → `no-groups`
- [ ] `call.lock` is gone after every call, success or refusal


## INT-07: A first lint failure goes back to the worker

**What to build:** `check` with a message or placement error returns exit 2 with the `errors`
array and no `reply`, keeps the run, and a corrected worker plan passes on the next `check`.

**Blocked by:** INT-02, MSG-05, PLN-04, RUN-16, EXE-01.

**Status:** ready-for-agent

**Sources:** M18 `check`, C:check, C:cli-and-exit-codes (`lint`), Q18, stories 122, 127.

- [ ] Seam 1: a header with an unknown type → exit 2 `lint`, `errors` names the group, no
      `reply`, lock and folder kept
- [ ] An unplaced unit → an error naming its ID and path; the old path of a rename → the
      "use the new path" error
- [ ] Lint runs over every group before the first commit: a plan whose second group fails
      commits nothing (story 122)
- [ ] A corrected plan then commits through the same run


## INT-08: `lintFailed` handback and the `--no-user` lint ending

**What to build:** the lint failure that ends the worker's retries (the second since the last
`plan --hunks`, or the first of `source: user` text) becomes a `lintFailed` handback in an
interactive run; with `--no-user` it releases the lock and deletes the folder.

**Blocked by:** INT-07, RUN-16.

**Status:** ready-for-agent

**Sources:** C:reply-and-handback (`lintFailed` row), C:check, Q18, Q20, stories 127, 214.

- [ ] Seam 1: two failing `check` calls → the second carries a `lintFailed` handback with
      `retry` (respawn `resume` plus `edit: fix these lint errors: …`, at most 500
      characters), `edit` (needsText) and `no` (`run release`)
- [ ] A first failure of `source: user` text carries the handback at once
- [ ] When every error is a shape error (invalid JSON, wrong shape) there is no `edit` answer
      (story 214)
- [ ] Under `--no-user` the second failure releases lock and folder; the next `plan` starts
      fresh


## INT-09: Several groups need confirmation; `yes` commits with `--confirmed`

**What to build:** a `split` run with more than one group gets a `confirm` handback from
`check`, which stores `awaitingConfirm`; the `yes` answer's `run` (`commit --all
--confirmed`) commits every group in order; `commit --all` without `--confirmed` while a
confirmation is pending is refused.

**Blocked by:** INT-02, RUN-18, EXE-04.

**Status:** ready-for-agent

**Sources:** Q16, C:confirmation-triggers, C:check, C:commit-release, C:reply-and-handback
(`confirm` row), architectural decision "Confirmation is bound to its answer", stories 87,
91, 92, 208.

- [ ] Seam 1: two groups → `check` exits 0 with a `confirm` handback: `yes` (`run` with
      `--confirmed`, `timeoutMs` 600000), `edit`, `one`, `no`; `ifNoUser` `yes` without
      `humanOnly`
- [ ] The confirm block shows each group's header, body and files (cap 20 per group) (story
      91)
- [ ] Running the `yes` command verbatim commits both groups in order and replies
      `committed`
- [ ] `commit --plan <id> --all` without `--confirmed` → exit 1 `usage` `unconfirmed`, run
      kept (story 208)


## INT-10: A new file in `split` triggers confirmation

**What to build:** untracked candidates join the plan as whole-file units; a `split` run that
adds a new file confirms even with one group.

**Blocked by:** INT-09, CHG-05, CHG-13.

**Status:** ready-for-agent

**Sources:** Further Notes "First slice" (new file needs confirmation), Q16, C:untracked-files,
stories 88, 152, 153.

- [ ] Seam 1: one modified file plus one new file in one group → `confirm` handback naming
      the new file; `yes` commits both
- [ ] Gitignored and hidden files are not units and are not in `notIncluded`


## INT-11: `no` releases the run; `release` edge cases

**What to build:** a `no` answer's `release --plan` deletes lock and folder with the index
untouched; `release` on a mismatched `planId` is a no-op; a `release` meeting a live
`call.lock` is `busy`; the tree-state read runs under the 45 s release budget.

**Blocked by:** INT-09, RUN-01, RUN-03, FND-05.

**Status:** ready-for-agent

**Sources:** M18 `release`, C:reply-and-handback (`run`), C:commit-release, stories 92, 45.

- [ ] Seam 1: `release` after a `confirm` → exit 0, `status: "nothing"`, lock and folder gone,
      the real index unchanged
- [ ] `release` with another run's `planId` → no-op, that run untouched
- [ ] `release` while a `call.lock` is live → `busy`, run kept
- [ ] With the clock stepped past 45 s before the tree-state read, the reply omits the tree
      state and the release is still complete


## INT-12: Resumed runs always confirm; `one` re-plans as one group

**What to build:** a separate `plan --hunks --plan` call re-renders the hunk index, resets the
lint counter and marks the run `resumed`, so the next `check` confirms even a single tracked
group; the `one` answer's respawn is offered only in `split` with several groups.

**Blocked by:** INT-09, INT-08, CHG-19.

**Status:** ready-for-agent

**Sources:** M18 `plan --hunks`, Q16, C:worker-input (`resume`, `edit`), stories 47, 93, 94,
95, 222.

- [ ] Seam 1: `plan --hunks --plan` as a separate call keeps the unit IDs and every stored
      notice, and resets the lint counter
- [ ] A following `check` with one tracked group returns a `confirm` whose reason is the edited
      plan (story 95)
- [ ] The `one` answer is absent from a single-group and from a `staged` confirmation (story
      94); a one-group plan written after `one` commits all included files (story 222)
- [ ] An edit to a known path between `plan` and `plan --hunks` → `diff-changed`, run ended


## INT-13: Mixed index asks `modeChoice`; an all-staged index plans `split`

**What to build:** `plan` without a mode flag on a mixed index returns a `modeChoice` handback
with counts only and releases its lock; an index holding every change plans `split`.

**Blocked by:** INT-10, RUN-13, CHG-14, RUN-20.

**Status:** ready-for-agent

**Sources:** Q9, Q16, M18 `plan` step 4, C:plan, C:reply-and-handback (`modeChoice`), stories
81, 82.

- [ ] Seam 1: some files staged, others not → `modeChoice` with the counts question, answers
      `staged` and `split` as respawns with `mode`, `ifNoUser` `split`; no lock or folder left
- [ ] Hidden files are not counted (story 81)
- [ ] Every change staged (as after `git add -A`) → plans `split` with no question (story 82)


## INT-14: `staged` mode commits the pre-staged set as-is

**What to build:** `plan --staged` plans the index as one group, commits exactly the staged
content with the written message and reports the rest; an empty index and a staged set with a
hit or a hidden staged-new path are refused.

**Blocked by:** INT-13, CHG-14, SCN-15, EXE-19.

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
- [ ] A commit message containing a token → exit 2 `lint` naming the pattern ID


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
      of that file → no trigger


## INT-17: Runs without a user (`--no-user`)

**What to build:** `plan --split --no-user` and its `check` commit plain confirmations without
a handback, turn a `humanOnly` confirmation into a `handedBack` handback with the lock
released, and commit the rest when a size-skipped file is left out.

**Blocked by:** INT-16, RPL-02, PRE-15.

**Status:** ready-for-agent

**Sources:** Q17, C:reply-and-handback (`handedBack` row), stories 100, 102, 103, 104.

- [ ] Seam 1: two groups under `--no-user` → both committed, no handback (story 100)
- [ ] A `humanOnly` trigger under `--no-user` → `handedBack` with `question: null`, text
      "nothing committed — run /commit to plan again", lock and folder released (story 102)
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


## INT-21: Failures end the run cleanly

**What to build:** M18's `try`/`finally` after `acquire`: a failing group stops the loop,
earlier commits stay, the current group is unstaged only if it reached staging, and the lock
and folder are released; each failure maps through the error table.

**Blocked by:** INT-09, EXE-06, EXE-07, EXE-08, EXE-10, EXE-11, EXE-12, EXE-13, EXE-01.

**Status:** ready-for-agent

**Sources:** Q18, M18 error table paragraph, C:commit-release, C:cli-and-exit-codes, stories
58, 76, 160-168.

- [ ] Seam 1: a pre-commit hook rejecting group 2 → exit 4 `git`, group 1 kept, `failed`
      reply listing the committed, failed and remaining groups, lock and folder gone (story
      160)
- [ ] A HEAD moved between `plan` and `commit` → exit 6 `head-moved`; staging by hand between
      groups → exit 6 `diff-changed` (`index-changed`) with earlier groups kept
- [ ] An edit to a planned file after `plan` → `diff-changed` before the index is touched
      (stories 58, 76)
- [ ] An existing `index.lock` → exit 6 `index-lock` with the index not reset (story 166)
- [ ] A commit git made despite a failure is reported with its `sha` (story 165)


## INT-22: Time budget: `continue`, boundaries and kills

**What to build:** the per-call 540 s budget: later groups start only while 480 s remain, an
out-of-budget call ends with a `continue` handback, and a hook past the budget is killed and
reported as `timeout`.

**Blocked by:** INT-21, FND-05, RUN-12, GIT-07, EXE-16, EXE-17, EXE-01.

**Status:** ready-for-agent

**Sources:** Testing seams "End-to-end time budget", Q9, Q18, stories 43, 53, 172, 173, 174,
215.

- [ ] Seam 1: three groups, clock stepped to 61 s after group 1 → `continue` handback whose
      `run` is the same `commit --all` without `--confirmed`; running it commits groups 2-3
- [ ] Stepped to exactly 60 s → group 2 still starts
- [ ] Stepped to 535 s at start with a hook sleeping past 5 s → tree killed, exit 5 `timeout`,
      a commit git made anyway detected
- [ ] `plan` past its 540 s deadline → exit 5 `timeout`, folder discarded


## INT-23: A killed call leaves no commit behind

**What to build:** the commit entry point's `SIGINT`/`SIGTERM`/`SIGHUP` handler kills the
active git child tree and removes `call.lock`, so a stopped call lands no commit.

**Blocked by:** INT-21, PRE-13, GIT-08, EXE-24.

**Status:** ready-for-agent

**Sources:** Q9, Q18, M2, Domain code → CLI kind (killed-process paragraph), story 217.

- [ ] Seam 1 (POSIX): `SIGTERM` to a `commit` call during a slow pre-commit hook → no commit
      lands afterwards and `call.lock` is gone
- [ ] The run state shows `indexReset` set when the kill came during staging, so a takeover can
      repair it (handed to RUN-25)


## INT-24: Reword workflow

**What to build:** `plan --reword` (and `--dictated`, which skips the hunk index) → `check` →
the amend, with repo-state refusals specific to reword.

**Blocked by:** INT-08, EXE-20, MSG-08, GIT-09.

**Status:** ready-for-agent

**Sources:** Q20, C:commit-release, C:worker-plan (dictated reword), stories 175-181.

- [ ] Seam 1: `plan --reword` on a clean tree → exit 0 with the lock taken; `check` amends
      the message, staged changes untouched (story 175)
- [ ] `--dictated` → no hunk index; a `source: user` plan commits its text as given (story
      178)
- [ ] Pushed, unborn and merge-commit HEAD → exit 6 (`pushed`, `state`); a root commit rewords
      (stories 176, 177)
- [ ] A first reword never confirms (story 181)


## INT-25: Post-scan refusal order and signing notices

**What to build:** `plan` step 6: the clean-tree and `staged-hit` checks come before the
signing probe; a locked SSH key refuses with `signing`; an openpgp setup carries its prompt
note to the reply.

**Blocked by:** INT-14, RUN-15, GIT-12.

**Status:** ready-for-agent

**Sources:** Q18, M18 `plan` step 6, C:plan, stories 169, 170, 171.

- [ ] Seam 1: a passphrase key not in the agent → exit 6 `signing`, folder discarded (story
      170)
- [ ] A clean tree with the same signing setup → `nothing`, not `signing`
- [ ] openpgp enabled → the prompt note in the reply's notices (story 171)


## INT-26: Takeovers carry their notices into every ending

**What to build:** the takeover behaviour itself (automatic takeover of a stale lock, `plan
--take-over <planId>`, index repair) belongs to RUN-21 to RUN-25; this slice wires the
takeover notices into every ending of `plan` and of the run, so the notice with the stale
run's `planId` and any `unstaged` report reach whatever reply the run ends with.

**Blocked by:** INT-05, INT-03, RUN-21, RUN-22.

**Status:** ready-for-agent

**Sources:** Q22, M18 `plan` step 3, C:run-folder, stories 189, 190, 210.

- [ ] The takeover notice survives a later refusal of the same `plan` (`staged-empty`,
      `timeout`)
- [ ] Seam 1: after an automatic takeover on a modified tree, the takeover notice (with the
      stale `planId`) and any `unstaged` report reach the `committed` reply and the text of
      a `confirm` handback


## INT-27: Guard heartbeat round trip

**What to build:** the guard, fed the worker's `plan` script call, writes the heartbeat, and
the next `plan` in that repo reports the guard active; without a heartbeat under 15 minutes
the reply carries the "guard did not run" notice.

**Blocked by:** INT-02, GRD-13, GRD-15, GRD-17.

**Status:** ready-for-agent

**Sources:** Q23, Testing seams "ScriptCall round trip", stories 34, 36, 37.

- [ ] Seam 2 then Seam 1: the guard process fed the exact `plan` command in Bash and in
      PowerShell form writes the heartbeat; the following `plan` has no guard notice
- [ ] A heartbeat older than 15 minutes, or from another repo → `env.guard: "not-seen"` and the
      notice in the reply text (stories 34, 36)
- [ ] Seam 1: the INT-02 First-slice run with no heartbeat in the Claude home → the
      `committed` reply's `notices` hold the guard "not seen" notice


## INT-28: ScriptCall round trip and the worker-only rule

**What to build:** every `run` string M17 can build goes through G1 `runHook` as Bash and as
PowerShell and is recognised with the same subcommand and arguments; as
`commit:commit-worker` a `commit` or `release` call is denied, from the main session it
passes.

**Blocked by:** INT-09, INT-11, INT-22, RPL-08, GRD-13, GRD-14.

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
