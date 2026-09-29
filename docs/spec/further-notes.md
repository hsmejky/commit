# Further Notes

## Open items

Each item is a spike or a manual check. Slice guidance: run the spike first, as its own
slice, and start the dependent slice only once the spike has settled the behaviour; a slice
that does not depend on an item does not wait for it.

- **G2 tokenizer spike** (Q3): the hand-written tokenizer against heredocs, `$(...)`,
  backticks, `bash -c '…'`, reordered flags, PowerShell here-strings and unterminated
  quotes, escaped newlines, plus subshells such as `( git commit )`. Case variants of the command name are decided (G3 compares the
  `git` basename and the subcommand case-insensitively, G1's `commit` substring is
  case-insensitive), and so are subshells and heredocs (G2: `(` and `)` are tokens of their
  own, so `( git commit -m x )` is denied; heredoc bodies were dropped until PRE-03 round 8
  made a heredoc a blanket deny, C:guard step 2); the spike only
  confirms them. Before the tokenizer slice (G2, G3); the spike fixtures
  become Seam 3 cases (`runHook`). To revisit, not a spike: vendoring unbash (ISC), a Bash-only tokenizer, which would
  need a Q1 amendment; reconsidered only if the spike shows the hand-written tokenizer is
  fragile. Run 2026-09-29; findings settled in Q3.
- **Hook `if` on compound commands, the heartbeat under the sandbox, exec-form hooks** (Q3,
  Q13, Q23): one spike settling whether an `if` condition matches when any subcommand of a
  compound command matches (with the script-call forms for the heartbeat), whether a
  sandboxed command reaches the heartbeat file on macOS and Linux, and the minimum Claude
  Code version that supports exec-form hooks in a plugin. If a sandboxed command cannot reach
  the heartbeat file, the spike picks another location. Before the guard slice.
- **Guard cold-start time** (Q13, story 22; introduced by this spec): measure the exec-form
  hook's cold start on all three OSes and set the target before the guard slice claims it.
- **Git and tool checks**, each on git 2.34 and the current release where git is involved,
  each before the first slice that uses it, as the decisions
  ([Open verification items](../decisions/open-verification-items.md)) gate them: the
  [First slice](#first-slice) builds the temporary index and prints a reply within the
  stdout budget, so it waits on those two checks; the filtered-files check gates the slice
  that stages a filtered or LFS file, and the allow-rules check the slice in which the
  worker runs the script:
  - the temporary index (Q11): intent-to-add paths shown as `A`, a plain `mv` and a `git mv`
    paired as `R`, and the `--diff-filter=A` listing on an unborn HEAD;
  - filtered files and LFS (Q11): a pointer diff, the object stored on `git add`, the staged
    diff matching the planned hash;
  - the README allow rules and the worker shell (Q16, Q24): the `PowerShell(…)` rule, macOS
    and Linux, and a Windows setup without Git Bash (story 41). If the worker cannot run the
    script without Git Bash, Git Bash becomes a documented requirement;
  - tool output limits (Q9, Q19): the Bash and PowerShell output cut-off and the `Read`
    tool's line cap and page size, which set the stdout budget and the hunk-index paging.
- **Project directory and `CLAUDE_PROJECT_DIR`** (Q5): which directory the harness reads the
  project settings from when Claude runs in a subfolder, and whether the variable reaches the
  main thread's shell tools. Before the attribution slice.
- **Handback answers by hand** (Q16, Q18, Q25): a manual hand-test at the end of the
  worker-protocol slice, run in the delivery shape current at the time, and in both if both
  can still be reached; the cases are the full list in the decisions
  ([Open verification items](../decisions/open-verification-items.md), "Handback answers by
  hand"), plus the forged `run` strings of the caller trust fixtures. If callers do not follow `callerRule`, the description's
  clause is strengthened; moving the protocol into skill text is deferred past 0.1.0 (Out of
  Scope). It runs from a marketplace install (a local marketplace is fine), since the
  caller's rule rejects a script path outside the plugin cache (Q25 as amended); the resolved
  Q24/Q25 spikes ran under `--plugin-dir` but do not depend on that path check, so they still
  hold. Before the reply slice is released.
- **Tool-call termination** (Q9, story 217; introduced by this spec): measure how Claude Code
  ends a Bash or PowerShell tool call on Esc and on a tool timeout on Linux, macOS and
  Windows (process-group `SIGTERM`, `SIGKILL`, a tree kill), and whether the `detached` git or
  hook child survives. If the script gets no catchable signal, the signal handler and story
  217 are revised. Before the commit slice claims story 217.

## Prerequisite of the first slice

- Commit `.claude/commit.json` with `scanIgnore: tests/fixtures/**` before any commit that
  adds fixtures, since `scanIgnore` is read at HEAD (Q10). The repo config also sets
  `body: "optional"`, since repo commits carry explanatory prose bodies (Q6).

## First slice

After the prerequisite: `plan` → `check` → `commit` for one group in `split`, whole-file
units of modified tracked files only (no hunks, and no new file, which would need
confirmation, story 88), with the lock, the run folder and the reply, the script called
directly (not through the worker), on a repo without hooks, signing or filtered files.
The message is committed as planned, without trailers, and the reply carries no guard
notice. Every later slice widens this path: confirmation (`computeConfirm`,
`awaitingConfirm`, `--confirmed`), attribution trailers, the scan wiring, the guard notice,
filtered and LFS files, the worker, hunks.

A walking skeleton comes before it: the thinnest `plan` on a clean repo, through the M1
envelope and M18, printing a reply. M2, M3, M10, M12-M16 are tested only through the entry
point (Seam 1), so each of their first slices builds on the skeleton, and the First slice
joins them (the roadmap calls it INT-02, "First end-to-end commit"). The slice order is in the [roadmap](../roadmap/README.md).

## Other notes

- Scope of 0.1.0: `infer`, `/commit-config` and reword via amend ship in 0.1.0; what is
  deferred is listed in [Out of Scope](out-of-scope.md).
- Public surface: the list in [Public surface](../decisions/public-surface.md) is authoritative for what
  needs a major version to change.
- Versioning: start at 0.1.0; 1.0.0 waits on the dogfood gate and the Haiku eval; public
  surface changes need a major version.
- Dogfooding: remove any personal commit skill before the spike and the 1.0.0 dogfood.
- Risks: probabilistic triggering and a high deny share; a high confirmation share in TDD
  work; the subagent handback framing weakening `callerRule`; the working-tree run folder
  (`git clean`, watchers, Docker, sync; a home-based run folder is deferred past 0.1.0);
  stale remote refs for `pushed`; unscanned LFS content.
