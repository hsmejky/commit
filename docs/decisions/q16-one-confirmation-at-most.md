# Q16 One confirmation at most

- **Context.** Asking on every commit is noise; never asking lets bad splits and stray files
  through.
- **Decision.**
  - Untracked files fall into two categories ([contracts](../contracts/untracked-files.md),
    tests there):
    `hidden` (never shown to the worker) and `candidate` (shown, with a `binary` flag).
    Gitignored files are never seen. The collapse rule targets junk directories (`dist/`,
    `coverage/`), which are **new**: no path under them exists at HEAD. So it counts per
    topmost new directory: one that holds no HEAD path, under a parent that does
    (`git ls-tree -r -d --name-only HEAD` gives the tracked directories; every directory is
    new on an unborn HEAD). More than 50 candidates (plus staged-new paths, Q11) in one such
    directory collapse it into a summary: the worker cannot include it, and `check` lists
    it in `not included` ("N untracked files in dist/ — add to .gitignore or commit by
    hand"). New files directly in a tracked directory ("loose" files: 51 migrations in an
    existing `db/migrations/`, icons in `assets/icons/`) are never collapsed per directory.
    Files at the repo root are the exception and count as one directory, `"."` ("N
    untracked files at repo root"): 50 new root files are almost always junk. More than 200
    in total → the largest new directories collapse until the total is at most 200; if
    loose files alone still exceed it, they collapse per parent directory, largest first.
    Example: in a layout where all code sits under `packages/`, scaffolding
    `packages/new-lib/` (60 files) collapses only `packages/new-lib/`; the one new file of
    an unrelated feature in `packages/app/src/` stays a candidate.
  - The tree is `clean` when nothing plannable is left: no tracked change and no candidate.
    Hidden-only or collapsed-only untracked files are clean (`planId: null`, no lock); `plan`
    still reports their counts. The same holds for staged-new paths the hidden or collapse
    rule excludes (Q11): with nothing else, the tree is clean, the index is left as it is,
    and `plan` names them ("`.env.local` is staged but hidden — commit by hand"). A
    submodule with dirt but no pointer change is clean too, and reported (Q11).
  - The worker places every unit exactly once: into a group, or into `not included` with a
    reason (a whole path, or single hunks in the hunk-level slice). `check` rejects an
    unplaced unit as a lint error ("h7 (src/c.js) not placed; put it in a group or in
    notIncluded"), and the retry fixes it, so no change is left out without a stated reason.
  - **The intent scopes a `split` run.** With an `intent`, a unit the intent clearly does
    not cover goes to `not included` with the reason "not part of the intent"; a unit that
    plausibly belongs to the change (its test, its docs, a lockfile it updated) stays
    planned. Without an `intent` (`/commit` with no text, Q2) everything is planned. A
    caller whose user asks to commit everything says so in the intent, or omits it. The
    rule is the same with and without a user: the left-out units show up in the report's
    "Not included" and in the tree state ("N files left: …"), are left in the working tree
    untouched (a pre-staged one is unstaged by `split`'s reset and listed in `unstaged`,
    Q11), and the next `/commit` plans them. They are not a trigger. `staged` commits the
    set the user picked and `reword` has one commit, so neither is scoped. This matches the
    baseline Q24 measured (`git add <its files> && git commit` commits only the agent's own
    change) and keeps an unrelated, possibly half-finished edit, or a parallel
    implementer's files in a shared working tree (Q22), out of an agent's commit.
  - Zero groups is a valid `split` outcome (everything is a hit, or
    deliberately left out): `check` returns `groups: []` and releases the lock itself, and
    the reply reports "nothing committed" with the reasons.
  - `check` computes `confirm` from the triggers below. Otherwise the commit goes through
    without a prompt.
  - The user sees one block, built by the script from `check`'s output and carried in the
    `confirm` handback (Q25): per group the header, body and files (with a hunk count per
    file in the hunk-level slice; at most 20 files per group, then "+N more"), then `not
    included` with reasons, then the scan notices. The worker has returned by then; the
    caller asks with `AskUserQuestion` and acts on the answer. The options are `yes`,
    `one` and `no`, with `one` only in a `split` run with more than one group (anywhere
    else it would respawn a worker to reach the same plan; `yes` and `no` still meet
    `AskUserQuestion`'s minimum of two); `edit` has no option of its own, since
    `AskUserQuestion` has no text
    field on an option: the question says "To change it, type your changes under Other",
    and text typed under Other is the `edit` answer (Q25):
    - `yes`: the caller runs the handback's `commit --plan <planId> --all` verbatim; for
      Q10 items, with the meaning given in Q10. No worker is spawned.
    - `edit <free text>` (e.g. "merge 2 and 3", "subject of 1: …"): the caller respawns the
      worker with `resume: <planId>` and the text; it reads the previous plan from
      `plan.groups.json`, and `hunks.txt` only when the grouping changes, runs `check`
      again, and a new block comes back. Repeatable.
    - `one`: the same respawn with `edit: one` ("single group, all included files"); the
      worker writes the header; the new block is confirmed once more.

    Both rest on a deterministic rule, not on the triggers: the respawned worker's separate
    `plan --hunks` call marks the run `resumed` in the state file, and `check` in an
    interactive `resumed` run always sets `confirm` (reason `edited plan`), in every mode.
    Without it, "merge 1 and 2" on a run with no new file gives one group and no trigger,
    and `check` would commit a header the user, who was in the middle of
    reviewing, never saw. `resumed` is never set without a user: a caller without one
    never answers `edit` or `one` (Q17).
    - `no`: the caller runs the handback's `release`; nothing is committed, the index is
      untouched.
  - Triggers per mode ([contracts](../contracts/confirmation-triggers.md)):

    | Mode | `confirm` when |
    | --- | --- |
    | `split` | more than one group; a new file (untracked or status `A`) in any group; an **included** skipped file or `scanIgnore` change (`humanOnly`) |
    | `staged` | the set holds a skipped file or a `scanIgnore` change (`humanOnly`). A new file in the set was staged by the user on purpose; it is listed in the report, not asked about, however many there are (the collapse rule does not apply in `staged`, Q10). A set with a pattern hit, or with a staged-new path the hidden rule excludes, never gets here (`staged-hit`, Q10) |
    | `reword` | never on the first spawn. The user asked for it explicitly; the new header is reported afterwards and can be reworded again |
    | any mode | the run is `resumed` (after `edit`, `one` or a lint `retry`), interactive only |

    A pattern hit is never a trigger: its unit is always left out (Q10) and the report names
    it. A binary new file is not a trigger of its own: "new file" covers it, and `binary`
    only changes the reason text (`new binary file logo.png`).
  - A pre-staged set skips grouping: the worker writes the message only (`staged` mode).
    `staged` is reached only when the user picks it: when the index and other changes are
    both present, the user picks the mode first; an index that holds every change is
    planned as `split` (Q9).
- **Amended.** By spec pass 2 (2026-09-27): `state.json` carries a `version` field, and a
  mismatch on re-read is refused with `ended`.
- **Amended.** By spec pass 3 (2026-09-27):
  - The tamper digest is deferred past 0.1.0: `state.json` keeps only its `version` check,
    and the digest file, its sweep and the digest-mismatch refusal are dropped. An agent
    that rewrites the state under the README `Edit` rule is an accepted gap.
  - The script-call builder escapes nothing; the commit entry point refuses (`env`) an
    install path containing `$`, a backtick, `"` or `\`, replacing the per-shell escaping
    (Q25).
- **Amended.** By spec pass 5 (2026-09-27): the candidates counted for the `modeChoice`
  decision (index plus other changes) are counted after the hidden rule and before the
  caps ([contracts](../contracts/plan.md) step 4), so a file the hidden rule excludes never
  tips the count into a mode choice. The `Edit(**/.commit-plan/**)` allow rule stays global
  (it must work across repos from user settings); known gap: `**/.commit-plan/**` matches at
  any depth, so a project path such as `src/.commit-plan/x.js` is also edited without a
  prompt. `staged` needs a non-empty index: a `plan --staged` that finds the index empty
  (emptied after the user picked `staged`) is refused as `usage` (`staged-empty`, Q9).
- **Rejected.**
  - Always asking; never including untracked files without an explicit request.
  - Separate `config` and `code/doc` categories: they behaved identically.
  - Treating every non-empty index as a set the user staged on purpose: agents stage too
    (`git mv`, `git rm`, `git add`). One `git mv` followed by five edits would give a
    rename-only commit, split from the edits that belong with it.
  - Telling the agent never to stage by hand (probabilistic), or treating an index of only
    renames and deletions as `split` (still misses an agent's `git add`).
  - An index that holds every change, with nothing else, as `staged`: an agent's
    `git add -A` followed by `/commit` would give one commit with no grouping and no
    confirmation, the most common way agents stage. `split` covers exactly the same set;
    the cost is one `one` answer for a user who staged everything meaning one commit.
  - Always `split`, ignoring pre-staging: throws away a user's `git add -p` selection.
  - A silently dropped unit reported as "not placed by the worker" instead of a lint error:
    no reason is given, and a subagent would confirm it by itself.
  - The worker releasing the lock after zero groups: one more call its prompt could miss.
  - A `yes` that respawns the worker to commit: an agent prefix to run one command (Q24).
  - An `edit` that commits at once when the edited plan hits no trigger, with `yes`
    implied: the user asked for a change mid-review, so the changed plan is what they
    have not seen.
  - Setting `resumed` from the worker input (`resume` in the prompt): the script never
    sees the prompt, and a prompt rule would make the second look probabilistic.
  - Collapsing per top-level directory: in a layout with all code under `src/`,
    `packages/` or `apps/`, one scaffolded package or a batch of 51 migrations collapsed
    the whole tree, the unrelated feature file in it included, and a subagent could commit
    nothing. `ls-files --others --directory` (wholly untracked directories): it does not
    see staged-new paths, which the rule must count too (Q11).
  - Planning every change whatever the intent (the design before the tenth review): a TDD
    step spawned with `interactive: false` committed the user's unrelated uncommitted
    edits with it, a regression against the baseline. Out-of-intent units as a separate
    group in interactive runs only: two rules for one judgement, and a group the user
    has to spot and answer `edit` for. Leaving out everything not named in the intent: a
    test or lockfile of the same change would be left behind.
- **Consequences.** The common case (one group, tracked files only) costs zero confirmation
  prompts. Permission prompts are separate: the first spawn makes three calls that need
  permission, `plan` (with `plan --hunks` in the same process, Q9), the worker's `Write` of
  `plan.groups.json` and `check`; a `resume` respawn adds its separate
  `plan --hunks`; the caller's `run` command after a handback is one more. The guard never
  returns `allow` (Q3). Without allow rules each of them asks
  for approval (spike: in a headless run all were denied; in an interactive one the
  background worker's prompts, for `node …commit.js` (stub named `commit.js`; same rule with
  `commit.cjs`, Q15) and for the `Write` of
  `plan.groups.json`, surfaced in the main session and held the worker until answered). The
  README therefore makes two allow rules a
  **required** install step, not a convenience:
  `Bash(node "<home>/.claude/plugins/cache/commit/commit/*/scripts/commit.cjs" *)` with the
  user's own absolute home (plus the matching `PowerShell(…)` rule), and
  `Edit(**/.commit-plan/**)` for the run folder (Q9). With both, a run needed no approval
  at all (spike, Windows, Bash tool: the quoted path, the `*` version segment and the
  `<marketplace>/<plugin>/<version>` cache layout all matched; stub named `commit.js`; same
  rule with `commit.cjs`, Q15). Each script call is a single
  `node … commit.cjs …` command, so one rule per shell covers all of them (Q9). A bare
  `node *commit.cjs*` would match **any** file named `commit.cjs`: an agent that writes
  `./commit.cjs` and runs it would get arbitrary code run without a prompt. The anchored
  path is outside the project, so writing there prompts. The README gives only the
  anchored rule and says why. `Edit(**/.commit-plan/**)` lets an agent write any file in a
  `.commit-plan` folder without a prompt; running one still needs a `Bash` approval, which
  the anchored rule does not give. Accepted. The same rule lets an agent rewrite
  `state.json` (units, messages, `confirm`, `awaitingConfirm`) without a prompt, an
  accepted gap in 0.1.0 (Q3: the plugin steers). The state carries a `version`, and every
  later call that opens the run refuses with `ended` on a `version` written by another
  plugin build. A tamper digest (a SHA-256 of `state.json` stored outside the run folder)
  is deferred past 0.1.0 (see [Non-goals](non-goals.md)).

  The script path in every `run` command is built without escaping: the commit entry point
  refuses (`env`) an install path containing `$`, a backtick, `"`, `\`, or a typographic
  quote (U+201C–U+201E: `“` `”` `„`, which PowerShell reads as a double quote, G2) before
  any work, so no shell can expand or mangle the path, and the one quoted form stays the one
  the anchored allow rules match. The check runs on the forward-slash form the call uses
  (Windows separators converted to `/`), so a native Windows install is not refused.
- **Amended.** By spec pass 7 (2026-09-27): the refused set gains U+201C–U+201E (PowerShell's
  typographic quotes): unrefused, one of them in a Claude home path breaks the quoted `run`
  in PowerShell and stops the S2 `recognise` guard from seeing script calls, silently
  disabling the worker-only rule (G3) and the heartbeat.
