# User stories: worker, grouping and confirmation

## Worker protocol and handback

40. As a developer, I want a one-group run to need a single planning call, so that the common case stays short. [Q9, Q24]
41. As a developer on Windows without Git Bash, I want the worker to use whichever shell tool it has, so that the plugin still works (subject to the worker-shell check in [Open items](further-notes.md#open-items)). [Q24]
42. As a developer, I want the worker to start lean, on a fixed model without my project or user CLAUDE.md instructions, and to stop after a bounded number of turns, so that runs are cheap and runaways stop (values: [Prompt-only and manifest blocks](prompt-only-and-manifest-blocks.md)). [Q24]
43. As a developer, I want a slow repo hook or clean filter to get up to the 540 s budget to finish (past it the script stops it before the tool timeout), and a retried `plan` never to race one still running in the background, so that a slow repo cannot corrupt a run (values: M15 `deadline`, worker prompt). [Q9, Q18]
44. As the Claude main session, I want the worker's final report to be exactly the reply the script built, whichever delivery shape brings it to me, so that I can rely on its fields and no notice is lost in a paraphrase. [Q25]
45. As a developer, I want a run the script itself ended with a failure to leave no plugin files behind in my working tree (a dead worker's run folder waits for a takeover, story 59; one moved in the put-back race waits for the 24-hour sweep, story 195; and a failed run whose unstage failed or ran past the cleanup budget keeps its lock and run folder, with a notice that the group's staging may remain, so the next /commit's takeover repairs the index, story 59), so that a failure needs no cleanup by hand. [C:worker-input, C:run-folder, Q9, Q18, Q25]
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
57. As a developer, I want every notice (for example guard, signing, config, detached HEAD, scan hits, discarded working-tree versions, an automatic takeover, a cleanup error) repeated in the reply text, so that it reaches me through subagents. [Q25]
58. As a developer, I want callers to edit no files until the reply, and an edit to a path the run already knows caught as `diff-changed` (a new untracked file is left for the next run, and `staged` mode checks only the index), so that edits cannot slip into or break a run. [Q25]
59. As a developer, I want a dead worker's lock left to the takeover question, so that no caller guesses a run ID. [Q22, Q25]
60. As a developer, I want a run blocked by a lock the plugin cannot read (corrupt or foreign) to ask me nothing and tell me when that lock will be taken over automatically, so that I know how long to wait and no run is ever taken over by guessing whose it is. [Q22, C:reply-and-handback]

## Caller trust

61. As a developer, I want a caller to run a handback command only when it is a single command (no `;`, `&&`, `|` or other segment) calling this plugin's installed `commit.cjs` by its plugin-cache path with `commit` or `release` for the reply's `planId`, and to refuse and show anything else, so that a prompt injection in my diff cannot get an arbitrary command run. [Q25, C:reply-and-handback]
62. As the Claude main session, I want to recognise the reply by its `version` and `callerRule` keys, not by its position in the worker's message, and to run nothing when more than one object carries both keys, so that a leading sentence holding JSON cannot pose as the reply. [Q25]
218. As a developer, I want control characters in paths escaped in the reply, so that a crafted file name cannot forge reply text or terminal output. [C:reply-and-handback]

## Atomic grouping and hunks

63. As a developer, I want commits grouped by functionality across folders, with buckets as hints only, so that commits are atomic. [Q11]
64. As a developer, I want each commit to hold exactly the changes the worker put in its group, also after I edited the plan and it re-planned, so that no hunk lands in the wrong commit. [Q9, Q11]
65. As a developer, I want every unit of a large diff listed in the hunk index with its ID, path, kind and range, even when its body is withheld (a summary-only file, a file past the 3000-line cap, a scan hit), so that no change is dropped unseen (a diff line over 2000 characters may be cut, see [Out of Scope](out-of-scope.md)). [Q9, Q10, Q19]
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

## Intent scope and modes

79. As a developer, I want units the intent clearly does not cover left out as "not part of the intent", while its tests, docs and lockfile stay in, so that unrelated edits stay out. [Q16]
80. As a developer, I want left-out units kept in the tree and listed, so that the next `/commit` plans them. [Q16]
81. As a developer, I want a mixed index to ask "staged only or group all" with counts only, so that my `git add -p` selection is respected; hidden files are never counted as candidates for this question. [Q9, Q16]
82. As a developer, I want an index holding every change planned as `split`, so that an agent's `git add -A` still gets grouping. [Q16]
83. As a developer, I want a staged set I picked committed as-is with a written message and the rest reported, so that my selection is honoured. [Q11, Q16]
84. As a developer, I want a large new directory I staged myself committed under `staged` without collapsing, so that `git add packages/new-lib` works. [Q10, Q16]
85. As a developer, I want a staged version that differs from both HEAD and my working tree reported with a recoverable blob ID when a run discards it, so that I can restore it. [Q11]
225. As a developer, I want `--staged` with an emptied index refused as `staged-empty`, so that a run I meant to commit staged changes for does not silently fall back to another mode. [Q9, Q16]

## Confirmation

86. As a developer, I want no question for one group of tracked files, so that the common case is instant. [Q16]
87. As a developer, I want a `split` run confirmed when it has several groups, so that bad splits are caught. [Q16]
88. As a developer, I want a `split` run confirmed when it adds a new file, so that stray files are caught. [Q16]
89. As a developer, I want a run that includes a file skipped for size (over 1 MB added) or a `scanIgnore` change confirmed by a human only, so that no caller without a user can let unscanned content or a scan-rule change into history (in interactive mode this is advisory, see [Out of Scope](out-of-scope.md)). [Q10, Q16, Q17]
90. As a developer, I want a `staged` run confirmed only for size-skipped or `scanIgnore` items or when resumed (story 95), and a first `reword` never, so that explicit requests are not nagged. [Q16]
91. As a developer, I want one block with headers, bodies, files (≤ 20 per group, each with its hunk count when the group holds hunks), not-included reasons and notices, so that I review everything once. [Q16]
92. As a developer, I want `yes` to run the commit command verbatim and `no` to release with my index untouched, so that no new worker is paid. [Q16, Q24]
93. As a developer, I want to type changes under Other ("merge 2 and 3"), repeatably, so that I can steer the plan. [Q16, Q25]
94. As a developer, I want `one` offered only in a `split` run with several groups, so that it never re-plans to the same result. [Q16]
222. As a developer, I want `one` to re-plan the run as a single group of all included files and show it again, so that I can commit everything as one commit with one more answer. [Q16]
95. As a developer, I want every resumed interactive run confirmed ("edited plan"), so that nothing I have not seen commits. [Q16]
96. As a developer, I want pattern hits and new binaries not to be triggers of their own, so that prompts stay rare. [Q16]
97. As a developer, I want zero groups reported as "nothing committed" with reasons, so that I know why. [Q16]

## Subagents and headless runs

98. As an implementer subagent, I want to spawn the worker nested with my intent, so that I commit through the same flow. [Q17]
99. As an implementer subagent, I want to know that no user can answer from what I already have, so that no extra call is paid to find out (rule: glossary, **interactive**). [Q17]
100. As an implementer subagent, I want `interactive: false` to commit plain confirmations itself, so that I save a call. [Q17]
101. As an implementer subagent, I want, with `interactive` omitted, to follow `ifNoUser` (`yes`, `no` plus pass-up, `split`, `wait` plus pass-up, `continue`), so that I judge the grouping myself. [Q17, Q25, C:reply-and-handback]
102. As a developer, I want a `humanOnly` confirmation never answered without a user, the lock released and the text passed up, so that I decide via `/commit`. [Q17]
103. As a developer, I want a subagent under `interactive: false` or `--no-user` to commit the rest when units are left out (including a file skipped for size, left in `notIncluded`) and relay notices verbatim, so that work continues safely; with `interactive` omitted, a skipped-for-size file makes the run `humanOnly` instead (story 102). [Q10, Q17]
104. As CI (headless `claude -p`, Agent SDK), I want the subagent path with notices in the final report, so that nobody waits on a question. [Q17]
