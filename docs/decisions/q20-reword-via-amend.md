# Q20 Reword via amend

- **Context.** "Fix the last commit message" needs `git commit --amend -m`, which the guard
  denies (Q4), and bare `--amend` opens an editor.
- **Decision.** The worker has an amend path, used only when the user explicitly asks to reword
  the last commit.
  - The script runs `git commit --amend --only -F -`: with `--amend` and no paths, `--only`
    changes the message only; staged changes stay staged and are not included (verified
    2026-09-26).
  - Flow, all inside the worker (input `reword: true`, or `reword: <dictated text>`):
    `plan --reword` (takes the lock and records HEAD, Q9) → the worker writes the message
    from HEAD's diff and old message (`reword` mode), or, after
    `plan --reword --dictated` (no hunk index, Q9), writes the dictated text as a
    one-group worker plan with `"source": "user"` → `check`, which commits at
    once. No confirmation on the first spawn (Q16); a respawn after a `lintFailed`
    answer is `resumed` and confirms like any other.
  - Dictated text that fails lint (a missing type: "Fixed the parser") is not fixed by
    the worker: the first lint failure of `"source": "user"` text returns the
    `lintFailed` handback (Q18), where the user types the corrected text under Other or
    picks `retry`. Either way the resumed run shows the result before the amend.
  - No content changes, so no content scan, no reset, no staging and no staged-diff check
    (Q18). Lint and the message scan (Q10) apply. A failure leaves the index as it is.
  - `commit` refuses with `head-moved` when HEAD is no longer the commit `plan --reword`
    checked, so the amend never rewrites a commit that skipped the pushed check (Q18).
  - Trailers of the **old** message, read with the script's footer parser (Q13):
    - allowed tokens (`BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes`, `Fixes`) are not
      carried over; the new message owns them. The worker sees the old message, and text the
      user gives is taken as meant.
    - any `Co-Authored-By: … <noreply@anthropic.com>` (whatever the model name) is dropped;
      the current attribution replaces it, so it is never doubled.
    - every other trailer (`Signed-off-by`, a human `Co-Authored-By`, Gerrit's `Change-Id`) is
      carried over verbatim, in its original order.

    Footer order in the result: the new message's footers, then the carried trailers, then
    the attribution.
  - The attribution follows who wrote the text: it is appended when the worker wrote the
    new message, or when the old message had an attribution trailer. Text the user dictates
    (`"source": "user"`) on a commit without one gets no Claude trailer, so a hand-written
    commit is not claimed as co-authored. `source` is set by the worker from its input;
    like the rest of the plugin it steers and does not enforce (Q3). After an `edit` or a
    `retry` it stays `user` only when the worker writes the user's words unchanged. In
    `split` and `staged` the worker always writes the message, so the attribution always
    applies.
  - Refused (by `plan --reword`, before the run folder exists) when HEAD is reachable from
    any remote-tracking ref (`git for-each-ref --contains HEAD refs/remotes`), on an unborn
    HEAD, or when HEAD is a merge commit (`state`: "HEAD is a merge commit; reword it by
    hand"). A root commit is allowed; its diff is against the empty tree.
  - The message: text the user gives is passed through `check` as is, and never rewritten
    by the worker unless the user answers `retry`; otherwise ("make it better", "wrong
    type") the worker writes it in `reword` mode.
- **Amended.** By spec pass 6 (2026-09-27): confirms and records that phase (a)'s
  `index-changed` check from Q18 does not apply to `reword` (extends "Refusing when the
  index is not empty: `--only` makes it unnecessary" below, and "No content changes, so no
  content scan, no reset, no staging and no staged-diff check (Q18)" above): staging a file
  during a reword must not end the run with `diff-changed`. Cross-references Q18's matching
  pass-6 amendment.
- **Rejected.**
  - Leaving rewording to the user (`!git commit --amend`): a common request would always need
    manual work.
  - Refusing when the index is not empty: `--only` makes it unnecessary.
  - Checking only the branch's upstream: misses commits pushed to another remote or branch.
  - Refusing to reword a commit with foreign trailers: a Gerrit repo, where every commit has
    a `Change-Id`, could never reword.
  - A separate `commit --amend` entry point without `--plan` for user-supplied text: a second
    input path to lint and lock.
  - Rewording a merge commit with its first-parent or combined diff: its message is usually
    git's own "Merge branch …", outside Conventional Commits, and either diff misdescribes
    what the merge did.
  - Appending the attribution to every reword: claims the user's own words, on a commit a
    human wrote, as co-authored. Never appending it in a reword: the worker's rewrite of a
    commit would go unattributed.
- **Consequences.** The allowlist stays free of any message-writing form. Accepted gap: stale
  remote-tracking refs (pushed from another clone, not fetched) pass the check; the README
  notes it.
