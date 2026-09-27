# User stories: config, messages and scan

## Config layers

105. As a developer, I want the user layer overridden per key by the repo layer, arrays replaced, so that the team repo wins. [Q6]
106. As a developer, I want `types`, `scope`, `body`, `maxSubjectLength` (20–200 code points of the header) and `subjectCase`, so that common styles are expressible. [Q6]
107. As a developer, I want `scanIgnore` accepted only in the repo layer, so that a personal file cannot silence a team's scan. [Q6, Q10]
108. As a developer, I want defaults of 11 standard types, no scope, no body, 72 and lowercase, so that repos without config work. [Q6]
109. As a teammate on an older plugin, I want unknown keys, unknown values and wrong-layer keys to warn and fall back, so that newer configs do not break me. [Q6]
110. As a developer, I want wrong types, out-of-range numbers, bad `types` or unparseable JSON to stop `plan` before any run starts, so that typos surface. [Q6]
111. As a developer, I want effective values and their sources reported, so that I see where a rule came from. [Q6]
112. As a developer with `CLAUDE_CONFIG_DIR` set, I want the user layer, the Claude settings and the heartbeat read from that directory, so that the plugin follows my Claude home. [Q5]
113. As a developer, I want no worker-model key, so that a repo config cannot move the worker to a model the plugin was not tuned and measured for. [Q6, Q24]

## Attribution and trailers

114. As a developer, I want the trailer to follow `attribution.commit`, then `includeCoAuthoredBy`, across managed, project-local, project and user settings, so that it matches the harness. [Q5]
115. As a developer, I want an empty `attribution.commit` to mean no trailer, so that I can turn it off. [Q5]
116. As an organisation admin, I want `managed-settings.json` honoured, and the policy sources the script does not read (the managed drop-in directory, MDM profile, registry, server-managed) documented, so that I know where the plugin follows policy. [Q5]
117. As a developer, I want non-trailer attribution lines dropped with a warning, so that `body: forbidden` holds. [Q5]
118. As a developer, I want a model-free default trailer, so that the attribution line is predictable and cannot be spoofed by the model. [Q5]
119. As a developer, I want trailers added only by the script, never from agent text, so that attribution cannot be spoofed. [Q5, Q13]
120. As a developer, I want only `BREAKING CHANGE`, `BREAKING-CHANGE`, `Refs`, `Closes` and `Fixes` footers allowed, with a lint hint for `Note:` paragraphs, so that footers stay predictable and the lint hint tells the worker how to fix a `Note:` paragraph. [Q13]
121. As a developer, I want a footer-only last paragraph allowed under `body: forbidden`, so that `Closes #n` works. [Q13]

## Lint and message grammar

122. As a developer, I want every message linted before the first commit, so that lint never leaves a run half done. [Q18]
123. As a developer, I want the lowercase rule to pass acronyms, digits and symbols, so that `API` subjects are fine. [C:message-grammar]
124. As a developer, I want messages normalised (BOM, UTF-16, CRLF and lone CR) and invalid UTF-8 rejected, so that encoding never corrupts history. [Q9]
219. As a developer with a file whose name is not valid UTF-8, I want it reported in `notIncluded` and never planned, so that it is not committed under a mangled name. [Q11]
125. As a developer, I want messages committed verbatim regardless of `commit.cleanup`, so that history equals what lint approved. [Q18]
126. As a developer, I want multi-line messages to survive every shell, PowerShell included, so that quoting never breaks a commit. [Q9]
127. As a developer, I want lint failures to end deterministically: at most one worker retry (none when the failing text is my dictated text), then a `lintFailed` question (`retry`, `no`, or any typed change, dictated text included), and with no user present the failure that ends the retries ending the run, so that loops end. [Q17, Q18]
214. As a developer, I want the `lintFailed` question to offer no dictated text when every error is a shape error (the worker plan is not valid JSON or not its shape), so that I am never asked for a message that cannot fix the failure. [Q18, C:reply-and-handback]

## commit-config and inference

128. As a developer, I want `commit-config` to infer a config from the last 200 non-merge commits, so that I need not guess conventions. [Q7]
129. As a developer, I want fixed thresholds (scope 90%/10%, body 10%, `lower` 90%, all 11 standard types always plus extra types ≥ 5%, p95 header length rounded up to 72 or 100, above 100 to the next multiple of 10 and flagged, clamped to 200 and flagged), so that proposals are predictable. [Q7]
130. As a developer, I want dropped types with counts and `wouldFail` shown, so that I see the cost first. [Q7]
131. As a developer, I want to pick repo or user level and confirm before writing, so that nothing changes unasked. [Q7]
132. As a developer, I want the written file to be the script's already-validated text for that layer, keeping my other keys such as `scanIgnore`, so that `commit-config` never writes an invalid or model-altered config. [Q6, Q7]
133. As a developer, I want the layer's validation errors shown and nothing written when my current layer is already invalid, so that a broken file is fixed by hand first. [C:infer]
134. As a developer, I want defaults recommended under 20 commits and the opt-out under 50% Conventional Commits, so that unsuitable repos are told so. [Q7, Q14]

