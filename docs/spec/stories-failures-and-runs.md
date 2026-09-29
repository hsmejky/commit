# User stories: failures, repo states and runs

## Failures, repo hooks, signing

160. As a developer, I want a stop at the first failing group, earlier commits kept and committed, failed and remaining groups reported, so that the state is explainable. [Q18]
161. As a developer, I want a failed group to unstage only when that group began staging, so that a foreign `index.lock` is never reset into, and every run end after the run reset my earlier staging, success included, to report what it unstaged, so that I know what changed. [Q18]
162. As a developer, I want the script to stage exactly the planned and confirmed changes and pass `git commit` exactly the approved message, so that nothing else goes in on the plugin's side (a hook that changes the tree afterwards is story 167 and a gap in [Out of Scope](out-of-scope.md)). [Q18]
163. As a developer, I want git and hook output shown with control characters escaped and capped to its last 2000 characters, with no retry and never `--no-verify`, so that repo rules stay mine and hook output can neither forge reply lines nor flood my context (a hook that prints plain-text lines or echoes a secret is a gap, see [Out of Scope](out-of-scope.md)). [Q18]
164. As a developer, I want a `diff-changed` after a formatter hook to name that likely cause, so that I understand it. [Q18]
165. As a developer, I want a commit git made despite a failure or timeout detected, so that the report is truthful. [Q18]
166. As a developer, I want an existing `index.lock` refused before each group touches the index, so that my index is never half staged. [Q18]
167. As a developer, I want a notice naming the tree actually committed when a hook or another process changed the index between the backstop check and the commit, so that the report matches what landed. [Q18]
168. As a developer, I want a run refused with `head-moved` when HEAD moved since planning, so that a commit never lands on a base I did not review. [Q18, C:cli-and-exit-codes]
169. As a developer, I want signing never disabled, so that my repo's signature policy holds for agent commits. [Q18]
170. As a developer, I want an SSH signing key with a passphrase that is not loaded in the agent refused at `plan` (`signing-locked`), so that no commit hangs on a passphrase. [Q18]
171. As a developer, I want enabled openpgp signing, and an SSH signing setup using a custom `gpg.ssh.program` (for example 1Password), noted in the plan, so that I expect a passphrase prompt may appear. [Q18]

## Time budget

172. As a developer, I want each `commit` call to return before a tool timeout can cut it (540-second budget; the first group always starts, a later group only while at least 480 seconds remain), so that no commit is cut mid-way. [Q18, C:commit-release]
173. As a developer, I want a call out of budget to stop cleanly with a `continue` handback that resumes after the committed groups, so that long runs finish. [Q18]
174. As a developer, I want a hung hook or a signing prompt nobody answers stopped at the budget, so that the call returns before the tool timeout and reports that a hook or a signing prompt may be waiting. [Q18]
215. As a developer, I want the plugin's own `index.lock` left behind by a timed-out partial `git commit` (reword's `--amend --only`) removed, while a lock another process created is kept, and after a timed-out plain commit (`split`, `staged`) any `index.lock` left in place with a notice to check it and remove it by hand if no git process is running, so that a timeout does not block my next git command and a foreign lock is never deleted. [Q18, C:commit-release]

## Reword via amend

175. As a developer, I want to reword the last commit with staged changes untouched, so that fixing a message is safe. [Q20]
176. As a developer, I want rewording refused on a pushed, unborn or merge-commit HEAD, so that shared history is not rewritten. [Q20]
177. As a developer, I want a root commit reworded against the empty tree, so that the first commit can be fixed too. [Q20]
178. As a developer, I want dictated text committed as given and a lint failure shown to me, so that my words are never rewritten unseen. [Q20]
179. As a developer, I want foreign trailers carried over, allowed footer tokens not carried and any Anthropic `Co-Authored-By` dropped, so that attribution is honest. [Q20]
180. As a developer, I want the attribution appended when the worker wrote the new message or the old message had one, so that my own dictated words stay mine. [Q20]
181. As a developer, I want a reword to scan the message but not the content and skip confirmation on the first spawn (a respawn after `lintFailed` confirms like any resumed run, stories 90, 95), so that it is quick. [Q20]

## Repo states

182. As a developer, I want an unborn HEAD planned against the empty tree, without `scanIgnore` and without a pushed check, so that the first commit works. [Q21]
183. As a developer, I want a detached HEAD warned about, so that I know where commits land. [Q21]
184. As a developer, I want an in-progress merge (including a pending `merge --squash`), cherry-pick, revert, rebase, bisect or paused sequence refused, so that those operations are never hijacked. [Q21]
185. As a developer, I want a non-repository or bare repository refused with a `state` error (exit 6), so that I know why nothing ran. [Q21]
186. As a developer, I want a repo whose `i18n.commitEncoding` is not UTF-8 (any spelling of `utf8` or `UTF-8`, case-insensitive, counts as UTF-8) refused, so that no commit is mislabelled. [Q21]

## Concurrent runs

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

## Install, README and opt-out

