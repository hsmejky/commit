# Known deficiencies

Open defects in the design documents (spec, contracts, decisions) that are known but not yet
fixed. Each item names the problem, where it lives, its impact, the suggested resolution
and, where one exists, the roadmap slice that settles it. Citations follow the spec
convention: `Qn` is a decision in [decisions](../decisions/README.md), `C:<section>` a file
in [contracts](../contracts/README.md). Plan-level defects are in the
[roadmap's known deficiencies](../roadmap/known-deficiencies.md). When an item is fixed,
delete it here; IDs are never reused.

## Error handling and cleanup

- **KD-S11. A throw between `create` and `acquire` leaks the provisional folder.** The
  try/finally covers only steps after `acquire`; an `internal` throw at steps 3-7 leaves
  the folder to the 24-hour sweep, against "no outcome without a lock leaves a folder".
  Where: [domain-code-cli-kind.md](domain-code-cli-kind.md), M18,
  [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md) `internal` row,
  [C:run-folder](../contracts/run-folder.md). Fix: discard the provisional run on such a
  throw, in spec and contract.
- **KD-S13. "Cannot leave `git commit` as an orphan" is unqualified.** Out of Scope accepts
  that a hard kill can orphan a commit, tool-call termination is an open verification
  item, and Windows delivers no catchable SIGTERM. Where:
  [architectural-decisions.md](architectural-decisions.md), [out-of-scope.md](out-of-scope.md).
  Fix: add "when the harness delivers a catchable signal". Disposition: accepted for 0.1.0.
- **KD-S14. Timeout text hard-codes "9 min".** A later group may start with 480 s left.
  Where: M16, [C:commit-release](../contracts/commit-release.md), Q18. Fix: compute the
  minutes or say "within the call's time budget". Disposition: accepted for 0.1.0.
- **KD-S77. Non-UTF-8 toplevel path mangled by the start-up `spawnSync` decode.** `toplevel`'s
  `spawnSync` call decodes stdout as UTF-8 text so the fixed short-timeout probe can return a
  string toplevel; on POSIX a toplevel path containing non-UTF-8 bytes is mangled to U+FFFD
  and then fails as a later call's `cwd`. Where: M2, `plugin/scripts/lib/process-adapter.mjs`.
  Disposition: accepted for 0.1.0.
- **KD-S78. `release` outside a working tree is unsettled.** `state` is limited to `plan` and
  `infer` (C:cli-and-exit-codes), while story 56 implies a not-a-repo refusal without a tree
  state; no slice schedules the choice. Today `release` throws "release outside a working
  tree is not built yet", which `main` maps to exit 1 `internal` — a real, if generic, ending,
  not a crash, but the message overclaims that a slice is scheduled. Where: M18
  `plugin/scripts/lib/workflows.mjs` (`releaseRefusals`), [C:commit-release](../contracts/commit-release.md),
  [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md),
  [domain-code-cli-kind.md](domain-code-cli-kind.md). Fix: settle on either a `state` row for
  `release`, a no-op "nothing to release" (no repo means no run folder), or a documented
  `internal` with a real message, then update the message and the tables together
  (review-RUN-01 finding 7).
- **KD-S79. A TOCTOU gap remains between `<planId>`'s `lstat` and the operation that
  follows it.** `release`'s `call.lock` write, its rename, and `close()`'s `rmSync`
  each `lstat` `<planId>` right before touching `call.lock`, but a junction swapped in
  inside that window still redirects the operation; Node has no `openat`/`O_NOFOLLOW` for
  directory path components, so this cannot be fully closed. Impact is small: the `wx`
  create never overwrites and the payload is `{pid,host}`; `close()`'s `rmSync` could
  at worst delete a same-named file in the junction's target. Where:
  `plugin/scripts/lib/run.mjs` (`takeCallLock`, `close`),
  [C:run-folder](../contracts/run-folder.md). Disposition: accepted for 0.1.0
  (review-RUN-02 finding 7).
- **KD-S82. A staged mode change is lost under `core.fileMode=false`.** With
  `core.fileMode=false` (the Windows default, or set by the user) `git update-index
  --chmod=+x` is the only way to stage an executable bit. Without a content edit it gives no
  unit: the temporary index is reset to HEAD's mode, and git compares no mode against the
  worktree. A `split` commit's real-index reset then drops the staged mode with no notice.
  `indexOnly` (CHG-14, "differs from HEAD and the worktree") does not catch it, since git
  sees no worktree difference. Where: Q11 (index-only content),
  [C:plan](../contracts/plan.md) (temporary index), M10 `snapshot`. Fix: list index entries
  whose mode differs from HEAD while `core.fileMode=false` as a `mode` unit taken from the
  index, or as `indexOnly` with a notice. Slices: CHG-08, CHG-14 (review-CHG-05 finding 5).
- **KD-S83. A post-commit hook's own staging silently slips past the index-fingerprint
  re-read.** In `split` mode a `post-commit` (or `commit-msg`/`post-rewrite`-style) hook of
  group n that `git add`s another file changes the index before `commit-executor.mjs:228`
  re-reads it for `state.indexFingerprint`, so the stored fingerprint absorbs that outside
  staging; group n+1's phase (c) `git reset -q -- .` then silently unstages it (the
  working-tree change survives; only the staging and the report are lost). EXE-06 treats
  the analogous HEAD case (a hook commit) by leaving `state.head` stale so the next group
  refuses `head-moved`; the index analogue is missing.
  [C:commit-release](../contracts/commit-release.md):43's own update rule ("the stored
  fingerprint is updated to the fresh read after each of the run's own `git commit` calls")
  absorbs hook staging inside that call, which contradicts the same bullet's promise that
  staging between two groups is never silently lost from the report — a design defect, not
  a slice deviation. `tests/commit-all.test.js`'s "group 1 already committed before the
  call, then a git add from outside" test does not cover the genuine within-call case
  either: it commits group 1 in the fixture before the call starts, so the call's first
  group is the first loop iteration, the same path the plan's first EXE-07 AC already
  covers; a real between-groups case needs a hook, which is exactly this gap, so no test
  exercises it today. Where: C:commit-release:43,
  `plugin/scripts/lib/commit-executor.mjs:228`, `tests/commit-all.test.js`. Fix: after
  `git commit`, in `split` mode (no `preStaged`, so the index the run leaves must equal the
  new HEAD's tree), check `git diff-index --cached --quiet HEAD` (read-only); on a
  difference keep the stored fingerprint stale (mirroring EXE-06) so the next group refuses
  `index-changed`, and push a notice naming the group. Do not compare the pre-commit and
  post-commit fingerprints instead: a lint-staged `pre-commit` hook legitimately re-adds
  files (that is `treeChangedDuringCommit`'s case, EXE-15). Once fixed, add a Seam-1 case
  with a `post-commit` hook of group 1 that stages `other.txt` → group 1 kept, group 2
  refused `index-changed`, `other.txt` still staged. Disposition: accepted for 0.1.0
  (review-EXE-07 findings 1, 5, 6).

## Error tables and API contract

- **KD-S18. No field for domain sub-codes.** The failure JSON has `kind` and `message`
  only, so `held`, `busy`, `taken-over`, `index-changed` … differ only by text; the spec
  table uses codes the contracts never define. Fix: add `error.code` and list every code
  in the contract, or state that sub-codes live only in `message`.
- **KD-S20. `infer` missing from the spec error table.** C:infer refuses outside a repo or
  in a bare repo; [domain-code-cli-kind.md](domain-code-cli-kind.md) has no `infer` rows,
  and unborn HEAD (success with zero samples?) is implicit. Fix: add the rows, state the
  unborn outcome in [C:infer](../contracts/infer.md) and Q7.
- **KD-S21. Error table heading "owned by M18".** The table also holds M1 `usage` rows and
  the entry point's `env` row. Fix: retitle.
- **KD-S22. `git-failed` producer cell garbled.** It names `check` as a producer. Fix:
  `git commit` non-zero (M16) plus the temporary-index `git add` (M10 via M18 in `plan`
  and `plan --hunks`, via M16 in commit phase b); align both contract tables.
- **KD-S23. Worker input cannot carry multi-line text.** `key: value` lines cannot hold a
  multi-paragraph dictated reword or `edit`; `reword: true` is ambiguous. Where:
  [C:worker-input](../contracts/worker-input.md). Fix: make `reword`/`edit` run to the end
  of the prompt, or define a block form; add a two-paragraph fixture.
- **KD-S80. The guard's prefix allowlist before `git` trusts names, not what they resolve
  to.** C:guard step 3 (review GRD-04 round 4) replaced the possible-wrapper denylist with
  a structural prefix allowlist, but a wrapper reached through an allowlisted word still
  passes: a Bash alias (with `expand_aliases`) for one, a function or a `PATH` script named
  `nice`, `nohup` or `env`; and since G2 drops quoting, a quoted reserved word or
  assignment (`'if'`, `"A"=x`) that bash runs as a command of that name. In PowerShell
  a string run by `iex` or `Invoke-Expression` (`iex 'git commit -m x'`) holds no `git`
  token and passes, like `eval` (the interpreter gap), and so does .NET `Process.Start`
  (`[Diagnostics.Process]::Start('git','commit --no-verify -m x')`, whose type and method
  names can be built at run time) and a command name built at run time
  (`& ('Start-'+'Process') git …`); a Start-Process word is denied (KD-S81). Impact is small:
  the guard steers, it is no security boundary (Q3), and each needs a prepared alias,
  function or script, or a deliberate string or .NET call. Where:
  [C:guard](../contracts/guard.md) step 3, Q3,
  [out-of-scope.md](out-of-scope.md). Disposition: accepted for 0.1.0.
- **KD-S81. Any Start-Process word denies a PowerShell command that mentions commit.**
  C:guard step 3 (review GRD-06 round 2): `Start-Process`, `saps` or `start` anywhere in the
  command, alone or after `=` in its token, gets the wrapper row whatever follows, since the
  program it runs can hide in `-FilePath:git`, `'git '`, `git.exe.`, `('git')`, a variable,
  splatting or `$PSDefaultParameterValues`, and the word runs in any statement form
  (`$p = Start-Process …`, `return …`, `. saps …`). Accepted false denies:
  `start https://github.com/o/r/commit/abc`, `npm start` or a `start` argument in a command
  that mentions commit, and a script block passed to Start-Process. Where:
  [C:guard](../contracts/guard.md) step 3. Disposition: accepted for 0.1.0 (fail closed,
  PRE-03); narrow it only with a reading of Start-Process's target that is checked against
  PowerShell 5.1 and 7.

## Testing

Other test gaps ([testing-modules.md](testing-modules.md), [testing-seams.md](testing-seams.md)):

- **KD-S35. PATH git shims cannot work on Windows.** Shell-less spawn finds only
  `.com`/`.exe`; no case is marked POSIX-only and no `git.exe` shim or argv log is
  specified. Fix: specify a compiled Windows shim and the log format, or mark the cases
  POSIX-only. Disposition: accepted for 0.1.0 (roadmap KD-R21).
- **KD-S37. Hook registration check ignores the `if` condition** (Q13); a mismatch
  silently disables the heartbeat. Fix: assert `if` matches every S2 `build` output.
  Disposition: accepted for 0.1.0.
- **KD-S39. Heartbeat and stderr redaction untested** (story 21). Fix: canary text absent
  from both outputs; a 300-character command cut to 200. Disposition: accepted for 0.1.0.
- **KD-S40. git-2.34 container job prerequisites unstated**: Node install, `openssh-client`
  for the M11 probe, skipped cases. Disposition: accepted for 0.1.0.
- **KD-S41. Kill-timeout cases leave about 5 s of real time** (clock stepped to 535 s);
  flaky on cold Windows runners. Fix: step to 530 s for hook-recording cases.
- **KD-S42. No test rows for `scanIgnoreChanged` and the backstop `--text` pass**: another
  key edited → false, invalid JSON → true, multi-hunk config, config renamed away,
  attribute-hidden `--text`. Fix: add them to the M4 and M6-M9 rows. Disposition: accepted
  for 0.1.0.

## Performance

- **KD-S43. 4 kB `text` budget ignores the multi-group confirm block** (20 files per
  group, uncapped groups); the size test has no confirm fixture. Where: Q24,
  [C:reply-and-handback](../contracts/reply-and-handback.md). Fix: exempt the confirm lists,
  or add a group cap or larger budget with a multi-group fixture. Disposition: accepted
  for 0.1.0.

## Decision fidelity and provenance

- **KD-S44. Open items labelled "introduced by this spec"** in [further-notes.md](further-notes.md)
  (guard cold start, tool-call termination) are already in
  [open verification items](../decisions/open-verification-items.md); the story-217 gate
  and revision rule have no source. Fix: drop the labels, record or drop the rule.
- **KD-S45. Worker prompt lacks "no git diff of its own"** (Q12): only `Read` is limited.
  Where: [prompt-only-and-manifest-blocks.md](prompt-only-and-manifest-blocks.md). Fix:
  read changes only through `hunks.txt` and run no other git command. Slice: WRK-02.
- **KD-S46. Dogfood gate lacks Q24's diff-size formula** (`git diff HEAD --numstat` plus
  `hunks.txt` tokens) and "the price-weighted ratio is a proxy only". Where:
  [story-verification.md](story-verification.md). Disposition: accepted for 0.1.0.
- **KD-S48. Heartbeat relocation drops Q23's constraints**: writer and reader both reach
  it, and not `os.tmpdir()`. Where: [further-notes.md](further-notes.md),
  [open verification items](../decisions/open-verification-items.md). Slices: GRD-15,
  GRD-17.
- **KD-S49. Code-level mechanics in Implementation Decisions** (`os.userInfo()`,
  `spawnSync`, `process.kill(pid, 0)`, `%SystemRoot%\System32` …), against the spec's own
  rule and Q15's wording. Fix: restate as behaviour. Disposition: accepted for 0.1.0.
- **KD-S50. Bare-name privacy gap missing from Out of Scope**, which claims to be the one
  gap list (Q15 accepts it). Disposition: accepted for 0.1.0.
- **KD-S51. The review-report exclude line (Q15) is not mentioned** in
  [further-notes.md](further-notes.md). Disposition: accepted for 0.1.0.
- **KD-S52. Three superseded texts remain in decision bodies**: Q9's `env` path set lacks
  Q16's typographic quotes; Q11's NUL-byte binary rule (limited by Q10); Q17's oversized
  subagent file rule (narrowed to no-user runs). Fix: amend or mark superseded.
