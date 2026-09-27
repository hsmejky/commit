# scanIgnore globs

Hand-written matcher (zero deps). Patterns are matched against the repo-relative path with
forward slashes, case-sensitively on every OS, and must match the whole path.

| Syntax | Meaning | Example | Matches | Does not match |
| --- | --- | --- | --- | --- |
| `*` | any characters except `/`, including none | `tests/*.json` | `tests/a.json` | `tests/x/a.json` |
| `?` | exactly one character except `/` | `a?.txt` | `ab.txt` | `a/.txt`, `a.txt` |
| `**` | zero or more whole segments; only as a whole segment | `tests/**/key.pem` | `tests/key.pem`, `tests/a/b/key.pem` | `testskey.pem` |
| trailing `/` | everything under that directory, same as `dir/**` | `tests/fixtures/` | `tests/fixtures/a/b.txt` | `tests/fixtures` (a file) |
| leading `/` | stripped; patterns are always relative to the repo root | `/docs/*.md` | `docs/a.md` | `x/docs/a.md` |
| anything else | literal | `a+b.txt` | `a+b.txt` | — |

Config error (Q6): `**` inside a segment (`a**b`), braces `{…}`, classes `[…]`, a leading
`!`, a `\`, an empty pattern, a `..` segment, or a pattern with no literal character (Q10):
one made only of `*`, `?`, `**` and `/` (`**`, `**/*`, `**/?*`, `*/**`, `/**`), so one
amended line cannot switch the scan off. A broad pattern with a literal character
(`src/**`) stays legal.
Every row, and every error, has a fixture.
