# Modules and how

| Module | Seam 1 | Seam 2 | Seam 3 |
| --- | --- | --- | --- |
| M1 | every usage combination, exit codes 0-6, new kinds | — | — |
| M2, M3 | through every subcommand; unborn, detached, in-progress incl. `sequencer/`, root-commit reword, encoding; `GIT_CONFIG_SYSTEM` exported with `commit.gpgsign=true` seen by the signing probe; a PATH git shim reporting a version below 2.34 → `env` (story 202); decoy `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_ATTR_SOURCE` exported → `plan` and the scan read the real repo; a pre-commit hook records its env → a user variable `git commit` does not strip (`GIT_AUTHOR_NAME`, a custom `GIT_FOO`) is present and `GIT_LITERAL_PATHSPECS` is absent; on POSIX, `SIGTERM` to a `commit` call during a slow pre-commit hook → no commit lands afterwards and `call.lock` is gone | — | — |
| M4, M5 | layers, warnings, `scanIgnore` at HEAD (an invalid value there → `[]` plus a warning, the same value in the worktree → `config`), `CLAUDE_CONFIG_DIR`, `managed-settings.json` (CI only), empty attribution, a `scanIgnore` pattern with no literal character → `config` | — | — |
| M6, M7, M8, M9 | lint through `check`; `scanIgnore` in a repo; hits, `staged-hit`, backstop; M9 `applyCaps` through the table-driven fixture generator; a `scanIgnore` pattern whose case differs from a matching path, checked on the case-insensitive macOS runner (Q15) | — | tables above (M9 without `applyCaps`) |
| M10 | the Q11 Consequences list (below) | — | — |
| M11 | SSH signing: a key in the agent, a key file without passphrase (OpenSSH and PEM headers) → allowed, a key with passphrase not in the agent → `signing-locked`; openpgp enabled → the prompt note; x509 or custom `gpg.program` → unknown; custom `gpg.ssh.program` → the prompt note; probe timeout → unknown; every row of the SSH readiness table (C:plan): a literal `key::` key in and not in the agent, `gpg.ssh.defaultKeyCommand` → unknown, a private-key path read through its `.pub`, a `~/` path; no `ssh-add` next to git's `ssh-keygen`: a passphrase-protected or literal key → unknown, an unencrypted key file → allowed; a `.pub` without its private file → unknown | — | — |
| M12 | fresh, stale (mtime), unparseable lock (no handback, text names the automatic takeover time), takeover and its notice, release no-op, a matching `release` while a `call.lock` is live → `busy`, sweep, folder contents, a state `version` mismatch → `ended`; a live lock refused by `plan`'s `peek` before inventory, and taken over by `--take-over` without the `peek`; a `call.lock` with a dead pid on this host stale at once, one from another host or with a live pid only after 15 minutes; on Windows a held file → `busy`; two linked worktrees of one repo each get their own run folder, lock and index (story 221) | — | — |
| M13, M14, M17 | hunk output, placement and shape errors, replies of every subcommand, respawn flags (both respawns of C:reply-and-handback: a live lock plus `plan --staged`, and `plan --take-over <planId>` on a mixed index answered `staged`, whose respawn holds `mode: staged` and no `takeOver`, and whose respawned `plan --staged` plans without a lock refusal), size fixtures at every cap; a reply naming a path that holds a newline, an ESC and a C1 character, each written as `\xNN` and the path given no manual line (the newline and ESC cases POSIX only: Windows forbids U+0001-U+001F in names); a unit left out on a hit whose path is bare (two manual lines, path unquoted), holds a space (two lines, path in single quotes), holds `'` or holds `’` (no line, only "commit by hand"); a `lintFailed` text for a message whose `generic-secret` span contains a `github-token` span → one `[generic-secret]` over the union, no token character left; `plan --hunks` stdout with no `scanIgnore` key in `config`; a failing hook printing over 2000 characters with ANSI colour → `text` holds the "[… N characters cut]" marker and the last 2000 characters with ESC as `\x1B`, `gitOutput` the full output | — | — |
| M15 | through `plan`, `check`, `commit`: `computeConfirm` through the table-driven fixture generator; mode, refusal order, lint counter, run end, the budget step (stepping clock) | — | — |
| M16 | groups, failures, hooks, refusal order, time budget; staging made by hand between `plan` and `commit`, and between groups → `index-changed` (`diff-changed`) with earlier groups kept; a file staged by hand during a `reword` → the reword commits (no `index-changed`) and the staging stays; a failed `git add -N` while rebuilding the temporary index → `git-failed` | — | — |
| M18, M19 | every step table; `infer` and `configJson` per layer | — | — |
| S1, S2 | `env.guard` from a written heartbeat; an install path with `$`, a backtick, `"`, `\` or a typographic double quote (U+201C-U+201E) → `env` (`"` and `\` POSIX only), a native Windows path → no refusal | heartbeat file; round trip | round trip via G1; S2 `build` (declared: README allow rules and worker prompt command form) |
| G1-G3 | — | early exit, fail-open (unreadable input under `COMMIT_GUARD_DEBUG=1`: no stdout, exit 0, one stderr line), deny texts, worker-only rule | `runHook` fixtures, including the stderr line with `agent_id` under `COMMIT_GUARD_DEBUG=1` and none without it, escaped newlines, case variants of the `git` basename and of the subcommand (`git COMMIT`), a quoted Windows path in Bash (`"C:\Program Files\Git\cmd\git.exe" commit`) recognised by its backslash-separated basename, a `commit` split by quotes or backticks (`git co''mmit`), a subcommand in a variable (`git $c`, PowerShell `git @a`), brace expansion (`git {commit,-m,x}`), a parenthesised subcommand (`git (…)`), a subshell (`(git commit -m x)`), a globbed one in a command that mentions `commit` elsewhere, typographic quotes (`git “commit”`, PowerShell `git co‘’mmit`), `git commit --squash=HEAD --no-edit`, the dashed `git-commit` binary, all denied; `git $(echo com)mit` and `git com\⏎mit` (an escaped newline inside the word) give no output (the documented gaps), and so do `(git commit --no-edit)` and a Bash heredoc (`cat <<'EOF' > f`, then a body line `git commit -m x`, then `EOF`); G2 `segments` (declared: golden fixtures against bash and the PowerShell parser API) |

