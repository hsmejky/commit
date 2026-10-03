# Other repo configurations

- **Case-only renames**: a staged `git mv` is one `R` unit on a case-sensitive filesystem;
  on a case-insensitive one, or with `core.ignorecase=true`, `plan` refuses with `state`
  (`case-rename`) naming each rename, for the user to commit by hand. An unstaged case-only
  rename on a case-insensitive filesystem is invisible to git and not planned.
- **Sparse checkout, `skip-worktree`**: such entries never appear in the diff and are never
  units; no special handling.
- **`i18n.commitEncoding`** other than UTF-8: refused at `plan` with `state`.

The first two entries are recorded in Q11, the third in Q21.
