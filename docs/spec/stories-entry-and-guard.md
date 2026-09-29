# User stories: entry points and guard

## Entry points and triggering

1. As a developer, I want "commit this" to reach the plugin without a command, so that agent commits get linted and scanned. [Q2]
2. As a developer, I want a bare `/commit` to plan every change, so that my own hand edits are not left behind. [Q2, Q16]
3. As a developer, I want `/commit <text>` to pass my text as the `intent`, so that the run is scoped to what I describe. [Q2]
4. As a developer, I want `/commit reword [<text>]` to reword the last commit, optionally with my dictated text, so that I can fix a message. [Q2, Q20]
5. As a developer, I want `/commit` never to invent an `intent` from the session, so that my hand edit is not silently excluded. [Q2]
6. As the Claude main session, I want the worker's description to tell me when to spawn it and what to pass, and to keep the rule for trusting its reply even when the description is shortened, so that I spawn it right with no skill loaded (priority order: [Prompt-only and manifest blocks](prompt-only-and-manifest-blocks.md)). [Q2, Q24]
7. As a developer, I want `/commit` to be a user-only command that just spawns the worker, so that no skill text sits in my context. [Q2, Q24]
8. As a workflow-skill author, I want to spawn `commit:commit-worker` with the public fields `intent`, `interactive` and `reword`, so that my skill can end in a plugin commit. [Q25]
9. As a developer with another `/commit` installed, I want to reach this one as `/commit:commit`, so that both commands stay usable. [Q8]

## Guard: detection

10. As a developer, I want an agent's direct `git commit` from a shell tool call denied and routed to `commit:commit-worker` with an intent, so that agent commits pass lint and scan. [Q3]
11. As the Claude main session, I want deny messages never to mention `/commit`, so that I do not waste a call on a skill I cannot invoke. [Q3, Q24]
12. As a developer, I want each routing deny to end with the fixed personal-commit-skill line, so that a misconfigured machine explains itself. [Q8]
13. As a developer, I want `git commit` caught inside compound commands (`&&`, `||`, `;`, `|`, `&`, newlines) in both shells, with redirections (`2>&1` and the like) dropped and lines continued at a trailing `\` or backtick joined before splitting, so that chaining cannot hide it. [Q3]
14. As a developer, I want `git` or `git.exe` at any path, compared case-insensitively, after PowerShell's `&` and after known git global options, detected, so that spelling cannot hide a commit. [Q3]
15. As a developer, I want a `git commit` whose command text mentions `commit` literally denied even when it hides behind an unknown git option before `commit`, a subcommand held in a variable or substitution (`git $c`, a PowerShell `@` splat), Bash brace expansion, a parenthesised or globbed subcommand, any other git argument that is not literal (a bracket, `$`, a backtick or a glob; in PowerShell a comma array, `@`, or `--%` stop-parsing), a commit run inside a command substitution (`echo $(git commit -m x)`), typographic quotes, or the dashed `git-commit` binary, so that detection fails closed (a command that never spells `commit` is a known gap, see [Out of Scope](out-of-scope.md)). [Q3]
16. As a developer, I want an unterminated quote to turn the rest of its line into one quoted token while scanning continues, so that a truncated `git commit -m "…` is still denied. [Q3]
17. As a developer, I want the guard never to return `allow`, so that my permission prompts still apply. [Q3]
18. As a developer, I want a guard crash or unreadable input to exit silently, so that a guard bug never blocks every shell call. [Q3]
19. As a developer, I want commits I type in a terminal or as a `!` prompt command unaffected, so that I keep a human-only channel. [Q3, Q10]
20. As a developer, I want `COMMIT_GUARD_DEBUG=1` to log each decision to stderr, so that I can diagnose the guard. [Q1]
21. As a developer, I want the heartbeat and the debug log to keep only the script-call form or the matched `git commit` options of a command, cut to 200 characters, so that message text and other arguments I passed never persist on disk or in logs. [Q1, Q23]
22. As a developer, I want shell commands that have nothing to do with committing to pass the guard within its cold-start target ([Open items](further-notes.md#open-items)), while a `commit` disguised by quotes, typographic quotes, backslashes or backticks (`co''mmit`, `co$'m'mit`) or split by an escaped newline is still checked, so that the guard neither slows every command nor is dodged by spelling (a word built at runtime is a known gap, see [Out of Scope](out-of-scope.md)). [Q3, Q13]

## Guard: allowlist

23. As a developer, I want `git commit --no-edit`, optionally with `--amend` and `-q` or `--quiet`, allowed, so that a merge can be finished. [Q4, Q21]
24. As a developer, I want plain `git commit --fixup=<commit>`, optionally with `-q` or `--quiet`, allowed, so that requested fixups work. [Q4]
25. As a developer, I want every other form denied, most naming the offending flag (a bare commit and `-m`/`-F`/`--message`/`--file` share one generic message instead), after expanding short flag clusters and `--opt=value`, so that the agent knows what to change. [Q4]
26. As a developer, I want `-m`, `-F`, `--message` and `--file` denied, so that no unlinted message lands. [Q4, C:guard]
27. As a developer, I want a bare `git commit`, `--amend` without `--no-edit`, and `--squash` in any form denied, so that no editor hangs and no unlinted message lands. [Q4]
28. As a developer, I want `-c <commit>`, `-C`, `--reuse-message`, `--reedit-message` and `--fixup=amend:` or `reword:` denied, so that no message bypasses lint. [Q4]
29. As a developer, I want `-a`, `-t`, `--allow-empty`, `--allow-empty-message`, pathspecs and `--` denied, so that nothing unscanned or unlinted lands through the commit itself. [Q4]
30. As a developer, I want `-n`, `--no-verify` and `--no-gpg-sign` denied with "fix the hook or signing setup instead", so that hooks and signing are never bypassed. [Q4, Q18]
31. As a developer, I want git `-c` or `--config-env` before `commit` denied for any key, so that config injection cannot undo the ban. [Q4]
32. As a developer, I want the `--amend` deny to route rewording to the worker and added changes to a new commit, so that an unscanned `--amend --no-edit` is never suggested. [Q4]
33. As a developer, I want no env switch that disables the guard, so that the agent cannot turn it off; `/plugin disable` is the brake. [Q4]

## Guard: heartbeat and worker-only rule

34. As a developer, I want a notice when the guard did not run (`node` missing from the hook's PATH, plugin hooks disabled, `disableAllHooks` set) while the run goes on, so that I know direct commits are unblocked (text: the recorded-texts table of [C:cli-and-exit-codes](../contracts/cli-and-exit-codes.md)). [Q23]
35. As a developer, I want the worker to reply that Node is missing and the guard is off too when its first `plan` cannot start, so that a machine without Node explains itself. [Q1]
36. As a developer, I want the guard status reported as active only when the guard saw a `plan` call in this repo within 15 minutes, so that the notice reflects what happened (the heartbeat's gaps are listed in [Out of Scope](out-of-scope.md)). [Q23]
37. As a developer, I want the heartbeat to recognise every worker's script call however its shell quotes it, so that an active guard is never reported as missing. [Q23]
38. As a developer, I want every command a handback asks my session to run to go through without a permission prompt once the README allow rules are set, and never to be denied by the guard, so that a run asks no unexpected question. [Q16, Q23, Q25]
39. As a developer, I want the guard to deny the worker's own `commit` and `release` script calls, so that the worker never answers its own handback. [Q25]
