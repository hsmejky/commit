# Q19 Large diffs

- **Context.** Lockfiles, generated and minified files, and big untracked files would flood the
  worker and slow the scan.
- **Decision.**
  - `plan --hunks` marks a file `summary-only` when it is a known lockfile, `*.min.*`, `*.map`,
    marked `linguist-generated` in `.gitattributes`, over 1000 changed lines, or over 256 KB.
    The worker gets only its stats (`+a -b`) and groups it as a whole file.
  - Hunk **bodies** in `plan --hunks` are capped at 3000 changed lines in total, counted over
    files in path order (byte-wise, UTF-8). The first file that would cross the cap and every
    file after it get no body in `hunks.txt`, but keep one ID per hunk with its range and
    line counts (`"body": "cap"` in the index). The worker can still split such a file by
    its ranges, and may `Read` the working-tree file at a range. The cap limits the
    worker's context, not the tool output.
  - Tool output limits are handled separately (Q9). The Bash tool cuts output at about
    30 000 characters and `Read` cuts lines over 2000 characters, so hunk bodies go to
    `hunks.txt` (raw text, one line per diff line), which the worker `Read`s in pages; stdout
    carries only an index within a 20 000-character budget. `plan`'s own stdout fields
    stay within 1 kB (its `reply` and `hunks` have their own budgets, Q9), and its full
    output always goes to `plan.json` in the run folder. Accepted: a diff line over 2000
    characters is cut by `Read`; grouping needs the shape of a hunk, not every byte, and
    minified files are summary-only anyway.
  - The scan still covers lockfiles and `.map` files (tokens do leak into them). Its skip
    limit is 1 MB of added content (Q10). Untracked directories collapsed by the count cap
    (Q16) are neither planned nor scanned.
- **Amended.** By the PRE-08 spike (2026-09-29, Claude Code 2.1.284): corrects "a diff line
  over 2000 characters is cut by `Read`". Measured: `Read` shows no per-line character cut
  (a single 10 000-character line came back whole); instead it enforces a whole-call token
  budget (~25 000 tokens, roughly 50 000 characters) and errors, asking for `offset`/`limit`,
  when a requested range is over it, rather than silently truncating a line. The `hunks.txt`
  paging is unaffected as long as each page the worker `Read`s stays under that budget,
  which the existing 20 000-character stdout budget and hunk-range paging already do with
  margin (Q9 amendment).
- **Rejected.**
  - No cap: a single lockfile update can exceed the worker's useful context.
  - Making files past the cap summary-only (whole-file units): the files past it are not
    huge, only late in path order (`z…`, `tests/…`), so on any diff near the cap the last
    files would lose hunk-level grouping.
- **Consequences.** Grouping inside a summary-only file is not possible; it is always one
  unit. Past the cap, grouping works from ranges and line counts alone, unless the worker
  `Read`s the file.
