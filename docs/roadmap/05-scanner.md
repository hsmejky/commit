# 05 Scanner

M7, the `scanIgnore` glob matcher, and M8, the scanner: the pattern table of
C:scan-patterns as data with its false-positive rules, `scanUnits` over units and
`scanText` over messages. Both are tested in-process at Seam 3 from their contracts tables;
a few Seam 1 slices prove the scan inside `plan`. Main sources: M7, M8, Q10, Q19,
C:scanignore-globs, C:scan-patterns, testing-modules (scanner case list), stories 135-140,
145, 146, 148-150.

## SCN-01: Literal and `*` glob match (M7 tracer)

**What to build:** `compileGlob(pattern)` (typed) and `matches(matcher, path)` for literal
patterns and `*`, whole-path, case-sensitive on every OS.

**Blocked by:** FND-01, PRE-01.

**Status:** done

**Sources:** C:scanignore-globs (`*`, literal rows), M7, Q10.

- [x] Seam 3: `tests/*.json` matches `tests/a.json`, not `tests/x/a.json`; `a+b.txt` matches
      itself only; `Tests/a.json` does not match `tests/*.json`.


## SCN-02: `?`, `**` and slash rules

**What to build:** the remaining rows of C:scanignore-globs: `?`, `**` as a whole segment,
trailing `/`, leading `/`; linear-time matching.

**Blocked by:** SCN-01.

**Status:** done

**Sources:** C:scanignore-globs, M7.

- [x] Seam 3: one fixture per row with its match and non-match examples.
- [x] Seam 3: a long path against a many-`*` pattern completes in linear time (bounded
      duration assertion).


## SCN-03: Glob config errors

