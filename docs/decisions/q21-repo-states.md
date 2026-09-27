# Q21 Repo states

- **Context.** Not every repo is on a branch with a HEAD and nothing in progress. `git diff
  HEAD` and `git show HEAD:` fail on an unborn HEAD, and during a merge the first group would
  become the merge commit.
- **Decision.** `plan` reports `state` and acts on it:

  | State | Behaviour |
  | --- | --- |
  | unborn HEAD | handled: diff against the empty tree, no `scanIgnore` (no HEAD config), reword refused, pushed check skipped |
  | merge, cherry-pick or revert in progress | refused: "finish it with `git commit --no-edit`, or abort it" |
  | rebase in progress (including `edit` / `reword` stops) | refused: "continue the rebase by hand" |
  | bisect in progress | refused |
  | paused sequence (a multi-commit cherry-pick or revert stopped between picks) | refused, like an in-progress operation: "continue or abort it by hand" |
  | pending `merge --squash` (`SQUASH_MSG` present) | refused: "a squashed merge is staged: commit it by hand, or drop it with `git reset --merge`" |
  | unmerged index entries without an in-progress marker (such as a conflicted `stash pop`) | refused with `unmerged`: "resolve the conflicts first" |
  | `i18n.commitEncoding` set to anything but UTF-8 | refused |
  | detached HEAD | handled, with a warning |
  | not a repository, bare repository | refused |

  Every refusal here is the CLI kind `state` (exit 6, Q9). Detection: `git rev-parse
  --git-path` for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`,
  `rebase-apply`, `BISECT_LOG`, `sequencer/` and `SQUASH_MSG`; unmerged entries from any `u`
  line of the same porcelain v2 status that reads HEAD (pinned `--untracked-files=no
  --ignore-submodules=all`), so conflict markers are never committed. A paused sequence counts as in progress
  even when no `CHERRY_PICK_HEAD` or `REVERT_HEAD` is left (the stop after a conflicted pick
  was committed by hand): a new commit would land in the middle of the sequence. The
  encoding check reads `i18n.commitEncoding`, compared case-insensitively with `utf-8` and
  `utf8`: the script writes UTF-8 messages only, so a repo that declares another encoding
  would get commits labelled with the wrong one.
- **Amended.** By spec pass 2 (2026-09-27): a paused sequence with no `CHERRY_PICK_HEAD` or
  `REVERT_HEAD` left still counts as in progress; a non-UTF-8 `i18n.commitEncoding` refuses;
  and "not a repository" and "bare repository" are both refused with the CLI kind `state`.
- **Amended.** By spec pass 3 (2026-09-27): a `SQUASH_MSG` row with its
  own refusal text; unmerged index entries without an in-progress marker refused with
  `unmerged`; `i18n.commitEncoding` compared case-insensitively, so `UTF-8`, `utf-8` and
  `utf8` all pass.
- **Rejected.** Letting the worker make the in-progress commit: its message, parents and
  conflict state belong to the operation, not to a Conventional Commits plan.
- **Consequences.** Finishing a merge goes through the guard's `--no-edit` form (Q4), which is
  what that allowance exists for.
