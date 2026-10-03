# Seams (confirmed by the user)

1. **Seam 1: the commit entry point as a subprocess over a temp git repo.** Inputs: argv; env
   with a temp OS home and Claude home (user config, heartbeat, Claude settings),
   `CLAUDE_PROJECT_DIR`, fixed identities and dates; the subprocess's spawned cwd, which is
   the project-dir input when `CLAUDE_PROJECT_DIR` is unset (a subfolder with its own
   `.claude/` vs. one without, PRE-11); the repo's contents, hooks, filters and
   config; the files the worker would write. Assertions: the single JSON object, the exit
   code, the resulting repo and the run folder. Lock ageing is set up by changing the lock's
   mtime (Q22). The managed-settings layer (`managed-settings.json` only) is covered at
   Seam 1 in CI only, where the job can write the platform's managed directory (the entry
   point derives it from the platform, never from `env`); elsewhere those cases are skipped,
   not faked. Because that directory is machine-wide and `node --test` runs files in parallel
   processes, the managed cases run in a separate, final `node --test` invocation that
   removes the file it wrote; every attribution case is skipped when the host already has a
   `managed-settings.json` of its own.
   **Clock at Seam 1.** The entry point reads time only through `Date.now()` and passes it
   down as `now`; M2 timers derive from that value. The time-budget test starts the entry
   point with Node's `--import` of a preload module that lives in the test tree and is never
   packaged; the preload replaces `Date.now` with a stepping clock whose schedule it reads
   from a file in the test's temp directory: a JSON list of steps, each keyed to an event
   the preload can observe (a path that must exist, such as a hook's marker file, or a
   reflog entry count) and giving the elapsed milliseconds from then on: after a step,
   `Date.now()` returns the frozen value `callStarted + elapsed`, where `callStarted` is the
   real time of the preload's first `Date.now()` call, which that call returns unchanged (the
   entry point's call start), and it stays frozen until the next step (before the first step
   it runs in real time), so a boundary such as exactly 60 s elapsed is exact when the check
   reads it. Steps are checked from the second call on, so a step whose event already holds
   at start (a path the fixture created before the launch) applies to every later read: at
   535 s elapsed the first group still starts (it always does) and its `git commit` gets a
   real `timeoutMs` of about 5 s. Every kill-timeout case (the end-to-end hook past the
   budget and the two `index.lock` timeouts, story 215) uses such a step, so no CI job waits
   540 s. Apart from that first call the schedule never counts `Date.now()` calls, so it does
   not break when the code reads the clock more or less often. The shipped CLI gains no
   switch.
   **Fault-injection preload at Seam 1.** A second test-tree preload, loaded the same way as
   the clock preload and never packaged, injects failures a fixture cannot otherwise cause.
   The test configures it through environment variables the preload reads: it can (a) make
   `os.userInfo()` throw, so a case can test `osUser` derivation with no OS user identity
   available; (b) fail a named fs boundary — `fs.linkSync` or `fs.renameSync`, and the
   callback and promise forms the code path uses — for a target path whose basename matches a
   given name, so a fixture can inject a fault between two specific writes with no process
   between them for a PATH shim to intercept; the injected error carries the errno code the
   test names (default `EIO`) as its `code`, with `syscall` and `path` set as Node's own fs
   errors carry them, because the code maps codes differently (`EEXIST` on the lock link →
   `held`, a Windows `EPERM` that outlasts the retries → the hard-link probe and `busy`, or `run-folder` when the probe link `hardlink-probe.link` fails too, `ENOTSUP` → `run-folder` with no retry,
   `EIO` → `internal`; a `state.json` rename failing with `EIO` after `git commit` is the
   Seam 1 trigger of M16's `internal` path, reported with `sha`, EXE-01); and (c) optionally log the order
   of those calls to a file in the test's temp directory, so a case can assert write order
   without forcing a fault. After patching `fs`, `fs.promises` and `os`, the preload calls
   `module.syncBuiltinESMExports()`, so a named ESM import (`import { linkSync } from
   'node:fs'`) sees the fault as well as a property access on the module object does. The
   shipped CLI still gains no switch; the preload lives only in the test tree.
   **Table-driven fixture generator.** M15 `computeConfirm` (C:confirmation-triggers) and M9
   `applyCaps` (the caps of C:untracked-files) are tested through Seam 1 from their contracts
   tables: a generator builds one temp repo and worker plan per table row (mode, groups, new
   files, scan items, resumed, interactive; directory shapes at, below and above each cap)
   and asserts the confirmation in `check`'s output or the `collapsed` and `stagedExcluded`
   lists in `plan`'s.
2. **Seam 2: the guard entry point fed `PreToolUse` JSON on stdin.** Inputs: `tool_name`,
   `tool_input.command`, `cwd`, `agent_type`, a temp Claude home. Assertions: stdout (deny
   JSON or empty), exit 0, the heartbeat file.
3. **Seam 3: in-process, table-driven tests** of modules whose oracle is a contracts table
   and whose interface is stable: M6 `lint` and `parse` (C:message-grammar); M7
   (C:scanignore-globs); M8 `scanUnits` and `scanText` (C:scan-patterns, including
   `osUser: null`), plus `createScanner(table)`, the factory the module's own `scanText` and
   `scanUnits` are built over, so the engine's rules (offsets, overlapping hits, a
   false-positive rule reading a capture group) are checked against a test table independent
   of C:scan-patterns' rows; M9 `hideFilter`, `summaryOnly` and `bucketOf` (the hidden rules of C:untracked-files,
   C:summary-only-files); G1 `runHook` with injected `claudeHome` and `now`
   as the single in-process guard entry, plus the G2/S2 unit carve-outs below (Bash and PowerShell tokenizer fixtures, allowlist,
   global options, script calls). The guard has this second seam beside Seam 2 on purpose:
   Seam 2 proves the real hook process (stdin to its end, exit codes, fail-open, the
   heartbeat file), while the several hundred tokenizer and allowlist fixtures would cost
   minutes on Windows CI with a Node process per fixture. Two more functions are declared here because an external
   oracle checks them directly: G2 `segments` (golden fixtures cross-checked against bash
   `printf '%s\0'` and the PowerShell parser API) and S2 `build` (the README allow rules and
   the worker prompt's command form must match its output).

Nothing else is tested in-process. M15 as a whole (confirmation, mode, refusal order, lint
counter, run end, the budget step) and M9 `applyCaps` are tested through Seam 1. M13, M14 and M17 are tested through Seam 1,
including the size-budget fixtures: fixture repos built at each hunk-index cap and at every
reply list cap, run through `plan` and `check`, with the size of stdout measured.

**ScriptCall round trip.** Every `run` string M17 can build (each handback kind, paths with
spaces and drive letters) goes through G1 `runHook` as Bash and as PowerShell and must be
recognised with the same subcommand and arguments; through Seam 2, as `commit:commit-worker`
a `commit` or `release` call is denied and a `plan` call writes the heartbeat. A check
asserts the README allow rules and the worker prompt's command form match `build` output.
The round trip uses install paths without `$`, a backtick, `"`, `\`, a typographic double
quote (U+201C-U+201E), `!` or a control character; a Seam 1 case copies the scripts under a
path with each of them and expects `env`. The `"` and `\` cases are POSIX only (Windows
forbids `"` in a name, and `\` is its separator); control characters other than those
Windows also forbids in a name are POSIX only too; the typographic-quote and `!` cases run
on both platforms; on Windows a case under a plain native path (`C:\…`) expects no `env`
refusal.

**Caller trust fixtures (Seam 1).** Every `run` string M17 builds passes the base
`callerRule`'s shape predicate: one command segment, an absolute path under the plugin cache,
a UUID `planId`; a fixture reply with two objects that both carry `version` and `callerRule`
checks that the base `callerRule` text tells the caller to run nothing. Forged `run` strings
a steered worker could return (a relative or non-plugin-cache path to a file named like the
entry point, a compound segment with `;`, `&&` or `|`, a redirection) are not guard fixtures:
the guard recognises a script call by the entry point's name only, so rejecting them is the
caller's job, checked in the manual hand-test together with the caller's own compliance.

**Parser oracles.** On every Seam 1 fixture repo, the per-file added and removed line counts
in the hunk index are cross-checked against `git diff --numstat -z`, observable at Seam 1.
The Bash tokenizer's golden fixtures are cross-checked in CI by letting bash print its own
words for each segment (`printf '%s\0'`); PowerShell fixtures by the PowerShell parser API
(Other checks). Fixture classes where G2 deliberately differs from the shell are
oracle-skipped, as listed in C:guard (Oracle-skip classes, from the tokenizer spike):
redirections, expansions (`$` variables, brace expansion, globs, process substitution),
unterminated quotes, blanket-rule commands (a substitution, heredoc, here-string, comment or
Bash typographic quote: never tokenized, no segments), subshell parentheses, PowerShell
script-block braces, PowerShell assignment and keyword statements, splats, `--%`
stop-parsing, PowerShell comma arrays, a PowerShell backtick plus newline inside a word, a
PowerShell NUL escape (`` `0 ``) and a carriage return in Bash (the
shell would expand, reject or drop them).

**End-to-end time budget (Seam 1).** A three-group `split` run with the stepping clock: group
1 commits, the clock steps to 61 s elapsed (fewer than 480 s left), the call stops with a
`continue`
handback whose `run` is the same command, the committed group is recorded; running that
command resumes at group 2. A boundary case steps the clock to exactly 60 s elapsed
(480 s left): group 2 still starts. A further case steps the clock to 535 s elapsed at
start and sets a `pre-commit` hook that sleeps past the remaining 5 s of the budget: the tree
is killed, `timeout` is reported, and no commit lands. A `post-commit` hook that sleeps the
same way lets the commit land before the kill: `timeout` is reported with the new `sha`.
