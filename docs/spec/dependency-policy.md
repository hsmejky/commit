# Dependency policy

**No npm dependencies, Node built-ins only, no vendored code** (Q1). Claude Code can install
a plugin's dependencies, but only non-blocking, with `--ignore-scripts` and a 60 s timeout,
so the guard could be silently absent on first run; add offline machines and the
supply-chain exposure of a hook that sees every command. Data (regex tables) and test cases
may be borrowed, with attribution, from MIT, ISC, BSD, Apache-2.0 (NOTICE kept) or
CC-BY-4.0 sources (Q10: licenses that do not restrict who may use them); code is never
copied. Token prefixes are facts and are credited anyway.

**Built-ins and version fences.** The floor is any Node 22 release, and the CI Node 22 leg
runs the oldest 22.x as well as the latest. The reasons below are kept timeless; the dated
release facts behind them are recorded in [Q1](../decisions/q01-skill-plus-a-deterministic-script.md).

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
unterminated quotes, subshells and case variants ([Open items](further-notes.md#open-items)). Safety comes from failing closed on unrecognised options; fragility is
answered with a wider fail-closed rule or a documented false positive. Run 2026-09-29;
findings settled in Q3.
