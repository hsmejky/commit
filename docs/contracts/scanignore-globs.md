# scanIgnore globs

Hand-written matcher (zero deps). Patterns are matched against the repo-relative path with
forward slashes, case-sensitively on every OS, and must match the whole path.

| Syntax | Meaning | Example | Matches | Does not match |
| --- | --- | --- | --- | --- |
| `*` | any characters except `/`, including none | `tests/*.json` | `tests/a.json` | `tests/x/a.json` |
| `?` | exactly one UTF-16 code unit except `/` (a character outside the BMP takes `??`) | `a?.txt` | `ab.txt` | `a/.txt`, `a.txt` |
| `**` | zero or more whole segments, only as a whole segment; a trailing `/**` takes one or more (everything under the directory, never the directory itself) | `tests/**/key.pem` | `tests/key.pem`, `tests/a/b/key.pem` | `testskey.pem` |
| `tests/**` | — | `tests/**` | `tests/a.txt`, `tests/a/b.txt` | `tests` |
| trailing `/` | everything under that directory, same as `dir/**` | `tests/fixtures/` | `tests/fixtures/a/b.txt` | `tests/fixtures` (a file) |
| leading `/` | stripped; patterns are always relative to the repo root | `/docs/*.md` | `docs/a.md` | `x/docs/a.md` |
| anything else | literal | `a+b.txt` | `a+b.txt` | — |

Config error (Q6): `**` inside a segment (`a**b`), any `{`, `}`, `[` or `]` (paired or stray),
a leading `!`, a `\`, an empty pattern, a `..` segment, an empty segment (two consecutive `/`, or a
pattern that is only `/`, before the leading-`/` strip and trailing-`/`-to-`**` rules above
are applied: `/`, `//`, `a//b`), or a pattern with no literal character (Q10): one made only
of `*`, `?`, `**` and `/` (`**`, `**/*`, `**/?*`, `*/**`, `/**`), so one amended line cannot
switch the scan off. A broad pattern with a literal character (`src/**`) stays legal.
Every row, and every error, has a fixture. A config error stops `plan` when the pattern is
in the repo layer in the working tree; in the `scanIgnore` read at HEAD it makes the value
`[]` with a warning instead (Q6, Q10 as amended by CFG-01).

## Differences from git pathspecs (SCN-04)

A CI oracle (testing-modules.md, "Platform oracles in CI only") cross-checks the supported
subset above against git's `:(glob)` pathspec, excluding these rows where they deliberately
differ:

- `?` against a non-ASCII character: git's wildmatch counts UTF-8 bytes, we count UTF-16 code
  units, so a BMP or astral character needs a different `?` count in each.
- A pattern ending in `/` combined with a wildcard elsewhere (e.g. `src/*/`): git's wildmatch
  never matches a trailing literal `/` against a file path, so it matches nothing, while ours
  expands it to everything under the directory. A purely literal trailing-`/` pattern happens
  to reach the same set in git, but only via its separate directory-prefix fallback below, not
  glob expansion, so trailing `/` is excluded as a whole category.
- A leading `/`: git reads it as an attempt at an absolute filesystem path and fails the
  command, rather than rooting the pattern at the repo top the way we do.
- A literal (wildcard-free) pattern naming an existing directory: git falls back to matching
  everything under that directory; our literal row matches only that exact whole path.
