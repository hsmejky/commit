# Q10 Secret and local-path scan

- **Context.** Secrets and local paths must not reach history through the plugin. Exceptions are
  needed (test fixtures), but the agent can write any file it can scan.
- **Decision.**
  - What is scanned: `plan` scans the index diff in `staged` mode, else the working-tree
    diff against HEAD plus the full content of untracked candidates that were not collapsed
    (Q16). `commit` scans the index diff as a backstop. `check` scans every group's
    normalised message with the same patterns: a hit is a lint error ("message contains
    `local-path`"), which the retry or an `edit` fixes, so a token or path quoted from the
    diff, or pasted into a reword, does not reach history either. Only added lines; binary
    files skipped. A tracked file whose added lines exceed 1 MB, or an untracked file over
    1 MB, is not scanned and is reported as skipped (Q19), checked before any content
    decision below. Binary is decided by content only for a file `git check-attr` confirms
    is hidden by an attribute (`diff`, `binary`, or a custom `diff` driver): a NUL byte in
    the first 8000 bytes of the new content (git's own heuristic) means it is genuinely
    binary; otherwise it is a text file the attribute hides, still scanned through a
    `--text` diff (Q11). A file git itself reports as binary without such an attribute
    (real NUL content, or over `core.bigFileThreshold`) stays binary and is not
    reclassified. A file with a `filter` attribute
    (Git LFS, git-crypt, `nbstripout`) is scanned in the cleaned form `git diff` shows,
    which is what enters history: an LFS pointer, ciphertext (usually binary, so skipped),
    a stripped notebook.
  - Patterns and their false-positive rules are fixed in
    [contracts](../contracts/scan-patterns.md). `local-path` also matches the current OS user
    name as a path segment in any path shape, but only a name of 4 or more characters that
    is not a well-known service user (`node`, `ubuntu`, `runner`, `vscode`, …). The same
    service users are placeholders for the fixed `/home/<name>`, `/Users/<name>` and
    `C:\Users\<name>` regexes, so `/home/node/app` in a Dockerfile is not a hit. A hit reports
    the pattern ID and location, never the matched value. The table records a source per
    row (gitleaks' rule file `config/gitleaks.toml`, `secretlint-rule-preset-recommend`,
    GitHub's documented token prefixes), borrowed as data with attribution only from
    sources whose license does not restrict who may use them; every pattern has one
    positive and one negative fixture.
  - Exceptions: `scanIgnore` globs only, read from the repo config **at HEAD**
    (`git show HEAD:.claude/commit.json`), not the working tree. The glob dialect is fixed in
    [contracts](../contracts/scanignore-globs.md) (the matcher is hand-written, zero deps).
    Matching is case-sensitive on every OS. A diff that changes `scanIgnore` is flagged.
    A pattern with no literal character (`**`, `**/?*`, `*/**` and the like) is a `config`
    error (Q9), so one amended line cannot switch the scan off. A broad but literal pattern
    such as `src/**` is accepted: whoever can commit `.claude/commit.json` can widen it, an
    accepted gap.
  - `plan` cuts the diff it scanned into units (Q9), maps every scan item to the unit that
    holds it and stores the map in the state file, so `check` decides per unit. Every
    `plan --hunks` must see the same hash set, so the map cannot drift from the diff the
    worker groups. What each item does:

    | Item | Rule in `check` | `humanOnly` (Q16, Q17) | `commit` backstop |
    | --- | --- | --- | --- |
    | pattern hit | the unit must be in `notIncluded`; in a group it is a lint error ("h4 has scan hit `github-token`; move it to notIncluded") | never: the unit is always left out, and the report names it with two lines, `!git --literal-pathspecs add -- <path>` and then `!git commit -m "<message>"` (no `&&`, which Windows PowerShell 5.1 cannot parse), to commit it by hand (a `!` command has no terminal, so a bare `git commit` could hang on an editor; the guard does not see `!` commands). The path is bare when it holds only `[A-Za-z0-9._/@+-]` and in single quotes otherwise (literal in Bash and PowerShell); a path holding `'`, a PowerShell single quote (U+2018–U+201B) or a control character gets no line, only "commit by hand"; `<message>` stays a placeholder | **blocks** |
    | skipped file | may be included | when the unit is included | does not block |
    | `scanIgnore` change | may be included | when the unit that changes the `scanIgnore` value in `.claude/commit.json` is included (a unit that edits only another key, e.g. `maxSubjectLength`, does not); it takes effect from the next commit. Amended by pass 9 and the CFG-01 decision pass, below: when the value changed, every unit of the file (by path or old path) is flagged | does not block |

    A hit is therefore a notice, not a question: nothing unscanned-and-flagged can be
    committed through the plugin, so a subagent commits the rest and passes the notice to its
    parent: notices are part of the reply's `text`, which every caller relays verbatim
    (Q25). The backstop cannot fire on the plugin path unless the files changed after
    `plan` (the hash checks in `plan --hunks` and `commit` catch that first); it stays as
    defence in depth.

    Pre-staged set with a hit (`plan --staged`): a set is committed as-is and cannot leave
    the unit out, so `plan` refuses with exit 6 `staged-hit` before any lock or grouping:
    "unstage `<file>` and run `/commit` again, or commit by hand". The same refusal covers a
    staged-new path that the **hidden** rule excludes (Q11): "`.env.local` is staged but
    hidden — unstage it or commit by hand". The reason that applies the hidden rule in
    `split` (staging a file does not get it past it; agents stage too) holds for `staged` as
    well, and the user who picked `staged` saw counts only (Q9). The **collapse** rule does
    not apply in `staged`: it keeps junk out of the worker's grouping, the set is not
    grouped, and only a human reaches `staged`. A 60-file `git add packages/new-lib` set is
    scanned like the rest of the index diff and committed; its new files are listed, not
    asked about (Q16).
  - The worker's prompt forbids adding `scanIgnore` entries unless the user asks.
  - A unit with a pattern hit gets no body in `hunks.txt` (`body: "none"`, its `scan` IDs
    in the index): it goes to `notIncluded` whatever it holds, so the secret reaches
    neither the run folder nor the worker's context
    ([contracts](../contracts/plan-hunks.md)).
- **Amended.** By spec pass 1 (2026-09-27): each secret pattern row records its source
  (gitleaks' rule file and generator samples, `secretlint-rule-preset-recommend`, GitHub's
  documented token prefixes, and Nosey Parker's examples as fixture seeds) and carries one
  positive and one negative fixture.
- **Amended.** By spec pass 2 (2026-09-27): in a container without a passwd entry,
  `os.userInfo()` throws; `osUser` falls back to `USER` or `USERNAME`, else `null`, which
  skips the OS-user segment of `local-path` rather than failing the scan. A whole-repo
  `scanIgnore` pattern is a `config` error.
- **Amended.** By spec pass 3 (2026-09-27):
  - A `scanIgnore` pattern with no literal character is a `config` error; this replaces the
    list of whole-repo shapes, which could never be complete.
  - The manual `!git` line uses `--literal-pathspecs` and `--`, and quotes the path so it
    stays literal in Bash and PowerShell; a path holding `'` gets no line. By pass 4, a path
    holding a control character gets no line either, and every path the reply `text`
    renders has C0 and C1 control characters and DEL written as `\xNN`, so a newline or
    ESC in a file name cannot forge a reply line or reach a terminal.
  - Binary is decided by content, so a `-diff` or `binary` attribute cannot hide a text
    file from the scan.
  - Every inherited `GIT_*` variable outside a keep-set is removed from the scan's git
    calls (Q9), so `GIT_INDEX_FILE` or `GIT_ATTR_SOURCE` cannot redirect what is scanned.
  - Accepted gaps recorded (Consequences): UTF-16 text and unprefixed secret formats are
    not scanned; `scanIgnore` is widenable by whoever commits the repo config.
- **Amended.** By spec pass 4 (2026-09-27): removed lines recorded as an
  accepted gap (Consequences).
- **Amended.** By spec pass 5 (2026-09-27): borrowed data and test cases (including the
  fixture license list) are restricted to MIT, ISC, BSD, Apache-2.0 (NOTICE kept) or
  CC-BY-4.0 sources — licenses that do not restrict who may use them; Nosey Parker's examples
  (Apache-2.0) are used as fixture seeds. Betterleaks is explicitly not a 0.1.0 source, and
  its token-efficiency filter is rejected.
- **Amended.** By spec pass 6 (2026-09-27):
  - Settled: symlink targets are scanned as an added line (Q11 already said so). Dropped the
    contradictory "symlink targets are not scanned" claim from both accepted-gap lists above
    (the pass-3 amendment and the Consequences list).
  - The NUL-byte content check only decides binary-vs-text for a file `git check-attr`
    confirms is hidden by an attribute (`diff`, `binary`, or a diff driver); a file git
    itself reports as binary without such an attribute (real NUL content, or over
    `core.bigFileThreshold`, default 512 MiB) stays binary and is not reclassified —
    otherwise the NUL check would force a `--text` diff on a huge binary file only for it to
    be skipped at the 1 MB scan limit anyway, wasting the budget, and the NUL check only
    looked at the new side while git checks both sides. The security property still holds:
    an attribute still cannot hide a text file.
- **Amended.** By spec pass 8 (2026-09-27):
  - Every scanned line (diff line, symlink target, message line) is cut to its first 4096
    characters before the regexes run, so scanning stays linear in the input (no regex
    backtracking over a minified or generated line); a secret past the cut is missed, an
    accepted gap (Consequences). The rule and the length are in C:scan-patterns.
  - The manual lines for a unit left out on a pattern hit are two lines, as the table says.
    A path holding U+2018–U+201B gets no line either, only "commit by hand": PowerShell
    treats those characters as single quotes, so they would end the quoted path.
- **Amended.** By spec pass 9 (2026-09-27):
  - A `scanIgnore` change is found by comparing the parsed `scanIgnore` at HEAD with the one
    parsed from the repo config on the snapshot side, in the config loader, so the pure
    scanner parses no config. A missing file or key is no patterns; the lists are compared
    in order; content that is not valid JSON, or a `scanIgnore` that is not an array of
    strings, counts as changed. When they differ, every unit of `.claude/commit.json` is
    flagged, not only the one that edits `scanIgnore`: a whole-file comparison cannot tell
    which hunk carries the change, and flagging one hunk would let the worker commit the
    other without a human. A unit that edits only another key is therefore flagged when
    the same diff also changes `scanIgnore` elsewhere in the file, an accepted extra
    confirmation; with `scanIgnore` unchanged, no unit is flagged (the table above).
  - The `commit` backstop scans its tree-to-tree diff with the same raw, patch and
    attribute-hidden `--text` passes and the same 1 MB limit as the `plan` diff, from the
    same change-set code, so an attribute cannot hide a text file from the backstop either
    (pass 3).
- **Amended.** By the CFG-01 decision pass (2026-09-29), settling KD-S26 to KD-S29:
  - The `scanIgnore` row of the table: when the parsed value differs, **every** unit of
    `.claude/commit.json` (its path or old path) is flagged, as pass 9 says; the row's
    "the unit that changes the `scanIgnore` value" is superseded. A unit that edits only
    another key is flagged only when the same diff changes `scanIgnore`; with the value
    unchanged, no unit is flagged.
  - The `commit` backstop exempts paths with the `scanIgnore` patterns `plan` stored in the
    run state (recompiled through the glob matcher on each call), not a fresh read of HEAD
    (Q9 as amended). After an earlier group commits a `scanIgnore` change, HEAD holds the
    new patterns, but the run was scanned, grouped and confirmed under the old ones; "takes
    effect from the next commit" means the next run.
  - The change test reads the repo config on the snapshot side at the fixed repo-config
    path, which the config loader exports (`REPO_CONFIG_PATH`), never at a unit's new path:
    a rename away from `.claude/commit.json` leaves no file there (no patterns), which
    differs from HEAD's patterns when HEAD had any.
  - `plan` outputs the test's result as `scan.scanIgnoreChanged`; it is an output field,
    not run state.
  - A `scanIgnore` that is invalid at HEAD (the file is not valid JSON, the value is not an
    array of strings, or a pattern is a glob error, including one with no literal
    character) is no longer a `config` refusal: the loader uses `[]` (no exemptions, so
    the scan fails closed) and adds a warning (stderr and `plan.warnings`). The worktree
    layer is validated as before, so a copy that is still invalid there is refused with
    `config`. The change test compares HEAD's `[]` with the fixed version: a fix that
    carries patterns counts as a change, so its units are flagged and including them makes
    the confirmation `humanOnly`. Before, the `config` refusal made the fix itself
    uncommittable through the plugin.
- **Rejected.**
  - Using gitleaks when installed (breaks zero-deps and behaves differently per machine).
  - A CLI override flag: an agent would add it to itself on refusal. The same holds for any
    flag, env variable or file the agent can reach; the only human-only channel is a manual
    commit.
  - Reading `scanIgnore` from the working tree: as agent-writable as a flag.
  - An inline `commit-scan: allow` marker. A changed or added line is always new, so a
    marker "already at HEAD" can only ever cover lines moved verbatim; that does not justify
    a public token and a content-matching rule.
  - Measuring the skip limit by file size: a dependency bump in a large lockfile would need a
    human on every update and could never be committed by a subagent.
  - Matching every OS user name: a user named `dev`, `app` or `src` would hit almost every
    path.
  - Any scan item anywhere in the run making the confirmation `humanOnly`: a 2 MB untracked
    file the worker leaves out would block every subagent commit in the repo until it is
    ignored.
  - A hit as `humanOnly` even when left out: the hit cannot reach history either way, and
    the subagent could commit nothing in the run.
  - A hidden staged-new path in `staged` as a `humanOnly` trigger instead of a refusal:
    `split` sends the same path to "commit by hand", and a question would make the plugin a
    path for `.env.local` after all.
  - Refusing a collapsed staged-new directory in `staged` like a hidden one: the concern is
    noise, not secrets, and the human staged it on purpose; the refusal sent them to a
    manual commit for no safety gain. A `humanOnly` trigger for it: only a human reaches
    `staged` anyway.
  - Treating a filtered file like a binary one (not scanned): `nbstripout` and similar
    filters commit text that the scan can check, and the cleaned form is exactly what
    history gets.
  - The backstop re-reading `scanIgnore` at HEAD (CFG-01): a `scanIgnore` change committed
    by an earlier group of the same run would exempt later groups under patterns that
    `plan`'s scan and the confirmation never used.
  - An invalid `scanIgnore` at HEAD as a `config` refusal (CFG-01): the repair of the file
    could then only be committed by hand.
- **Consequences.** This repo's own fixtures with fake secrets live under `tests/fixtures/`, and
  the repo config lists that in `scanIgnore`. Since `scanIgnore` is read at HEAD,
  `.claude/commit.json` must be committed before the first commit that adds
  `tests/fixtures/`; `/to-issues` puts that commit first. The docs need no entry: the
  regex table in [Scan patterns](../contracts/scan-patterns.md) does not match itself, because a user segment holding a
  character no OS allows in a user name (`[`, `^`, `(`, …) is not a hit, and example paths
  in the docs use the `<you>` placeholder (`C:/Users/<you>/…`), never `…` as the user
  segment. The privacy-guard test (Q15) runs the `local-path` pattern over the docs, so a
  bad example fails CI before it can fail a commit. Test sources (`tests/*.test.js`) are
  scanned like any other file, so they never hold a literal hit: a test builds such a string
  at run time (`'ghp' + '_' + 'x'.repeat(36)`) or loads it from `tests/fixtures/`, and the
  privacy-guard test runs every scan pattern over them too. Accepted noise: a real person's
  home path in a Dockerfile or CI file still needs a human, which is the point. A new exception
  takes effect only after the commit that adds it, which a human has confirmed; files matching
  it in the same run are still scanned under the HEAD rules. Accepted gap: the content of an
  LFS-tracked file goes to the LFS server on push, and the scan sees only its pointer; a secret
  in an LFS-tracked `*.json` is not caught. The README says so. Also accepted: UTF-16 text
  counts as binary (its NUL bytes) and is not scanned;
  every scanned line is cut to its first 4096 characters, so a secret past the cut on a
  longer line is missed;
  unprefixed secret formats (Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-proj-`, JWTs)
  have no pattern of their own in 0.1.0 and are caught only where `generic-secret` matches
  their key. Only added lines are scanned, so a hunk that removes a hardcoded secret shows
  it in `hunks.txt`, and through it in the worker's model context and transcript; it never
  enters history through the plugin. Roadmap: `scanIgnore` entries
  of the form `{ "path": "<glob>", "pattern": "<id>" }` to silence one pattern per path
  (additive); new pattern IDs for common high-signal prefixes: `sk_live_` / `rk_live_`
  (Stripe), `glpat-` (GitLab), `npm_`, `AIza` (Google), `sk-proj-` (OpenAI); Slack app
  tokens (`xapp-`) are already matched by `slack-token`. IDs are additive public surface.