**What to build:** `compileGlob` returns code `config` for `**` inside a segment, braces,
classes, a leading `!`, `\`, an empty pattern, a `..` segment, and a pattern with no literal
character.

**Blocked by:** SCN-01.

**Status:** done

**Sources:** C:scanignore-globs (errors), Q6, Q10, M7, story 150.

- [x] Seam 3: one fixture per error; `**`, `**/*`, `**/?*`, `*/**`, `/**` → `config`.
- [x] Seam 3: `src/**` compiles (broad literal pattern stays legal).


## SCN-04: Glob oracle against git pathspecs (CI)

**What to build:** a CI check cross-checking the supported glob subset against git
`:(glob)` pathspecs, excluding rows where C:scanignore-globs deliberately differs.

**Blocked by:** SCN-02.

**Status:** done

**Sources:** testing-modules (platform oracles), C:scanignore-globs.

- [x] CI: each non-excluded row gives the same match set as `git ls-files ':(glob)…'` over
      a fixture tree; excluded rows are listed with the reason.


## SCN-05: One secret pattern over text and units (M8 tracer)

**What to build:** the pattern table as data (ID, regex, flags, false-positive rule, source)
with `github-token` only; `scanText(text, { osUser })` → `[{ patternId, start, end }]` and
`scanUnits(units, { scanIgnore, osUser })` → `{ hits, skipped }` over added lines. The unit
record shape comes from the M10 interface; CHG-03 produces real units.

**Blocked by:** SCN-01.

**Status:** done

**Sources:** C:scan-patterns, M8, Q10, stories 135, 140.

- [x] Seam 3: a `github-token` added line → one hit with pattern ID, path and line; the
      result holds no matched value (asserted by searching the serialised result).
- [x] Seam 3: `scanText` returns UTF-16 offsets, `end` exclusive; two overlapping hits stay
      two entries.
- [x] Positive and negative fixtures under the fixtures directory; the test source holds no
      literal hit (strings built at run time or loaded from fixtures).


## SCN-06: Prefixed / connection / generic rows

**What to build:** `aws-access-key`, `slack-token`, `anthropic-key` rows with their
false-positive rules; the `connection-string` row and its placeholder-password rule; and the
fixed `C:\Users\<name>`, `/Users/<name>`, `/home/<name>` `local-path` regexes with the
placeholder and service-user list and the illegal-character rule.

**Blocked by:** SCN-05.

**Status:** ready-for-agent

**Sources:** C:scan-patterns, Q10, stories 135, 136, 138.

- [ ] Seam 3: positive and negative per ID; `EXAMPLE` AWS key and IAM `AIDA…`/`AROA…` IDs
      are not hits; one positive per Slack prefix form; a short `sk-ant-…` placeholder is not
      a hit.
- [ ] Seam 3: `postgres://u:s3cr3tpw@h` → hit; passwords `${X}`, `<pw>`, `$VAR`, `%VAR%`,
      `***`, `password`, `pass`, `secret` → no hit.
- [ ] Seam 3: a home path with a real-looking name → hit per shape; `/home/node/app`,
      `/Users/<you>/x`, `C:\Users\%USERNAME%` → no hit.
- [ ] Seam 3: `c:/users/jdoe` (lowercase drive letter, forward slashes) → hit, since the
      regex is case-insensitive and accepts either slash direction (this is a contract
      fixture example, not a real path).
- [ ] Seam 3: the regex table text of C:scan-patterns scanned as added lines → no hit.


## SCN-07: `private-key` with its body rule

**What to build:** the `private-key` row: a header is a hit only when a key body line
follows within the next 3 non-blank added lines (RFC 1421 header lines not counted), with
literal `\n` escapes splitting a flattened key.

**Blocked by:** SCN-05.

**Status:** ready-for-agent

**Sources:** C:scan-patterns (`private-key`), testing-modules (scanner case list), story 135.

- [ ] Seam 3: a header with no body and an encrypted header with only `Proc-Type`/`DEK-Info`
      → no hit; an encrypted PEM with those lines before the body → hit.
- [ ] Seam 3: a key flattened onto one line as a GCP JSON value and as an escaped `.env`
      value → hit.
- [ ] Seam 3: a header with 40 or more body characters appended directly after it on the
      same physical line, with no `\n` escape (the one-line-key case) → hit.
- [ ] Seam 3: the same 3-non-blank-line body rule applied to a commit message: a header line
      followed within 3 non-blank message lines by a body line → hit; a header with no
      qualifying body line in the message → no hit.


## SCN-09: `generic-secret`

**What to build:** the `generic-secret` row with its entropy (below 3.5) and placeholder
rules for quoted and unquoted values.

**Blocked by:** SCN-05.

**Status:** ready-for-agent

**Sources:** C:scan-patterns (`generic-secret`), story 135, 146.

- [ ] Seam 3: one positive per spelling (`GITHUB_TOKEN = "…"`, `DB_PASSWORD: "…"`,
      `STRIPE_SECRET_KEY = "…"`, a JSON key, an unquoted `.env` value, a YAML value).
- [ ] Seam 3: `tokenizer = …`, a low-entropy value and each placeholder word → no hit.
- [ ] Seam 3: a `commit-scan: allow` comment on the line changes nothing (story 146).
- [ ] No CLI flag or environment variable exists that turns the scan off (story 146; checked
      by a review of the argv/usage table and the entry point's env reads).
- [ ] Seam 3: zero- or one-identifier-argument calls of 40 characters or fewer → no hit; a
      quoted call-shaped value, a call-shaped value over 40 characters, a high-entropy
      argument, or a digit inside a callee or argument segment → hit.


## SCN-11: `local-path` OS-user segment

**What to build:** the OS-user name as a whole path segment in any path, only for names of 4
or more characters that are not service users; `osUser: null` skips it.

**Blocked by:** SCN-06.

**Status:** ready-for-agent

**Sources:** C:scan-patterns (OS-user segment), Q10, architectural-decisions (`osUser`),
stories 138, 139.

- [ ] Seam 3: `osUser: "jdoe1"` → `/srv/jdoe1/x` is a hit; `osUser: "dev"` and `"runner"` →
      no segment hit.
- [ ] Seam 3: `osUser: "bob"` (3 characters, not a service user) → no segment hit, isolating
      the length rule from the service-user list.
- [ ] Seam 3: `osUser: null` → no segment check, the fixed shapes still hit.


## SCN-12: Line cut at 4096 characters

**What to build:** every scanned line (diff line, symlink target, message line) is cut to
its first 4096 UTF-16 code units before any regex or rule runs.

**Blocked by:** SCN-05.

**Status:** ready-for-agent

**Sources:** C:scan-patterns (cut), Q10.

- [ ] Seam 3: a `github-token` secret before the cut on a very long diff line → hit; one
      past it → missed (SCN-05's pattern is enough; the other pattern rows add nothing to
      this rule).
- [ ] Seam 3: the same cut applied to a message line and to a symlink target: a secret
      before the cut → hit, one past it → missed.
- [ ] Seam 3: a multi-megabyte line scans in linear time (bounded duration).


## SCN-13: Unit-level rules: added lines, binaries, 1 MB skip, symlinks, `scanIgnore`

**What to build:** `scanUnits` scans added lines only, skips binary units silently, reports
units over 1 MB added (tracked or untracked) in `skipped`, scans a symlink target as one
added line, and drops units whose path a `scanIgnore` matcher matches.

**Blocked by:** SCN-05, SCN-02.

**Status:** ready-for-agent

**Sources:** M8, Q10, Q19, C:scan-patterns, stories 140, 145, 148.

- [ ] Seam 3: a secret on a removed line → no hit; a binary unit → neither hit nor skipped.
- [ ] Seam 3: a unit with over 1 MB added → `skipped` with the exact reason `"added content
      over 1 MB"` (C:plan), no hits.
- [ ] Seam 3: a symlink unit whose target is a home path → hit.
- [ ] Seam 3: a secret in a unit matched by `tests/fixtures/**` → no hit.


## SCN-14: `scanIgnore` change flags the repo config's units

**What to build:** M4 pure `scanIgnoreChanged(headPatterns, snapshotBlob)`, M10
`snapshotBlob(path)` for the repo config on the snapshot side, and M8's `scanIgnoreUnits`:
when the parsed `scanIgnore` differs, every unit whose path or old path is the repo config
is flagged; M18 `plan` step 5 stores the flag and the units in the scan map, as
`scan.scanIgnoreChanged` and `scanIgnoreUnits`.

**Blocked by:** SCN-13, CFG-07, CFG-01, CHG-08, CHG-16.

**Status:** ready-for-agent

**Sources:** M4, M8, M18 step 5, C:plan-hunks (scan map, `snapshotBlob`), Q10 (pass 9),
story 149.

- [ ] Seam 3: `scanIgnoreChanged: true` flags both hunks of the repo config; `false` flags
      none.
- [ ] Seam 1: editing only `maxSubjectLength` → `scan.scanIgnoreChanged: false`, empty
      `scanIgnoreUnits`; adding a pattern → `true` and every repo-config unit in the scan
      map (provisional: depends on CFG-01 open item 2 settling whether every repo-config
      unit, or only the changed unit, is flagged).
- [ ] Seam 1: snapshot content that is not valid JSON, or a non-array `scanIgnore`, counts
      as changed; a missing file or key is no patterns.
- [ ] Seam 1: renaming or moving `.claude/commit.json` while also changing `scanIgnore` →
      the unit is flagged by its old path, since it is the repo config file (C:plan-hunks).
- [ ] Seam 1 (macOS runner, case-insensitive FS): a `scanIgnore` pattern differing in case
      from the path does not exempt it.
- [ ] Seam 1: a `scanIgnore` pattern committed at HEAD exempts a matching hit from
      `scan.hits`.
- [ ] A static test asserts M18's source imports `isRepoConfigPath` and passes it to
      `scanUnits`, M8's source does not import it, and neither holds a repo-config filename
      literal of its own.


## SCN-15: `plan` reports hits without values

**What to build:** the scan inside `plan` at Seam 1: hits by pattern ID and location in
`plan`'s `scan`, skipped files, and the secret nowhere in stdout or the run folder.

**Blocked by:** SCN-13, CHG-16, FND-10.

**Status:** ready-for-agent

**Sources:** Q10, C:plan (`scan`), M18, stories 135-137, 140, 145.

- [ ] Seam 1: an added token in a modified file → `scan.hits` entry with path, line and
      pattern; the token string is absent from stdout and every run-folder file.
- [ ] Seam 1: a 2 MB untracked candidate → `scan.skipped` with the exact reason `"added
      content over 1 MB"`.
- [ ] Seam 1: the entry point derives `osUser` via `os.userInfo()` when available, else
      falls back to `USER` then `USERNAME`, else `null`; with the fault preload making
      `os.userInfo()` throw and neither env var set, `plan` still completes with
      `osUser: null` — the OS-user segment check is skipped, the fixed `local-path` shapes
      still run.


## SCN-16: Scan sees committed content (attribute-hidden text, symlinks)

**What to build:** Seam 1 proof that the scan reads what history gets: a secret in a file
marked `-diff` or `binary` in `.gitattributes` is found, and a new symlink to a home path is
blocked.

**Blocked by:** SCN-15, CHG-11, CHG-09.

**Status:** ready-for-agent

**Sources:** testing-modules (scanner case list), Q10, Q11.

- [ ] Seam 1: a token in a `-diff` text file and in a `binary`-attributed text file → hits.
- [ ] Seam 1: a new symlink whose target is a home path → hit on that unit.
- [ ] Seam 1: the same hits occur whether or not `GIT_ATTR_SOURCE` (or another
      attribute-source decoy) is exported pointing elsewhere — the scan reads the real
      repo's `.gitattributes`, not the decoy's.