Case lists:

- **Q11 Consequences** ([Q11](../decisions/q11-atomic-commits-by-functionality.md)) is the authoritative list for M10, including plain
  `mv`, `git mv` on an unborn HEAD, a new file in a later group, `diff-changed` on group 1
  with `unstaged: null`, a staged 60-file directory under `--staged`, dirt without a pointer
  change, `apply.whitespace=error`, a `sed` clean filter, `diff.relative`,
  `diff.interHunkContext`. Also: a force-added ignored file in `split`, committed in its
  group; CRLF content with `core.autocrlf=true`; a
  `.gitattributes` `eol=crlf` file; a Latin-1 file and a file with CRLF content under
  `core.autocrlf=false`, each split into two groups and committed byte for byte (the
  committed blobs equal the working-tree bytes); paths with quotes, tabs and newlines,
  staged through a built patch (headers as git quotes them);
  `stage-failed` after the reset (`core.safecrlf=true`, a required filter that is missing)
  with the index unstaged and the run released; a leftover `index.lock` whose mtime lies
  between the two markers, removed after a real `git commit` timeout (the clock stepped to 535 s
  elapsed at start, so the timeout comes after about 5 s; the stepping clock does not move
  file mtimes), built on the `reword` path (`--amend --only` is a partial commit and
  holds `index.lock` across its hooks; a plain `git commit`, as in `split` and `staged`,
  releases it before the hooks run), with a sleeping hook that first records that
  `index.lock` exists, and the test asserting that record, so the lock existed when the tree
  was killed; and a lock another process created after the kill kept (story 215); a plain
  `git commit` timeout on the `split` path, with the same 535 s step at start and a sleeping hook that creates `index.lock`
  (standing in for another process) before it sleeps: after the kill the lock is still
  there and the output's notices carry the "index.lock was left in place" line (story 215);
  on Windows, a rename group of a few thousand
  paths that would exceed the command-line limit on argv; a non-UTF-8 path reported in
  `notIncluded` with its bytes written as `\xNN`; an attribute-binary text file as one
  `kind: "text"` whole-file unit; an attribute-hidden file over 1 MB skipped for size,
  asserted by its `scan.skipped` entry with the size reason; a file over
  `core.bigFileThreshold` (lowered in the fixture) with no
  hiding attribute kept binary;
  unmerged entries left by a conflicting `stash pop` (no in-progress marker)
  refused with `unmerged`; an in-progress squash (`SQUASH_MSG`) refused; `i18n.commitEncoding`
  set to `utf8` and `UTF-8` (accepted) and to another encoding (refused); a lock held by
  another run refused by `plan` before inventory (`peek`); a changed index fingerprint with
  HEAD unchanged at step 7 (`diff-changed`); a cone-mode sparse checkout with an edit
  inside the cone, a path outside the cone, and a path marked `--skip-worktree` whose
  working-tree file is removed (story 78): neither path is a unit or in `notIncluded`, and
  the commit keeps both with their HEAD content, so neither is committed as a deletion.
