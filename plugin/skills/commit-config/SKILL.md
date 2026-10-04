---
name: commit-config
description: Infer commit conventions from history, show the proposal with its numbers, and write the chosen layer's commit.json only after you confirm.
disable-model-invocation: true
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/commit.cjs" infer` with whichever shell tool you
have (no arguments, no flags), with a tool timeout of 600000 ms (above `infer`'s own
540-second deadline), and read its JSON reply from stdout. Write nothing before this call
returns, and never compose config JSON yourself: the only text you ever write is a
`configJson` layer's `text`, verbatim.

If `ok` is false, show `error.message` and write nothing.

Otherwise branch on `outcome`:

- `too-few-commits`: there are too few commits to infer from. Say so and recommend the
  defaults (no config file). Do not show a proposal, do not ask, write nothing.
- `not-conventional`: the Conventional Commits share (`ccShare`) is under 50%, so this repo
  is out of scope for `commit`. Say so and point to the per-repo opt-out: disable the plugin
  for this repo by setting `"commit@commit": false` under `enabledPlugins` in the repo's
  `.claude/settings.local.json`. Do not ask, write nothing.
- `proposal`: show the proposal's keys (`types`, `scope`, `body`, `subjectCase`,
  `maxSubjectLength`) with their evidence, plus `wouldFail`, `nonConventional`, and
  `droppedTypes` with their counts, so the cost of adopting it is visible before anyone
  commits to it. Then ask whether to write it at `repo` or `user` level.

  After the user confirms the layer, read `configJson.repo` or `configJson.user` for the
  layer they picked:
  - `{ text }`: write `text` verbatim with the Write tool, to `.claude/commit.json` at the
    git toplevel for `repo` (`git rev-parse --show-toplevel`), or to `commit.json` in the
    Claude home for `user` (`CLAUDE_CONFIG_DIR` when set, else `~/.claude`; expand it
    yourself, the Write tool does not). If the target file already exists, Read it first —
    Write refuses to overwrite a file it has not seen. Confirm what was written.
  - `{ errors }`: the chosen layer is already invalid. Show the errors and write nothing;
    the existing file needs a hand fix first.

  Never write before the user has both seen the proposal and confirmed a layer.
