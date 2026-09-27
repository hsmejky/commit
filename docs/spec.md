# Spec: commit plugin 0.1.0

What the `commit@commit` plugin does, for whom, and how it is split into modules.
[decisions.md](decisions.md) (Q1-Q25, the why) and [contracts.md](contracts.md) (data shapes,
grammars, tables) are the source of truth. Decisions this spec introduced beyond those
documents are recorded there as `**Amended.**` bullets.

## Problem Statement

As a developer working with Claude Code, I let the agent commit its own work many times a
day, and it goes wrong quietly. The agent runs `git add … && git commit` itself: it lumps
unrelated changes together or splits by folder instead of by functionality, sweeps in
scratch files, my half-finished hand edits or a parallel implementer's files, and can commit
a token, a private key or my home path unnoticed. Messages drift from the repo's
Conventional Commits style, the harness's attribution leaks in through the agent, and
multi-line messages break on shell quoting, especially in PowerShell. A prompt-only commit
skill scans and splits "by eye", costs more calls than no skill, and is skipped whenever the
model commits directly. Repo hooks, signing, in-progress merges, huge lockfiles and
concurrent agents add failure modes, and a run that breaks halfway leaves the index in an
unexplained state.

## Solution

With `commit@commit` installed, agent commits go through one path. A commit request spawns
the `commit:commit-worker` agent, which drives a deterministic Node script with no npm
dependencies: it inventories changes, scans added lines for secrets and local paths, and
shows the worker the changes as units (whole files or hunks). The worker groups units into
atomic commits by functionality, scoped by the caller's `intent`, and writes each message;
the script lints, decides whether a human must confirm, and commits. One group of tracked
files commits with no question; otherwise I see one block and answer `yes`, `one`, `no`, or
type an edit. The diff never enters the main context. A guard hook denies direct
`git commit` from agent tool calls and steers to the worker; the merge-finishing and plain
fixup forms stay allowed. Rules live in a user layer and a repo layer of `commit.json`,
inferable from history by `/commit-config`, which writes only a valid config. Failures stop
cleanly and explain themselves; hooks and signing are never bypassed; a repo opts out
through `enabledPlugins`.

## User Stories

Citations: `Qn` is a decision in decisions.md; `C:<section>` is a section of contracts.md.

### Entry points and triggering

1. As a developer, I want "commit this" to reach the plugin without a command, so that agent commits get linted and scanned. [Q2]
2. As a developer, I want a bare `/commit` to plan every change, so that my own hand edits are not left behind. [Q2, Q16]
3. As a developer, I want `/commit <text>` to pass my text as the `intent`, so that the run is scoped to what I describe. [Q2]
4. As a developer, I want `/commit reword [<text>]` to reword the last commit, optionally with my dictated text, so that I can fix a message. [Q2, Q20]
5. As a developer, I want `/commit` never to invent an `intent` from the session, so that my hand edit is not silently excluded. [Q2]
6. As the Claude main session, I want the worker's description to tell me when to spawn it and what to pass, and to keep the rule for trusting its reply even when the description is shortened, so that I spawn it right with no skill loaded (priority order: [Prompt-only and manifest blocks](#prompt-only-and-manifest-blocks)). [Q2, Q24]
7. As a developer, I want `/commit` to be a user-only command that just spawns the worker, so that no skill text sits in my context. [Q2, Q24]
8. As a workflow-skill author, I want to spawn `commit:commit-worker` with the public fields `intent`, `interactive` and `reword`, so that my skill can end in a plugin commit. [Q25]
9. As a developer with another `/commit` installed, I want to reach this one as `/commit:commit`, so that both commands stay usable. [Q8]

### Guard: detection

