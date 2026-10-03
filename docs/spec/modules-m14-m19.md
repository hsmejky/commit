# Modules M14-M19

**M14 Plan validator.** Pure over the worker plan and the run state. Shape errors become lint
errors with `group: null`; resolve file-level paths to units via the unit table (a rename by
its new path only); IDs exist, are used once and are not mixed with `files`; completeness in
`split`; identical hunks placed the same way (identity key): all in one group or all in
`notIncluded`; no hit, collapsed-directory or
`dirtySubmodules` path in a group; exactly one group in `staged` and `reword`; lint (M6) and
scan (M8) each message; add the `notIncluded` extras and notices; derive new files, file lists and the
attribution flag per group. `validatePlan(planBytes, runState, { osUser })` (typed: `{ groups,
notIncluded, notices, stored }` or `lint` with errors; `stored` is the per-group rows
`check` writes into `state.json`, PLN-01; a message's scan errors, one per pattern ID,
carry the M8 `scanText` spans for M17's redaction, and an M6 reason quoting a fragment that
overlaps a span quotes `[<pattern-id>]` instead, C:check). `osUser` is the entry point's injected value, passed
by M18 on every call and never stored in the run state (Q10 as amended by EXE-01). Sources:
Q9, Q10, Q11, Q16, Q20, C:worker-plan, C:check.

**M15 Run policy.** Every pure decision of a run; one entry per contracts table:
- `resolveMode(flags, indexState, killedLeftover)`: `killedLeftover` is true when a takeover
  finds staging it did not reset (the index holds paths beyond the killed group's paths,
  C:run-folder); when true: with `--reword` (with or without `--no-user`) the mode stays
  `reword` plus a notice naming the killed group's paths still staged (`--amend --only`
  never touches the index); else with `--no-user` the refusal `killed-leftover` (exit 6
  `state`, its text naming those paths; M18 releases the lock and deletes the folder, the
  index untouched); else `modeChoice` whatever the flags (`--staged` included) and the
  index shape. Otherwise: flags (`--staged` with an empty index → `staged-empty`);
  empty or fully staged index → `split`; a mixed index (staged plus unstaged tracked changes
  or candidates) → `modeChoice`. Candidates are counted after M9 `hideFilter` and before
  the caps, so a large new directory beside a fully staged index still asks `modeChoice`.
- `planRefusal(facts)`: in order `env`, `config`, `state` (incl. encoding and `unmerged`);
  in `reword` then unborn and merge commit (`state`) and `pushed`; after the scan
  `staged-hit` (in `staged`, `stagedExcluded` holds hidden paths only) and clean-tree
  detection (hidden-only, collapsed-only, `stagedExcluded`-only, non-UTF-8-only or `dirtySubmodules`-only
  counts as clean, and the `nothing` reply's `text` names their counts and paths,
  C:plan; skipped in `reword`, which
  usually runs on a clean tree, Q9), then `signing`. Each refusal's `message` for a
  domain code with a recorded text is the recorded-texts table of C:cli-and-exit-codes, verbatim.
- `checkGate(runState)`: refuse `check` after any committed group (`already-committed`).
- `onLintFailure(runState, source, kind)` → `fix` | `lintFailed`: the second failure since
  the last `plan --hunks`, or the first with `source: user`, ends the worker's retries. When
  every error of the ending failure is a shape error (the worker plan is not valid JSON or
  not the C:worker-plan shape), the `lintFailed` handback offers `retry` and `no` only:
  dictated text cannot fix a shape (story 214).
- `computeConfirm(mode, groups, scanMap, { resumed, interactive }) → null | { reasons,
  humanOnly }` per C:confirmation-triggers; a hit is never a trigger.
- `afterCheck(confirm, groups, runState) → "commit" | "confirm" | "handedBack" |
  "releaseNothing"`.
