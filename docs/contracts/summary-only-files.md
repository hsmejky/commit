# Summary-only files

A file is summary-only when any rule matches, checked in this order:

1. `lockfile`: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`,
   `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`.
2. `minified`: `*.min.*`.
3. `sourcemap`: `*.map`.
4. `generated`: `linguist-generated` set in `.gitattributes`.
5. `lines`: over 1000 changed lines.
6. `size`: over 256 KB.
Body cap (not a summary-only rule): files are visited in path order (byte-wise over UTF-8,
ascending), summing changed lines of the files not summary-only. The first file that would
take the sum over 3000, and every file after it, get no block in `hunks.txt`; each of their
hunks keeps its own ID with `body: "cap"` ([plan --hunks](plan-hunks.md), Q19).

The scan ignores summary-only status. It skips a tracked file whose added lines exceed 1 MB
and an untracked file over 1 MB; both are reported in `scan.skipped`.
