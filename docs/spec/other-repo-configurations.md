# Other repo configurations

- **Case-only renames**: supported when git reports them (a staged `git mv`); an unstaged
  case-only rename on a case-insensitive filesystem is invisible to git and not planned.
- **Sparse checkout, `skip-worktree`**: such entries never appear in the diff and are never
  units; no special handling.
- **`i18n.commitEncoding`** other than UTF-8: refused at `plan` with `state`.

The first two entries are recorded in Q11, the third in Q21.