- `runEnd(event, runState) → "keep" | "release"`, for the events `refusal(code)`,
  `lintFailure`, `checkResult`, `commitOutcome`, `release`; the single source of which
  outcomes release the lock and delete the folder (C:cli-and-exit-codes, C:run-folder). A
  failed outcome whose unstage failed or was skipped (`cleanupDeadline` below) → `keep`.
- `deadline(callStarted)` = the call's start plus 540 s, computed once when the call starts
  (C:commit-release). `nextStep({ now, deadline, groupIndex }) → { go: true, deadline } |
  { go: false }`: the first group always starts; a later group only while at least 480 s
  remain before `deadline`. Every M2 call of the call (in `plan` also those before
  `acquire`; later the snapshot, reset, apply, backstop and `git commit`) takes
  `timeoutMs = deadline - now()` at its own start, so the budget never goes stale; `plan`
  past its deadline ends as `timeout` and discards its provisional run.
- `cleanupDeadline(callStarted)` = the call's start plus 580 s: after a failure or timeout,
  the cleanup and reporting calls (the `finally` unstage, the HEAD re-read, M10 `treeState`,
  the release) take `cleanupDeadline - now()`, never the spent `deadline`, so a timed-out
  call still reports and releases inside the worker's 600 s tool timeout. A cleanup call
  whose `timeoutMs` (`cleanupDeadline - now()`) is at or below 0 is not spawned and counts as
  `timed-out`. A cleanup call that fails or is skipped never changes the outcome: the exit
  code and kind stay the original cause's, and the cleanup error becomes a notice. When the
  skipped or failed call is the unstage of a group that reached phase (c), `runEnd` returns
  `keep`: the lock and the run folder stay (the state holds `indexReset` and the unfinished
  group), so the next run's takeover repair resets the index (C:run-folder); `unstaged` is
  `null` and a notice says "group <n> staging may remain, the next /commit repairs it" (Q18
  as amended by EXE-01).
- `releaseDeadline(callStarted)` = the call's start plus 45 s: `release`'s M10 `treeState`
  read for the reply takes this deadline, kept below the 60 s `release` tool timeout (M17);
  when the budget runs out, the reply omits `treeState` (the release itself is already
  complete).
Sources: Q9, Q10, Q16-Q18, Q20-Q22, C:plan, C:check, C:confirmation-triggers,
C:commit-release.

**M16 Commit executor.** The per-group loop of `commit --all`, and nothing about
presentation. Each group runs the three phases of C:commit-release in order, and every check
of phase (a) runs again before each group, so the advanced expected HEAD and an `index.lock`
created between groups are both caught:
- (a) Refusals, in C:commit-release order: `lock` (M12 `open` with its `call.lock` once per
  call, before the first group; `touch(run)` before each group), `unconfirmed`

  (first group of the call only), `no-groups` (no stored groups, or all committed), `head-moved` (M3 `head()` against the current expected
  HEAD: the one `plan` recorded, then the SHA of each group this run committed; text per
  the recorded-texts table of C:cli-and-exit-codes),
  `index-changed` (M10 `indexFingerprint` against the fingerprint in the run state: staging
  made between `plan` and `commit` is refused, never folded into a group or lost from the
  report; after each of the run's own commits and unstages the stored fingerprint is
  updated; skipped in `reword`, whose `--amend --only` ignores the index, Q18, Q20),
  `index-lock` (M10); then M15 `nextStep` (stop → the budget stop, exit 0 with `continue`).
- (b) Match (`split`): M10 `matchIds` on the temporary index, without touching the real
  index; a failed `git add -N` while rebuilding that index → `git-failed` (exit 4, the real
  index untouched). In `staged`, M10 `verifyIndex` instead; `reword` skips (b) and (c).
- (c) Apply (`split`): set `indexReset` in the run state, then M10 `stage` (reset, apply,
  add, verify; `mismatch` or `stage-failed`).
