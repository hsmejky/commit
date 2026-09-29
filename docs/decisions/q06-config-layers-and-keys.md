# Q6 Config layers and keys

- **Context.** Commit style is shared by a team, but repos without a config still need
  personal defaults.
- **Decision.** Two layers: user `commit.json` in the Claude home (`~/.claude`, or
  `CLAUDE_CONFIG_DIR` when set, Q5) overridden per key by repo
  `.claude/commit.json` (at the git toplevel). Override is per key and replaces the value,
  arrays included.

  | Key | Values | Layer |
  | --- | --- | --- |
  | `types` | non-empty array of lowercase types, each `^[a-z][a-z0-9-]*$` | either |
  | `scope` | `"forbidden" \| "optional" \| "required"` | either |
  | `body` | `"forbidden" \| "optional"` | either |
  | `maxSubjectLength` | integer 20–200, code points of the whole header (`type(scope)!: description`) | either |
  | `subjectCase` | `"lower" \| "any"`, see [contracts](../contracts/message-grammar.md) | either |
  | `scanIgnore` | array of path globs (Q10) | repo only |

  - Unknown key: warning (stderr and `plan.warnings`), ignored.
  - Unknown value for a known key (a future `body: "required"`):
    warning, and the key falls back to the next layer, then the default.
  - A key in the wrong layer: warning, ignored.
  - Wrong JSON type (`maxSubjectLength: "72"`), a number out of range or not an integer
    (`0`, `72.5`), an empty `types` array (every commit would fail lint), a malformed
    `types` entry, or unparseable JSON: error; `plan` stops before any run starts, with
    the CLI kind `config` (exit 1, Q9).
  - `scanIgnore` is read from the repo config at HEAD (Q10), every other repo key from the
    working tree; `plan` reports its source as `repo@HEAD`. An invalid value at HEAD is a
    warning, not an error (amended by the CFG-01 decision pass, below).

  Defaults: the commitlint `config-conventional` types (build, chore, ci, docs, feat, fix,
  perf, refactor, revert, style, test), no scope, no body, 72 code points, lowercase. The
  worker's model is not a config key (Q24).
- **Amended.** By spec pass 2 (2026-09-27): added the user layer's `commit.json` in the
  Claude home below the repo layers, and gave an invalid layer or glob the CLI kind
  `config` (exit 1) instead of a bare error.
- **Amended.** By the CFG-01 decision pass (2026-09-29): the error list covers the layers
  as read (the user layer and the repo layer in the working tree), not the repo config at
  HEAD. When the `scanIgnore` read at HEAD is invalid (the file at HEAD is not valid JSON,
  the value is not an array of strings, or a pattern is a glob error, Q10), the loader uses
  `[]` and adds a warning; `plan` goes on. `[]` exempts nothing, so the scan fails closed.
  The worktree layer is validated as before, `scanIgnore` included, so a copy still invalid
  there stops `plan` with `config`, and a fixed copy is committable: its `scanIgnore`
  differs from HEAD's `[]` when it carries patterns, which makes the confirmation
  `humanOnly` (Q10 as amended). The loader exports the repo-config path
  (`REPO_CONFIG_PATH`), so no other module spells it.
- **Rejected.**
  - Repo only; a third local layer (commit style is shared by nature).
  - Unknown key or value as an error: one teammate on a newer plugin would break every commit
    for teammates on older versions.
  - A `version` key: additive keys and values plus warnings cover forward compatibility.
  - `body: "required"`: forced bodies produce filler on trivial commits, and `infer` has no
    signal that would justify it.
  - A `plannerModel` / `workerModel` key (dropped after the commit-worker spike,
    2026-09-26): the Agent call's `model` parameter does override the agent's frontmatter,
    but the caller that makes the call never reads `commit.json`, so the key would need a
    read in the main thread on every commit, and a handback's `respawn` would lose it. A
    personal cost choice in the repo layer was wrong anyway. Roadmap: Haiku through the
    frontmatter default once the eval allows it (Q12).
- **Consequences.** The repo is the team's source of truth; the user layer covers repos
  without a config. Paths and key names are public surface.