198. As a developer, I want a per-repo opt-out via `enabledPlugins`, so that repos with other conventions are untouched. [Q14]
199. As a developer, I want the README to require the anchored node allow rule for both shells and the run-folder `Edit` rule, and to explain why a bare `node *commit.cjs*` rule is unsafe, so that a run asks no permission and no lookalike script is allowed. [Q16]
200. As a developer, I want the README to require removing a personal commit skill, so that it does not capture "commit this" before the worker. [Q8]
201. As a developer, I want the README to state the gaps it cannot close, as one list ([Out of Scope](out-of-scope.md), accepted gaps), so that I know the limits. [Q3, Q5, Q9, Q10, Q11, Q16, Q17, Q18, Q19, Q20, Q22, Q23, Q25]
223. As a developer installing the plugin, I want the README to present its allow rules as a required install step and say what goes wrong without them (the worker's calls stall on permission prompts), so that I set them up before my first run. [Q16, Q24]
202. As a developer, I want Node 22+ and git 2.34+ required, and an older git, older Node or missing git reported as such, so that support is predictable and failures are loud. [Q1, Q15]
203. As a developer, I want a plugin with no npm dependencies, so that the guard works from the first shell call, offline, with no install step and no third-party code watching my commands. [Q1]
204. As a developer whose plugin sits under a path containing `$`, a backtick, `"`, `\` or a typographic double quote (U+201C-U+201E), I want the first call refused with an explanation before any work, while an ordinary Windows path works, so that no shell ever expands or mangles the script path. [Q16, C:guard]

## Budget and release

205. As a developer, I want a plugin commit to cost my main session, as a median per episode class, no more calls than the harness floor of the delivery shape in use, and, as a median per episode, no more than 2k main-context tokens (cache writes plus output) above a direct commit, so that my usage limits last (a 1.0.0 dogfood gate only, not a 0.1.0 check; limits: [Dogfood gate](story-verification.md)). [Q24]
228. As a developer, I want CI to hold the plugin's texts and outputs to fixed size budgets (agent and skill descriptions ≤ 200 characters; `/commit`'s `SKILL.md` ≤ 1.5 kB; a reply without its `text` ≤ 2 kB; `text` ≤ 4 kB with every list capped at 10 entries; `plan`'s own fields ≤ 1 kB; `plan --hunks` stdout ≤ 20 000 characters; the worker prompt ≤ 6 kB), so that a run cannot grow the context it costs without a failing test. [Q24, C:reply-and-handback]

## Run integrity

Story numbers are stable IDs, not a sequence: number 216 was never assigned (story 215
is under Time budget, story 217 below), and no story is missing.

206. As a developer, I want a run ID accepted only in the exact form the script mints, and every deletion kept inside the run-folder directory, so that a forged lock, flag or reply cannot make the plugin delete anything else. [Q22, Q25]
207. As a developer, I want a `.commit-plan` that is tracked, a link or not a directory refused, so that a cloned repo cannot redirect the plugin's writes. [Q9, Q22]
208. As a developer, I want `commit` refused without `--confirmed` while a confirmation is pending, and only the `yes` answer's `run` to carry `--confirmed`, so that a steered worker cannot skip the question with a plain `commit --all` or a forged `continue` (a forged no-user answer and a rewritten run state remain gaps, see [Out of Scope](out-of-scope.md)). [Q16, Q25]
209. As a developer, I want a second call on a run refused while another call on the same run is still running, so that a retried call cannot corrupt the run in progress, and a retried call after a crash not blocked by the killed one. [Q22]
210. As a developer, I want a run whose call was killed while staging to report what it unstaged when the next run takes it over, whatever that next run ends with (a clean tree, `modeChoice` or a refusal included), without the killed call blocking that takeover, so that my earlier staging is never lost without a word. [Q18, Q22]
217. As a developer, I want pressing Esc or ending the session to stop the script's git and hook processes, so that no commit lands after I stopped the run (pending the tool-termination item in [Open items](further-notes.md#open-items)). [Q9, Q18]
224. As a developer who updated the plugin mid-run, I want a run started by another plugin build refused as `ended`, so that no call acts on state it cannot read. [Q16]
211. As a developer, I want unresolved conflict entries in my index refused, so that conflict markers are never committed. [Q21]
212. As a developer, I want a file whose attributes call it binary but whose content is text scanned as text, so that a `-diff` or `binary` rule cannot hide a secret. [Q10]
213. As the Claude main session, I want a worker whose script call prints output that is not JSON (a Node too old to parse the entry point, before 12; a removed plugin version) to return the fallback reply quoting that output escaped and capped like relayed git or hook output (story 163), so that nobody guesses what happened. [Q1, Q25, C:worker-input]
229. As the Claude main session, I want to show the user the output of a handback `run` that holds no reply and to run nothing more, leaving the lock to the takeover question (story 59), so that a broken script call stops the handback visibly and nobody guesses what happened. [Q22, Q25, C:reply-and-handback]
227. As a developer, I want a takeover that finds only the killed group's paths staged to reset the index, and one that finds more than that never to commit the extra staging unasked (an interactive run asks `modeChoice`, a `--no-user` run refuses with `killed-leftover` naming the killed group's paths still staged, a `--reword` run goes on with a notice naming them), and the killed run's folder kept until that repair is done, so that a killed run's leftover staging is handled safely even when the takeover itself is killed. [Q17, Q18, Q22]