- Then the backstop (not in `reword`): first M10 `writeTree` records the index's tree ID,
  then M8 `scanUnits`, with matchers recompiled by M7 from the stored patterns, runs over
  M10 `treeDiffUnits(expected HEAD, recorded tree)` (`null` for the empty tree when unborn),
  which carries the attribute-hidden `--text` pass and the 1 MB limit of the snapshot diff,
  so the tree scanned is exactly the tree recorded and an index change after
  `writeTree` shows up in the M3 `headTree` comparison below; trailers (M6) from the
  stored attribution; `git commit --cleanup=verbatim` with the message on stdin
  (`--amend --only` in `reword`) through M10 `commitGuarded` with the time left before
  `deadline`, `partial` set only in `reword` (M10 owns the markers, the tree kill via M2 and
  the stale-lock removal; a `git commit` killed there fails `timed-out` with the text "git
  commit did not finish in 9 min — a pre-commit hook or a signing prompt may be waiting",
  Q18, plus, when M10 returns `lockLeft`, the notice that `index.lock` was left in place and
  should be checked and removed by hand if no git process is running); after
  a commit, M3 `head()` reads the new HEAD and checks its first parent against the SHA
  expected before this commit (an unborn branch: HEAD has no parent) — except in `reword`,
  where `--amend --only` gives the new commit the same parent as the one it replaced, so
  there M3 compares HEAD's first parent against the expected HEAD's own first parent (both
  none, on a root commit); when it matches, HEAD is the group's SHA; when it does not (a
  hook or another process committed as well), the
  group is still reported committed, with the SHA HEAD holds, a notice names the group
  ("another commit was made during group <n>; later groups refused"), and the next group's
  (a) check then finds HEAD moved from the expected SHA and refuses `head-moved`;
  separately, when M3 `headTree()` differs from the
  recorded tree ID (a hook or another process changed the index between the backstop and the
  commit, with no extra commit), a notice names the group ("committed tree differs from the scanned index"); after any failure or timeout re-read HEAD (within
  `cleanupDeadline`), so a commit git made anyway is reported with its `sha`; hook-rewrite detection
  (`treeChangedDuringCommit`, stored in the run state); on a match, mark the group committed
  and advance the expected HEAD to the SHA just determined; on a mismatch, mark it committed
  with the SHA HEAD holds but leave the expected HEAD as it was, so the next group's own
  check finds it stale and refuses `head-moved`.
- On failure, M10 `unstage` runs only when the failing group itself reached (c); a refusal in
  (a) or a failure in (b) leaves the real index as it is, even when an earlier group or call
  set `indexReset`. `indexReset` only decides the report: `unstaged` is `null` unless it is
  set, else M10 `unstagedAfterReset`. When that unstage fails or is skipped past
  `cleanupDeadline`, `unstaged` is `null`, the outcome keeps its original cause, and the run
  is kept for the next run's takeover repair (M15 `cleanupDeadline`, C:run-folder).

`commitAll(run, { now, osUser, env }) → Outcome` (`env`: the injected environment its M10/M3 calls take), with `osUser` passed by M18 for the backstop's
M8 `scanUnits` and never stored in the run state (Q10 as amended by EXE-01), where `Outcome` holds the output fields of
C:commit-release, plus `refusal: { code, message } | null`: how a phase (a) check hands a mid-run refusal to M18, which
maps `code` through the domain-code table (C:cli-and-exit-codes) and merges `message` into the CLI `error`; `null` on
every other outcome, including success and a budget stop. `hits` is present on a backstop-scan refusal (exit 3), `sha` after exit 4 or 5, and before an
`internal` reply (exit 1), when HEAD moved anyway; a budget stop is `ok` with `failed: null` and a non-empty `remaining`. M18
adds M10 `treeState`, builds the reply (M17) and releases per M15 `runEnd`.

Accepted limits of the hook path are listed in [Out of Scope](out-of-scope.md).
Sources: Q9, Q11, Q18, Q20, Q22, C:commit-release.