- Run integrity: a traversal or absolute `planId`, alone and with a forged lock and
  `--take-over` (usage, nothing outside `<toplevel>/.commit-plan/` touched); a symlinked and a tracked
  `.commit-plan` (refused); a forged `continue` of `commit --plan <id> --all` without
  `--confirmed` while a confirmation is pending (`unconfirmed`); a second call on the same
  `planId` while the first holds `call.lock` (`busy`); a call killed mid-staging, whose
  takeover reports the unstaged paths; a call killed before the reset inside phase (c)
  completed, then taken over → the index is reset and inventory sees a clean index; a call
  killed in phase (c), the user stages another file, then a takeover with
  `--take-over --staged` → no reset, `modeChoice` asked naming the killed group's paths
  (whatever the flags), whose `staged` answer respawns without `takeOver` and plans the
  index as staged; the same with an automatic takeover under `--split --no-user` →
  exit 6 `state` `killed-leftover` naming those paths, index untouched, lock and folder
  gone, and under `--reword` → the run goes on with a notice naming them; the old run's
  folder still in place when the repair runs, and a takeover killed during the repair,
  then taken over → the repair reads the first run's facts through the renamed lock file;
  group 1 committed, a call killed in phase (a) of group 2, then
  taken over → no reset and no reset notice, the `unstaged` notice still given; an automatic stale takeover on a clean tree → "nothing to commit" carrying the takeover notice with the stale run's `planId`, and a takeover whose index repair resets the killed group's staging and leaves a mixed index → `modeChoice` carrying the takeover, reset and `unstaged` notices; `plan --reword` on a clean tree → exit 0 and the lock taken; a
  signing failure reached only after the clean-tree and `staged-hit` checks.
- Scanner: positive fixtures for a private key flattened onto one line, as a GCP JSON key and
  as an escaped `.env` value; a line far over the 4096-character cut, scanned in linear time, with a secret
  before the cut found and one past it missed; a secret
  added in a file marked `-diff` or `binary` in `.gitattributes` (found by the content scan);
  `generic-secret` as a JSON key, an unquoted `.env` value and a YAML value; an encrypted PEM
  with `Proc-Type` and `DEK-Info` header lines (a hit: the body after the header lines
  counts); an encrypted PEM header with no body (not a hit); a new symlink whose target holds
  a home-directory path (blocked: the target is scanned as an added line).
- Guard: `git commit -m "unterminated` in both shells (deny), an unterminated here-string,
  bypass cases from prior art, the closed bypasses of story 15.
- Replies: a lock with a null holder (no handback); an injected `run` fixture for the caller
  hand-test.

**Other checks.** Dogfooding (Q10, Q15): this repo commits through its own plugin, so bugs
surface here first. Manual check (M12): a lock put-back that meets `EEXIST` (`held` naming
the new holder, private copy kept for the sweep, the moved run `taken-over`); the race
cannot be produced deterministically from outside the process, so no Seam 1 fixture claims
it. The `ENOTSUP`/`ENOSYS` → `run-folder` case (a filesystem without hard links, story 220)
is likewise a manual check only, run by hand against such a filesystem when available; no
fixture or CI runner exercises it. CI size tests hold the budgets (Q24, story 228): the worker, `/commit` and
`/commit-config` descriptions ≤ 200 characters each, skill texts and worker prompt as files; a static check that `package.json` lists no dependencies
(story 203) and that the worker frontmatter matches its stated values (story 42:
`maxTurns: 25`, tools, `omitClaudeMd`); on
the Seam 1 size fixtures, `plan`'s own fields ≤ 1 kB (excluding `hunks` and `reply`), reply
≤ 2 kB without `text`, `text` ≤ 4 kB at the 11-entry cap fixtures (quoted messages not
counted), `plan --hunks` stdout ≤ 20 000 characters (the hunk index spills to `hunks.json`
past that budget).
Privacy-guard test (Q15: no local paths or usernames in docs, README, manifests or test
sources): `local-path` over all four, matching a home-directory path with any user name on
every OS, not just the runner's; every other scan pattern over test sources; the CI runner's
user name only as a path segment (`/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` and
any other path, as in story 138 but without its service-user and length exemptions), never
as a bare word, since `runner` and `root` are ordinary words in the docs. A bare name
outside a path is not caught (accepted). A self-test runs the segment check over the
repo's tracked files (`git ls-files`, so untracked review reports are skipped) with the
user name set to `runner` and to `root`, so a doc that quotes a
runner path fails locally, not only on the runner.
Hook registration check: the packaged hook file registers exactly one `PreToolUse` hook on
`Bash|PowerShell` in exec form, with `node` as the command and the guard entry point as the
only argument. Fixtures: one positive and one negative
per pattern, one per glob row and error; the repo config ignores the fixtures directory.
Platform oracles in CI only: PowerShell fixtures cross-checked with the PowerShell parser
API; the supported glob subset cross-checked with git `:(glob)` pathspecs (rows where
C:scanignore-globs deliberately differs excluded).

CI: ubuntu, windows, macos × Node 22 (oldest and latest) and 24 (on windows the oldest leg
is 22.1.0, not 22.0.0: Node 22.0.0's bundled npm cannot resolve npm-cli.js there,
nodejs/node#52682, fixed in 22.1.0), plus a git 2.34 job in an
`ubuntu:22.04` container with the distribution's git, whose first step asserts
`git --version` is 2.34.x (the hosted `ubuntu-22.04` image ships a newer git). The guard
supports both Windows PowerShell 5.1 and PowerShell 7+: the windows runner ships both, and
the guard's PowerShell tests and the parser oracle run under each (`powershell.exe` and
`pwsh`) (Q3, Q15).