10. As a developer, I want an agent's direct `git commit` from a shell tool call denied and routed to `commit:commit-worker` with an intent, so that agent commits pass lint and scan. [Q3]
11. As the Claude main session, I want deny messages never to mention `/commit`, so that I do not waste a call on a skill I cannot invoke. [Q3, Q24]
12. As a developer, I want each routing deny to end with the fixed personal-commit-skill line, so that a misconfigured machine explains itself. [Q8]
13. As a developer, I want `git commit` caught inside compound commands (`&&`, `||`, `;`, `|`, `&`, newlines) in both shells, with redirections (`2>&1` and the like) dropped and lines continued at a trailing `\` or backtick joined before splitting, so that chaining cannot hide it. [Q3]
14. As a developer, I want `git` or `git.exe` at any path, compared case-insensitively, after PowerShell's `&` and after known git global options, detected, so that spelling cannot hide a commit. [Q3]
15. As a developer, I want a `git commit` whose command text mentions `commit` literally denied even when it hides behind an unknown git option before `commit`, a subcommand held in a variable or substitution (`git $c`, a PowerShell `@` splat), Bash brace expansion, a parenthesised or globbed subcommand, typographic quotes, or the dashed `git-commit` binary, so that detection fails closed (a command that never spells `commit` is a known gap, see [Out of Scope](#out-of-scope)). [Q3]
16. As a developer, I want an unterminated quote or here-string to turn the rest of its line into one quoted token while scanning continues, so that a truncated `git commit -m "…` is still denied. [Q3]
17. As a developer, I want the guard never to return `allow`, so that my permission prompts still apply. [Q3]
18. As a developer, I want a guard crash or unreadable input to exit silently, so that a guard bug never blocks every shell call. [Q3]
19. As a developer, I want commits I type in a terminal or as a `!` prompt command unaffected, so that I keep a human-only channel. [Q3, Q10]
20. As a developer, I want `COMMIT_GUARD_DEBUG=1` to log each decision to stderr, so that I can diagnose the guard. [Q1]
21. As a developer, I want the heartbeat and the debug log to keep only the script-call form or the matched `git commit` options of a command, cut to 200 characters, so that message text and other arguments I passed never persist on disk or in logs. [Q1, Q23]
22. As a developer, I want shell commands that have nothing to do with committing to pass the guard within its cold-start target ([Open items](#open-items)), while a `commit` disguised by quotes, typographic quotes, backslashes or backticks (`co''mmit`) is still checked, so that the guard neither slows every command nor is dodged by spelling (a `commit` split by an escaped newline is a known gap, see [Out of Scope](#out-of-scope)). [Q3, Q13]

### Guard: allowlist

23. As a developer, I want `git commit --no-edit`, optionally with `--amend` and `-q` or `--quiet`, allowed, so that a merge can be finished. [Q4, Q21]
24. As a developer, I want plain `git commit --fixup=<commit>`, optionally with `-q` or `--quiet`, allowed, so that requested fixups work. [Q4]
25. As a developer, I want every other form denied naming the offending flag, after expanding short flag clusters and `--opt=value`, so that the agent knows what to change. [Q4]
26. As a developer, I want `-m`, `-F`, `--message` and `--file` denied, so that no unlinted message lands. [Q4, C:guard]
27. As a developer, I want a bare `git commit`, `--amend` without `--no-edit`, and `--squash` in any form denied, so that no editor hangs and no unlinted message lands. [Q4]
28. As a developer, I want `-c <commit>`, `-C`, `--reuse-message`, `--reedit-message` and `--fixup=amend:` or `reword:` denied, so that no message bypasses lint. [Q4]
29. As a developer, I want `-a`, `-t`, `--allow-empty`, `--allow-empty-message`, pathspecs and `--` denied, so that nothing unscanned or unlinted lands through the commit itself. [Q4]
30. As a developer, I want `-n`, `--no-verify` and `--no-gpg-sign` denied with "fix the hook or signing setup instead", so that hooks and signing are never bypassed. [Q4, Q18]
31. As a developer, I want git `-c` or `--config-env` before `commit` denied for any key, so that config injection cannot undo the ban. [Q4]
32. As a developer, I want the `--amend` deny to route rewording to the worker and added changes to a new commit, so that an unscanned `--amend --no-edit` is never suggested. [Q4]
33. As a developer, I want no env switch that disables the guard, so that the agent cannot turn it off; `/plugin disable` is the brake. [Q4]

### Guard: heartbeat and worker-only rule

34. As a developer, I want a notice when the guard did not run (hooks disabled, `disableAllHooks`), so that I know direct commits are unblocked. [Q23]
35. As a developer, I want the worker to reply that Node is missing and the guard is off too when its first `plan` cannot start, so that a machine without Node explains itself. [Q1]
36. As a developer, I want the guard status reported as active only when the guard saw a `plan` call in this repo within 15 minutes, so that the notice reflects what happened (the heartbeat's gaps are listed in [Out of Scope](#out-of-scope)). [Q23]
37. As a developer, I want the heartbeat to recognise every worker's script call however its shell quotes it, so that an active guard is never reported as missing. [Q23]
38. As a developer, I want every command a handback asks my session to run to go through without a permission prompt once the README allow rules are set, and never to be denied by the guard, so that a run asks no unexpected question. [Q16, Q23, Q25]
39. As a developer, I want the guard to deny the worker's own `commit` and `release` script calls, so that the worker never answers its own handback. [Q25]

### Worker protocol and handback

40. As a developer, I want a one-group run to need a single planning call, so that the common case stays short. [Q9, Q24]
41. As a developer on Windows without Git Bash, I want the worker to use whichever shell tool it has, so that the plugin still works (subject to the worker-shell check in [Open items](#open-items)). [Q24]
42. As a developer, I want the worker to start lean, on a fixed model without my project or user CLAUDE.md instructions, and to stop after a bounded number of turns, so that runs are cheap and runaways stop (values: [Prompt-only and manifest blocks](#prompt-only-and-manifest-blocks)). [Q24]
43. As a developer, I want a slow repo hook or clean filter to get up to the 540 s budget to finish (past it the script stops it before the tool timeout), and a retried `plan` never to race one still running in the background, so that a slow repo cannot corrupt a run (values: M15 `deadline`, worker prompt). [Q9, Q18]
44. As the Claude main session, I want the worker's final report to be exactly the reply the script built, whichever delivery shape brings it to me, so that I can rely on its fields and no notice is lost in a paraphrase. [Q25]
45. As a developer, I want a run the script itself ended with a failure to leave no plugin files behind in my working tree (a dead worker's run folder waits for a takeover, story 59, and one moved in the put-back race waits for the 24-hour sweep, story 195), so that a failure needs no cleanup by hand. [C:worker-input, Q9, Q25]
46. As the Claude main session, I want a fallback reply carrying the `planId` whenever the worker can still answer after a failure, so that the failure is traceable to its run; the lock is left to the takeover question. [Q25]
47. As a developer, I want my typed plan edits applied to the grouping I was shown, so that a resumed run changes the right grouping. [C:worker-input]
48. As a developer, I want trailer instructions in the worker's input ignored, so that only the script adds trailers. [Q25]
49. As a developer, I want messages written in the language of recent history, with issue footers only when I supplied them, so that nothing is invented. [Q13, Non-goals]
50. As the Claude main session, I want a `callerRule` in every reply, so that I show the text verbatim and skip git log and git status. [Q25]
51. As the Claude main session, I want each handback to carry its question, its answers (a command with its timeout, or a respawn input) and `ifNoUser`, so that I follow it without plugin knowledge. [Q25]
52. As the Claude main session, I want the run's scope, dictated text and no-user setting to survive every respawn, so that a resumed run behaves like the first spawn. [Q9, Q25, C:reply-and-handback]
53. As the Claude main session, I want a `continue` handback run without asking, so that a long commit finishes without a question. [Q18, Q25]
54. As the Claude main session, I want every handback answer to either run one command, respawn the worker, or end the run, so that I can offer the answers through `AskUserQuestion` with no extra logic. [Q25]
55. As a developer, I want the reply to name the appended trailer, so that nobody adds another. [Q25]
56. As a developer, I want the reply text to end with the tree state ("working tree clean" or "N files left"), so that nobody verifies by hand. [Q25]
57. As a developer, I want every notice (for example guard, signing, config, detached HEAD, scan hits, discarded staged versions, an automatic takeover, a cleanup error) repeated in the reply text, so that it reaches me through subagents. [Q25]
58. As a developer, I want callers to edit no files until the reply, and an edit to a path the run already knows caught as `diff-changed` (a new untracked file is left for the next run, and `staged` mode checks only the index), so that edits cannot slip into or break a run. [Q25]
59. As a developer, I want a dead worker's lock left to the takeover question, so that no caller guesses a run ID. [Q22, Q25]
60. As a developer, I want a run blocked by a lock the plugin cannot read (corrupt or foreign) to ask me nothing and tell me when that lock will be taken over automatically, so that I know how long to wait and no run is ever taken over by guessing whose it is. [Q22, C:reply-and-handback]

### Caller trust

61. As a developer, I want a caller to run a handback command only when it is a single command (no `;`, `&&`, `|` or other segment) calling this plugin's installed `commit.js` by its plugin-cache path with `commit` or `release` for the reply's `planId`, and to refuse and show anything else, so that a prompt injection in my diff cannot get an arbitrary command run. [Q25, C:reply-and-handback]
62. As the Claude main session, I want to recognise the reply by its `version` and `callerRule` keys, not by its position in the worker's message, and to run nothing when more than one object carries both keys, so that a leading sentence holding JSON cannot pose as the reply. [Q25]
218. As a developer, I want control characters in paths escaped in the reply, so that a crafted file name cannot forge reply text or terminal output. [C:reply-and-handback]

### Atomic grouping and hunks

63. As a developer, I want commits grouped by functionality across folders, with buckets as hints only, so that commits are atomic. [Q11]
64. As a developer, I want each commit to hold exactly the changes the worker put in its group, also after I edited the plan and it re-planned, so that no hunk lands in the wrong commit. [Q9, Q11]
65. As a developer, I want every unit of a large diff listed in the hunk index with its ID, path, kind and range, even when its body is withheld (a summary-only file, a file past the 3000-line cap, a scan hit), so that no change is dropped unseen (a diff line over 2000 characters may be cut, see [Out of Scope](#out-of-scope)). [Q9, Q10, Q19]
66. As a developer, I want every unit placed once, in a group or under "not included" with a reason, so that nothing is dropped unexplained. [Q16]
67. As a developer, I want identical hunks in one file placed in the same group, so that no intermediate commit edits the wrong place. [Q11]
68. As a developer, I want new, deleted, binary, renamed, summary-only, mode, symlink, submodule and filtered files handled as whole-file units, so that staging stays correct. [Q11]
69. As a developer, I want a plain `mv` or a `git mv` paired into one rename named by its new path, so that its halves never split. [Q11]
70. As a developer, I want planning, untracked files included, to leave my index untouched, so that my staging survives a run that stops. [Q11]
71. As a developer, I want a mode change kept with its content, so that nothing is lost. [Q11]
72. As a developer, I want filtered files (LFS, `nbstripout`) staged through their filter, so that the committed form is the cleaned one. [Q11]
73. As a developer, I want submodule pointer changes committed and dirt without a pointer change only reported, so that build output inside a submodule does not block. [Q11]
74. As a developer, I want units to be independent of my diff config, my working directory and special characters in paths such as `[id].tsx`, so that they cannot change under me. [Q9, Q11]
75. As a developer on Windows, I want files with `core.autocrlf` or `eol` attributes planned and staged in git's converted form, so that line endings never cause a mismatch. [Q11]
76. As a developer, I want a changed tree detected before my index is touched, so that a `diff-changed` keeps my staging. [Q11, Q18]
77. As a developer, I want a file I force-added despite `.gitignore` (`git add -f`) planned and committed like any other new file, so that a run neither drops it nor fails on it. [Q11]
78. As a developer, I want a case-only rename staged with `git mv` planned as a rename, and sparse-checkout or `skip-worktree` entries never planned, so that neither shows up as a spurious change (an unstaged case-only rename on a case-insensitive filesystem is invisible to git and not planned). [Q11]

### Intent scope and modes

79. As a developer, I want units the intent clearly does not cover left out as "not part of the intent", while its tests, docs and lockfile stay in, so that unrelated edits stay out. [Q16]
80. As a developer, I want left-out units kept in the tree and listed, so that the next `/commit` plans them. [Q16]
81. As a developer, I want a mixed index to ask "staged only or group all" with counts only, so that my `git add -p` selection is respected; hidden files are never counted as candidates for this question. [Q9, Q16]
82. As a developer, I want an index holding every change planned as `split`, so that an agent's `git add -A` still gets grouping. [Q16]
83. As a developer, I want a staged set I picked committed as-is with a written message and the rest reported, so that my selection is honoured. [Q11, Q16]
84. As a developer, I want a large new directory I staged myself committed under `staged` without collapsing, so that `git add packages/new-lib` works. [Q10, Q16]
85. As a developer, I want a staged version that differs from both HEAD and my working tree reported with a recoverable blob ID when a run discards it, so that I can restore it. [Q11]
225. As a developer, I want `--staged` with an emptied index refused as `staged-empty`, so that a run I meant to commit staged changes for does not silently fall back to another mode. [Q9, Q16]

### Confirmation

86. As a developer, I want no question for one group of tracked files, so that the common case is instant. [Q16]
87. As a developer, I want a `split` run confirmed when it has several groups, so that bad splits are caught. [Q16]
88. As a developer, I want a `split` run confirmed when it adds a new file, so that stray files are caught. [Q16]
89. As a developer, I want a run that includes a file skipped for size (over 1 MB added) or a `scanIgnore` change confirmed by a human only, so that no caller without a user can let unscanned content or a scan-rule change into history (in interactive mode this is advisory, see [Out of Scope](#out-of-scope)). [Q10, Q16, Q17]
90. As a developer, I want a `staged` run confirmed only for size-skipped or `scanIgnore` items or when resumed (story 95), and a first `reword` never, so that explicit requests are not nagged. [Q16]
91. As a developer, I want one block with headers, bodies, files (≤ 20 per group, each with its hunk count when the group holds hunks), not-included reasons and notices, so that I review everything once. [Q16]
92. As a developer, I want `yes` to run the commit command verbatim and `no` to release with my index untouched, so that no new worker is paid. [Q16, Q24]
93. As a developer, I want to type changes under Other ("merge 2 and 3"), repeatably, so that I can steer the plan. [Q16, Q25]
94. As a developer, I want `one` offered only in a `split` run with several groups, so that it never re-plans to the same result. [Q16]
222. As a developer, I want `one` to re-plan the run as a single group of all included files and show it again, so that I can commit everything as one commit with one more answer. [Q16]
95. As a developer, I want every resumed interactive run confirmed ("edited plan"), so that nothing I have not seen commits. [Q16]
96. As a developer, I want pattern hits and new binaries not to be triggers of their own, so that prompts stay rare. [Q16]
97. As a developer, I want zero groups reported as "nothing committed" with reasons, so that I know why. [Q16]

### Subagents and headless runs

98. As an implementer subagent, I want to spawn the worker nested with my intent, so that I commit through the same flow. [Q17]
99. As an implementer subagent, I want to know that no user can answer from what I already have, so that no extra call is paid to find out (rule: glossary, **interactive**). [Q17]
100. As an implementer subagent, I want `interactive: false` to commit plain confirmations itself, so that I save a call. [Q17]
101. As an implementer subagent, I want, with `interactive` omitted, to follow `ifNoUser` (`yes`, `no` plus pass-up, `split`, `wait` plus pass-up, `continue`), so that I judge the grouping myself. [Q17, Q25, C:reply-and-handback]
102. As a developer, I want a `humanOnly` confirmation never answered without a user, the lock released and the text passed up, so that I decide via `/commit`. [Q17]
103. As a developer, I want a subagent under `interactive: false` or `--no-user` to commit the rest when units are left out (including a file skipped for size, left in `notIncluded`) and relay notices verbatim, so that work continues safely; with `interactive` omitted, a skipped-for-size file makes the run `humanOnly` instead (story 102). [Q10, Q17]
104. As CI (headless `claude -p`, Agent SDK), I want the subagent path with notices in the final report, so that nobody waits on a question. [Q17]

### Config layers

105. As a developer, I want the user layer overridden per key by the repo layer, arrays replaced, so that the team repo wins. [Q6]
106. As a developer, I want `types`, `scope`, `body`, `maxSubjectLength` (20–200 code points of the header) and `subjectCase`, so that common styles are expressible. [Q6]
107. As a developer, I want `scanIgnore` accepted only in the repo layer, so that a personal file cannot silence a team's scan. [Q6, Q10]
108. As a developer, I want defaults of 11 standard types, no scope, no body, 72 and lowercase, so that repos without config work. [Q6]
109. As a teammate on an older plugin, I want unknown keys, unknown values and wrong-layer keys to warn and fall back, so that newer configs do not break me. [Q6]
110. As a developer, I want wrong types, out-of-range numbers, bad `types` or unparseable JSON to stop `plan` before any run starts, so that typos surface. [Q6]
111. As a developer, I want effective values and their sources reported, so that I see where a rule came from. [Q6]
112. As a developer with `CLAUDE_CONFIG_DIR` set, I want the user layer, the Claude settings and the heartbeat read from that directory, so that the plugin follows my Claude home. [Q5]
113. As a developer, I want no worker-model key, so that a repo config cannot move the worker to a model the plugin was not tuned and measured for. [Q6, Q24]

### Attribution and trailers

114. As a developer, I want the trailer to follow `attribution.commit`, then `includeCoAuthoredBy`, across managed, project-local, project and user settings, so that it matches the harness. [Q5]
115. As a developer, I want an empty `attribution.commit` to mean no trailer, so that I can turn it off. [Q5]
116. As an organisation admin, I want `managed-settings.json` honoured, and the policy sources the script does not read (the managed drop-in directory, MDM profile, registry, server-managed) documented, so that I know where the plugin follows policy. [Q5]
117. As a developer, I want non-trailer attribution lines dropped with a warning, so that `body: forbidden` holds. [Q5]
118. As a developer, I want a model-free default trailer, so that the attribution line is predictable and cannot be spoofed by the model. [Q5]
119. As a developer, I want trailers added only by the script, never from agent text, so that attribution cannot be spoofed. [Q5, Q13]
120. As a developer, I want only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes` and `Fixes` footers allowed, with a lint hint for `Note:` paragraphs, so that footers stay predictable and the lint hint tells the worker how to fix a `Note:` paragraph. [Q13]
121. As a developer, I want a footer-only last paragraph allowed under `body: forbidden`, so that `Closes #n` works. [Q13]

### Lint and message grammar

122. As a developer, I want every message linted before the first commit, so that lint never leaves a run half done. [Q18]
123. As a developer, I want the lowercase rule to pass acronyms, digits and symbols, so that `API` subjects are fine. [C:message-grammar]
124. As a developer, I want messages normalised (BOM, UTF-16, CRLF and lone CR) and invalid UTF-8 rejected, so that encoding never corrupts history. [Q9]
219. As a developer with a file whose name is not valid UTF-8, I want it reported in `notIncluded` and never planned, so that it is not committed under a mangled name. [Q11]
125. As a developer, I want messages committed verbatim regardless of `commit.cleanup`, so that history equals what lint approved. [Q18]
126. As a developer, I want multi-line messages to survive every shell, PowerShell included, so that quoting never breaks a commit. [Q9]
127. As a developer, I want lint failures to end deterministically: at most one worker retry (none when the failing text is my dictated text), then a `lintFailed` question (`retry`, `no`, or any typed change, dictated text included), and with no user present the failure that ends the retries ending the run, so that loops end. [Q17, Q18]
214. As a developer, I want the `lintFailed` question to offer no dictated text when every error is a shape error (the worker plan is not valid JSON or not its shape), so that I am never asked for a message that cannot fix the failure. [Q18, C:reply-and-handback]

### commit-config and inference

128. As a developer, I want `commit-config` to infer a config from the last 200 non-merge commits, so that I need not guess conventions. [Q7]
129. As a developer, I want fixed thresholds (scope 90%/10%, body 10%, `lower` 90%, all 11 standard types always plus extra types ≥ 5%, p95 header length rounded up to 72 or 100, above 100 to the next multiple of 10 and flagged, clamped to 200 and flagged), so that proposals are predictable. [Q7]
130. As a developer, I want dropped types with counts and `wouldFail` shown, so that I see the cost first. [Q7]
131. As a developer, I want to pick repo or user level and confirm before writing, so that nothing changes unasked. [Q7]
132. As a developer, I want the written file to be the script's already-validated text for that layer, keeping my other keys such as `scanIgnore`, so that `commit-config` never writes an invalid or model-altered config. [Q6, Q7]
133. As a developer, I want the layer's validation errors shown and nothing written when my current layer is already invalid, so that a broken file is fixed by hand first. [C:infer]
134. As a developer, I want defaults recommended under 20 commits and the opt-out under 50% Conventional Commits, so that unsuitable repos are told so. [Q7, Q14]

### Secret and local-path scan

135. As a developer, I want added lines scanned for AWS keys, GitHub, Slack and Anthropic tokens, private keys, connection strings and generic secrets, so that none reach history. [Q10]
136. As a developer, I want added lines scanned for local paths, so that my home path and user name do not reach history. [Q10]
137. As a developer, I want messages scanned too, so that a quoted token or path cannot land. [Q10]
138. As a developer, I want my OS user name (≥ 4 characters, not a service user) caught as a path segment while `/home/node/app` is not, so that noise stays low. [Q10]
139. As a developer in a container without a passwd entry, I want the OS-user rule skipped rather than the scan failing, so that planning still works. [Q10]
140. As a developer, I want hits reported by pattern ID and location only, never in `hunks.txt` or any output, so that a secret I am adding is copied nowhere (a secret on a removed line is not scanned, see [Out of Scope](#out-of-scope)). [Q10]
141. As a developer, I want a hit's unit left out with two manual commit lines (`add`, then `commit`), except a path holding `'`, a PowerShell single quote (U+2018–U+201B) or a control character, which gets only "commit by hand", so that the rest still commits. [Q10]
142. As a developer, I want a staged set with a hit or a hidden staged-new path refused (`staged-hit`), so that a set cannot smuggle it in. [Q10, Q11]
143. As a developer, I want the index rescanned before each commit, so that a file changed after planning cannot slip a secret into the commit. [Q10]
144. As a developer, I want filtered files scanned in cleaned form, so that the scan sees what is committed. [Q10]
145. As a developer, I want binaries not scanned, and additions over 1 MB skipped and reported in `scan.skipped`, so that the scan is bounded. [Q10, C:scan-patterns]
146. As a developer, I want no override flag, env or marker, so that an agent cannot silence the scan. [Q10]
147. As a developer, I want my shell's exported `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_ATTR_SOURCE` or other `GIT_*` variables ignored by the script's own git calls, while my hooks still see my environment, so that no inherited variable redirects what the scan reads. [Q9, Q10]
226. As a developer, I want the worker's rule to never `Read` a file with a scan hit, and to read a working-tree file only at a line range, understood as prompt-only and not enforced by the script (an accepted gap, see [Out of Scope](#out-of-scope)), so that a secret I am adding does not enter the worker's context. [Q10, Q11]

### scanIgnore

148. As a developer, I want `scanIgnore` read from the repo config at HEAD, so that an agent cannot add an exception mid-run. [Q10]
149. As a developer, I want a `scanIgnore` change to apply only from the next commit (the human confirmation is story 89), so that exceptions are deliberate. [Q10]
150. As a developer, I want a small case-sensitive glob dialect in which braces, classes, a leading `!` and a pattern with no literal character (such as `**`, `**/?*` or `*/**`) are config errors, so that matching is predictable on every OS and one line cannot switch the scan off. [C:scanignore-globs, Q10]
151. As a developer, I want the worker to add `scanIgnore` entries only when I ask, so that exceptions never widen on their own. [Q10]

### Untracked and summary-only files

152. As a developer, I want gitignored files unseen, so that build output never appears. [Q16]
153. As a developer, I want hidden files (dot segments, `.env*` except templates, private `.claude/` files) never shown, while committed tooling dotfiles (`.github/**`, `.gitignore`, `.gitattributes`, `.editorconfig`, the shared `.claude/` files, `.changeset/**`, `.husky/**`, lint and format rc files, `.nvmrc`, `.devcontainer/**` and CI directories) stay visible, so that secrets stay out and a tooling-only change is not read as clean. [Q16, C:untracked-files]
154. As a developer, I want in `split` new directories over 50 files, over 50 root files, or totals over 200 collapsed to "add to .gitignore or commit by hand", so that junk stays out. [Q16]
155. As a developer, I want loose files in tracked directories not collapsed per directory unless they alone exceed 200, so that 51 migrations still commit. [Q16]
156. As a developer, I want hidden-only or collapsed-only changes, and a dirty submodule with no pointer change, to count as clean, still named in the `nothing` reply, so that junk does not start a run. [Q16, Q11]
157. As a developer, I want lockfiles, minified, source-map, generated, over-1000-changed-line or over-256 KB files shown to the worker as stats only and grouped as whole files, so that runs stay cheap. [Q19]
158. As a developer, I want hunk bodies capped at 3000 changed lines, files past the cap cut whole while each of their hunks keeps its own ID, so that the worker can still split them. [Q19, C:summary-only-files]
159. As a developer, I want a change set larger than a tool call can print still planned in full, so that tool output limits never cut the worker's view of it. [Q9, Q19]

### Failures, repo hooks, signing

160. As a developer, I want a stop at the first failing group, earlier commits kept and committed, failed and remaining groups reported, so that the state is explainable. [Q18]
161. As a developer, I want a failed group to unstage only when that group began staging, so that a foreign `index.lock` is never reset into, and every run end after the run reset my earlier staging, success included, to report what it unstaged, so that I know what changed. [Q18]
162. As a developer, I want the script to stage exactly the planned and confirmed changes and pass `git commit` exactly the approved message, so that nothing else goes in on the plugin's side (a hook that changes the tree afterwards is story 167 and a gap in [Out of Scope](#out-of-scope)). [Q18]
163. As a developer, I want git and hook output shown with control characters escaped and capped to its last 2000 characters, with no retry and never `--no-verify`, so that repo rules stay mine and hook output can neither forge reply lines nor flood my context (a hook that prints plain-text lines or echoes a secret is a gap, see [Out of Scope](#out-of-scope)). [Q18]
164. As a developer, I want a `diff-changed` after a formatter hook to name that likely cause, so that I understand it. [Q18]
165. As a developer, I want a commit git made despite a failure or timeout detected, so that the report is truthful. [Q18]
166. As a developer, I want an existing `index.lock` refused before each group touches the index, so that my index is never half staged. [Q18]
167. As a developer, I want a notice naming the tree actually committed when a hook or another process changed the index between the backstop check and the commit, so that the report matches what landed. [Q18]
168. As a developer, I want a run refused with `head-moved` when HEAD moved since planning, so that a commit never lands on a base I did not review. [Q18, C:cli-and-exit-codes]
169. As a developer, I want signing never disabled, so that my repo's signature policy holds for agent commits. [Q18]
170. As a developer, I want an SSH signing key with a passphrase that is not loaded in the agent refused at `plan` (`signing-locked`), so that no commit hangs on a passphrase. [Q18]
171. As a developer, I want enabled openpgp signing, and an SSH signing setup using a custom `gpg.ssh.program` (for example 1Password), noted in the plan, so that I expect a passphrase prompt may appear. [Q18]

### Time budget

172. As a developer, I want each `commit` call to return before a tool timeout can cut it (540-second budget; the first group always starts, a later group only while at least 480 seconds remain), so that no commit is cut mid-way. [Q18, C:commit-release]
173. As a developer, I want a call out of budget to stop cleanly with a `continue` handback that resumes after the committed groups, so that long runs finish. [Q18]
174. As a developer, I want a hung hook or a signing prompt nobody answers stopped at the budget, so that the call returns before the tool timeout and reports that a hook or a signing prompt may be waiting. [Q18]
215. As a developer, I want the plugin's own `index.lock` left behind by a timed-out partial `git commit` (reword's `--amend --only`) removed, while a lock another process created is kept, and after a timed-out plain commit (`split`, `staged`) any `index.lock` left in place with a notice to check it and remove it by hand if no git process is running, so that a timeout does not block my next git command and a foreign lock is never deleted. [Q18, C:commit-release]

### Reword via amend

175. As a developer, I want to reword the last commit with staged changes untouched, so that fixing a message is safe. [Q20]
176. As a developer, I want rewording refused on a pushed, unborn or merge-commit HEAD, so that shared history is not rewritten. [Q20]
177. As a developer, I want a root commit reworded against the empty tree, so that the first commit can be fixed too. [Q20]
178. As a developer, I want dictated text committed as given and a lint failure shown to me, so that my words are never rewritten unseen. [Q20]
179. As a developer, I want foreign trailers carried over, allowed footer tokens not carried and any Anthropic `Co-Authored-By` dropped, so that attribution is honest. [Q20]
180. As a developer, I want the attribution appended when the worker wrote the new message or the old message had one, so that my own dictated words stay mine. [Q20]
181. As a developer, I want a reword to scan the message but not the content and skip confirmation on the first spawn (a respawn after `lintFailed` confirms like any resumed run, stories 90, 95), so that it is quick. [Q20]

### Repo states

182. As a developer, I want an unborn HEAD planned against the empty tree, without `scanIgnore` and without a pushed check, so that the first commit works. [Q21]
183. As a developer, I want a detached HEAD warned about, so that I know where commits land. [Q21]
184. As a developer, I want an in-progress merge (including a pending `merge --squash`), cherry-pick, revert, rebase, bisect or paused sequence refused, so that those operations are never hijacked. [Q21]
185. As a developer, I want a non-repository or bare repository reported as an error, so that I know why nothing ran. [Q21]
186. As a developer, I want a repo whose `i18n.commitEncoding` is not UTF-8 (any spelling of `utf8` or `UTF-8`, case-insensitive, counts as UTF-8) refused, so that no commit is mislabelled. [Q21]

### Concurrent runs

187. As a developer with parallel implementers, I want a run lock, so that runs cannot clobber each other's index. [Q22]
188. As a developer, I want a live lock refused with its start and last-active times, so that I know who holds it. [Q22]
189. As a developer, I want a lock idle for 15 minutes taken over automatically, so that stale runs clear. [Q22]
190. As a developer, I want to take over a live lock by answering the question, replacing only that run, and not be refused because an earlier call was killed, so that a fresh run is never reset unasked. [Q22]
191. As a developer, I want a lock without a valid run ID (unparseable, or not in the minted form) never taken over by answering the question, only waited for until it ages out, so that nobody picks a run ID by guessing. [Q22]
192. As a developer, I want a taken-over or ended run refused at its next step, so that two runs never act at once. [Q22]
193. As a developer on Windows, I want file-in-use errors mapped to a lock refusal, so that I get no internal errors. [Q22]
220. As a developer on a filesystem without hard links, I want a run refused with a text saying the run folder's filesystem is not supported, while a file merely in use by another process is only reported as busy, so that the lock never fails open and a busy file is not mistaken for a missing feature. [Q22]
194. As a developer, I want a run's folder deleted with its lock, so that nothing lingers after a run. [Q9, Q22]
195. As a developer, I want run folders older than 24 hours swept, so that crashed runs leave nothing behind. [Q22]
196. As a developer, I want run folders excluded from git status without touching my `.gitignore`, so that they never show up as changes. [Q9]
197. As a developer, I want worktree isolation recommended for parallel implementers, so that each has its own index. [Q22]
221. As a developer in a linked worktree, I want each worktree to get its own run folder, lock and index, so that runs in two worktrees of one repo do not collide. [Q9, Q22]

### Install, README and opt-out

198. As a developer, I want a per-repo opt-out via `enabledPlugins`, so that repos with other conventions are untouched. [Q14]
199. As a developer, I want the README to require the anchored node allow rule for both shells and the run-folder `Edit` rule, and to explain why a bare `node *commit.js*` rule is unsafe, so that a run asks no permission and no lookalike script is allowed. [Q16]
200. As a developer, I want the README to require removing a personal commit skill, so that it does not capture "commit this" before the worker. [Q8]
201. As a developer, I want the README to state the gaps it cannot close, as one list ([Out of Scope](#out-of-scope), accepted gaps), so that I know the limits. [Q3, Q5, Q9, Q10, Q11, Q16, Q17, Q18, Q19, Q20, Q22, Q23]
223. As a developer installing the plugin, I want the README to present its allow rules as a required install step and say what goes wrong without them (the worker's calls stall on permission prompts), so that I set them up before my first run. [Q16, Q24]
202. As a developer, I want Node 22+ and git 2.34+ required, and an older git, older Node or missing git reported as such, so that support is predictable and failures are loud. [Q1, Q15]
203. As a developer, I want a plugin with no npm dependencies, so that the guard works from the first shell call, offline, with no install step and no third-party code watching my commands. [Q1]
204. As a developer whose plugin sits under a path containing `$`, a backtick, `"`, `\` or a typographic double quote (U+201C-U+201E), I want the first call refused with an explanation before any work, while an ordinary Windows path works, so that no shell ever expands or mangles the script path. [Q16, C:guard]

### Budget and release

205. As a developer, I want a plugin commit to cost my main session, as a median per episode class, no more calls than the harness floor of the delivery shape in use, and, as a median per episode, no more than 2k main-context tokens (cache writes plus output) above a direct commit, so that my usage limits last (a 1.0.0 dogfood gate only, not a 0.1.0 check; limits: [Dogfood gate](#story-verification)). [Q24]
228. As a developer, I want CI to hold the plugin's texts and outputs to fixed size budgets (a reply without its `text` ≤ 2 kB; `text` ≤ 4 kB with every list capped at 10 entries; `plan`'s own fields ≤ 1 kB; `plan --hunks` stdout ≤ 20 000 characters; the worker prompt ≤ 6 kB), so that a run cannot grow the context it costs without a failing test. [Q24, C:reply-and-handback]

### Run integrity

206. As a developer, I want a run ID accepted only in the exact form the script mints, and every deletion kept inside the run-folder directory, so that a forged lock, flag or reply cannot make the plugin delete anything else. [Q22, Q25]
207. As a developer, I want a `.commit-plan` that is tracked, a link or not a directory refused, so that a cloned repo cannot redirect the plugin's writes. [Q9, Q22]
208. As a developer, I want `commit` refused without `--confirmed` while a confirmation is pending, and only the `yes` answer's `run` to carry `--confirmed`, so that a steered worker cannot skip the question with a plain `commit --all` or a forged `continue` (a forged no-user answer and a rewritten run state remain gaps, see [Out of Scope](#out-of-scope)). [Q16, Q25]
209. As a developer, I want a second call on a run refused while another call on the same run is still running, so that a retried call cannot corrupt the run in progress, and a retried call after a crash not blocked by the killed one. [Q22]
210. As a developer, I want a run whose call was killed while staging to report what it unstaged when the next run takes it over, whatever that next run ends with (a clean tree, `modeChoice` or a refusal included), without the killed call blocking that takeover, so that my earlier staging is never lost without a word. [Q18, Q22]
217. As a developer, I want pressing Esc or ending the session to stop the script's git and hook processes, so that no commit lands after I stopped the run (pending the tool-termination item in [Open items](#open-items)). [Q9, Q18]
224. As a developer who updated the plugin mid-run, I want a run started by another plugin build refused as `ended`, so that no call acts on state it cannot read. [Q16]
211. As a developer, I want unresolved conflict entries in my index refused, so that conflict markers are never committed. [Q21]
212. As a developer, I want a file whose attributes call it binary but whose content is text scanned as text, so that a `-diff` or `binary` rule cannot hide a secret. [Q10]
213. As the Claude main session, I want a worker whose script call prints output that is not JSON (a Node too old to parse the entry point, before 12; a removed plugin version) to return the fallback reply quoting that output escaped and capped like relayed git or hook output (story 218), so that nobody guesses what happened. [Q1, Q25, C:worker-input]
229. As the Claude main session, I want to show the user the output of a handback `run` that holds no reply and to run nothing more, leaving the lock to the takeover question (story 59), so that a broken script call stops the handback visibly and nobody guesses what happened. [Q22, Q25, C:reply-and-handback]
227. As a developer, I want a takeover that finds only the killed group's paths staged to reset the index, and one that finds more than that never to commit the extra staging unasked (an interactive run asks `modeChoice`, a `--no-user` run refuses with `killed-leftover` naming the killed group's paths still staged, a `--reword` run goes on with a notice naming them), and the killed run's folder kept until that repair is done, so that a killed run's leftover staging is handled safely even when the takeover itself is killed. [Q17, Q18, Q22]

## Implementation Decisions

### Glossary

- **run**: one `planId`, from `plan` to release (the lifetime of the lock and run folder).
  **episode**: one user request, from the first commit attempt (a denied `git commit`
  included) to the final reply; it may hold several runs (a takeover, a re-plan after
  `diff-changed`) (Q24).
- **worker**: the `commit:commit-worker` agent (Q24, Q25). **caller**: whoever spawned it
  (main session, subagent, `/commit`, a workflow skill).
- **intent**: optional free text from the caller that scopes a run (public, Q2).
  **interactive**: the caller's statement whether a user can answer: `true` (the default,
  also what an omitted value means), in which case the worker returns handbacks and the
  caller decides, following `ifNoUser` when no user can answer, or `false` (which the worker
  passes to the script as the flag `--no-user`) (Q17). A caller knows no user can answer when
  `AskUserQuestion` is absent from its tool list and
  from its deferred-tool list, with no ToolSearch call (Q17).
- **bucket**: a path-derived grouping hint (M9 `bucketOf`), never a grouping rule (Q11).
- **pass-up**: passing a question the worker's caller cannot answer up to its own caller
  (the `handedBack` handback, Q17, Q25).
- **deny share `d`**: in the dogfood gate, the share of episodes in which the guard denied a
  direct `git commit` (Q24).
- **delivery shape**: how the worker's final report reaches the caller (Q25): the
  **notification shape** (its last message, delivered in the completion notification) or
  the **`SubagentHandback` shape** (a `SubagentHandback` tool call, followed by the
  completion notification). Not to be confused with a **handback** (below).
- **mode**: `split` (group everything), `staged` (the pre-staged set as-is), `reword` (amend
  the last message).
- **unit**: one hunk or whole-file change, ID `h1…hN`, identified by a content **hash**; the
  **unit table** holds each unit's ID, hash, path, old path, status, kind, identity key (the
  hash without the occurrence index, for identical hunks) and summary-only flag.
- **pinned diff options**: the fixed diff flags that define a unit (Q11); private to M10.
- **temporary index**: a copy of the real index in the run folder, `git reset -q` on the copy
  so it matches HEAD while keeping its stat cache and sparse-checkout entries (empty when
  unborn), plus intent-to-add of the stored path lists (Q11 step 1); paths with
  `ignored: true` are added with `-f`. Never built from HEAD alone: out-of-cone
  sparse-checkout paths would then show as deleted.
- **inventory**: candidates, staged-new, `indexOnly`, dirty submodules, tracked directories,
  pre-staged paths, gathered by `plan` before diffing.
- **candidate / hidden / collapsed**: untracked-file categories (C:untracked-files).
  **staged-new**: a path the real index adds versus HEAD. **stagedExcluded**: a staged-new
  path that is hidden, or (in `split` only) inside a collapsed directory. **indexOnly**: an
  index entry that differs from both HEAD and the worktree (kept by blob ID).
- **summary-only**: a file shown as stats only and grouped as one whole-file unit;
  **cap**: the 3000 changed-line body cap (Q19).
- **hit**: a scan match, reported by pattern ID and location. **skipped**: a file whose
  additions exceed 1 MB, not scanned and listed in `scan.skipped` (a confirmation trigger
  when included).
  A binary (see M10) is **not scanned**: not listed and not a trigger.
- **notice**: a one-line fact the reply text must carry, for example guard, signing, config,
  detached HEAD, hits, `indexOnly` paths (the list is not exhaustive).
- **hunk index**: the entries (one per unit: ID, stats, range, `body`, `scan`) that the
  worker groups from, in `plan`'s stdout (spilled to `hunks.json` past the 20 000-character
  budget, pending the tool-output-limits check in Open items). **Hunk bodies**: the
  `hunks.txt` blocks the entries point to, read by line range (M13).
- **worker plan**: `plan.groups.json` (groups plus `notIncluded`, `source: worker|user`).
- **lint**: grammar, config rules, message scan and placement validation, all run by `check`.
- **confirm / humanOnly**: the computed confirmation; a `humanOnly` one is never answered
  without a user. **resumed**: set by a separate `plan --hunks`; forces confirmation in an
  interactive run (Q16).
- **reply**: the script-built final JSON (`version`, `status`, `planId`, `text`, `commits`,
  `notices`, `callerRule`, `handback`, C:reply-and-handback). **tree state**: the last line of
  `text`. **handback**: a self-describing question (`confirm`, `modeChoice`, `lock`,
  `lintFailed`, `handedBack`, `continue`) with `run` or `respawn` answers and `ifNoUser`.
  **Other**: `AskUserQuestion`'s free-text option.
- **script call**: a shell segment that runs the commit entry point with a subcommand, in the
  shape C:guard fixes; built and recognised only by S2.
- **run-folder directory**: `<toplevel>/.commit-plan/`, which holds every run folder and
  the run lock (the `run-folder` refusal is about this directory).
  **run folder / run lock / run state**: per-run working files (`<planId>/`), the single
  lock next to them, and the state file (C:run-folder); the lock's `touched` is its mtime
  (Q22). **`call.lock`**: a per-call lock inside a run folder, held by every call on that
  run so that two calls on one run never overlap (`busy`).
- **backstop**: `commit`'s rescan of the index before `git commit`.
- **heartbeat**: a guard-written file proving the hook ran (Q23).
- **plugin cache**: `<Claude home>/plugins/cache/`, where Claude Code installs marketplace
  plugins; a handback `run` names the script there. Handbacks work only from a marketplace
  install (a local marketplace is fine): with `--plugin-dir` the caller shows the command
  instead of running it (story 61; Q25 as amended; an accepted gap in Out of Scope).
- **Claude home**: `CLAUDE_CONFIG_DIR` when set, else the `.claude` directory in the OS home;
  resolved once by each entry point (story 112).
- **managed directory**: the platform's fixed managed-settings directory (Q5); the script
  reads only its `managed-settings.json` (the drop-in directory is not read in 0.1.0).
- **typed result**: `{ ok: true, … } | { ok: false, code, … }`, where `code` is a domain code
  (never a CLI kind); used by every module that can fail.

### Constraints

- **No npm dependencies, Node built-ins only, nothing vendored** (Q1; see Dependency policy).
- **Processes**: git, plus `ssh-add` for the signing probe and, on Windows, `taskkill` for
  the tree kill (resolved from `%SystemRoot%\System32`, never from `PATH`), all spawned
  through M2. Minimum git 2.34, Node 22 (Q15).
- **The guard runs on every shell tool call** (Q13): it exits early when the command lacks
  `commit` and never loads the commit machinery.

### Architectural decisions

- **Code split** (Q1, Q15 as amended). Two thin entry points over one shared library. The
  guard entry point loads only G1-G3, S1 and S2; S1 and S2 load nothing else. The commit
  entry point loads M1; layering is CLI (M1) → workflows (M18) → run policy and domain
  modules → adapters (M2 and the filesystem). Nothing below M18 calls upward.
- **Typed results and one error table.** Modules return typed results; only M18 maps domain
  codes to CLI kinds (table below); M1 alone owns kind → exit code and the envelope; an
  unexpected throw becomes `internal`.
- **Injected environment.** Each entry point resolves once and passes down: the clock
  (`now()`), the OS home, the Claude home, the managed directory (derived from the platform,
  never from `env`), `osUser` (from `os.userInfo()`, falling back to `USER` or `USERNAME`,
  else `null`, which skips the OS-user rule, story 139), the script's own path and `env`. Modules never read these ambiently. The shipped CLI has **no test-only switch**
  (no env knob, no flag): anything reachable from the CLI is reachable by an agent.
- **Asynchronous process adapter.** Every git call, read-only ones included, is spawned
  asynchronously by M2 with a timer from the call's `deadline`, so that a timeout can kill
  the whole tree while git, a hook, a clean filter or fsmonitor still runs (Q18), and the
  event loop is never blocked. `spawnSync` is reserved for M2's named short calls
  (`git --version` and `git rev-parse --show-toplevel` at start-up); the guard loads only
  G1-G3, S1 and S2 and spawns nothing. While a child
  runs, the commit entry point handles `SIGINT`, `SIGTERM` and `SIGHUP` by killing the
  active child's tree (M2) and removing the call's `call.lock` (M12) before it exits; it neither unstages nor releases
  (a takeover reports the unstaging through `indexReset`, below), so an
  Esc or a session end cannot leave `git commit` running as an orphan that lands a commit
  after the call ended.
- **One script-call shape.** S2 builds every `run` a handback carries and recognises script
  calls in the guard; the README allow rules and the worker prompt's command form follow the
  same shape, checked by the round trip (Testing Decisions).
- **One run owner.** M12 owns the run folder, lock and typed run state, including the folder
  lifecycle: `plan` gets a provisional run whose only exits are `acquire` (kept) or
  `discard` (deleted), so no workflow deletes folders.
- **Stored, not recomputed.** Everything a later call needs is stored by `plan` in the run
  state, so later calls are cheap and see exactly the diff `plan` scanned (Q9).
- **Versioned run state.** The state carries a `version`; every later call refuses a state
  written by another plugin build with `ended` (C:run-folder). The run folder is writable
  without a prompt under the README `Edit` rule (Q16); a tamper digest is deferred past
  0.1.0 (Out of Scope).
- **Run IDs are validated, deletions contained.** A `planId` is `crypto.randomUUID()` output;
  every `planId` the script reads (`--plan`, `--take-over`, a lock's content) must match that
  form exactly (lowercase UUID v4). M1 refuses a malformed flag value as `usage`; M12 treats a
  lock with a malformed `planId` like an unparseable one (story 191). Every folder or file M12
  deletes is resolved and checked to lie strictly inside `<toplevel>/.commit-plan/` (no `..`,
  not absolute, not the directory itself), and the sweep considers only entries named in the
  minted form, never following a link. The reply's shape check names the form too
  (story 206).
- **The run-folder directory is checked before use.** Before its first write, M12 `lstat`s
  `<toplevel>/.commit-plan`: a symlink, a junction, a non-directory, or a path tracked in the
  index refuses `plan` with `state` ("`.commit-plan` is tracked or not a plain directory;
  remove it by hand"); after `mkdir` it checks again (story 207).
- **One call per run at a time.** Every call with `--plan` creates `<planId>/call.lock`
  exclusively, and `plan --take-over` creates the `call.lock` of the old run it takes over
  (the old run's `planId`), so a call still running on that run and the takeover end in
  `busy` whichever comes first; a call whose `call.lock` or run folder vanishes under it
  (`ENOENT` after a takeover) ends as `taken-over`. Each removes it on exit; a second call on the same run while
  it exists is refused with `busy` (a call backgrounded by a tool timeout and then retried
  must not share the temporary index). The `call.lock` holds `{ pid, host }`: one whose host
  is this host and whose pid is dead (`process.kill(pid, 0)` → `ESRCH`) was left by a killed
  call and is stale at once, so a `--take-over` of that run is not refused `busy` (stories
  190, 210); any other `call.lock` is stale when older than the run's own staleness limit
  (15 minutes). A stale one is replaced with the lock's atomic takeover (story 209).
  `release` takes the `call.lock` only after reading a lock that holds its `planId`, so
  `busy` is the only `lock` refusal it can raise.
- **Confirmation is bound to its answer.** When `check` returns a `confirm` handback it stores
  `awaitingConfirm` in the run state; the `yes` answer's `run` carries `--confirmed`, which no
  other handback carries. `commit` refuses without `--confirmed` while `awaitingConfirm` is
  set (`unconfirmed`), and clears it on its first group. The base `callerRule` tells callers
  to run a command with `--confirmed` only as the answer the user picked, or as
  `ifNoUser.answer` without a user (story 208).
- **Entry points survive an old Node.** Both entry points are written in syntax every Node
  since 12 parses, check `process.versions.node` first (commit entry point: the `env` JSON
  refusal; guard: silent exit), and only then load the library with a dynamic `import()`.

| Fact | Produced by (at `plan`) | Read by |
| --- | --- | --- |
| state `version` | M12 | M12 `open` |
| paths that are not UTF-8 (each non-UTF-8 byte written as `\xNN`) | M10 | M14 (`notIncluded` extras), M17 |
| unit table, `id → hash` map, scan map | M10, M8 | M13 (index), M14 (paths, renames, new files, identical hunks), M15 (confirm), M16 (match), M12 `acquire` (takeover: the killed group's unit paths) |
| candidate, staged-new, `indexOnly`, `preStaged` lists | M10 inventory, M9 | M10 temporary index, M16 `unstaged`, M17 notices, M12 `acquire` (takeover: `preStaged`, `indexOnly`) |
| collapsed directories, `stagedExcluded`, `dirtySubmodules` | M9, M10 | M13, M14 (`notIncluded` extras), M17 |
| effective config values and `scanIgnore` at HEAD | M4 | M13 (`config.values` without `scanIgnore`), M14 lint, M16 backstop (recompiled through M7 on each call) |
| attribution trailer text and source | M5 | M14 (attribution flag), M16 trailers, M17 trailer line |
| `recentSubjects` (the last 10), `oldMessage` (reword) | M3 history query | M13 (`plan --hunks` output), M6 carry-over |
| expected HEAD, notices, `interactive`, mode | M3, M18 | M15, M16, M17 |
| index fingerprint (updated after each of the run's own commits) | M10 `indexFingerprint` | M16 `index-changed` check |
| `lintFailures`, `resumed`, `awaitingConfirm`, validated groups, `indexReset`, `treeChangedDuringCommit` | later calls | M12 `acquire` (takeover: validated groups, `indexReset`, current group status), M15, M16, M17 |

### Domain code → CLI kind (owned by M18)

| Domain code | Producer | CLI kind | Exit |
| --- | --- | --- | --- |
| bad argv or flag combination, malformed `planId` | M1 | `usage` | 1 |
| `unconfirmed` (`commit` without `--confirmed` while a confirmation is pending) | M16 | `usage` | 1 |
| `staged-empty` (`--staged` with an empty index) | M15 `resolveMode` via M18 | `usage` | 1 |
| `already-committed` (`check` after a committed group) | M15 `checkGate` | `usage` | 1 |
| `no-groups` (no stored groups, or all committed) | M16 | `usage` | 1 |
| `config` (invalid layer or glob) | M4, M7 | `config` | 1 |
| `env` (git missing, git < 2.34, Node < 22, an install path containing `$`, a backtick, `"`, `\` or a typographic double quote (U+201C-U+201E)) | entry point, M3 | `env` | 1 |
| `not-a-repo`, `bare`, `in-progress` (incl. a pending `merge --squash`), `unmerged`, `unborn` or `merge` HEAD in reword, `encoding` | M3 via M15 | `state` | 6 |
| `run-folder` (`.commit-plan` tracked, a link or not a directory; its filesystem does not support hard links) | M12 | `state` | 6 |
| `killed-leftover` (`--no-user` without `--reword`: a takeover found staging beyond the killed group's paths; lock released, folder deleted, index untouched) | M15 `resolveMode` via M18 | `state` | 6 |
| `signing-locked` | M11 via M15 | `signing` | 6 |
| `pushed` | M3 via M15 | `pushed` | 6 |
| `staged-hit` | M15 | `staged-hit` | 6 |
| `held` (also from `peek` at `plan` step 3), `taken-over`, `ended` (also a state `version` mismatch), `busy` (also a live `call.lock`) | M12 | `lock` | 6 |
| `index-locked` | M10 via M16 | `index-lock` | 6 |
| `unmatched` (hash set differs), `mismatch` (staged ≠ group) | M10 via `plan --hunks` and M16 | `diff-changed` | 6 |
| `index-changed` (index fingerprint changed, HEAD unchanged) | M18 `plan` step 7; M16 before each group | `diff-changed` | 6 |
| `head-moved` | M3 via `plan` (after `acquire`), `plan --hunks` and M16 | `head-moved` | 6 |
| `lint` | M14 | `lint` | 2 |
| `backstop-hit` | M8 via M16 | `scan` | 3 |
| `git-failed` (also a failed `git add` in M10 `snapshot`, in `plan`, `plan --hunks`, `check` and `commit`); `stage-failed` (`git apply --cached` or `git add` failed after the reset) | M16, M10 via M18 and M16; M10 via M16 | `git` | 4 |
| `timed-out` (also `plan` or a separate `plan --hunks` past its 540-second deadline) | M2 via M16 and M18 | `timeout` | 5 |
| unexpected throw | any | `internal` | 1 |
| clean tree (`nothing`; never in `reword`) | M15 `planRefusal` | none: success reply `status: "nothing"`, folder discarded | 0 |

Every step after `acquire` runs inside a `try`/`finally` in M18: when the current group
reached staging (phase (c)), the `finally` unstages it and the output carries `unstaged`;
`internal` then releases the lock and deletes the folder like any other ending refusal, so
the next `/commit` starts fresh (C:cli-and-exit-codes error table). The `finally` and the
reporting calls after a failure or timeout (unstage, HEAD re-read, `treeState`, release) run
against M15 `cleanupDeadline`, never the spent `deadline`. Before an `internal`
reply ends the run, M16 re-reads HEAD, so a commit it already made is reported with its
`sha`.

A killed process (Esc, a session end, a signal) runs no `finally`; the signal handler only
kills the child tree and removes `call.lock`, so a group killed during phase (c) can leave
part of its staging in the index. The run state records `indexReset` before staging
starts, so the evidence survives. A takeover (automatic or `--take-over`, both at M18
`plan` step 3, before step 4) runs in three steps: M12 `acquire` moves the lock and returns
the taken-over run's facts, read from its `state.json` without deleting its folder; M18
repairs the index; M12 `finishTakeover` then deletes the old folder. When those facts show
`indexReset` set and the current group not `committed`, M18 computes M10
`unstagedAfterReset` from their `preStaged` and `indexOnly` lists and repairs the index
before `inventory`: when nothing is staged (index equals HEAD, e.g. a kill in phase (a) of
a later group), it neither resets nor gives the reset notice; when every staged path
(index versus HEAD) belongs to the killed group's paths (the set C:run-folder defines), it
runs `git reset -q` and the takeover notice says the killed group's partial staging was
reset; otherwise (the user staged something else after the kill, so the index holds paths
beyond that set) it leaves the index untouched and sets `killedLeftover` for `resolveMode`
(below): an interactive `split` or `staged` run gets `modeChoice` whatever the flags
(`--staged` included) and the index shape, whose notice names the killed group's paths
still staged; `--no-user` without `--reword` refuses with `killed-leftover` (exit 6
`state`, text naming those paths; the lock is released and the folder deleted); `--reword`
goes on with a notice naming those paths, since `--amend --only` never touches the index.
So the leftover is never committed unasked. A kill during the repair leaves the old folder
and its `indexReset` for the next takeover (C:run-folder: the renamed lock file names the
run to read). The new run's reply carries the `unstaged` notice either way (stories 210,
227; Q17, Q18 and Q22 as amended).

### Modules

| Module | Kind | Depends on |
| --- | --- | --- |
| M1 CLI and envelope | effectful (stdout, exit code) | M18 |
| M2 Process adapter | effectful | — |
| M3 Repo-state probe | effectful, read-only | M2 |
| M4 Config loader | effectful, read-only; pure merge and validation | M2, M7 |
| M5 Attribution resolver | effectful, read-only | M6 |
| M6 Message grammar | pure | — |
| M7 Glob matcher | pure | — |
| M8 Scanner | pure | M7 |
| M9 Path classifier | pure | — |
| M10 Change-set engine | effectful (temporary and real index) | M2, M9 |
| M11 Signing probe | effectful | M2 |
| M12 Run | effectful | M2, M10 |
| M13 Hunk index renderer | pure | — |
| M14 Plan validator | pure | M6, M8 |
| M15 Run policy | pure | — |
| M16 Commit executor | effectful (clock injected) | M3, M6, M7, M8, M10, M12, M15 |
| M17 Reply and handback | pure | S2 |
| M18 Subcommand workflows | effectful orchestration | all M modules except M1; S1 |
| M19 History inference | pure | M4 (pure `validateLayer` only), M6 |
| S1 Heartbeat | effectful | — |
| S2 ScriptCall | pure | — |
| G1 Hook I/O | effectful (Claude home, now injected) | G2, G3, S1 |
| G2 Shell tokenizer | pure | — |
| G3 Command classifier and deny catalogue | pure | S2 |

No cycles; an edge from a pure module reaches only pure exports (M19 uses M4's pure
`validateLayer`, never its file reads). The former G4 (deny messages) is data inside G3, so a
new deny case edits one module. The finer split (M7 apart from M4, M11 apart from M3, M13
apart from M17) is kept because each of those modules has its own contracts table as a test
oracle and its own consumers (M7 also serves M8; M13 renders for the worker, M17 for the
caller). The episode-analysis tools (Q24) are a maintainer utility outside the plugin package
and outside this module map. Decisions for them: the input is Claude Code session transcripts
(the source of the Q24 baseline), the worker's own transcripts included for worker tokens; an
episode (glossary) starts at the first main-thread commit attempt after a user prompt (a
`git commit` shell call, denied or not, or an Agent call spawning `commit:commit-worker`)
and ends at the main-thread turn that presents the last reply before the next user prompt
that is not an answer to a handback question; each episode records its delivery shape and
episode class, and the output is the Dogfood gate's measures ([Story verification](#story-verification)).
The tools are built for the 1.0.0 gate, after 0.1.0 ships; no 0.1.0 slice depends on them.

**M1 CLI and envelope.** Peel the subcommand off argv, then one strict `parseArgs` per
subcommand (`no-user` declared literally, never `allowNegative`); reject illegal flag
combinations as `usage`; route to M18; print exactly one JSON object (`version: 1`) on
success and failure; kind → exit code 0-6; debug to stderr only; no subcommand reads stdin.
`main(argv, env) → { stdoutJson, exitCode }`. Sources: Q9, C:cli-and-exit-codes.

**M2 Process adapter.** The only module that spawns processes. Mechanism only: for git,
working directory = toplevel; on every call except `git commit`, every inherited `GIT_*`
variable is removed except a keep-set (`GIT_EXEC_PATH`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`), so
`GIT_ATTR_SOURCE`, `GIT_TRACE*` and the object-directory variables cannot reach the scan, and
the signing probe reads the same config files `git commit` does; `git commit` removes
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
`GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`, `GIT_CONFIG_PARAMETERS`, `GIT_ATTR_SOURCE`,
`GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` and keeps the rest for the
user's hooks; `GIT_OPTIONAL_LOCKS=0` on read-only calls
(never on staging or commit); optional alternate index; `GIT_LITERAL_PATHSPECS=1`,
`core.quotePath=false` and `diff.suppressBlankEmpty=false` on every call except `git commit`,
which takes no pathspec and runs with neither, so hooks inherit the user's own git
environment (stories 147 and 163, Q9); history reads also pin
`log.showSignature=false` and `i18n.logOutputEncoding=UTF-8`; NUL-separated output where git
offers `-z`; stdin for message input and path lists; `windowsHide` on every spawn; a timeout
that kills the process tree: on POSIX `SIGTERM` to the process group, then `SIGKILL` after a
5-second grace; on Windows `taskkill /T`, then `taskkill /T /F` after the same grace (the grace is
intended: bounded, and inside the cleanup window). The
`timeoutMs` of every M2 call, in `plan` as in later subcommands, is computed from the call's
`deadline` (M15), or from `cleanupDeadline` for the cleanup and reporting calls after a
failure or timeout, so `plan`'s calls before `acquire` are bounded too. Every call is
asynchronous; only `toplevel` and `gitVersion` use `spawnSync`, each under a fixed short
timeout. `stdout` is returned as a `Buffer`, never decoded by M2, so diff output keeps its
raw bytes; with an `onStdout(chunk)` consumer (M10's patch pass only) each chunk goes to it
as it arrives and nothing is buffered. M2 tracks the child it is running; `killActive()`
kills that child's tree the same way, for the entry point's `SIGINT`/`SIGTERM`/`SIGHUP`
handler.

`run(cmd, args, { index?, input?, timeoutMs, readOnly?, commit?, onStdout? }) → { code,
stdout: Buffer, stderr, timedOut, spawnedAt }` (`stdout` empty with `onStdout`); `toplevel(fromCwd)`; `gitVersion()`; `gitPath(names)` (one
`rev-parse --git-path` call); `killActive()`. Sources: Q9, Q18.

**M3 Repo-state probe.** Every question about repository state, as typed results: not a
repo or bare; unborn, detached and current HEAD from one porcelain v2 `--branch` status
(pinned `--untracked-files=no --ignore-submodules=all`);

unmerged entries (any `u` line of that same status, such as a conflicted `stash pop` that
left no in-progress marker) → `unmerged` ("resolve the conflicts first"); in-progress merge,
cherry-pick, revert, rebase, bisect or `sequencer/` via `gitPath`; a pending
`merge --squash`, detected by `SQUASH_MSG`, with its own text ("a squashed merge is staged:
commit it by hand, or drop it with `git reset --merge`"); `i18n.commitEncoding` not UTF-8,
compared case-insensitively with `utf-8` and `utf8` (story 186); git and Node versions; for
`reword`, unborn, merge commit, root commit and pushed (one `for-each-ref --contains` over
remote-tracking refs, skipped when unborn); `head()`; `headTree()` (the tree ID of
`HEAD^{tree}`, which M16 compares with the tree its backstop scanned); history reads (`recentSubjects`,
`oldMessage`, and the last 200 non-merge messages for `infer`). Sources: Q18, Q20, Q21, C:plan, C:commit-release.

**M4 Config loader.** Read the user layer from the Claude home and the repo layer from the
worktree, plus `scanIgnore` from the repo layer at HEAD (none when unborn); validate types
and ranges; per-key override; warnings (unknown key or value, wrong layer) versus errors;
defaults; `sources` per key. Every `scanIgnore` pattern is compiled by M7 `compileGlob`,
whose `config` errors (including a pattern with no literal character) M4 reports as layer
errors. Returns compiled `scanIgnore` matchers (via M7) and exports
`isRepoConfigPath(path)`, so M8 compiles nothing and knows no config file names. It also
owns the `scanIgnore` change test, pure so that no other module parses the config: pure
`scanIgnoreChanged(headPatterns, snapshotBlob) → boolean` compares the `scanIgnore` patterns
`loadConfig` read at HEAD with the `scanIgnore` parsed from the repo config's content on the
snapshot side (M10 `snapshotBlob`). A missing file or key counts as no patterns; the two
lists are compared in order, element by element, so an edit to another key never counts;
a snapshot blob that is not valid JSON, or whose `scanIgnore` is not an array of strings,
counts as changed.
`loadConfig({ claudeHome, toplevel, unborn })`, `readLayers(…)`, pure
`validateLayer(obj, layer)`, all typed. Sources: Q6, Q10, C:plan, C:plan---hunks.

**M5 Attribution resolver.** Resolve the trailer from the Claude settings layers, highest
first: managed (`managed-settings.json` only; the drop-in directory is not read, Out of
Scope), project-local, project (project directory = `CLAUDE_PROJECT_DIR`, else the
toplevel), user (in the Claude home). Two passes: `attribution.commit` (empty string = no
trailer), then `includeCoAuthoredBy`. Keep trailer-shaped lines only, warn on dropped
lines. MDM profiles, registry policy and server-managed settings are not read; the source
is reported and the README names the gap (story 116). `managedDir` is the injected managed
directory. `plan` outputs `attribution: null` when the resolution yields no trailer (an
empty `attribution.commit` or `includeCoAuthoredBy: false`); the source is known at `plan`
and stored for M16 and M17 (C:plan).
`resolveAttribution({ env, claudeHome, toplevel, managedDir }) → { trailer | null, source,
warnings }`. Sources: Q5, C:plan.

**M6 Message grammar.** Byte normalisation (BOM, UTF-16, invalid UTF-8, CRLF and lone CR,
trailing blank lines) with `TextDecoder` `fatal`; one parser for header, body and footers
(Conventional Commits footer grammar), shared by lint, `infer`, attribution and append;
lint against config (`maxSubjectLength` in code points); allowed agent footer tokens;
reword carry-over (foreign trailers kept verbatim, allowed tokens not carried, every
`Co-Authored-By: … <noreply@anthropic.com>` dropped); append in the order new footers,
carried trailers, attribution, into the footer paragraph when the message ends in one,
otherwise as a new last paragraph (Q5). `normalise`, `parse`, `lint`, `carryOver`, `appendTrailers`.
Sources: Q5, Q7, Q13, Q20, C:message-grammar.

**M7 Glob matcher.** Compile and validate `scanIgnore` patterns per C:scanignore-globs;
case-sensitive whole-path match on every OS; linear time. A pattern with no literal
character (only `*`, `?`, `**` and `/`, such as `**`, `**/*`, `**/?*` or `*/**`) is a
`config` error, so one amended line cannot switch the scan off; a broad literal pattern
(`src/**`) stays legal, an accepted gap (Out of Scope). `compileGlob(pattern)` (typed,
code `config`),
 `matches(matcher, path)`. Sources: Q10, C:scanignore-globs.

**M8 Scanner.** The pattern table of C:scan-patterns as data (ID, regex with whole-regex
flags only, false-positive rule, source) with its false-positive rules; added lines only;
binaries not scanned; files with more than 1 MB added, tracked or untracked, skipped and
reported; honours `scanIgnore` matchers; when passed `scanIgnoreChanged: true` (M4's
pure test, run by M18), flags every unit whose path or old path is the repo config
(`isRepoConfigPath`), since a whole-file comparison cannot tell which hunk carries the
change; with `false`, as when only another repo-config key was edited, it flags none, and
M8 itself parses no config; never returns a
matched value; the same patterns run over messages.
A symlink's target is scanned as one added line of its unit (Q11; Q10 as amended). The
regexes and false-positive rules (among them the one-line `private-key` form, the RFC 1421
header lines and the `generic-secret` spellings) are C:scan-patterns' and are not restated
here. Every regex runs on a line cut to its first 4096
characters (C:scan-patterns), so scanning stays linear in the input; the cut is an accepted gap (Out of
Scope). Binaries (M10) and credential containers are not scanned (Out of Scope).
`scanUnits(units, { scanIgnore, osUser, scanIgnoreChanged, isRepoConfigPath }) → { hits,
skipped, scanIgnoreUnits }` (the last two options only from `plan`; the backstop passes
neither and gets an empty `scanIgnoreUnits`); `scanText(text, { osUser }) → [{ patternId, start, end }]` (UTF-16
offsets into `text`, `end` exclusive, never the matched value), the spans M14 passes on with
its lint errors so M17 can replace the union of the spans with `[<pattern-id>]` (the first
hit's ID where spans overlap). Sources: Q10, Q19,
C:scan-patterns.

**M9 Path classifier.** Pure classification of paths, in two mode-aware steps so that mode
can be resolved in between: `hideFilter(paths) → { candidates, hidden }` (hidden rules,
`.env*`, mode-free) and, in `split` only, `applyCaps(candidates, stagedNew, trackedDirs) →
{ candidates, stagedNew, collapsed, stagedExcluded }` (topmost new directory, root as `"."`,
loose files per parent only when they alone exceed 200, ties by byte order; the caps count
both inputs together). The returned `candidates` and `stagedNew` are the survivors, outside
every collapsed directory. Per collapsed directory, its untracked candidates become a
`collapsed` entry `{ dir, count, bytes }` and its staged-new paths a `stagedExcluded` entry
`{ dir, count, reason: "collapsed" }`, each counting only its own kind: a directory holding
only staged-new paths appears in `stagedExcluded` alone, one holding both appears in both. Also `bucketOf(path)` and
`summaryOnly(path, stats) → reason | null` in C:summary-only-files order. `applyCaps` sums
the `bytes` of each collapsed directory from the candidates' sizes, which M10 `inventory`
sets together with `binary`. Sources: Q11, Q16,
Q19, C:untracked-files, C:summary-only-files.

**M10 Change-set engine.** Q11's "one function", the only owner of the pinned diff options
and of the real index.
- `inventory()` → the inventory lists (`stagedNew` and `indexOnly` carry `ignored`;
  `indexOnly` carries the blob ID; every candidate carries its size in bytes and `binary`,
  which M9 `applyCaps` and M13 read; in `staged` mode it also counts `unstagedLeft`, `null`
  in `split` and `reword`, C:plan---hunks).
- `snapshot({ mode, storedLists, indexPath })` → units. Builds the temporary index by
  copying the real index and running `git reset -q` on the copy (empty when unborn), then
  `git add -N` of the stored lists, skipping missing paths (Q11 steps 1-3); paths with
  `ignored: true` go in a separate `git add -N -f` call, so no other ignored path is added.
  A non-zero `git add` exit counts as failed even when some paths were added (`git-failed`,
  whichever subcommand ran the snapshot: `plan`, `plan --hunks`, `check` or `commit`). Runs the pinned diff
  (worktree, index versus HEAD, or HEAD's own diff against its parent or the empty tree for
  a root commit) with exactly Q11's pinned options; `diff.renameLimit` stays the user's
  (Q11). Paths and whole-file kinds come from a `--raw -z` pass, so no path is ever parsed out
  of patch text; the patch pass supplies only hunk bodies, ranges and the added lines the
  scan reads. The patch pass is one `git diff -z --raw -p` call over the whole diff, with no
  pathspecs (a path list would go on argv, and a pathspec narrows rename detection, Q11),
  read as a stream (M2 `onStdout`) keeping only what a later step needs: hunks of
  body-carrying units and, for M8, added lines up to the 1 MB scan limit (then the file is
  skipped, Q10), so memory stays bounded by the Q19 and Q10 caps. Section *i* belongs to raw
  record *i* and takes its path, except that a type-change (`T`) record (file↔symlink,
  file↔submodule) owns two consecutive sections with its path (git prints a delete, then a
  new file) and is one whole-file unit; a section count or path that does not match the raw
  pass under this rule is `internal` (C:plan---hunks). **Raw bytes**: diff output stays a `Buffer` from M2 onward; records split on
  NUL, sections and lines on `\n` bytes, and hunk bodies, unit hashes and built patches use
  the raw bytes, so a Latin-1 file or CRLF content is staged exactly as git showed it. Only
  presentation decodes, lossily: M13 for the worker's body text, M17 for the reply, and M8
  scans a lossy decode (its patterns are ASCII); none of them feeds a hash or a patch. A path
  that is not valid UTF-8 is not a unit: it goes to `notIncluded` ("path is not UTF-8 —
  commit by hand"), since `state.json` and the reply carry paths as strings; its string
  form writes each non-UTF-8 byte as `\xNN`. Whole-file unit categories: new,
  deleted, binary, summary-only via M9, rename, mode, symlink, submodule, filtered: one
  `check-attr --stdin -z` call queries `filter` and `linguist-generated` together, and the
  latter goes in `stats` to M9 `summaryOnly`; hashes with `crypto.createHash`. **Hidden by an attribute**: for a path git
  reports as binary (`-\t-` in `--numstat`), the same `check-attr` call also queries `diff`
  and `binary`; only a path whose attributes hide its diff (`-diff`, `binary`, or a `diff`
  driver) gets the content check: its size is checked against the 1 MB scan limit first
  (over it, the file is skipped, Q10), then it is binary when its new content has a NUL byte
  in git's first-8000-bytes window. A path git reports binary without such an attribute
  (NUL content, or over `core.bigFileThreshold`) stays binary with no check (Q10 as
  amended). An attribute-hidden file without a NUL is text: the unit has `kind: "text"`, is one whole-file unit (staged with
  `git add`) whose `body` is like a summary-only file's (no hunk block), and its added lines
  are scanned (story 212). They come from a second whole-diff `git diff -z --raw -p --text`
  pass, run only when such a file exists, streamed like the first and keeping only those
  files' sections: the same rename detection, the same section-to-record pairing (a `T`
  record owns two sections), and no path list on argv. Units come from git's
  diff, which already compares converted content, so `core.autocrlf` and `eol` attributes
  need no handling of their own; conversion warnings on stderr are not errors.
- `snapshotBlob(path) → Buffer | null`: the repo config's content on the snapshot side of
  the last `snapshot` (the working-tree file in `split`, the index entry in `staged`;
  `null` when the path is absent there), which M18 passes to M4 `scanIgnoreChanged`.
- `assignIds(units)`, `matchIds(idMap, units)` (typed, `unmatched`).
- Backstop reads (M16): `writeTree() → treeId` records the real index's tree
  (`git write-tree`); `treeDiffUnits(fromTree, toTree) → units` diffs two trees (`fromTree` the
  expected HEAD, or `null` for the empty tree when unborn) with the same pinned options,
  the same `--raw -z` pass, streamed patch pass and section-to-record pairing, the same
  `check-attr` call and attribute-hidden `--text` pass (story 212), and the same 1 MB
  streaming scan limit as `snapshot`, keeping only what the scan reads. So the backstop
  scans the tree it recorded exactly as `plan` scanned the snapshot, and no other module
  holds a diff option.
- Path lists never go on argv: staging, attribute and index calls pass them on stdin,
  NUL-separated, so a large rename group cannot hit the Windows command-line limit (Q11,
  C:commit-release).
- Real index: `stage(groupUnits)` (reset, apply the patch built from current ranges with
  `git apply --cached --whitespace=nowarn`, whole-file adds, then verify the staged hash
  set; typed: `mismatch`, or `stage-failed` when `apply` or `add` fails after the reset;
  ignored whole-file paths go in a separate `git add -A -f` call, and a non-zero `git add`
  exit counts as `stage-failed` even when some paths were added). The built patch reuses,
  per file, git's own header lines from the current diff verbatim (`diff --git`, mode,
  rename, `index`, `---` and `+++` lines), followed by the group's hunks as raw bytes, so a
  path with quotes, tabs, newlines or leading spaces is quoted exactly as git quotes it and
  `git apply` parses it back; the builder never formats a path itself.
  `verifyIndex(groupUnits)` for `staged`; `unstage()`; `indexLockExists()`;
  `commitGuarded({ args, input, timeoutMs, partial }) → { code, stdout, stderr, timedOut,
  lockRemoved, lockLeft }`: the whole stale-`index.lock` mechanism, so no other module
  writes a marker or touches the lock. It resolves the lock path through M2
  `gitPath('index.lock')` (the per-worktree git directory), brackets the `git commit` spawn
  and a timeout's tree kill with two marker files next to it. With `partial` (reword's
  `--amend --only`, where git holds the lock until the kill) it removes a leftover
  `index.lock` only when its mtime lies between the markers, so it never removes a foreign
  lock; without it (a plain commit, `split` and `staged`, where git released the lock before
  the hooks ran) it never removes the lock and sets `lockLeft` when one exists, which M16
  turns into the notice "index.lock was left in place — if no git process is running, check
  it and remove it by hand". A lock it keeps is also reported by the next `index-lock`
  refusal (story 166; the mtime rule is in Q18). The stale-lock case is covered by a
  fixture with a real `git commit` timeout, shortened by a clock step that holds at start
  (Clock at Seam 1);
  `unstagedAfterReset(preStaged, indexOnly)`; `indexFingerprint()` (a hash of
  `git ls-files --stage -z`: read-only, takes no index lock, works while an `index.lock`
  exists and never rewrites the index; an intent-to-add entry and a staged empty file look
  alike, both the empty blob, which is accepted; used by `plan` step 7 and by M16 before each
  group); `treeState() → { clean: true } | { count, paths }`
  (paths capped at 10 plus "+N more" by M17), read after the subcommand's last git call by
  every M18 workflow that builds a reply (`plan`, `plan --hunks`, `check`, `commit`,
  `release`).
Sources: Q9, Q10, Q11, Q18, C:plan---hunks, C:commit-release.

**M11 Signing probe.** When `commit.gpgsign` is true (read with `--type=bool`): SSH format →
`true` when the key is listed by `ssh-add -L`, or when the private key file has no
passphrase, decided by parsing its header with no extra process; a key with a passphrase not
loaded in the agent → `false` (`signing-locked`); anything the probe cannot decide →
`"unknown"`. Every case, in order, is per the SSH readiness table of C:plan, which is
exhaustive; `~/` expands against the injected OS home, and `ssh-add` is taken only from the
directory of the `ssh-keygen` git runs. openpgp → `"prompt"`, with the note "signing enabled; a passphrase prompt may appear" (a
locked openpgp key is not detected; Out of Scope). x509 or custom `gpg.program` →
`"unknown"`; custom `gpg.ssh.program` → `"prompt"`. Never pops up a prompt. The probe runs
only git and `ssh-add`, each under a fixed timeout; a timeout ends as `"unknown"` instead of
stalling `plan`. It runs after clean-tree and `staged-hit` detection (M18 `plan` step 6), so
a clean tree on a locked key reports "nothing to commit". `probeSigning({ home, toplevel, execPath, deadline })
 → { enabled, format?, ready }`. Sources: Q18, C:plan.

**M12 Run.** Everything under the run folder. Check `.commit-plan` (Run-folder directory
check above); add the exclude line once (path from `gitPath`, `info/exclude`, which git
resolves to the common dir, so every worktree shares the one entry; only the run folder and
its lock are per worktree, Q9); mint `planId`
(`randomUUID`); provisional folder, then `acquire` (the lock `{ planId, created }` is
written to a temporary file in `.commit-plan/` and hard-linked into place, which fails
when a lock exists, so no reader ever sees a lock without its content: an existing lock →
`held`; on Windows `EPERM` and `EBUSY` are retried like the state rename, and one that
persists falls back to a hard-link probe of a temporary file in `.commit-plan/`: the probe
succeeds → `busy` (the file is in use, story 193), the probe fails → `run-folder` ("the run
folder's filesystem does not support hard links"); `ENOTSUP` or `ENOSYS` is `run-folder` at
once, without a probe; the errno mapping is in C:run-folder) or `discard`; a read-only `peek()` reports a live lock without
acquiring anything (M18 skips it under `--take-over`);
verify-and-touch on `open` and before each group (`touch()`); the per-call `call.lock`
(`{ pid, host }`) on `open`, removed when the call ends, stale at once when its owner pid is dead
on this host, else like the lock at 15 minutes, and replaced with the same atomic takeover; staleness at 15 minutes by mtime against the injected
clock, including for an unparseable lock or one whose `planId` is not in the minted form,
which is never taken over by `--take-over`; atomic takeover by renaming to a private name, verifying bytes plus mtime
(automatic) or `planId` (`--take-over`), putting a mismatched lock back with a hard link (a
put-back that fails with `EEXIST` keeps the private copy for the sweep and refuses `held`
naming the lock now in place; the moved run meets `taken-over` at its next step), then
linking its own lock and reading the taken-over run's facts for the index repair from its
`state.json` (following the renamed lock files of a takeover killed mid-repair back to the
first folder with a `state.json`, C:run-folder), without deleting anything; the repair
itself is M18's (the killed-process paragraph under the error table above), and
`finishTakeover` afterwards deletes the taken-over run's folder (every folder on that
chain) and the renamed lock file; an automatic takeover adds a notice naming the stale
`planId`; a file-in-use error on any other operation → `busy` (C:run-folder);
`release` a no-op on mismatch, and on a match it takes the `call.lock` (`busy`) before
deleting; 24-hour sweep of `<planId>/` folders (minted form only, never
following a link) the lock does not name, and of leftover takeover and lock temp files.
Every write of `state.json` goes to a temporary name, then a rename; on Windows a rename
that fails as file-in-use is retried briefly before it counts as a failure (C:run-folder). A cleanup error after
a successful commit (for example a Windows file lock on a temp file) never changes the
outcome: it becomes a notice and the sweep removes the leftovers later. Typed state
(C:run-folder plus the stored-facts rows above), written atomically with a `version` field
(Versioned run state); `open` refuses `ended` on a `version` mismatch. Paths absolute with
forward slashes.
- `Run.create({ now }) → provisional`; `provisional.peek()` (typed, `held` with holder, or
  ok when no live lock, carrying the stale holder when there is one; read-only); `provisional.acquire({ takeOver? })` (typed, `held`
  with holder, `busy`, `taken-over`, `run-folder`) or `provisional.discard()`. `takeOver`
  is the stale holder `peek` reported (automatic) or the `--take-over` `planId`; without it
  `acquire` only links the lock (step 7). Success: `{ run, takeover }`, `takeover` `null`
  without `takeOver`, else `{ planId, notice, killedRun }`, where `killedRun` is `null`
  when no taken-over `state.json` is readable, else `{ groupPaths, preStaged, indexOnly,
  indexReset, groupStatus }` (`groupPaths`: the current group's unit paths, both halves of
  a rename included).
- `run.finishTakeover()`: after M18's repair, deletes the taken-over folder(s) and the
  renamed lock file; a no-op without a takeover.
- `Run.open(planId, { now })` (typed: `taken-over`, `ended`, `busy`).
- `run.state`, `run.write(name, data)`, `run.readWorkerPlan()`, `run.touch()`,
  `run.release()`, `Run.releaseById(planId)` (typed: `busy`, or ok with `released: false`
  when the lock does not hold `planId`), `Run.sweep(now)`.
Sources: Q9, Q22, C:run-folder.

**M13 Hunk index renderer.** Presentation only: the summary-only reason per unit; the body
cap per C:summary-only-files (files past the 3000-line cap keep each hunk's own ID and range
with `body: "cap"`); `hunks.txt` blocks; `body` per C:plan---hunks, one of three values:
`"file"` (a block in `hunks.txt`), `"cap"` (past the cap), and `"none"` (no block: a binary,
a submodule, a summary-only file, an attribute-binary text file, a filtered file whose cleaned
diff is binary, and a unit with a pattern hit); per-entry `scan`; the 20 000 character stdout
budget with spill to `hunks.json`; `config.values` without `scanIgnore`, `recentSubjects` and
`oldMessage` from the run state.
Returns texts; M18 writes them through M12. `renderHunks(runState, units) → { stdoutObj,
hunksTxt, hunksJson? }`, where `stdoutObj` is exactly the C:plan---hunks output shape (with
`runDir`, `mode`, `counts`, `hunksFile`, `hunksIndexFile` on a spill, and per entry `range`,
`lines`, `offset`, and `added`/`deleted` on `body: "cap"`), where `units` are the snapshot units `plan --hunks` matched (the
stored unit table holds no bodies or ranges). Sources: Q10, Q19, C:plan---hunks,
C:summary-only-files.

**M14 Plan validator.** Pure over the worker plan and the run state. Shape errors become lint
errors with `group: null`; resolve file-level paths to units via the unit table (a rename by
its new path only); IDs exist, are used once and are not mixed with `files`; completeness in
`split`; identical hunks together (identity key); no hit, collapsed-directory or
`dirtySubmodules` path in a group; exactly one group in `staged` and `reword`; lint (M6) and
scan (M8) each message; add the `notIncluded` extras and notices; derive new files, file lists and the
attribution flag per group. `validatePlan(planBytes, runState)` (typed: `{ groups,
notIncluded, notices }` or `lint` with errors; a message's scan error carries the M8
`scanText` spans for M17's redaction). Sources: Q9, Q11, Q16, Q20, C:worker-plan,
C:check.

**M15 Run policy.** Every pure decision of a run; one entry per contracts table:
- `resolveMode(flags, indexState, killedLeftover)`: `killedLeftover` is true when a takeover
  finds staging it did not reset (the index holds paths beyond the killed group's paths,
  C:run-folder); when true: with `--reword` (with or without `--no-user`) the mode stays
  `reword` plus a notice naming the killed group's paths still staged (`--amend --only`
  never touches the index); else with `--no-user` the refusal `killed-leftover` (exit 6
  `state`, its text naming those paths; M18 releases the lock and deletes the folder, the
  index untouched); else `modeChoice` whatever the flags (`--staged` included) and the
  index shape. Otherwise: flags (`--staged` with an empty index → `staged-empty`);
  empty or fully staged index → `split`; a mixed index (staged plus unstaged tracked changes
  or candidates) → `modeChoice`. Candidates are counted after M9 `hideFilter` and before
  the caps, so a large new directory beside a fully staged index still asks `modeChoice`.
- `planRefusal(facts)`: in order `env`, `config`, `state` (incl. encoding and `unmerged`);
  in `reword` then unborn and merge commit (`state`) and `pushed`; after the scan
  `staged-hit` (in `staged`, `stagedExcluded` holds hidden paths only) and clean-tree
  detection (hidden-only, collapsed-only, `stagedExcluded`-only or `dirtySubmodules`-only
  counts as clean, and the `nothing` reply's `text` names their counts and paths,
  C:plan; skipped in `reword`, which
  usually runs on a clean tree, Q9), then `signing`.
- `checkGate(runState)`: refuse `check` after any committed group (`already-committed`).
- `onLintFailure(runState, source, kind)` → `fix` | `lintFailed`: the second failure since
  the last `plan --hunks`, or the first with `source: user`, ends the worker's retries. When
  every error of the ending failure is a shape error (the worker plan is not valid JSON or
  not the C:worker-plan shape), the `lintFailed` handback offers `retry` and `no` only:
  dictated text cannot fix a shape (story 214).
- `computeConfirm(mode, groups, scanMap, { resumed, interactive }) → null | { reasons,
  humanOnly }` per C:confirmation-triggers; a hit is never a trigger.
- `afterCheck(confirm, groups, runState) → "commit" | "confirm" | "handedBack" |
  "releaseNothing"`.
- `runEnd(event, runState) → "keep" | "release"`, for the events `refusal(code)`,
  `lintFailure`, `checkResult`, `commitOutcome`, `release`; the single source of which
  outcomes release the lock and delete the folder (C:cli-and-exit-codes, C:run-folder).
- `deadline(callStarted)` = the call's start plus 540 s, computed once when the call starts
  (C:commit-release). `nextStep({ now, deadline, groupIndex }) → { go: true, deadline } |
  { go: false }`: the first group always starts; a later group only while at least 480 s
  remain before `deadline`. Every M2 call of the call (in `plan` also those before
  `acquire`; later the snapshot, reset, apply, backstop and `git commit`) takes
  `timeoutMs = deadline - now()` at its own start, so the budget never goes stale; `plan`
  past its deadline ends as `timeout` and discards its provisional run.
- `cleanupDeadline(callStarted)` = the call's start plus 580 s: after a failure or timeout,
  the cleanup and reporting calls (the `finally` unstage, the HEAD re-read, M10 `treeState`,
  the release) take `cleanupDeadline - now()`, never the spent `deadline`, so a timed-out
  call still reports and releases inside the worker's 600 s tool timeout. A cleanup call
  whose `timeoutMs` (`cleanupDeadline - now()`) is at or below 0 is not spawned and counts as
  `timed-out`.
- `releaseDeadline(callStarted)` = the call's start plus 45 s: `release`'s M10 `treeState`
  read for the reply takes this deadline, kept below the 60 s `release` tool timeout (M17);
  when the budget runs out, the reply omits `treeState` (the release itself is already
  complete).
Sources: Q9, Q10, Q16-Q18, Q20-Q22, C:plan, C:check, C:confirmation-triggers,
C:commit-release.

**M16 Commit executor.** The per-group loop of `commit --all`, and nothing about
presentation. Each group runs the three phases of C:commit-release in order, and every check
of phase (a) runs again before each group, so the advanced expected HEAD and an `index.lock`
created between groups are both caught:
- (a) Refusals, in C:commit-release order: `lock` (M12 `open` with its `call.lock` once per
  call, before the first group; `run.touch()` before each group), `unconfirmed`

  (first group of the call only), `no-groups` (no stored groups, or all committed), `head-moved` (M3 `head()` against the current expected
  HEAD: the one `plan` recorded, then the SHA of each group this run committed),
  `index-changed` (M10 `indexFingerprint` against the fingerprint in the run state: staging
  made between `plan` and `commit` is refused, never folded into a group or lost from the
  report; after each of the run's own commits and unstages the stored fingerprint is
  updated; skipped in `reword`, whose `--amend --only` ignores the index, Q18, Q20),
  `index-lock` (M10); then M15 `nextStep` (stop → the budget stop, exit 0 with `continue`).
- (b) Match (`split`): M10 `matchIds` on the temporary index, without touching the real
  index; a failed `git add -N` while rebuilding that index → `git-failed` (exit 4, the real
  index untouched). In `staged`, M10 `verifyIndex` instead; `reword` skips (b) and (c).
- (c) Apply (`split`): set `indexReset` in the run state, then M10 `stage` (reset, apply,
  add, verify; `mismatch` or `stage-failed`).
- Then the backstop (not in `reword`): first M10 `writeTree` records the index's tree ID,
  then M8 `scanUnits`, with matchers recompiled by M7 from the stored patterns, runs over
  M10 `treeDiffUnits(expected HEAD, recorded tree)` (`null` for the empty tree when unborn),
  which carries the attribute-hidden `--text` pass and the 1 MB limit of the snapshot diff,
  so the tree scanned is exactly the tree recorded and an index change after
  `writeTree` shows up in the M3 `headTree` comparison below; trailers (M6) from the
  stored attribution; `git commit --cleanup=verbatim` with the message on stdin
  (`--amend --only` in `reword`) through M10 `commitGuarded` with the time left before
  `deadline`, `partial` set only in `reword` (M10 owns the markers, the tree kill via M2 and
  the stale-lock removal; a `git commit` killed there fails `timed-out` with the text "git
  commit did not finish in 9 min — a pre-commit hook or a signing prompt may be waiting",
  Q18, plus, when M10 returns `lockLeft`, the notice that `index.lock` was left in place and
  should be checked and removed by hand if no git process is running); after
  a commit,
  when M3 `headTree()` differs from the
  recorded tree ID (a hook or another process changed the index between the backstop and the
  commit), a notice names the group ("committed tree differs from the scanned index"); after any failure or timeout re-read HEAD (within
  `cleanupDeadline`), so a commit git made anyway is reported with its `sha`; hook-rewrite detection
  (`treeChangedDuringCommit`, stored in the run state); mark committed and advance the
  expected HEAD.
- On failure, M10 `unstage` runs only when the failing group itself reached (c); a refusal in
  (a) or a failure in (b) leaves the real index as it is, even when an earlier group or call
  set `indexReset`. `indexReset` only decides the report: `unstaged` is `null` unless it is
  set, else M10 `unstagedAfterReset`.

`commitAll(run, { now }) → Outcome`, where `Outcome` holds exactly the output fields of
C:commit-release. `hits` is present on a backstop-scan refusal (exit 3), `sha` after exit 4 or 5, and before an
`internal` reply (exit 1), when HEAD moved anyway; a budget stop is `ok` with `failed: null` and a non-empty `remaining`. M18
adds M10 `treeState`, builds the reply (M17) and releases per M15 `runEnd`.

Accepted limits of the hook path are listed in [Out of Scope](#out-of-scope).
Sources: Q9, Q11, Q18, Q20, Q22, C:commit-release.

**M17 Reply and handback.** Build the reply for every output that ends the worker's part:
`status`; `text` (commits, failure, the confirm block with its 20-file cap and a hunk count per file in a hunk plan, lint texts,
`Notices:`, trailer line, tree state; lists capped at 10 plus "+N more"); `callerRule`
(base plus handback rule, fixed text); the handback kinds with their answers; `run` via S2
`build` from the injected `scriptPath`, with `timeoutMs` 600 000 for `commit` and 60 000
otherwise; `respawn` (answer fields plus the `mode` flag of the `plan` call that produced
the handback; `takeOver` only in a `lock` handback's `take over`, never in a `modeChoice`,
whose takeover already finished at `plan` step 3); `ifNoUser`. M17 owns the `--no-user` lock rule: it reads
`interactive` from `plan`'s argv, and a `lock` refusal under `--no-user` is a plain reply
with no takeover answer (C:cli-and-exit-codes). A `lock` refusal whose holder has no `planId`
carries no handback: `status: "failed"`, and the text says the lock is unreadable (corrupt
or foreign: M12 links a run's lock into place fully written, so no run is ever seen
starting) and is waited out, naming the time it is taken over automatically (`touched`
plus 15 minutes). Budgets per
C:run-folder and C:reply-and-handback: reply ≤ 2 kB without `text`, `text` ≤ 4 kB at every
cap, not counting the messages a `confirm` block or a `lintFailed` text quotes (Q24);
`lintFailed` retry text ≤ 500 characters. A `lintFailed` text quotes each rejected message
with every scan-hit span replaced by `[<pattern-id>]`, so no secret reaches the caller. The
`yes` answer of a `confirm` carries `--confirmed`; no other `run` does. A unit left out on a
hit gets the two manual lines per C:reply-and-handback (`!git --literal-pathspecs add --
<path>`, then `!git commit -m "<message>"`), with `<message>` left as a placeholder the
user fills in (Q10); a path it cannot quote safely (`'`, U+2018–U+201B, a control
character) gets only "commit by hand". Every `ReplyFacts` variant carries the M10 `treeState`, except `release`'s past its
45 s budget (M15 `releaseDeadline`), which omits it since the release already completed,
rendered as "working tree clean" or "N files left: …" with up to 10 paths plus "+N more".
Every path M17 renders anywhere in `text` has its control characters escaped per
C:reply-and-handback, so a crafted name can neither forge a reply line nor send a terminal
escape. Git and hook output (a failed commit, a hook's message) goes into `text` escaped the
same way except that `\n` and `\t` are kept (ESC is escaped, so ANSI sequences are
neutralised), and only its last 2000 characters, prefixed with "[… N characters cut]" when
cut; the full output stays in `gitOutput` (Q18, C:reply-and-handback). `reply(facts: ReplyFacts, { scriptPath,
argv })`, where `ReplyFacts` is a discriminated union per status (`committed`, `nothing`,
`handback`, `failed`) carrying exactly the fields C:reply-and-handback lists for it.
Sources: Q9, Q16, Q22, Q24, Q25, C:reply-and-handback.

**M18 Subcommand workflows.** Sequences over the modules, each a numbered step table that is
the contract for Seam 1 tests; each maps typed results through the error table and builds
the reply with M17.
- **`plan`.** M15 `deadline` from the call's start bounds every M2 call of every step
  (exceeded → `timeout`, discard).
  1. M3 probe (plus reword facts, `unmerged`); M4 config; M5 attribution.
  2. M15 `planRefusal` (pre-folder refusals: `env`, `config`, `state`, `pushed`).
  3. M12 `create` (run-folder directory check, provisional folder); M12 `peek` before any
     inventory work: a live lock → `lock`, discard; a stale lock → the automatic takeover,
     here. `--take-over` skips `peek`, and its takeover of the named lock, whatever its age,
     runs here too. A takeover is M12 `acquire({ takeOver })`, then the index repair from its
     `killedRun` (the killed-process paragraph under the error table), then M12
     `finishTakeover`, all before step 4, so inventory never sees a killed group's partial
     staging. From here on the run holds the lock: every later outcome that takes no lock
     on the path with no takeover (clean, `modeChoice`, `staged-empty`, `staged-hit`,
     `signing`, `killed-leftover`, `git-failed`, `timeout`, …) releases the lock and deletes
     the folder, so each discard below is then an M12 `release` (C:plan step 3). The
     takeover's notices (the takeover notice with the stale run's `planId`, the reset
     notice, the `unstaged` report, the `killedLeftover` paths) are kept from here on and
     M17 puts them in the reply's notices of every output `plan` ends with, whatever step
     it ends at (clean, `modeChoice`, a refusal, `timeout`, `internal`), since
     `finishTakeover` has already deleted the evidence (story 210).
  4. M10 `inventory` and `indexFingerprint`; M9 `hideFilter`; M15 `resolveMode` (passed
     `killedLeftover` from the takeover repair at step 3) (`modeChoice`, `staged-empty` or
     `killed-leftover` → discard; a `reword` run with `killedLeftover` goes on with its
     notice).
  5. M9 `applyCaps` (`split` only); M10 `snapshot` (a failed `git add` → `git-failed`,
     discard) and `assignIds`; when a unit's path or old path is the repo config (M4
     `isRepoConfigPath`), M4 `scanIgnoreChanged` compares step 1's HEAD patterns with that
     file's M10 `snapshotBlob` (no unit of it: `false`); M8 scan with that boolean, which
     M18 also stores as `scan.scanIgnoreChanged`, and M8's `scanIgnoreUnits` go in the
     scan map.
  6. M15 `planRefusal` post-scan (`staged-hit`, clean → discard, no clean check in
     `reword`); then M11 signing
     (`signing` → discard).
  7. Store the stored-facts rows except notices; on the path with no takeover M12 `acquire`
     (a race lost after `peek` → `lock`, discard), skipped after a step-3 takeover; then
     re-read HEAD and the index fingerprint: a moved HEAD (another run
     committed in the window between inventory and lock) releases and refuses `head-moved`;
     a changed index fingerprint with an unchanged HEAD releases and refuses
     `index-changed` (CLI kind `diff-changed`, not checked in `reword`, which `--amend --only`
     never touches); otherwise that fingerprint is stored for M16; M12 `sweep`.

  8. S1 `guardState`; then the notices (`env.guard: "not-seen"`, the takeover's notices
     kept since step 3, the sweep's cleanup errors, plus the earlier ones) are stored in one more atomic `state.json` write, so none computed after step 7
     is lost; write `plan.json` (the full `plan` output) through M12; then `plan --hunks`
     in-process unless `--dictated`.
- **`plan --hunks`.** A separate call takes its own M15 `deadline` (540 s from its start)
  for every M2 call of its work (exceeded → `timeout`) and `cleanupDeadline` for a refusal's
  tree-state read and the release; in-process it runs under `plan`'s deadline. M12 `open`;
  `head-moved` via M3; M10 `snapshot` from the stored lists
  and `matchIds` (a separate call only: in-process it reuses `plan`'s step-5 units, from
  which the stored `id → hash` map was just built, so the diff is not taken twice; the
  scanned and the rendered units are the same, and `commit`'s own match still catches a
  later edit); reset `lintFailures`; set `resumed` only as a separate call; M13
  `renderHunks` with the matched snapshot units; write through M12, changing only its own
  fields of the state it read (in-process too), so `notices` and every other stored fact
  survive; a refusal's reply carries M10 `treeState`.
- **Every call with `--plan`** holds the run's `call.lock` for its whole duration (M12
  `open`), so two calls on one run never overlap (`busy`).
- **`check`.** M12 `open`; M15 `checkGate`; clear stored groups and `awaitingConfirm`; M14; on lint errors M15
  `onLintFailure` and `runEnd` (an interactive `lintFailed` keeps the run for its `resume`;
  with `--no-user` the failure that ends the retries releases the lock and deletes the
  folder, so nothing waits for an answer and the next `/commit` starts fresh); M15 `computeConfirm` and `afterCheck`; store groups
  (and `awaitingConfirm` for a `confirm`); M16 or a handback; M10 `treeState` for the reply.
  When `confirm` is null, the output is `commit --all`'s with `groups`, `notIncluded` and
  `notices` merged in, the merged notices landing in `reply.notices` (C:check).
- **`commit`.** M16; M10 `treeState` for the reply; M15 `runEnd`. **`release`.** M12
  `releaseById` (no-op on mismatch, before any `call.lock`; on a match it takes the
  `call.lock`, so a call still running on the run → `busy` and the run is kept); M10
  `treeState` for the reply (within the 45 s budget below the 60 s tool timeout, M15
  `releaseDeadline`; past it the reply omits `treeState`).
- **`infer`.** M3 history read; M19 `infer`; M4 `readLayers`; M19 `configFor`.
Sources: Q7, Q9, Q10, Q16-Q18, Q20-Q23, C:plan, C:check, C:commit-release.

**M19 History inference.** Pure. `infer(messages) → InferOutput` computes the Conventional
Commits share, scope, body, case, p95 length with the rounding and clamp of C:infer, types
(all 11 standard types always, plus non-standard ones by the 5% rule, dropped list) and
`wouldFail` via M6 lint; outcomes `too-few-commits` and
`not-conventional`, which still carry `nonConventional` and `commitCount`, with
`wouldFail: null` and no proposal. `configFor(proposal, layers) → { repo, user }`: per layer the current raw
layer with the proposal's keys replaced and other keys kept, checked by M4 `validateLayer`,
each `{ text } | { errors }`. Sources: Q6, Q7, C:infer.

**S1 Heartbeat.** The guard writes `{ ts, cwd, command }` to `commit-guard/heartbeat.json`
(location pending the heartbeat-under-sandbox spike, Open items)
under the Claude home (glossary) when a classified segment is a script call to `plan`,
before deciding. The write goes to a temporary file named with the pid and a random suffix
and is renamed into place, so a reader never sees a partial file and parallel sessions
never share a temporary name. `command` is stored redacted: the script-call form only
(subcommand and flags), cut to 200 characters, so arguments a caller passed on the command
line do not persist. `plan` judges `active` (under 15 minutes old,
and the realpathed hook `cwd` inside the toplevel or vice versa) versus `not-seen`.
`writeHeartbeat({ claudeHome, cwd, command, now })`; `guardState({ claudeHome, toplevel, now
})`; pure `samePathTree(a, b, { caseFold })` over already-realpathed paths, `caseFold` true
on Windows and macOS. Sources: Q23, C:guard.

**S2 ScriptCall.** The single definition of a script call (C:guard): `node` or `node.exe`
(optionally after `&`), a token whose basename is the commit entry point's, a subcommand
from the fixed list, compared after quote removal. `build({ scriptPath, subcommand, args })`
emits the one quoted form (absolute forward-slash path in double quotes) that the anchored
README allow rules match. It escapes nothing: the commit entry point refuses (`env`) an
install path containing `$`, a backtick, `"`, `\` or a typographic double quote
(U+201C-U+201E) before any work, so no shell can expand or mangle the path. The check runs on the path `build` emits, after the Windows separators
are converted to `/`, so a native Windows path is not refused for its separators; a `\`
left after the conversion can only be part of a POSIX file name; `recognise(tokens) → { subcommand, args } | null`. Sources: Q16,
Q23, Q25, C:guard, C:reply-and-handback.

**G1 Hook I/O.** Read the `PreToolUse` JSON from stdin to its end (not a synchronous read of
descriptor 0, which throws on Windows pipes); exit early with no output when the command,
with every `'`, `"`, `\`, backtick and typographic quote (U+2018-U+201B, U+201C-U+201E)
removed for this check only, lacks `commit` (checked case-insensitively); then tokenise (G2) → classify (G3) → when the classification's
`scriptCalls` holds a `plan` call, write the heartbeat (S1) before the decision is emitted
(C:guard: "before deciding"), so a denied compound command that also calls `plan` still
counts → emit the deny JSON or nothing, never `allow`. A crash anywhere, including in the classifier, fails open (exit 0, no output, no
heartbeat); a stderr log with `agent_id` when `COMMIT_GUARD_DEBUG=1`, holding the
decision, the deny reason and the command in the same redacted form as the heartbeat
(script-call form or the matched `git commit` segment's options, never message text or
other segments), cut to 200 characters. A crash or unreadable input writes the same one
line under debug, with the fields known so far, and still no stdout.
`runHook(stdinText, { env, claudeHome, now }) → { stdout, stderr }`. Sources: Q1, Q3, Q23, C:guard.

**G2 Shell tokenizer.** Tokenise per `tool_name` with the rules of C:guard (Bash: `\` escapes,
literal single quotes, `\"` `\\` `\$` in double quotes; PowerShell: backtick escapes, `''`
and `""`, here-strings closing at column 0); in both shells typographic quotes as quotes,
as PowerShell reads them (‘ ’ ‚ ‛ single, “ ” „ double, so `git co‘’mmit` is `commit`;
Q3 as amended); escaped newlines (Bash `\` plus newline,
PowerShell backtick plus newline) removed outside single quotes before splitting; quote
removal; split into segments on `&&`,
`||`, `;`, `|`, `&` and newlines outside quotes. An unterminated quote or here-string makes
the rest of its line one quoted token and scanning continues on the next line (Q3 as
amended). Redirection operators (`>`, `>>`, `<`, `2>&1` and the like) outside quotes become
tokens of their own that G3 and S2 drop together with their target, so they are never read
as commit arguments or options. An unquoted `(` or `)` becomes a token of its own too (not
dropped), except inside a `$(…)` substitution, which stays in its word up to its matching
`)`; so G3 finds the `git` of `(git commit -m x)`, and a `)` token ends `commit`'s arguments.
A Bash heredoc (`<<` or `<<-` outside quotes) drops its operator and delimiter word like a
redirection, and drops its body, from the next line to the first line equal to the
delimiter after quote removal (leading tabs stripped with `<<-`; bodies of several heredocs
on one line in order; an unterminated body runs to the end of the command), so no body
line is read as a command. `segments(command, shell) → Token[][]`. Sources: Q3, C:guard.

**G3 Command classifier and deny catalogue.** Per segment: find a token whose basename (the
part after the last `/` or `\`, in both shells) is `git` or `git.exe`, compared
case-insensitively (optionally after `&`), or whose basename is
the dashed `git-commit` (with or without `.exe`, in any directory, compared
case-insensitively), which classifies as `git commit`; skip the
known global options; remember `-c` and `--config-env`; compare the subcommand with
`commit` case-insensitively (`git COMMIT` is a commit, fail closed); deny an unknown option before
`commit`, and a subcommand token that contains `$`, `{`, `(` or a glob character (`*`, `?`,
`[`) or, in PowerShell only, starts with `@` (fail closed); expand commit arguments up to
the segment's end or a `)` token and apply the Q4 allowlist;
detect script calls with S2; the worker-only rule (`agent_type` `commit:commit-worker` and a
script call to `commit` or `release` → deny). The fixed deny texts of C:guard, `<route>`
expansion and the trailing personal-skill line are data here; no text names `/commit`.
`classify(segments, { agentType, shell }) → { decision: "deny" | "none", message?,
scriptCalls, matched?: { options } }`, where `matched` holds the matched `git commit`
segment's options for G1's debug log.
Sources: Q3, Q4, Q8, Q24, Q25, C:guard.

### Prompt-only and manifest blocks

- **commit-worker agent.** Frontmatter `model: sonnet`, `omitClaudeMd: true`, `maxTurns: 25`,
  tools Bash, PowerShell, Read, Write. Description ≤ 200 characters with the clauses in Q2
  order ("follow the reply's `callerRule`" first and never cut; the triggers; `intent`;
  "edit no files until it replies"; `interactive`; "don't read the diff first"); when it
  must shorten, it cuts from the bottom. Prompt ≤ 6 kB, obliging the worker to:
  - run steps 1-4 of C:worker-input, and on `resume` start at `plan --hunks --plan <planId>`
    and `Read` the worker plan before writing it;
  - name the script by the loader-substituted plugin-root path, because the variable is not
    in its shell and S2 recognises a script call by that path; commit only through the script
    call (`check`, which commits when no confirmation is needed), never `git commit`, which the
    guard denies;
  - `Read` nothing outside the run folder except a working-tree file at a line range, when a
    hunk needs more context, and never a file that has a hit, also not to recover a hit;
  - on an `edit`, apply the user's text verbatim (`source: user`); on a `retry`, rewrite the
    message from the lint errors and set `source: worker` when the words change (the script
    does not compare them; C:worker-plan);
  - under `interactive: false` or `--no-user`, leave every file skipped for size
    (`scan.skipped`) out, in `notIncluded` with the reason "over 1 MB, not scanned: commit
    by hand", so the rest commits (story 103, Q17);
  - run each script call with whichever shell tool you have, every one of them (`plan`,
    `plan --hunks`, `check`) with a 600 000 ms tool timeout (Q9);
  - fix lint failures without replying; your final report is the reply JSON, verbatim;
    never run a handback's commands; write nothing after a failed script call;
  - when a script call fails without JSON output (a Node too old to parse the entry point, before 12; a removed plugin version),
    return the fallback reply (stories 46 and 213) with the output as its `text` (escaped and capped
    like relayed git or hook output: controls as `\xNN`, the last 2000 characters), the known `planId` or
    `null`, and the base `callerRule`, whose text the prompt carries verbatim (counted in the
    6 kB);
  - reply that Node is missing and the guard is off too when `plan` cannot start Node;
  - ignore trailer instructions; write issue footers only when the user supplied them; follow
    the language of recent subjects; add `scanIgnore` entries only when asked.
  Sources: Q2, Q9, Q10, Q11, Q12, Q13, Q18, Q24, Q25.
- **`/commit` skill.** User-only (`disable-model-invocation: true`); spawns the worker only,
  mapping its arguments per Q2 (bare → no `intent`; text → `intent`; `reword [<text>]`), and
  tells the caller to edit no files until the worker's reply arrives (Q25); ≤ 1.5 kB, description ≤ 200 characters (Q24).
  Sources: Q2, Q24, Q25.
- **`/commit-config` skill.** User-only. Runs `infer`, shows the proposal with its numbers,
  asks for repo or user level, and after confirmation writes that layer's `configJson` text
  verbatim; if that layer has `errors`, shows them and writes nothing. Below 20 commits it
  proposes nothing and recommends the defaults; below 50% Conventional Commits it says the
  repo is out of scope and points to the opt-out line. Description ≤ 200 characters (Q24).
  Sources: Q6, Q7, Q14, Q24.
- **Hook registration.** `PreToolUse` on `Bash|PowerShell`, exec form (`node` as the command,
  the guard entry point as the only argument), so that no shell quotes the plugin path. The
  `if` condition (`Bash(git *)`, `PowerShell(git *)`, plus the script-call forms for the
  heartbeat) is added only if the spike confirms it covers compound commands; G1's early
  exit stays as the backstop either way. Sources: Q3, Q13, Q23.
- **README.** One line saying the plugin spawns the public worker `commit:commit-worker` with
  `intent`, `interactive` and `reword`, and that a caller follows the reply's `callerRule`;
  the allow rules of Q16 (anchored node rule for both shells, run-folder `Edit` rule; no
  bare rule), the personal-skill removal, the opt-out line, worktree isolation, Node as a
  hard requirement (the native installer ships none, Q1), `.commit-plan/` for the ignore
  lists of file watchers and sync tools (Q9), and the
  accepted gaps listed in Out of Scope (the one gap list; story 201 points there too).
- **Manifests.** Plugin and marketplace identity `commit@commit`, version 0.1.0.

### Other repo configurations

- **Case-only renames**: supported when git reports them (a staged `git mv`); an unstaged
  case-only rename on a case-insensitive filesystem is invisible to git and not planned.
- **Sparse checkout, `skip-worktree`**: such entries never appear in the diff and are never
  units; no special handling.
- **`i18n.commitEncoding`** other than UTF-8: refused at `plan` with `state`.

The first two entries are recorded in Q11, the third in Q21.

### Dependency policy

**No npm dependencies, Node built-ins only, no vendored code** (Q1). Claude Code can install
a plugin's dependencies, but only non-blocking, with `--ignore-scripts` and a 60 s timeout,
so the guard could be silently absent on first run; add offline machines and the
supply-chain exposure of a hook that sees every command. Data (regex tables) and test cases
may be borrowed, with attribution, from MIT, ISC, BSD, Apache-2.0 (NOTICE kept) or
CC-BY-4.0 sources (Q10: licenses that do not restrict who may use them); code is never
copied. Token prefixes are facts and are credited anyway.

**Built-ins and version fences.** The floor is any Node 22 release, and the CI Node 22 leg
runs the oldest 22.x as well as the latest. The reasons below are kept timeless; the dated
release facts behind them are recorded in decisions.md.

| Built-in | Module | Note |
| --- | --- | --- |
| `util.parseArgs` | M1 | no `allowNegative` (not available across the Node 22 line) |
| async `child_process.spawn`, `detached`, own timer | M2 | tree kill must run while the child runs; `spawnSync` only for the named short calls (`toplevel`, `gitVersion`) under a fixed timeout |
| `TextDecoder` (`fatal`) | M6 | not `Buffer.isUtf8` (experimental) |
| `crypto.createHash`, `crypto.randomUUID` | M10, M12 | not `crypto.hash` (release candidate) |
| `fs.openSync(p, 'wx')`, `utimesSync`, `renameSync`, `linkSync` | M12 | `openSync('wx')` the per-call `call.lock`, `linkSync` the run lock (and putting back a mismatched lock), mtime `touched`, takeover |
| `os.userInfo`, `os.homedir` | entry points | `userInfo` throws without a passwd entry; fall back |
| `node:test`, `node:assert` | tests | no snapshots, `mock.module`, `mock.timers` or coverage flag |

Fenced off: RegExp modifiers `(?i:…)` and `RegExp.escape` (Node 24 only), `path.matchesGlob`
and `fs.glob` (see below).

**Git built-ins adopted.** `GIT_OPTIONAL_LOCKS=0`, porcelain v2 `--branch` headers,
`rev-parse --git-path` (state files, `info/exclude`), `for-each-ref --contains` for
`pushed`, `config --type=bool`. Rejected: `GIT_ADVICE` (git 2.46), `ls-files --directory`
for collapse (index-relative, no thresholds).

**Rejected candidates:**

| Candidate | Would serve | Reason |
| --- | --- | --- |
| simple-git, isomorphic-git, dugite | M2 | dependencies; reimplements or bundles git |
| tree-kill libraries | M2 | process groups and `taskkill /T /F` suffice |
| ajv, zod, schemasafe | M4, M14 | a handful of keys; the rules are domain logic |
| parse-diff, gitdiff-parser, jsdiff | M10 | miss rename, mode, symlink and submodule headers |
| conventional-commits-parser (7.x ESM-only), @commitlint/parse, @conventional-commits/parser (unmaintained) | M6 | dependencies; footer rules differ from Q13 |
| `git interpret-trailers` | M6 | failed the Q13 spike |
| `path.matchesGlob`, `fs.glob`, picomatch, minimatch (BlueOak-1.0.0) | M7 | not stable across the Node 22 line; case-insensitive on Windows and macOS; braces and classes accepted where C:scanignore-globs demands errors |
| gitleaks, secretlint, detect-secrets, trufflehog as engines | M8 | separate binary, JS package tree, Python tool, AGPL |
| proper-lockfile | M12 | unmaintained; staleness semantics differ from Q22 |
| shell-quote, bash-parser, tree-sitter-bash, unbash | G2 | no PowerShell; advisory history or WASM; unbash (ISC) is Bash-only and would need vendoring, i.e. a Q1 amendment, revisited only if the tokenizer spike shows fragility |
| `permissions.deny`, plugin `settings.json` | guard | no custom text, no flag allowlist, no worker-only rule; plugins cannot ship deny rules |
| plugin agent `hooks`, `permissionMode`; skill `allowed-tools` | README allow rules | ignored for plugin agents; cover only the invoking turn |
| plugin `bin/`, `userConfig`, `CLAUDE_PLUGIN_DATA` | S2, M4, S1 | Bash-only PATH and refused by some hosts; values never reach the worker's shell |

**Secret pattern data (M8).** C:scan-patterns stays authoritative. Rows come from gitleaks'
rule file and generator samples (MIT; name the version taken, upstream is frozen),
`secretlint-rule-preset-recommend` (MIT), GitHub's documented token prefixes, and, as
fixture seeds, Nosey Parker's examples (Apache-2.0). Betterleaks is not a 0.1.0 source; its
token-efficiency filter is rejected. RE2 scoped flags become whole-regex flags or explicit
classes.

**Tokenizer spike (G2).** Before G2's slice, a spike runs the hand-written design against
heredocs, `$(...)`, backticks, `bash -c '…'`, reordered flags, PowerShell here-strings,
unterminated quotes, subshells and case variants ([Open items](#open-items)). Safety comes from failing closed on unrecognised options; fragility is
answered with a wider fail-closed rule or a documented false positive.

## Testing Decisions

### What makes a good test

- It checks external behaviour only: a call's JSON object and exit code, the resulting
  commits, index and working tree, the run folder, and the guard's stdout, its heartbeat
  file and its `COMMIT_GUARD_DEBUG=1` stderr line. It never asserts
  internal calls, intermediate state or mocks, and it survives any refactor that keeps
  behaviour.
- Oracle: contracts.md first; decisions.md for rules contracts do not carry (for example
  the stale `index.lock` rule of M10 `commitGuarded`, Q18: after a partial `git commit`
  timeout (`reword`), the `index.lock` that `git commit` left is gone when the call returns,
  while one another process created after the kill is still there, and a later `commit`
  call is refused with `index-lock`; after a plain `git commit` timeout (`split`,
  `staged`), an existing `index.lock` is still there and the output carries the notice).
  Every expected value traces to one of them.
- `node:test`, no dependencies. Tests build git repos in temp directories at run time, with
  fixed author, committer and dates via env.

### Seams (confirmed by the user)

1. **Seam 1: the commit entry point as a subprocess over a temp git repo.** Inputs: argv; env
   with a temp OS home and Claude home (user config, heartbeat, Claude settings),
   `CLAUDE_PROJECT_DIR`, fixed identities and dates; the repo's contents, hooks, filters and
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
   `osUser: null`); M9 `hideFilter`, `summaryOnly` and `bucketOf` (the hidden rules of C:untracked-files,
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
The round trip uses install paths without `$`, a backtick, `"`, `\` or a typographic double
quote (U+201C-U+201E); a Seam 1 case copies the scripts under a path with each of them and
expects `env`. The `"` and `\` cases are POSIX only (Windows forbids `"` in a name, and `\`
is its separator); the typographic-quote case runs on both platforms; on Windows a case
under a plain native path (`C:\…`) expects no `env` refusal.

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
oracle-skipped: typographic quotes in Bash, unterminated quotes, redirections, `$` and
`$(…)` expansion, splats, subshell parentheses and heredocs (the shell would expand or
reject them).

**End-to-end time budget (Seam 1).** A three-group `split` run with the stepping clock: group
1 commits, the clock steps to 61 s elapsed (fewer than 480 s left), the call stops with a
`continue`
handback whose `run` is the same command, the committed group is recorded; running that
command resumes at group 2. A boundary case steps the clock to exactly 60 s elapsed
(480 s left): group 2 still starts. A further case steps the clock to 535 s elapsed at
start and sets a hook that sleeps past the remaining 5 s of the budget: the tree is killed, `timeout` is reported, and a commit git made anyway is detected.

### Modules and how

| Module | Seam 1 | Seam 2 | Seam 3 |
| --- | --- | --- | --- |
| M1 | every usage combination, exit codes 0-6, new kinds | — | — |
| M2, M3 | through every subcommand; unborn, detached, in-progress incl. `sequencer/`, root-commit reword, encoding; `GIT_CONFIG_SYSTEM` exported with `commit.gpgsign=true` seen by the signing probe; a PATH git shim reporting a version below 2.34 → `env` (story 202); decoy `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_ATTR_SOURCE` exported → `plan` and the scan read the real repo; a pre-commit hook records its env → a user variable `git commit` does not strip (`GIT_AUTHOR_NAME`, a custom `GIT_FOO`) is present and `GIT_LITERAL_PATHSPECS` is absent; on POSIX, `SIGTERM` to a `commit` call during a slow pre-commit hook → no commit lands afterwards and `call.lock` is gone | — | — |
| M4, M5 | layers, warnings, `scanIgnore` at HEAD, `CLAUDE_CONFIG_DIR`, `managed-settings.json` (CI only), empty attribution, a `scanIgnore` pattern with no literal character → `config` | — | — |
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

- **Q11 Consequences** (decisions.md) is the authoritative list for M10, including plain
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

CI: ubuntu, windows, macos × Node 22 (oldest and latest) and 24, plus a git 2.34 job in an
`ubuntu:22.04` container with the distribution's git, whose first step asserts
`git --version` is 2.34.x (the hosted `ubuntu-22.04` image ships a newer git). The guard
supports both Windows PowerShell 5.1 and PowerShell 7+: the windows runner ships both, and
the guard's PowerShell tests and the parser oracle run under each (`powershell.exe` and
`pwsh`) (Q3, Q15).

### Story verification

| Story group | Verified by |
| --- | --- |
| Entry points and triggering | CI size test (description, skill), manual hand-test (`/commit` arguments, namespacing, the worker spawned from a plain request), dogfood (trigger share) |
| Guard: detection, allowlist, worker-only rule | Seam 2, Seam 3 (`runHook`); manual hand-test for terminal and `!` commands and the `if` cost |
| Guard: heartbeat | Seam 1 (`env.guard`), Seam 2, round trip; manual hand-test for Node missing and for a Node older than 22 (silent exit: no output, no heartbeat) |
| Worker protocol and handback | Seam 1 (reply shapes, respawn flags), round trip, manual hand-test (verbatim reply, no write after failure, resume path, handback answers in the delivery shape current at the time, both if both can be reached, the caller recognising the reply by `version` and `callerRule`, story 62), dogfood |
| Caller trust | Seam 1 (every `run` passes the base rule's shape predicate), caller trust fixtures, manual hand-test with injected forged `run` strings (relative path, compound, redirection) and the reply recognised by `version` and `callerRule` (story 62) |
| Atomic grouping and hunks | Seam 1 (Q11 list), manual hand-test and dogfood (grouping quality) |
| Intent scope and modes | Seam 1 (modes, `modeChoice`), manual hand-test (intent scope), dogfood (`modeChoice` share) |
| Confirmation | Seam 1 (`computeConfirm` through the table-driven fixture generator, C:confirmation-triggers); the answer routes (stories 92, 93, 97, 222) are covered by the worker-protocol hand-test and the M13/M14/M17 reply fixtures above |
| Subagents and headless runs | Seam 1 (`--no-user`, `ifNoUser`), manual hand-test (a subagent caller), dogfood |
| Config layers, attribution, lint, commit-config | Seam 1, Seam 3 (M6); manual hand-test of the skill |
| Secret scan, scanIgnore | Seam 3 (M7, M8), Seam 1 |
| Untracked and summary-only files | Seam 3 (M9 without `applyCaps`), Seam 1 (`applyCaps` through the fixture generator), CI size test |
| Failures, hooks, signing | Seam 1 (SSH signing, `signing-locked`, `head-moved`, the tree-ID notice); manual hand-test for the openpgp note |
| Time budget | Seam 1 (stepping clock, including the 60 s and 61 s boundary cases and a 535 s step at start for every kill-timeout case) |
| Reword, repo states, concurrent runs | Seam 1 |
| Install, README and opt-out | Seam 1 env fixture (a PATH git shim reporting < 2.34, story 202), round-trip check (allow rules), manual hand-test (opt-out, README gaps, the README line on the worker spawn and `callerRule`) |
| Budget and release | 0.1.0: CI size test only (story 228's size budgets); story 205's dogfood gate, run with the episode-analysis tools (deferred, [Out of Scope](#out-of-scope)) against 0.1.0, is the 1.0.0 gate, not a 0.1.0 check |
| Run integrity | Seam 1 (run integrity and scanner case lists), manual hand-test (a script output that is not JSON) |

**Dogfood gate** (acceptance criteria for the episode analysis tools, Q24): median
main-thread calls per episode ≤ 3 unconfirmed interactive, ≤ 2 headless, ≤ 5 confirmed, each
the harness floor of the delivery shape in use (these values for the notification shape),
with a "question before planning" episode class (a `modeChoice` or `lock` handback) gated against
its own floor. The floor is measured once per shape with a stub worker that replies at
once, and each episode records its shape; median
main-context tokens ≤ baseline + 2k; the confirmation share `c` with its reasons, `d`, the
`modeChoice` and `lock` shares and the diff size recorded; one fixture run near the
3000-line body cap finishing within `maxTurns: 25`; worker tokens recorded per worker model; 30+ episodes.

No 0.1.0 story is verified by an eval. The Haiku-vs-Sonnet eval, the grouping-quality
fixture set and the caller-trust eval fixture set (Q12, Q17) are 1.0.0-roadmap items with
their own harness and thresholds; in 0.1.0 the manual hand-test stands in for them; the
dogfood gate is the 1.0.0 gate.

### Prior art

None in this repo (new). Borrowed test cases, adapted and credited in fixture headers:
- M6: conventional-commits-parser and @commitlint/* test suites (MIT), adapted to Q13's
  footer rules.
- M8: gitleaks generator samples and secretlint's preset (MIT), Nosey Parker examples
  (Apache-2.0).
- G2, G3: bypass cases (`bash -c` wrappers, reordered flags, env prefixes) from
  claude-code-safety-net (kenryu42) and destructive_command_guard (Dicklesworthstone).

## Out of Scope

Non-goals (decisions.md):
- Pushing and pull requests; setting up signing (the plugin only coexists with it).
- Repos that do not use Conventional Commits (use the opt-out).
- The commit that finishes a merge, rebase, cherry-pick or revert.
- Folding new changes into an existing commit (roadmap: a scanned amend mode).
- Rewording a merge commit; generating issue references; inferring monorepo scopes.
- Enforcing a message language (the worker follows recent history instead).

Accepted gaps (Q3, Q5, Q9, Q10, Q11, Q16, Q17, Q18, Q19, Q20, Q22, Q23, Q25). This is the one gap list:
every accepted gap named elsewhere in this spec is listed here; story 201, the README block
and the module sections point here, and the README states it in full.
- The guard is not a security boundary: every allowed form (`--no-edit`, `--amend
  --no-edit`, `--fixup=<commit>`) commits the current index unscanned, and aliases,
  interpreters (`sh -c '…'`, `pwsh -c`), command substitution and variables anywhere
  but git's subcommand position (`$(echo git) commit`), `GIT_DIR` redirection and
  env-prefixed config pass it.
- A command whose text never spells `commit` (`git $(echo com)mit`, PowerShell
  `git ('com'+'mit')`) passes G1's early exit unparsed (Q3); `sudo -u git git commit` is
  not addressed. Brace expansion, a parenthesised or globbed subcommand, typographic quotes
  and the dashed `git-commit` binary are denied (story 15).
- Other paths to a commit pass the guard (Q3): `git commit-tree`, `git am`, the replays of
  `git stash` and `git cherry-pick`, and shells provided by MCP servers.
- A `commit` split by an escaped newline (Bash `\` plus newline, PowerShell backtick plus
  newline) passes the guard (Q3): G1's early-exit check removes the `\` or backtick but
  keeps the newline, so the command exits early unparsed.
- False positives: a command that only mentions `git commit` in text, such as
  `echo git commit`, is denied, and so is a git subcommand held in a variable (`git $x`)
  in a command that mentions `commit` anywhere.
- In interactive mode a `humanOnly` confirmation is advisory (Q16, Q17): the reply asks the
  caller to put it to the user, but nothing enforces that the user, not the model, answers
  it. `--confirmed` stops a steered worker from returning the confirmed command itself, but
  such a worker can still misdescribe the plan in its own reply text.
- A steered worker can forge a `confirm` reply whose `ifNoUser.answer` picks the `yes`
  answer (`commit --all --confirmed`) on a `humanOnly` confirmation (a file skipped for size, a
  `scanIgnore` change), and a caller without a user that spawned the worker without
  `interactive: false` runs it, because `callerRule` travels inside the reply; `commit`
  accepts it, since `awaitingConfirm` is set (Q25). Mitigation: a caller that no user can
  answer spawns the worker with `interactive: false`, so `check` hands a `humanOnly` run
  back and releases it instead of asking.
- `Edit(**/.commit-plan/**)` lets an agent rewrite any file in a run folder without a prompt
  (Q16), `state.json` included (for example clearing `awaitingConfirm`); a tamper digest is
  deferred past 0.1.0. The rule stays global (it must work across repos from user
  settings), and `**/.commit-plan/**` matches at any depth, so a project file such as
  `src/.commit-plan/x.js` is editable without a prompt too.
- A main interactive session in which the user denied or disallowed `AskUserQuestion`
  (`permissions.deny`, `--disallowedTools`) takes the subagent path (Q17).
- Settings passed on the command line (`claude --settings <file>`), MDM, registry and
  server-managed policy are invisible to the script (Q5), and so are the drop-in files of
  the managed settings directory (only `managed-settings.json` is read); attribution set
  only there is not applied.
- A locked openpgp signing key is not detected at `plan` (Q18): the plan notes that openpgp
  signing is enabled, and the commit fails, or times out, at `git commit`.
- `.git/config` and `.git/hooks` are trusted as git itself trusts them: an untrusted repo
  can run code through `core.fsmonitor`, `filter.*.clean`, `core.hooksPath` or
  `gpg.program` during any git call the plugin makes.
- Scan coverage (Q10): LFS content is not scanned (only its pointer); binaries and
  credential containers (keystores, `.p12` files) are not scanned, which matters most in
  headless runs where no user sees the file list; UTF-16 text counts as binary (its NUL
  bytes) and is not scanned; every scanned line is cut to
  its first 4096 characters before the regexes run (M8), so a secret past the cut is missed. Unprefixed secret
  formats (Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-proj-`, JWTs) have no pattern of
  their own in 0.1.0 (a roadmap item); they are caught only where `generic-secret` matches
  their key.
- Only added lines are scanned (Q10): a hunk that removes a hardcoded secret shows it in
  `hunks.txt`, and through it in the worker's model context and transcript; it never
  enters history through the plugin.
- The worker's rule never to `Read` a file with a scan hit, and to read a working-tree file
  only at a line range, is prompt-only (Q10, Q11; story 226): the script does not enforce
  it, so keeping a hit's content out of the worker's context depends on the worker
  following its prompt.
- A diff line over 2000 characters may be cut by `Read` (Q19).
- `scanIgnore` silences the scan for its paths, and it is read from the committed config, so
  whoever can commit `.claude/commit.json` can widen it (Q10). Only a pattern with no
  literal character is rejected (a `config` error); a broad but
  literal pattern such as `src/**` is legal.
- A path whose bytes are not UTF-8 is never planned (Q11); it is reported in `notIncluded`,
  each non-UTF-8 byte written as `\xNN`, for the user to commit by hand.
- An unstaged case-only rename on a case-insensitive filesystem is invisible to git and not
  planned (Q11, story 78).
- The index fingerprint (Q11, M10 `indexFingerprint`, checked by `plan` and `commit`) sees an intent-to-add entry
  and a staged empty file alike (both the empty blob), so a switch between the two is not
  refused as `index-changed`.
- `pushed` passes a commit that only a stale remote-tracking ref would show as pushed (pushed
  from another clone, not fetched) (Q20).
- Lock staleness on a network filesystem compares the file server's mtime with the local
  clock (Q22), so clock skew shifts the 15-minute limit.
- The heartbeat is one file per Claude home (Q23): with parallel sessions or worktrees,
  another session's worker can overwrite it with its own cwd, so a run can report the guard
  as not seen although it is active. Keying it by repo would need a git call on the guard's
  hot path, where the guard knows only the hook's cwd. For the same reason, a session
  without the guard reports it `active` from another session's fresh heartbeat; a guard
  disabled mid-session is noticed only once the heartbeat is 15 minutes old; and a command
  such as `cd ../other-repo && …` reports it `not-seen` for the repo the run is in.
- An edit to a path the run already knows (a stored candidate, staged-new, `indexOnly`, or
  tracked-directory path) between `plan` and `commit` ends the run with `diff-changed` (Q11,
  Q22): the snapshot hash matches those stored lists, not every file in the tree, so a new
  untracked file or a hidden path is left for the next run and `staged` mode checks only the
  index. Parallel implementers in one repo use worktrees (Q22).
- Manual git activity during a run is not locked (Q22): an `index.lock` present before
  `git commit` is refused as `index-lock`, and one created during it surfaces as an ordinary
  Q18 failure.
- Repo hooks (Q18, M16): after `git commit` returns, a changed tree is only noticed (story
  167), never undone, and a changed message is not checked; hook-rewrite detection covers
  only the diff left for later groups; a slow hook spends the call's 540 s budget, so later
  groups may need several `continue` round trips; a timeout kills the process tree, which
  can strand a hook's own stash. Hook output reaches `text` escaped and cut to its last 2000
  characters (story 163), but a hook can still print forged plain-text lines or echo a
  secret into the reply.
- Handbacks work only from a marketplace install (Q25 as amended): the caller's rule requires
  the script path to be under the plugin cache, so with `--plugin-dir` the caller shows the
  command instead of running it.
- The run folder lives in the working tree (Q9): `git clean -fdx` mid-run deletes it, file
  watchers and Docker build contexts see it, and cloud-synced folders may copy or lock it.
- A lock put-back that meets `EEXIST` (Q22) keeps its private copy until the 24-hour sweep.
- Claude Code versions older than the first one with exec-form plugin hooks are not
  supported (the minimum is pending the spike); the sandbox is covered only as far as the
  heartbeat spike reaches; PowerShell editions other than Windows PowerShell 5.1 and
  PowerShell 7+ (both tested in CI) are not supported.
- A hard kill of the script itself (`SIGKILL`, a Windows hard kill) runs no signal handler
  (Q9): a running `git commit` or hook can be left as an orphan and still land a commit
  after the call ended, and `call.lock` stays behind until it is found stale.

Also out: re-planning after a hook rewrites files mid-run; reading commitlint configs;
`body: "required"`; npm dependencies, vendored code and a full shell parser.

Deferred past 0.1.0 (roadmap; 0.1.0 is designed without them):
- The 1.0.0 gate: 30+ dogfood episodes, the episode-analysis tool in `tools/` (reads session transcripts and reports the
  [Dogfood gate](#story-verification)'s measures per episode class and delivery shape),
  the Haiku-vs-Sonnet eval and the caller-trust eval fixture set, so that cost and quality
  are measured (Q12, Q17, Q24).
- The scanned amend mode and the object form of `scanIgnore`.
- A per-group temporary index.
- A home-based run folder under the Claude home; 0.1.0 keeps `<toplevel>/.commit-plan/`
  (Q9).
- A tamper digest for run state; 0.1.0 checks only the state `version`.
- Reading the managed settings drop-in directory (Q5).
- Classifying openpgp pinentry programs (`gpg`/`gpgconf` probes) at `plan` (Q18).
- `module.enableCompileCache` for the guard's cold start, and a concurrent-runs stress test.
- Moving the caller protocol into trusted, skill-like text if callers do not follow
  `callerRule` (it would revisit story 7 and the skill's 1.5 kB budget).

## Further Notes

### Open items

Each item is a spike or a manual check. Slice guidance: run the spike first, as its own
slice, and start the dependent slice only once the spike has settled the behaviour; a slice
that does not depend on an item does not wait for it.

- **G2 tokenizer spike** (Q3): the hand-written tokenizer against heredocs, `$(...)`,
  backticks, `bash -c '…'`, reordered flags, PowerShell here-strings and unterminated
  quotes, escaped newlines, plus subshells such as `( git commit )`. Case variants of the command name are decided (G3 compares the
  `git` basename and the subcommand case-insensitively, G1's `commit` substring is
  case-insensitive), and so are subshells and heredocs (G2: `(` and `)` are tokens of their
  own, so `( git commit -m x )` is denied; heredoc bodies are dropped); the spike only
  confirms them. Before the tokenizer slice (G2, G3); the spike fixtures
  become Seam 3 cases (`runHook`). To revisit, not a spike: vendoring unbash (ISC), a Bash-only tokenizer, which would
  need a Q1 amendment; reconsidered only if the spike shows the hand-written tokenizer is
  fragile.
- **Hook `if` on compound commands, the heartbeat under the sandbox, exec-form hooks** (Q3,
  Q13, Q23): one spike settling whether an `if` condition matches when any subcommand of a
  compound command matches (with the script-call forms for the heartbeat), whether a
  sandboxed command reaches the heartbeat file on macOS and Linux, and the minimum Claude
  Code version that supports exec-form hooks in a plugin. If a sandboxed command cannot reach
  the heartbeat file, the spike picks another location. Before the guard slice.
- **Guard cold-start time** (Q13, story 22; introduced by this spec): measure the exec-form
  hook's cold start on all three OSes and set the target before the guard slice claims it.
- **Git and tool checks**, each on git 2.34 and the current release where git is involved,
  each before the first slice that uses it, as decisions.md
  ([Open verification items](decisions.md#open-verification-items)) gates them: the
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
  can still be reached; the cases are the full list in decisions.md
  ([Open verification items](decisions.md#open-verification-items), "Handback answers by
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

### Prerequisite of the first slice

- Commit `.claude/commit.json` with `scanIgnore: tests/fixtures/**` before any commit that
  adds fixtures, since `scanIgnore` is read at HEAD (Q10).

### First slice

After the prerequisite: `plan` → `check` → `commit` for one group in `split`, whole-file
units of modified tracked files only (no hunks, and no new file, which would need
confirmation, story 88), with the lock, the run folder and the reply, the script called
directly (not through the worker), on a repo without hooks, signing or filtered files.
Every later slice widens this path: confirmation (`computeConfirm`, `awaitingConfirm`,
`--confirmed`), filtered and LFS files, the worker, hunks.

### Other notes

- Scope of 0.1.0: `infer`, `/commit-config` and reword via amend ship in 0.1.0; what is
  deferred is listed in [Out of Scope](#out-of-scope).
- Public surface: the list in decisions.md ("Public surface") is authoritative for what
  needs a major version to change.
- Versioning: start at 0.1.0; 1.0.0 waits on the dogfood gate and the Haiku eval; public
  surface changes need a major version.
- Dogfooding: remove any personal commit skill before the spike and the 1.0.0 dogfood.
- Risks: probabilistic triggering and a high deny share; a high confirmation share in TDD
  work; the subagent handback framing weakening `callerRule`; the working-tree run folder
  (`git clean`, watchers, Docker, sync; a home-based run folder is deferred past 0.1.0);
  stale remote refs for `pushed`; unscanned LFS content.