**M17 Reply and handback.** Build the reply for every output that ends the worker's part:
`status`; `text` (commits, failure, the confirm block with its 20-file cap and a hunk count per file in a hunk plan, lint texts,
`Notices:`, trailer line when `commits` is non-empty, tree state; lists capped at 10 plus "+N more"); `callerRule`
(base plus handback rule, fixed text); the handback kinds with their answers; `run` via S2
`build` from the injected `scriptPath`, with `timeoutMs` 600 000 for `commit` and 60 000
otherwise; `respawn` (answer fields plus the `mode` flag of the `plan` call that produced
the handback, which a `modeChoice` answer's own `mode` replaces; `takeOver` only in a `lock` handback's `take over`, never in a `modeChoice`,
whose takeover already finished at `plan` step 3); `ifNoUser`. M17 owns the `--no-user` lock rule: it reads
`interactive` from `plan`'s argv, and a `lock` refusal under `--no-user` is a plain reply
with no takeover answer (C:cli-and-exit-codes). A `lock` refusal whose holder has no `planId`
carries no handback: `status: "failed"`, and the text says the lock is unreadable (corrupt
or foreign: M12 links a run's lock into place fully written, so no run is ever seen
starting) and is waited out, naming the time it is taken over automatically (`touched`
plus 15 minutes). Budgets per
C:run-folder and C:reply-and-handback: reply ≤ 2 kB without `text`, `text` ≤ 4 kB at every
cap, not counting the messages a `confirm` block or a `lintFailed` text quotes (Q24);
`lintFailed` retry text ≤ 500 characters. A `lintFailed` text quotes each rejected message
with every scan-hit span replaced by `[<pattern-id>]`, so no secret reaches the caller. The
`yes` answer of a `confirm` carries `--confirmed`; no other `run` does. A unit left out on a
hit gets the two manual lines per C:reply-and-handback (`!git --literal-pathspecs add --
<path>`, then `!git commit -m "<message>"`), with `<message>` left as a placeholder the
user fills in (Q10); a path it cannot quote safely (`'`, U+2018–U+201B, a control
character) gets only "commit by hand". Every `ReplyFacts` variant carries the M10
`treeState`, except `release`'s past its 45 s budget (M15 `releaseDeadline`), which omits
it since the release already completed, and a `not-a-repo` refusal, which has no tree to
read; rendered as "working tree clean", or "N files left: …" (singular "1 file left"),
the paths joined by ", ", with up to 10 paths plus "+N more".
Every path M17 renders anywhere in `text` has its control characters escaped per
C:reply-and-handback, so a crafted name can neither forge a reply line nor send a terminal
escape. Git and hook output (a failed commit, a hook's message) goes into `text` escaped the
same way except that `\n` and `\t` are kept (ESC is escaped, so ANSI sequences are
neutralised), and only its last 2000 characters, prefixed with "[… N characters cut]" when
cut; the full output stays in `gitOutput` (Q18, C:reply-and-handback). `reply(facts: ReplyFacts, { scriptPath,
argv })`, where `ReplyFacts` is a discriminated union per status (`committed`, `nothing`,
`handback`, `failed`) carrying exactly the fields C:reply-and-handback lists for it, plus one
internal discriminator per variant that never reaches the rendered reply: the `nothing`
variant also carries `reason` (`clean` | `released` | `already-ended`), which selects the
first line of `text` (C:commit-release) and is not itself one of C:reply-and-handback's
fields (review-RUN-01 finding 6).
Sources: Q9, Q16, Q22, Q24, Q25, C:reply-and-handback.

**M18 Subcommand workflows.** Sequences over the modules, each a numbered step table that is
the contract for Seam 1 tests; each maps typed results through the error table and builds
the reply with M17.
- **`plan`.** M15 `deadline` from the call's start bounds every M2 call of every step
  (exceeded → `timeout`, discard).
  1. M3 probe (plus reword facts, `unmerged`); M4 config; M5 attribution.
  2. M15 `planRefusal` (pre-folder refusals: `env`, `config`, `state`, `pushed`).
  3. M12 `create` (run-folder directory check, provisional folder); M12 `peek` before any
     inventory work: a live lock → `lock`, discard; a stale lock, or no lock but an orphan
     renamed lock → the automatic takeover (adopting the orphans' chains), here.
     `--take-over` skips `peek`, and its takeover of the named lock, whatever its age,
     runs here too (`ended` when that run is already gone). A takeover is M12
     `acquire({ takeOver })`, then the index repair from its `killedRun` (the
     killed-process paragraph under the error table), then M12 `finishTakeover`, all
     before step 4, so inventory never sees a killed group's partial staging. A repair
     whose `git reset -q -- .` fails (`index-lock`, `timeout`, `git-failed`) skips
     `finishTakeover`, keeping the chain for the next `plan`, then releases its own lock and
     deletes its own folder, and the reply carries the notices so far plus a "repair
     failed" notice (C:run-folder). From here on the run holds the lock: every later outcome that takes no lock
     on the path with no takeover (clean, `modeChoice`, `staged-empty`, `staged-hit`,
     `signing`, `killed-leftover`, `git-failed`, `timeout`, …) releases the lock and deletes
     the folder, so each discard below is then an M12 `release` (C:plan step 3). The
     takeover's notices (the takeover notice with the stale run's `planId`, the reset
     notice, the `unstaged` report, the `killedLeftover` paths) are kept from here on and
     M17 puts them in the reply's notices of every output `plan` ends with, whatever step
     it ends at (clean, `modeChoice`, a refusal, `timeout`, `internal`), since
     `finishTakeover` has already deleted the evidence (story 210).
  4. M10 `indexFingerprint`, read first, then M10 `inventory`; M9 `hideFilter`; M15
     `resolveMode` (passed `killedLeftover` from the takeover repair at step 3)
     (`modeChoice`, `staged-empty` or `killed-leftover` → discard; a `reword` run with
     `killedLeftover` goes on with its notice); then, only in the resolved `split` mode,
     M10 `unplannableCaseRenames` over the staged-new paths, the hidden ones included, and
     the tracked paths (any → `case-rename`, discard; never in `staged` or `reword`).
  5. M9 `applyCaps` (`split` only); M10 `snapshot` (a failed `git add` → `git-failed`,
     discard) and `assignIds`; when a unit's path or old path is the repo config (M4
     `isRepoConfigPath`), M4 `scanIgnoreChanged` compares step 1's HEAD patterns (`[]` when
     the value at HEAD was invalid) with M10 `snapshotBlob(REPO_CONFIG_PATH)`, the path M4
     exports, never the unit's own path (no unit of it: `false`); M8 scan with that
     boolean, which M18 also outputs as `scan.scanIgnoreChanged`, and M8's
     `scanIgnoreUnits` go in the scan map.
  6. M15 `planRefusal` post-scan (`staged-hit`, clean → discard, no clean check in
     `reword`); then M11 signing
     (`signing` → discard).
  7. Store the stored-facts rows except notices; on the path with no takeover M12 `acquire`
     (a race lost after `peek` → `lock`, discard; an orphan it adopts whose `killedRun`
     calls for the repair → no repair and no `finishTakeover`, the chain left for the next
     `plan`'s step 3, then release and refuse `index-changed` with a notice, since the
     inventory is already taken; an orphan with nothing to repair is finished here),
     skipped after a step-3 takeover; then
     re-read HEAD and the index fingerprint, on both paths: a moved HEAD (another run
     committed since the inventory) releases and refuses `head-moved`;
     a changed index fingerprint with an unchanged HEAD releases and refuses
     `index-changed` (CLI kind `diff-changed`, not checked in `reword`, which `--amend --only`
     never touches); otherwise that fingerprint is stored for M16; S1 `guardState` (read here, ahead of
     the sweep, so `plan.json` carries `env.guard`; the order is not observable); write
     `plan.json` (the full `plan` output) through M12; M12 `sweep`.

  8. The notices (`env.guard: "not-seen"`, the takeover's notices
     kept since step 3, the sweep's cleanup errors, plus the earlier ones) are stored in one more atomic `state.json` write, so none computed after step 7
     is lost; then `plan --hunks`
     in-process unless `--dictated`.
- **`plan --hunks`.** A separate call takes its own M15 `deadline` (540 s from its start)
  for every M2 call of its work (exceeded → `timeout`) and `cleanupDeadline` for a refusal's
  tree-state read and the release; in-process it runs under `plan`'s deadline. M12 `open`;
  `head-moved` via M3; M10 `snapshot` from the stored lists
  and `matchIds` (a separate call only: in-process it reuses `plan`'s step-5 units, from
  which the stored `id → hash` map was just built, so the diff is not taken twice; the
  scanned and the rendered units are the same, and `commit`'s own match still catches a
  later edit); reset `lintFailures`; set `resumed` only as a separate call; M13
  `renderHunks` with the matched snapshot units; write through M12, changing only its own
  fields of the state it read (in-process too), so `notices` and every other stored fact
  survive; a refusal's reply carries M10 `treeState`.
- **Every call with `--plan`** holds the run's `call.lock` for its whole duration (M12
  `open`, removed by M12 `run.close()` in M18's `finally`), so two calls on one run never
  overlap (`busy`).
- **`check`.** M12 `open`; M15 `checkGate`; clear stored groups and `awaitingConfirm`; M14 `validatePlan(planBytes,
  runState, { osUser })`; on lint errors M15
  `onLintFailure` and `runEnd` (an interactive `lintFailed` keeps the run for its `resume`;
  with `--no-user` the failure that ends the retries releases the lock and deletes the
  folder, so nothing waits for an answer and the next `/commit` starts fresh); M15 `computeConfirm` and `afterCheck`; store groups
  (and `awaitingConfirm` for a `confirm`); M16 or a handback; M10 `treeState` for the reply.
  When `confirm` is null, the output is `commit --all`'s with `groups`, `notIncluded` and
  `notices` merged in, the merged notices landing in `reply.notices` (C:check).
- **`commit`.** M16 `commitAll(run, { now, osUser })` (`check` calls it the same way); M10
  `treeState` for the reply; M15 `runEnd`. **`release`.** M12
  `releaseById` (no-op on mismatch, before any `call.lock`; on a match it takes the
  `call.lock`, so a call still running on the run → `busy` and the run is kept); M10
  `treeState` for the reply (within the 45 s budget below the 60 s tool timeout, M15
  `releaseDeadline`; past it the reply omits `treeState`).
- **`infer`.** M3 history read; M19 `infer`; M4 `readLayers`; M19 `configFor`.
Sources: Q7, Q9, Q10, Q16-Q18, Q20-Q23, C:plan, C:check, C:commit-release.

**M19 History inference.** Pure. `infer(messages) → InferOutput` computes the Conventional
Commits share (a commit counts as Conventional Commits only when its header matches M6
`lint`'s header grammar; a footer paragraph does not count as a body, Q7), scope, body,
case via M6 `passesLowerCase`, p95 length with the rounding and clamp of C:infer, types
(all 11 standard types always, plus non-standard ones by the 5% rule, dropped list) and
`wouldFail` via M6 lint; outcomes `too-few-commits` and
`not-conventional`, which still carry `ccShare` (over all commits read, `null` only when
`commitCount` is 0), `nonConventional` and `commitCount`, with
`wouldFail: null` and no proposal. `configFor(proposal, layers) → { repo, user }`: per layer the current raw
layer with the proposal's keys replaced and other keys kept, checked by M4 `validateLayer`,
each `{ text } | { errors }`. Sources: Q6, Q7, C:infer.
