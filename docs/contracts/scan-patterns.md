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
| `private-key` | `-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----` with flag `i` | none of the next 3 non-blank added lines of the same unit (or message), not counting RFC 1421 header lines (`Proc-Type:`, `DEK-Info:`), is a key body line: 40 or more characters of `[A-Za-z0-9+/=]` after trimming; literal `\n` escapes after the header split the header's line into lines first, and 40 or more such characters after the header on its own line also count as a body (a one-line key) | gitleaks, secretlint |
| `connection-string` | `\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s/@]+@` | the password is `${…}`, `<…>`, `$VAR`, `%VAR%`, `***`, `password`, `pass` or `secret` | secretlint |
| `generic-secret` | `(?<![A-Za-z0-9])[A-Za-z0-9_]*?(secret\|token\|passw(or)?d\|api[_-]?key\|client[_-]?secret)(?![A-Za-z0-9])(_[A-Za-z0-9_]*)?["']?\s*[:=]\s*(["'][^"'\s]{12,}["']\|[^"'\s,;#]{12,}(?=[\s,;#]\|$))` with flags `iu` | the value has Shannon entropy below 3.5, contains `example`, `changeme`, `dummy`, `xxx`, `${`, `<`, `process.env` or `os.environ`, or, when unquoted, is a call site of 40 or fewer characters matching `^[A-Za-z_$][\w$.]*\((?:[A-Za-z_$][\w$.]*)?\)$` (empty or a single identifier argument) whose every dotted segment, in the callee and in the argument if any, is word-shaped (a digit may appear only at the segment's end) and whose argument, if any, itself has Shannon entropy below 3.5 (`fetchAccessToken()`, `getV2()`, `self._fetch_token(scope)`) | gitleaks |
| `local-path` | ``\b[a-z]:[\\/]+users[\\/]+[^\\/\s"'`<>]+`` (flags `iu`), ``/Users/[^/\s"'`<>]+``, ``/home/[^/\s"'`<>]+``; plus the current OS user name as a whole path segment (`[\\/]<name>[\\/]`) in any path, only when the name has 4 or more characters and is not a service user (below) | the user segment is a placeholder or service user (below), or contains a character no OS allows in a user name: `[ ] ( ) * + ? \| ^ $ { } < > %` | this plugin (Q10) |

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
The call rule applies only to an unquoted value (a quoted call-shaped value, e.g.
`token = "fetchToken(abc123XYZ)"`, still hits): an unquoted value made entirely of a bare or
dotted identifier followed by an empty parameter list or a single identifier argument, and no
longer than 40 characters, such as `fetchAccessToken()` in `const token = fetchAccessToken();`
or `self._fetch_token(scope)` in `token = self._fetch_token(scope)`, is a call site reading a
secret, not the secret itself, and is not a hit — unless disqualified by either of the two
checks below, in which case it stays subject to the ordinary entropy and placeholder rules
above (it is scanned as an ordinary value, not specially rejected). First, every dotted
segment of the callee, and of the argument if any, must be word-shaped: a digit may appear
only at the segment's end, so a trailing version number still reads as a name
(`getV2()`, `fetchToken2()` stay excluded) but a digit anywhere else means a secret is
standing in as the callee or the argument, not a plausible identifier (`Xk9aQ2xL7mZ4pRkW8vT3()`,
`a.Xk9aQ2xL7mZ4pRkW8vT3()`, `Xk9aQ2xL7mZ4pRkW8vT3.x()`, `Xk9aQ2xL7mZ4(pRkW8vT3)`,
`Xk9a.Q2xL.7mZ4.pRkW.8vT3(a)`, `$Xk9aQ2xL7mZ4pRkW8vT3()` and a hex-shaped
`f3a9c2e1b7d4a8f6c0e2b9d7a1c3e5f7()` all hit). This is a hardening against accidental leaks,
not deliberate evasion, so an all-letter random callee (`XkaQxLmZpRkWvT()`) remains a residual
limit, accepted because a real secret does not accidentally end in `()`. Second, an
identifier-shaped but high-entropy argument (`abc(Xk9aQ2xL7mZ4pRkW8vT3)`) is a secret smuggled
into the argument position, not a parameter name, so the argument, if any, must also have
Shannon entropy below 3.5. The 40-character cap catches the same smuggling one level up: a
value long enough to hold a real secret as its own identifier-shaped "callee", such as a JWT
immediately followed by a trivial `(x)`, is longer than any plausible call site and so is
never treated as one, whatever its argument — including a real, long call such as
`token = this.authService.getAccessTokenForUser(user)` (44 characters), which is a documented
false positive alongside the multi-argument case below. Only a zero- or one-argument call is
excluded this way: a multi-argument call's value stops at the row's own `,` lookahead before
reaching a closing `)` (the value captured from `fetchAccessToken(a, b);` is
`fetchAccessToken(a`), so it never matches the call shape and remains a documented false
positive — `fetchAccessToken(a, b);` and `jwt.sign(payload, key)` still hit.

A `private-key` body line starts, after trimming, with a run of 40 or more
`[A-Za-z0-9+/=]` characters; what follows the run (a closing quote, an `-----END` marker on a
one-line key) does not matter.

`connection-string` placeholders match the whole password: the words `password`, `pass`
and `secret` case-insensitively, `$VAR` and `%VAR%` as one variable name, and `***` as a run of
three or more `*`; `postgres://u:passwords@h` is a hit.

`local-path`'s three fixed shapes (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`) are
one regex, not three separate rows, so a path more than one shape could match
(`C:/Users/<name>` matches both the drive shape and `/Users/<name>`) gives one span at that
location, not overlapping spans. The name segment of all three stops at a backtick, like it
already stops at a quote or `<`, so a name inside a Markdown code span (`` `/home/node` ``)
does not absorb the closing backtick.

`local-path` OS-user segment: `osUser` comes from `os.userInfo()`, falling back to `USER` or
`USERNAME`, else `null`; a container without a passwd entry throws there, so with `osUser:
null` the OS-user segment check is skipped and the fixed `/home/<name>`, `/Users/<name>` and
`C:\Users\<name>` regexes still run. The segment compares with `osUser` case-insensitively,
needs a `/` or `\` on both sides, and is checked independently of the fixed regexes, so a
path both match is one hit per line in `scanUnits` (two overlapping spans in `scanText`). The
illegal-character rule also runs against `osUser` itself, not only a matched segment: an OS
user name holding one of those characters is treated as no usable user (the check is
skipped), the same as `osUser: null`.

`local-path` placeholders and service users (case-insensitive): `<…>`, `{…}`, `$USER`,
`%USERNAME%`, `user`, `username`, `you`, `me`, `name`, `example`, `node`, `root`, `ubuntu`,
`admin`, `runner`, `app`, `build`, `dev`, `src`, `docker`, `jenkins`, `vagrant`, `ec2-user`,
`www-data`, `git`, `circleci`, `gitpod`, `vscode`, `codespace`, `public`, `default`. The
illegal-character rule keeps regexes such as `/Users/[^/…]` (this file) from matching
themselves.

Each ID has a positive and a negative fixture under `tests/fixtures/`; `generic-secret` has
one positive per spelling above (among them a JSON key, an unquoted `.env` value and a
YAML value), plus a positive for a dotted key with an unquoted value (`config.apiKey=…`), a
dotted, parenthesis-free unquoted value (`token = config.apiKeyValue`), a quoted call-shaped
value (`token = "fetchToken(…)"`), and one per bypass the call rule's shape, word-shape and
entropy checks close off (an unquoted value with a punctuation, digit-led or hyphenated
argument, a call-shaped high-entropy argument, a call-shaped value longer than 40 characters,
and a digit inside a callee or argument segment — a bare callee, a leading and a trailing
dotted segment, a dotted callee with every segment affected, a `$`-prefixed callee, and a
hex-shaped callee); and a negative for `tokenizer` and for each call form in the "Not a hit
when" clause (a bare call, a `snake_case` call, a dotted method call with an argument), and
`local-path` a negative for
`/home/node/app`
and for a name that stops at a backtick (`` `/home/node` ``), and a positive for a name that
stops at a backtick (`` `/Users/jdoe` ``). `slack-token` has one positive per prefix form; `private-key` has
a negative for a header with no body (a placeholder), a negative for an encrypted PEM
header (`Proc-Type` and `DEK-Info` lines) with no body, a positive for an encrypted PEM
with `Proc-Type` and `DEK-Info` lines before the body, and a positive for a key flattened
onto one line with literal `\n` escapes (a GCP JSON key, an escaped `.env` value); `anthropic-key` has a negative for a
short `sk-ant-…` placeholder; `aws-access-key` has a negative for an IAM unique ID (`AIDA…`,
`AROA…`), which names a principal and is not a credential.
