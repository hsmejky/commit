# Q4 Hook allowlist, no env switch

- **Context.** Some legitimate commits are outside the plugin's scope: finishing a merge, a
  fixup the user asked for. A non-interactive agent hangs on any form that opens an editor.
- **Decision.** A strict allowlist; every other form of `git commit` is denied. The deny
  message names the offending flag for a form with its own row in C:guard (`--amend`,
  `--squash`, `-n` / `--no-verify` / `--no-gpg-sign`, `--fixup=amend:` / `--fixup=reword:`,
  `-c` / `--config-env` before `commit`, and any flag caught by the generic row); the bare
  form and `-m`, `-F`, `--message`, `--file` share one generic "Direct git commit is
  blocked" message instead, and an unknown global option or a subcommand-injection attempt
  gets its own message that names no flag (C:guard has the precedence when a command matches
  more than one row). Short flags are expanded before matching (`-am` → `-a -m`, `-mfoo` →
  `-m foo`) and `--opt=value` is split.

  | Form | Extra flags allowed |
  | --- | --- |
  | `--no-edit` | `--amend`, `-q` / `--quiet` |
  | `--fixup=<commit>` (plain only) | `-q` / `--quiet` |

  Denied therefore: bare `git commit`; anything with `-m`, `-F`, `--message` or `--file`;
  `--amend` without `--no-edit`; `--squash` in any form; `-c <commit>` / `--reedit-message`,
  `-C <commit>` / `--reuse-message`; `--fixup=amend:` and `--fixup=reword:` (both open an editor); `-n` /
  `--no-verify`, `--no-gpg-sign`, `--allow-empty`, `--allow-empty-message`, `-a`, `-t`,
  pathspecs and `--`. Also denied: the git global options `-c <k=v>` and `--config-env`
  before `commit`, whatever the key. `core.hooksPath`, `commit.gpgsign`, `gpg.program` and
  `user.signingkey` each undo a `--no-verify` / `--no-gpg-sign` ban, and a key list would
  always miss one.

  `git revert`, `cherry-pick` and `merge` do not call `git commit` and are not affected. A
  merge with resolved conflicts is finished with `git commit --no-edit` (Q21).
- **Amended.** By spec pass 3 (2026-09-27): `--quiet` is allowed wherever
  `-q` is; it is the same flag spelled long, and denying it cost a turn for nothing.
- **Amended.** By spec pass 6 (2026-09-27): reworded the denial to "`--squash` in any form"
  (not just "without `--no-edit`"); the old wording implied `--squash --no-edit` might be
  allowed, when the allowlist table above (only `--amend` / `-q` / `--quiet` are allowed
  alongside `--no-edit`) already denies it. Matches the contracts and spec wording.
- **Amended.** By spec pass 8 (2026-09-27): names `--reedit-message`, the long form of
  `-c <commit>`, in the denied list (spec story 28 already did); no behaviour change, since
  every form outside the allowlist is denied.
- **Amended.** By spec pass 9 (2026-09-27): the deny message names the offending flag only
  for a form with its own row in C:guard; the bare form and `-m`, `-F`, `--message`,
  `--file` share one generic "Direct git commit is blocked" message instead, and an unknown
  global option or a subcommand-injection attempt gets its own message that names no flag.
- **Rejected.**
  - A global env switch (`COMMIT_GUARD=off`): the agent can set it itself.
  - "`--no-edit` with any other flags": lets `--no-verify` and `--no-gpg-sign` through,
    which the plugin path forbids (Q18).
  - Allowing `-a` with `--no-edit`: widens the unscanned path for no need; a merge finishes
    without it.
  - `-C <commit>` / `--reuse-message`, with or without `--amend`: without `--amend` it makes a
    new commit whose content is unscanned and whose message is unlinted, with no use case
    in this question's context; with `--amend`, `--no-edit` already covers keeping the
    message.
  - Denying only `-c core.hooksPath=…` and `-c commit.gpgsign=…`: see above.
- **Consequences.** The emergency brake is `/plugin disable`. Rewording goes through the
  worker (Q20). The deny message for `--amend` without `--no-edit` leads with the worker and
  never suggests `--amend --no-edit`, which commits the index unscanned (Q3): "To reword the
  last commit: spawn the commit:commit-worker agent (…). Ask it to reword. To add
  changes, make a new commit the same way." Folding content into an existing commit has no
  plugin path (see [Non-goals](non-goals.md)).
