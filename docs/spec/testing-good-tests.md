# What makes a good test

- It checks external behaviour only: a call's JSON object and exit code, the resulting
  commits, index and working tree, the run folder, and the guard's stdout, its heartbeat
  file and its `COMMIT_GUARD_DEBUG=1` stderr line. It never asserts
  internal calls, intermediate state or mocks, and it survives any refactor that keeps
  behaviour.
- Oracle: the contracts first; the decisions for rules contracts do not carry (for example
  the stale `index.lock` rule of M10 `commitGuarded`, Q18: after a partial `git commit`
  timeout (`reword`), the `index.lock` that `git commit` left is gone when the call returns,
  while one another process created after the kill is still there, and a later `commit`
  call is refused with `index-lock`; after a plain `git commit` timeout (`split`,
  `staged`), an existing `index.lock` is still there and the output carries the notice).
  Every expected value traces to one of them.
- `node:test`, no dependencies. Tests build git repos in temp directories at run time, with
  fixed author, committer and dates via env.
