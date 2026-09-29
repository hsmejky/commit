# Scan patterns

Only added lines are scanned. The IDs are public surface. Every scanned line (diff line,
symlink target, message line) is cut to its first 4096 characters (UTF-16 code units)
before any regex or false-positive rule runs, so scanning stays linear in the input; text
past the cut is not scanned (accepted gap, Q10). Over a commit message the scanner
returns each hit as `{ patternId, start, end }`: UTF-16 offsets into the normalised message,
`end` exclusive, never the matched value; overlapping hits stay separate entries. A
`lintFailed` text replaces the union of the spans with `[<pattern-id>]` (the first hit's ID
where spans overlap), so no secret reaches the caller ([reply](reply-and-handback.md)).

| ID | Regex | Not a hit when | Source |
| --- | --- | --- | --- |
| `aws-access-key` | `\b(A3T[A-Z0-9]\|AKIA\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16}\b` | the value contains `EXAMPLE` | gitleaks, secretlint |
| `github-token` | `\b(gh[pousr]_[A-Za-z0-9]{36,}\|github_pat_[A-Za-z0-9_]{22,})\b` | — | GitHub token prefixes |
| `slack-token` | `\b(xox[abeoprs]-\|xoxe\.xox[bp]-\|xapp-\d-)[A-Za-z0-9-]{10,}` | — | gitleaks, secretlint |
| `anthropic-key` | `\bsk-ant-(api\|admin)\d{2}-[A-Za-z0-9_-]{93}AA(?![A-Za-z0-9_-])` | — | gitleaks, secretlint |
| `private-key` | `-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----` with flag `i` | none of the next 3 non-blank added lines of the same file (or message), not counting RFC 1421 header lines (`Proc-Type:`, `DEK-Info:`), is a key body line: 40 or more characters of `[A-Za-z0-9+/=]` after trimming; literal `\n` escapes after the header split the header's line into lines first, and 40 or more such characters after the header on its own line also count as a body (a one-line key) | gitleaks, secretlint |
| `connection-string` | `\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s/@]+@` | the password is `${…}`, `<…>`, `$VAR`, `%VAR%`, `***`, `password`, `pass` or `secret` | secretlint |
| `generic-secret` | `(?<![A-Za-z0-9])[A-Za-z0-9_]*?(secret\|token\|passw(or)?d\|api[_-]?key\|client[_-]?secret)(?![A-Za-z0-9])(_[A-Za-z0-9_]*)?["']?\s*[:=]\s*(["'][^"'\s]{12,}["']\|[^"'\s,;#]{12,}(?=[\s,;#]\|$))` with flags `iu` | the value has Shannon entropy below 3.5, or contains `example`, `changeme`, `dummy`, `xxx`, `${`, `<`, `process.env` or `os.environ` | gitleaks |
| `local-path` | `\b[a-z]:[\\/]+users[\\/]+[^\\/\s"'<>]+` (flags `iu`), `/Users/[^/\s"'<>]+`, `/home/[^/\s"'<>]+`; plus the current OS user name as a whole path segment (`[\\/]<name>[\\/]`) in any path, only when the name has 4 or more characters and is not a service user (below) | the user segment is a placeholder or service user (below), or contains a character no OS allows in a user name: `[ ] ( ) * + ? \| ^ $ { } < > %` | this plugin (Q10) |

Sources, credited here and in the README; data and sample cases only, no code, and nothing
from a source whose license restricts who may use it:

- gitleaks: the rule file `config/gitleaks.toml` (MIT; the rule file, not the
  gitleaks-action). RE2 inline `(?i)` becomes a JS flag. Its generator samples seed the
  fixtures.
- secretlint: `secretlint-rule-preset-recommend` (MIT).
- GitHub token prefixes `ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, as documented
  in GitHub's "About authentication to GitHub".
- Nosey Parker: its rule examples (Apache-2.0, NOTICE kept), as fixture seeds only.

A row's source is where its shape and sample cases were checked against; the regex and the
false-positive rules above are this table's own and stay authoritative.

`generic-secret` matches `GITHUB_TOKEN = "…"`, `DB_PASSWORD: "…"`, `STRIPE_SECRET_KEY =
"…"`, a JSON key with its closing quote (`"api_key": "…"`, `"client_secret":"…"`), and an
unquoted value of 12 or more characters running to whitespace, `,`, `;`, `#` or the line end
(`API_KEY=…` in a `.env` file, `password: …` in YAML). The key word may follow `_` or other
name characters and be followed by `_`-joined name parts (`_KEY`), but not sit inside a
longer word (`tokenizer`). The entropy and placeholder rules apply to quoted and unquoted
values alike, and read the value without its quotes: Shannon entropy in bits per character
(code point), and each placeholder word matched case-insensitively anywhere in the value.

A `private-key` body line starts, after trimming, with a run of 40 or more
`[A-Za-z0-9+/=]` characters; what follows the run (a closing quote, an `-----END` marker on a
one-line key) does not matter.

`connection-string` placeholders match the whole password: the words `password`, `pass`
and `secret` case-insensitively, `$VAR` and `%VAR%` as one variable name, and `***` as a run of
three or more `*`; `postgres://u:passwords@h` is a hit.

`local-path` OS-user segment: `osUser` comes from `os.userInfo()`, falling back to `USER` or
`USERNAME`, else `null`; a container without a passwd entry throws there, so with `osUser:
null` the OS-user segment check is skipped and the fixed `/home/<name>`, `/Users/<name>` and
`C:\Users\<name>` regexes still run. The segment compares with `osUser` case-insensitively,
needs a `/` or `\` on both sides, and is checked independently of the fixed regexes, so a
path both match is one hit per line in `scanUnits` (two overlapping spans in `scanText`).

`local-path` placeholders and service users (case-insensitive): `<…>`, `{…}`, `$USER`,
`%USERNAME%`, `user`, `username`, `you`, `me`, `name`, `example`, `node`, `root`, `ubuntu`,
`admin`, `runner`, `app`, `build`, `dev`, `src`, `docker`, `jenkins`, `vagrant`, `ec2-user`,
`www-data`, `git`, `circleci`, `gitpod`, `vscode`, `codespace`, `public`, `default`. The
illegal-character rule keeps regexes such as `/Users/[^/…]` (this file) from matching
themselves.

Each ID has a positive and a negative fixture under `tests/fixtures/`; `generic-secret` has
one positive per spelling above (among them a JSON key, an unquoted `.env` value and a
YAML value) and a negative for `tokenizer`, and `local-path` a negative for `/home/node/app` and for
this file's regex table. `slack-token` has one positive per prefix form; `private-key` has
a negative for a header with no body (a placeholder), a negative for an encrypted PEM
header (`Proc-Type` and `DEK-Info` lines) with no body, a positive for an encrypted PEM
with `Proc-Type` and `DEK-Info` lines before the body, and a positive for a key flattened
onto one line with literal `\n` escapes (a GCP JSON key, an escaped `.env` value); `anthropic-key` has a negative for a
short `sk-ant-…` placeholder; `aws-access-key` has a negative for an IAM unique ID (`AIDA…`,
`AROA…`), which names a principal and is not a credential.