## Secret and local-path scan

135. As a developer, I want added lines scanned for AWS keys, GitHub, Slack and Anthropic tokens, private keys, connection strings and generic secrets, so that none reach history. [Q10]
136. As a developer, I want added lines scanned for local paths, so that my home path and user name do not reach history. [Q10]
137. As a developer, I want messages scanned too, so that a quoted token or path cannot land. [Q10]
138. As a developer, I want my OS user name (≥ 4 characters, not a service user) caught as a path segment while `/home/node/app` is not, so that noise stays low. [Q10]
139. As a developer in a container without a passwd entry, I want the OS-user rule skipped rather than the scan failing, so that planning still works. [Q10]
140. As a developer, I want hits reported by pattern ID and location only, never in `hunks.txt` or any output, so that a secret I am adding is copied nowhere (a secret on a removed line is not scanned, see [Out of Scope](out-of-scope.md)). [Q10]
141. As a developer, I want a hit's unit left out with two manual commit lines (`add`, then `commit`), except a path holding `'`, a PowerShell single quote (U+2018–U+201B) or a control character, which gets only "commit by hand", so that the rest still commits. [Q10]
142. As a developer, I want a staged set with a hit or a hidden staged-new path refused (`staged-hit`), so that a set cannot smuggle it in. [Q10, Q11]
143. As a developer, I want the index rescanned before each commit, so that a file changed after planning cannot slip a secret into the commit. [Q10]
144. As a developer, I want filtered files scanned in cleaned form, so that the scan sees what is committed. [Q10]
145. As a developer, I want binaries not scanned, and additions over 1 MB skipped and reported in `scan.skipped`, so that the scan is bounded. [Q10, C:scan-patterns]
146. As a developer, I want no override flag, env or marker, so that an agent cannot silence the scan. [Q10]
147. As a developer, I want my shell's exported `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_ATTR_SOURCE` or other `GIT_*` variables ignored by the script's own git calls, while my hooks still see my environment, so that no inherited variable redirects what the scan reads. [Q9, Q10]
226. As a developer, I want the worker's rule to never `Read` a file with a scan hit, and to read a working-tree file only at a line range, understood as prompt-only and not enforced by the script (an accepted gap, see [Out of Scope](out-of-scope.md)), so that a secret I am adding does not enter the worker's context. [Q10, Q11]

## scanIgnore

148. As a developer, I want `scanIgnore` read from the repo config at HEAD, so that an agent cannot add an exception mid-run. [Q10]
149. As a developer, I want a `scanIgnore` change to apply only from the next commit (the human confirmation is story 89), so that exceptions are deliberate. [Q10]
150. As a developer, I want a small case-sensitive glob dialect in which braces, classes, a leading `!` and a pattern with no literal character (such as `**`, `**/?*` or `*/**`) are config errors, so that matching is predictable on every OS and one line cannot switch the scan off. [C:scanignore-globs, Q10]
151. As a developer, I want the worker to add `scanIgnore` entries only when I ask, so that exceptions never widen on their own. [Q10]

## Untracked and summary-only files

152. As a developer, I want gitignored files unseen, so that build output never appears. [Q16]
153. As a developer, I want hidden files (dot segments, `.env*` except templates, private `.claude/` files) never shown, while committed tooling dotfiles (`.github/**`, `.gitignore`, `.gitattributes`, `.editorconfig`, the shared `.claude/` files, `.changeset/**`, `.husky/**`, lint and format rc files, `.nvmrc`, `.devcontainer/**` and CI directories) stay visible, so that secrets stay out and a tooling-only change is not read as clean. [Q16, C:untracked-files]
154. As a developer, I want in `split` new directories over 50 files, over 50 root files, or totals over 200 collapsed to "add to .gitignore or commit by hand", so that junk stays out. [Q16]
155. As a developer, I want loose files in tracked directories not collapsed per directory unless they alone exceed 200, so that 51 migrations still commit. [Q16]
156. As a developer, I want hidden-only or collapsed-only changes, and a dirty submodule with no pointer change, to count as clean, still named in the `nothing` reply, so that junk does not start a run. [Q16, Q11]
157. As a developer, I want lockfiles, minified, source-map, generated, over-1000-changed-line or over-256 KB files shown to the worker as stats only and grouped as whole files, so that runs stay cheap. [Q19]
158. As a developer, I want hunk bodies capped at 3000 changed lines, files past the cap cut whole while each of their hunks keeps its own ID, so that the worker can still split them. [Q19, C:summary-only-files]
159. As a developer, I want a change set larger than a tool call can print still planned in full, so that tool output limits never cut the worker's view of it. [Q9, Q19]
