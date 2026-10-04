// M10 Change-set engine (docs/spec/modules-m10-m13.md, Q11): the inventory, the temporary
// index, units and the tree state. Effectful; spawns only through M2.
//
// INT-01 builds the `treeState` every reply ends with; CHG-04 adds `indexFingerprint` and
// M17's "N files left" rendering of that tree state. CHG-03 builds the tracer `inventory` (unstaged
// modifications of tracked files only), `snapshot` in `split` (one whole-file unit per
// modified file, diffed against HEAD) and `assignIds`; CHG-05 adds the temporary index,
// CHG-06 the streamed hunk-level pass, CHG-08 onward the other change kinds (CHG-09:
// symlinks, submodule pointers, type changes and `dirtySubmodules`).
// EXE-02 adds M16's thin whole-file `matchIds`, `stage`, `writeTree`, `treeDiffUnits` and
// a plain `commitGuarded` (CHG-19 to CHG-23 widen them).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { copyFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { hideFilter } from './path-classifier.mjs';
import { gitPath, run } from './process-adapter.mjs';

// Q11's pinned options, every one of them, for every diff the script runs. Only M10 holds
// them (M10: "the only owner of the pinned diff options").
const PINNED_CONFIG = [
  '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false',
  '-c', 'diff.autoRefreshIndex=true',
];
const PINNED_DIFF_OPTIONS = [
  '--no-ext-diff', '--no-color', '--no-textconv', '--no-relative', '-U3',
  '--inter-hunk-context=0', '--indent-heuristic', '-M', '--diff-algorithm=myers',
  '--ignore-submodules=dirty', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/',
  '--full-index',
];

const NUL = 0x00;
const LF = 0x0a;
const COLON = 0x3a;
const SPACE = 0x20;
const PLUS = 0x2b;
const MINUS = 0x2d;
const BACKSLASH = 0x5c;
const SECTION_START = Buffer.from('diff --git ');
const HUNK_START = Buffer.from('@@ ');
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const LOSSY_UTF8 = new TextDecoder('utf-8');
const BINARY_SNIFF_BYTES = 8000;
const BINARY_PATCH = Buffer.from('Binary files ');
// A section header's `index <old>..<new>[ <mode>]` line, full IDs under `--full-index`.
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]+)?\n$/;
const NO_MODE = '000000';
const REGULAR_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

/**
 * Reads the working tree's state: every path `git status` reports (tracked changes and
 * untracked, non-ignored files).
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options `now`: the
 *   injected clock, passed on to M2.
 * @returns {Promise<{ clean: true } | { count: number, paths: string[] }>}
 * @throws {Error} when `git status` exits non-zero.
 */
export async function treeState({ toplevel, env, now }) {
  const paths = (await statusEntries({ toplevel, env, now, untracked: 'all' })).map((entry) => entry.path);
  return paths.length === 0 ? { clean: true } : { count: paths.length, paths };
}

/**
 * The index fingerprint (C:plan steps 4 and 7, Q11): SHA-256 hex over the raw stdout bytes of
 * one `git ls-files --stage -z` call. Read-only: it takes no index lock, so it works while an
 * `index.lock` exists, and never rewrites the index. An intent-to-add entry and a staged empty
 * file look alike (both the empty blob), an accepted gap (Q11).
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<string>}
 * @throws {Error} when `git ls-files` exits non-zero.
 */
export async function indexFingerprint({ toplevel, env, now }) {
  const result = await run('git', ['ls-files', '--stage', '-z'], { cwd: toplevel, env, now, readOnly: true });
  if (result.code !== 0) {
    throw new Error(`git ls-files failed (${result.code}): ${result.stderr}`);
  }
  return createHash('sha256').update(result.stdout).digest('hex');
}

/**
 * Whether `index.lock` exists for this worktree (EXE-08, reused by CHG-23's
 * `commitGuarded`), resolved through M2 `gitPath` (the per-worktree git directory). Read-only:
 * an `fs.existsSync` check, never an attempt to create or remove the lock.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<boolean>}
 */
export async function indexLockExists({ toplevel, env, now }) {
  const [lockPath] = await gitPath(['index.lock'], { cwd: toplevel, env, now });
  return existsSync(lockPath);
}

/**
 * The inventory (C:plan step 4, Q11). Read-only: four git calls (six when the tree can hold a
 * submodule), none writes the index.
 * - candidates: `git ls-files --others --exclude-standard -z` after `hideFilter`, each with
 *   its `lstat` size and `binary` (a NUL in the first 8000 bytes; `.gitattributes` is not
 *   read here, CHG-08/CHG-11). An entry ending in `/` is an untracked embedded repository:
 *   no candidate, it goes to `embeddedRepos` without the slash (C:untracked-files).
 * - preStaged: every path of `git diff --cached --ita-visible-in-index --no-renames
 *   --name-status -z` but the intent-to-add ones (an empty index column, ` A` or ` D`
 *   when the worktree file is gone: no staged content); its `A` paths are the staged-new
 *   ones, a user's intent-to-add (`git add -N`) entries included (plain `diff --cached`
 *   hides them). A hidden staged-new path goes to `stagedExcluded`, the rest to
 *   `stagedNew` with `ignored`: listed by `git ls-files --cached --ignored
 *   --exclude-standard` (index entries an ignore rule matches; `git check-ignore`
 *   refuses M2's `GIT_LITERAL_PATHSPECS=1`).
 * - tracked: the `git status --untracked-files=no --no-renames --ignore-submodules=dirty`
 *   entries that are not staged-new (a rename's old path is its own deletion). The pin
 *   matches the pinned diff, so a submodule's `ignore=all` setting hides no pointer change
 *   and dirt alone is no entry.
 * - unstagedTracked (RUN-13, KD-R75): every status entry with a path and a non-blank
 *   worktree column (`xy[1]`), a genuine intent-to-add one excluded (a blank index column
 *   whose path is also staged-new: its worktree content is already counted once in
 *   `other`, through `stagedNew`). This is wider than `tracked`: a staged-new path edited
 *   again (`AM`, a force-added `.env` included) belongs here too, not only a tracked
 *   change outside the index. A `git add -p` style `MM` file, or such an `AM` one, is both
 *   staged (in `preStaged`) and here, so M15's mode decision counts it as staged and as
 *   another change.
 * - dirtySubmodules (CHG-09): the submodules with dirt inside but no pointer change, in byte
 *   order (`dirtySubmodulePaths`); not units, and dirt alone leaves the tree `clean`.
 * - caps (CHG-13): not this function's job. `collapsed` is always `[]` and `stagedExcluded`
 *   holds only the hidden entries here; the workflow calls M9 `applyCaps` itself, in `split`
 *   only, once the mode decision has counted these (pre-cap) lists (C:plan step 4 counts the
 *   mode decision's candidates "after the hidden rule and before the caps"; step 5 is the
 *   caps). `trackedDirectories` below is `applyCaps`'s third argument.
 * Unborn HEAD needs no other special case: `diff --cached` then lists every index entry as
 * `A`, as C:untracked-files asks.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<{ clean: boolean, tracked: string[], unstagedTracked: string[],
 *   preStaged: string[],
 *   candidates: Array<{ path: string, size: number, binary: boolean }>,
 *   collapsed: Array<{ dir: string, count: number, bytes: number }>,
 *   hidden: { count: number, sample: string[] },
 *   stagedNew: Array<{ path: string, ignored: boolean }>,
 *   stagedExcluded: Array<{ path: string, reason: 'hidden' }
 *     | { dir: string, count: number, reason: 'collapsed' }>, notUtf8: string[],
 *   dirtySubmodules: string[], embeddedRepos: string[] }>}
 *   `notUtf8` (CHG-12, Q11): every path of the three listings whose bytes are not valid
 *   UTF-8, left out of every other list (never a unit, never in the temporary index) and
 *   written by `escapeNonUtf8`, each once, in byte order, for `notIncluded` ("path is not
 *   UTF-8 — commit by hand"); like a hidden path it does not make the tree dirty (a
 *   non-UTF-8-only tree is clean, and the `nothing` reply names it, C:plan `clean`). Two
 *   exceptions: an untracked one the hidden rule matches in that `\xNN` form is counted in
 *   `hidden` instead, and a staged one (not intent-to-add) is also in `preStaged`, in that
 *   form, since the index holds its content (C:plan `preStaged`). The collapse rule does not
 *   apply to this list (C:plan). `hidden.sample`: the first
 *   5 hidden untracked paths in UTF-8 byte order. `clean`: no tracked change, candidate or
 *   staged-new path left (hidden-only trees are clean, C:plan; a caller that then collapses
 *   every remaining candidate and staged-new path away must recompute `clean`, since this
 *   function's own `clean` is pre-cap).
 * @throws {Error} when a git call fails.
 */
export async function inventory({ toplevel, env, now }) {
  const opts = { cwd: toplevel, env, now, readOnly: true };
  const notUtf8 = [];
  const untracked = [];
  // Entries, not a map keyed by the escaped string: two distinct byte sequences can escape
  // to the identical `\xNN` string (a literal "\xe9" next to the escape of byte 0xe9), and a
  // map would keep only the last one (review-CHG-12 finding 1).
  const untrackedNotUtf8 = [];
  for (const bytes of nulFields(await gitOk(['ls-files', '--others', '--exclude-standard', '-z'], opts))) {
    const path = utf8Path(bytes);
    if (path === null) untrackedNotUtf8.push({ escaped: escapeNonUtf8(bytes), bytes: Buffer.from(bytes) });
    else untracked.push(path);
  }
  const filtered = hideFilter(untracked);
  // C:untracked-files: `ls-files --others` lists an untracked embedded repository (a
  // directory holding its own `.git`) as one `dir/` entry instead of its files. It is no
  // candidate (`git add` would commit a gitlink without a `.gitmodules` entry, which git
  // itself warns about); it is reported for `notIncluded` (review-CHG-09 finding 2).
  const embeddedRepos = filtered.candidates.filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1));
  const candidates = candidateFacts(toplevel, filtered.candidates.filter((path) => !path.endsWith('/')));
  // The hidden rule runs on a non-UTF-8 path's `\xNN` form too: a hidden one (`.env\xe9`)
  // is counted as hidden, not reported as "commit by hand" (review-CHG-12 finding 7).
  // `hideFilter` only partitions by the escaped string's own content, so colliding entries
  // (same escaped string) land in the same partition, in their original relative order;
  // a per-escaped-string queue pairs each partitioned string back with its own bytes.
  const byEscaped = new Map();
  for (const entry of untrackedNotUtf8) {
    if (!byEscaped.has(entry.escaped)) byEscaped.set(entry.escaped, []);
    byEscaped.get(entry.escaped).push(entry.bytes);
  }
  const filteredNotUtf8 = hideFilter(untrackedNotUtf8.map((entry) => entry.escaped));
  for (const escaped of filteredNotUtf8.candidates) notUtf8.push(byEscaped.get(escaped).shift());
  const allHidden = [...filtered.hidden, ...filteredNotUtf8.hidden];
  const hidden = {
    count: allHidden.length,
    sample: allHidden.sort(byteOrder).slice(0, 5),
  };

  // `--no-renames`: a rename's old path is its own deletion, kept in `tracked` also when the
  // new path is staged-new or hidden (C:plan).
  // `--ignore-submodules=dirty`, as the pinned diff: a `submodule.<name>.ignore=all` or
  // `diff.ignoreSubmodules=all` setting must not hide from `clean` a pointer change the
  // snapshot finds (review-CHG-09 finding 1), and dirt alone is no entry here.
  const status = await statusEntries({
    toplevel, env, now, untracked: 'no', renames: false, ignoreSubmodules: 'dirty', notUtf8,
  });
  // An intent-to-add entry (a blank index column, ` A` normally, ` D` once its worktree
  // file is deleted, or even ` M`/others after further edits) stages no content, so it is
  // staged-new but not pre-staged (C:plan). Git keeps its index column blank until it is
  // `git add`ed for real, whatever the worktree does to it afterwards, so a blank index
  // column alone identifies it here. This is wider than ` A`: a tracked-but-unstaged
  // deletion (` D`) or edit (` M`) is blank there too, but neither ever appears in the
  // cached diff below (only staged content, or an ita entry via `--ita-visible-in-index`,
  // does), so the two never collide where this set is tested against that diff
  // (review-RUN-13-r3 finding 1: an ita entry whose worktree copy was deleted, ` D`, was
  // missed by the narrower ` A`-only check and fell through into `preStaged`).
  // Keyed by the path's bytes (`latin1` maps each byte to one character), so a non-UTF-8
  // intent-to-add entry is known too.
  const intentToAdd = new Set(
    status.filter((entry) => entry.xy[0] === ' ').map((entry) => entry.bytes.toString('latin1')),
  );
  const cached = nulFields(await gitOk(
    ['diff', '--cached', '--ita-visible-in-index', '--no-renames', '--name-status', '-z'], opts,
  ));
  const preStaged = [];
  const added = [];
  for (let i = 0; i + 1 < cached.length; i += 2) {
    const bytes = cached[i + 1];
    const path = utf8Path(bytes, notUtf8);
    // A staged non-UTF-8 path is no unit, but its staged content still counts for the mode
    // decision and the `unstaged` report: it is listed in its `\xNN` form (C:plan
    // `preStaged`, review-CHG-12 finding 2).
    if (!intentToAdd.has(bytes.toString('latin1'))) preStaged.push(path ?? escapeNonUtf8(bytes));
    if (path !== null && cached[i].toString('latin1') === 'A') added.push(path);
  }
  const split = hideFilter(added);
  const stagedExcluded = split.hidden.map((path) => ({ path, reason: 'hidden' }));
  const ignored = new Set(split.candidates.length === 0 ? [] : nulList(
    await gitOk(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], opts),
  ));
  const stagedNew = split.candidates.map((path) => ({ path, ignored: ignored.has(path) }));

  const staged = [];
  for (let i = 1; i < cached.length; i += 2) staged.push(stringPath(cached[i]));
  const dirtySubmodules = await dirtySubmodulePaths(staged, toplevel, opts);
  const notTracked = new Set(added);
  const tracked = status
    .filter((entry) => entry.path !== null && !notTracked.has(entry.path))
    .map((entry) => entry.path);
  // Every status entry with a worktree (unstaged) change, read from the same status entries'
  // `xy[1]` (RUN-13, KD-R75): a `git add -p`-style `MM` file is both staged and unstaged at
  // once, so the mode decision's `indexState` must count it in `other` as well as `staged`.
  // This is wider than `tracked`/`notTracked`: a staged-new path edited again (`AM`) still
  // has a worktree change and belongs here too. Excluded only when the entry is BOTH a
  // blank-index-column one (`intentToAdd`) AND already in `notTracked`/`added` (a genuine
  // ita entry, whose content is never staged and is already counted once in `other`,
  // through `stagedNew`): `intentToAdd` alone is too wide here, since a plain
  // tracked-but-unstaged deletion (` D`) or edit (` M`) has the same blank index column and
  // must still be counted (review-RUN-13-r3 finding 1).
  const unstagedTracked = status
    .filter((entry) => entry.path !== null && entry.xy[1] !== ' '
      && !(intentToAdd.has(entry.bytes.toString('latin1')) && notTracked.has(entry.path)))
    .map((entry) => entry.path);
  return {
    clean: tracked.length === 0 && candidates.length === 0 && stagedNew.length === 0,
    tracked, unstagedTracked, preStaged, candidates, collapsed: [], hidden, stagedNew, stagedExcluded,
    notUtf8: notUtf8List(notUtf8), dirtySubmodules, embeddedRepos,
  };
}

// C:plan `dirtySubmodules` (CHG-09, Q11): the submodules whose own working tree has changes
// (edits or untracked files) but whose pointer did not change. Those are the paths that
// `git diff --ignore-submodules=none --name-only` lists (worktree against index) and
// `--ignore-submodules=dirty` does not, less every path the index changes against HEAD (a
// staged pointer change is a unit whatever its dirt). The two calls run only when the
// worktree has a `.gitmodules` file: the dirt of a gitlink added without one is not
// reported (the tree is clean either way; review-CHG-09 finding 3). A path that is not
// UTF-8 is written in its `\xNN` form (CHG-12; review-CHG-09 finding 8).
async function dirtySubmodulePaths(staged, toplevel, opts) {
  if (!existsInWorktree(toplevel, '.gitmodules')) return [];
  const names = async (ignore) => nulFields(await gitOk(
    ['diff', `--ignore-submodules=${ignore}`, '--no-renames', '--no-ext-diff', '--name-only', '-z'], opts,
  )).map(stringPath);
  const pointerOrStaged = new Set([...await names('dirty'), ...staged]);
  return (await names('none')).filter((path) => !pointerOrStaged.has(path)).sort(byteOrder);
}

// A path's bytes as a string: UTF-8, else its `\xNN` form (`escapeNonUtf8`).
function stringPath(bytes) {
  return utf8Path(bytes) ?? escapeNonUtf8(bytes);
}

/**
 * The tracked directories caps (CHG-13) collapse into: `git ls-tree -r -d --name-only -z
 * HEAD` (`-r` lists every depth, which implies `-t`, so intermediate trees are included; none
 * on an unborn HEAD, which has no `HEAD` to list). Read-only. The workflow's own call, made
 * only in `split` and only once the mode decision has counted `inventory`'s pre-cap lists
 * (C:plan step 4), then fed with them into M9 `applyCaps` (step 5).
 *
 * @param {{ toplevel: string, env: object, now?: () => number, unborn?: boolean }} options
 * @returns {Promise<string[]>}
 * @throws {Error} when `git ls-tree` exits non-zero.
 */
export async function trackedDirectories({ toplevel, env, now, unborn = false }) {
  if (unborn) return [];
  const opts = { cwd: toplevel, env, now, readOnly: true };
  return nulList(await gitOk(['ls-tree', '-r', '-d', '--name-only', '-z', 'HEAD'], opts));
}

/**
 * The staged case-only renames the temporary index cannot plan (CHG-07 decision, Q11). A
 * pair is a staged-new path and a `tracked` path that differ only in case
 * (`toLowerCase`). It cannot be planned when `core.ignorecase` is true (`git add -N` of the
 * new path then matches the old entry of the reset temporary index, so no new entry is made)
 * or when the filesystem is case-insensitive for it (`lstat` of the old path finds the new
 * path's file, same device and inode, so the worktree diff never reports the deletion):
 * either way the rename would silently give no unit, and `plan` refuses instead (fail
 * closed). On a case-sensitive filesystem with `core.ignorecase` false the pair is a normal
 * `R` unit and this returns nothing. Read-only; `git config` runs only when a pair exists.
 *
 * @param {{ stagedNew: string[], tracked: string[], toplevel: string, env: object,
 *   now?: () => number }} options `stagedNew`, `tracked`: the inventory's pre-cap paths,
 *   `stagedNew` with the staged-new paths the hidden rule excluded (`stagedExcluded`).
 * @returns {Promise<Array<{ oldPath: string, path: string }>>} sorted by `path` in UTF-8
 *   byte order.
 * @throws {Error} when `git config` fails other than with an unset key, or on a filesystem
 *   error other than a missing path.
 */
export async function unplannableCaseRenames({ stagedNew, tracked, toplevel, env, now }) {
  const byFold = new Map();
  for (const path of tracked) {
    const key = path.toLowerCase();
    if (!byFold.has(key)) byFold.set(key, []);
    byFold.get(key).push(path);
  }
  const pairs = [];
  for (const path of stagedNew) {
    for (const oldPath of byFold.get(path.toLowerCase()) ?? []) {
      if (oldPath !== path) pairs.push({ oldPath, path });
    }
  }
  if (pairs.length === 0) return [];
  pairs.sort((a, b) => byteOrder(a.path, b.path) || byteOrder(a.oldPath, b.oldPath));
  const result = await run(
    'git', ['config', '--bool', '--get', 'core.ignorecase'], { cwd: toplevel, env, now, readOnly: true },
  );
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git config --get core.ignorecase failed (${result.code}): ${result.stderr}`);
  }
  if (result.code === 0 && result.stdout.toString('utf8').trim() === 'true') return pairs;
  return pairs.filter(({ oldPath, path }) => sameFile(toplevel, oldPath, path));
}

// Whether two worktree paths name one file (`lstat`: same device and inode); false when
// either is missing.
function sameFile(toplevel, a, b) {
  const statOf = (path) => {
    try {
      return lstatSync(join(toplevel, path), { bigint: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
  };
  const first = statOf(a);
  const second = first === null ? null : statOf(b);
  return second !== null && first.dev === second.dev && first.ino === second.ino;
}

/**
 * Each candidate's size and `binary` sniff: a NUL in its first 8000 bytes (only a regular
 * file is read; anything else is not binary). A path gone since `ls-files --others` listed
 * it (an editor temp file, build output) is skipped, as `snapshot` skips a missing path.
 *
 * @param {string} toplevel
 * @param {string[]} paths repo-relative candidate paths.
 * @returns {Array<{ path: string, size: number, binary: boolean }>} in `paths` order.
 * @throws {Error} on a filesystem error other than a missing path.
 */
export function candidateFacts(toplevel, paths) {
  const facts = [];
  for (const path of paths) {
    try {
      facts.push(fileFacts(toplevel, path));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
  }
  return facts;
}

function fileFacts(toplevel, path) {
  const full = join(toplevel, path);
  const stat = lstatSync(full);
  let binary = false;
  if (stat.isFile()) {
    const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
    const fd = openSync(full, 'r');
    try {
      const read = readSync(fd, buf, 0, buf.length, 0);
      binary = buf.subarray(0, read).includes(NUL);
    } finally {
      closeSync(fd);
    }
  }
  return { path, size: stat.size, binary };
}

async function gitOk(args, opts) {
  const result = await run('git', args, opts);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr}`);
  return result.stdout;
}

// A `-z` output's NUL-terminated fields, decoded as UTF-8.
function nulList(stdout) {
  return stdout.toString('utf8').split('\0').filter((field) => field !== '');
}

// A `-z` output's non-empty NUL-terminated fields, as raw bytes.
function nulFields(stdout) {
  const fields = [];
  let pos = 0;
  while (pos < stdout.length) {
    let end = stdout.indexOf(NUL, pos);
    if (end === -1) end = stdout.length;
    if (end > pos) fields.push(stdout.subarray(pos, end));
    pos = end + 1;
  }
  return fields;
}

// A path's bytes as a string, or null when they are not valid UTF-8 (CHG-12, Q11): such a
// path is never a unit, and `notUtf8` (when given) collects its bytes for `notIncluded`.
function utf8Path(bytes, notUtf8) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    notUtf8?.push(Buffer.from(bytes));
    return null;
  }
}

/**
 * The string form of a path that is not valid UTF-8 (CHG-12, Q11, C:plan): every byte that
 * is not part of a well-formed UTF-8 sequence (Unicode Table 3-7: no overlong form, no
 * surrogate, nothing above U+10FFFF) is written as `\xNN`, in lower-case hex as M17 writes
 * it; the well-formed sequences around them stay as their characters.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function escapeNonUtf8(bytes) {
  let out = '';
  let pos = 0;
  while (pos < bytes.length) {
    const length = utf8SequenceLength(bytes, pos);
    if (length === 0) {
      out += `\\x${bytes[pos].toString(16).padStart(2, '0')}`;
      pos += 1;
    } else {
      out += bytes.toString('utf8', pos, pos + length);
      pos += length;
    }
  }
  return out;
}

// The length of the well-formed UTF-8 sequence at `pos`, or 0 when there is none: per lead
// byte, the allowed range of the second byte (Unicode Table 3-7); every later byte is a
// plain continuation byte, 0x80-0xBF.
function utf8SequenceLength(bytes, pos) {
  const lead = bytes[pos];
  if (lead <= 0x7f) return 1;
  let length;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
    if (lead === 0xe0) low = 0xa0;
    if (lead === 0xed) high = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
    if (lead === 0xf0) low = 0x90;
    if (lead === 0xf4) high = 0x8f;
  } else {
    return 0;
  }
  if (pos + length > bytes.length) return 0;
  if (bytes[pos + 1] < low || bytes[pos + 1] > high) return 0;
  for (let i = 2; i < length; i += 1) {
    if (bytes[pos + i] < 0x80 || bytes[pos + i] > 0xbf) return 0;
  }
  return length;
}

// The collected non-UTF-8 paths in their string form, each once, in byte order.
function notUtf8List(collected) {
  const unique = new Map(collected.map((bytes) => [bytes.toString('hex'), bytes]));
  return [...unique.values()].sort(Buffer.compare).map(escapeNonUtf8);
}

function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Takes the snapshot's units (Q11, M10). `split` only (CHG-14, CHG-15 build the others):
 * one whole-file unit per changed text file, diffed against the temporary index.
 *
 * The temporary index (Q11 steps 1-3, C:plan): the real index is copied to `indexPath`
 * (keeping its mtime, see `copyIndex`) and the copy reset to HEAD with `git reset -q -- .`
 * (the pathspec form writes no ref; a bare reset would move ORIG_HEAD, append a HEAD reflog
 * entry and take HEAD.lock); on an unborn HEAD it starts empty instead. Then `git add -N` of the stored candidate and
 * staged-new paths from stdin, the `ignored: true` ones in a separate `-f` call; a path gone
 * from the worktree since the inventory is skipped. Only the copy is written: the real index never is.
 *
 * One pinned `git diff -z --raw -p` call from the toplevel against that index, with no
 * pathspecs. Paths come from the `--raw -z` records only, never from patch text (a header
 * such as `diff --git a/a b/c b/a b/c` is ambiguous); section *i* belongs to record *i*, and
 * a count mismatch is `internal` (C:plan-hunks). Output stays raw bytes: the body is a
 * `Buffer` and the hash is taken over bytes, never over a decode. A section whose path
 * (either side of a rename) is not valid UTF-8 makes no unit (CHG-12, Q11; the inventory's
 * `notUtf8` reports it). Only when a rename's old path is not UTF-8 and its new path is, a
 * second pinned call, the same with `--no-renames` (still no pathspecs), gives each such
 * new path its `A` unit, so the UTF-8 side is not lost (review-CHG-12 finding 1).
 *
 * @param {{ mode: 'split' | 'reword', storedLists?: { candidates: string[],
 *   stagedNew: Array<{ path: string, ignored: boolean }> }, tracked?: string[],
 *   indexPath?: string, unborn?: boolean, head?: string, root?: boolean, toplevel: string,
 *   env: object, now?: () => number }} options
 *   `storedLists`: the inventory's lists as stored in `state.json`; `tracked` (required in
 *   `split`, CHG-10): the tracked paths whose units this snapshot must classify, which go to
 *   the `check-attr` call with the stored lists (`plan`: the inventory's `tracked`; a later
 *   subcommand: the paths of the run's stored units, the only ones it must reproduce);
 *   `indexPath`: the run folder's `git-index`. `head` (required in `reword`, CHG-15): HEAD's
 *   own SHA; `root` (`reword` only): GIT-09's `rewordFacts.root`. `reword` needs none of
 *   `storedLists`/`tracked`/`indexPath`/`unborn`, builds no temporary index, and never reads
 *   or writes the real index; it still runs `check-attr` over a `--name-only` pass of the
 *   same two trees (steps 1-3 below are `split`-only, the `check-attr` and patch passes run
 *   either way).
 * @returns {Promise<Array<{ path: string, oldPath: string|null, status: 'M'|'A'|'R',
 *   kind: 'text', hash: string, generated: boolean, binary: boolean, added: number, deleted: number, range: string,
 *   body: Buffer }>>} sorted by path in UTF-8 byte order (the user's `diff.orderFile` never
 *   decides the order, Q11). `oldPath`: a rename's old path, else null. `hash`: SHA-256 hex
 *   over the old path bytes and a NUL (a rename only), the path bytes, a NUL, then every
 *   hunk line starting `-` or `+` with its `\n`, plus a following `\` (`\ No newline at end
 *   of file`) line only when it follows one of those (no context, Q11; the `\` marker keeps
 *   a newline-at-EOF edit apart from the same lines with a newline, but one that follows an
 *   unchanged context line is excluded like the rest of that context). `added`/`deleted`:
 *   the `+`/`-` hunk lines. `range`: the hunk header's ranges for one hunk, else the span
 *   enclosing every hunk; `-0,0 +0,0` for an `A`/`R` section without a hunk (an empty new
 *   file, a pure rename), whose `body` is then empty. `body`: the section's bytes from its
 *   first `@@` line on.
 * @throws {Error} with `domainCode: 'git-failed'` when a `git add -N` exits non-zero, even
 *   if some paths were added (C:plan); a plain Error when another git call fails, the
 *   sections do not pair with the records, or on a change kind not built yet.
 */
export async function snapshot({
  mode, storedLists, tracked, indexPath, unborn, head, root, toplevel, env, now,
}) {
  if (mode === 'reword') {
    // CHG-15 (Q20, C:plan-hunks "what is diffed"): HEAD's own diff against its single
    // parent, or the empty tree for a root commit (`root`, GIT-09's `rewordFacts.root`,
    // read by the caller before the lock). No temporary index: the real index is never
    // read or written here, so staged changes never reach these units (unlike `split`,
    // `reword`'s IDs are never staged, Q20). `tracked`/`indexPath` are `split`-only and
    // unused here.
    if (typeof head !== 'string') throw new Error('snapshot in reword mode needs head (CHG-15)');
    const opts = { toplevel, env, now };
    // KD-R68 (fail-safe, chosen over "accept and document"): a shallow clone's boundary
    // (graft) commit also reads `root: true` (GIT-09 `rewordFacts`: `rev-list --parents`
    // prints no parents for it), even though it is not really a root commit. Diffing it
    // against the empty tree would then silently hunk-index the whole repository. On a
    // shallow repo, `<head>^` is tried instead of the empty tree: the graft makes git read
    // a shallow boundary commit as parentless regardless of whether the real parent object
    // happens to be present locally, so `<head>^` always fails the diff below with git's own
    // "bad revision" error (the existing plain-Error path, never a silently wrong tree).
    // Residual, accepted limitation (KD-R68): a root reword on any shallow repo now fails
    // loudly instead of succeeding, not only a true one-commit clone (almost always masked
    // by `pushed`, but an unpushed orphan-branch commit in a shallow clone, e.g. CI, is not).
    const shallow = root && await isShallowRepository(opts);
    const from = root && !shallow ? await emptyTreeId(opts) : `${head}^`;
    // CHG-10's check-attr pass applies to every hunk index (C:plan-hunks), including
    // reword's: a name-only pass over the same two trees gives the paths; no temporary
    // index exists in reword, so this reads the real index/worktree attributes, read-only.
    const names = nulFields(await gitOk(
      ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', from, head],
      { cwd: toplevel, env, now, readOnly: true },
    )).map((bytes) => utf8Path(bytes)).filter((path) => path !== null);
    const attrs = await checkAttrs(names, opts);
    return diffUnits([from, head], opts, attrs);
  }
  if (mode !== 'split') throw new Error(`snapshot in ${mode} mode is not built yet (CHG-14)`);
  // review-CHG-10 finding 2: never defaulted. A caller that left the tracked paths out
  // would get a modified tracked filtered file as per-hunk `text` units, whose hashes never
  // match `plan`'s one `filtered` unit.
  if (!Array.isArray(tracked)) throw new Error('snapshot needs the tracked paths for its check-attr call (CHG-10)');
  await buildTemporaryIndex({ storedLists, indexPath, unborn, toplevel, env, now });
  const opts = { toplevel, env, now, indexPath };
  // CHG-10: one `check-attr` call, over every path the snapshot could turn into a unit
  // (tracked, candidate and staged-new), before the diff pass runs: `filter`-attributed
  // paths get `kind: "filtered"` at section-open time (openSection), and `linguist-generated`
  // is carried on every unit as `generated`, for M9 `summaryOnly` (CHG-17).
  const attrPaths = [...new Set([
    ...tracked,
    ...storedLists.candidates,
    ...storedLists.stagedNew.map((entry) => entry.path),
  ])];
  const attrs = await checkAttrs(attrPaths, opts);
  const reader = await pinnedDiff([], opts, attrs);
  const units = reader.end();
  if (reader.rediff.length === 0) return units;
  // A rename from a non-UTF-8 path: its UTF-8 new path, as the same diff shows it without
  // rename detection, is an `A` unit; the old path stays in `notUtf8` (review-CHG-12
  // finding 1). No pathspec (Q11: argv length), so the other paths' units are dropped.
  const rediff = new Set(reader.rediff);
  const again = (await pinnedDiff(['--no-renames'], opts, attrs)).end().filter((unit) => rediff.has(unit.path));
  return [...units, ...again].sort((a, b) => byteOrder(a.path, b.path));
}

// One `git check-attr --stdin -z filter linguist-generated` call (CHG-10, Q11): paths go on
// stdin, NUL-separated, never argv. Runs through M2's `run`, which strips every inherited
// `GIT_*` variable outside the keep-set (GIT-05), so a decoy `GIT_ATTR_SOURCE` cannot
// redirect which `.gitattributes` this call reads. Returns a `Map<path, { filtered:
// boolean, generated: boolean }>`; a path with no row (not in `paths`) is absent.
async function checkAttrs(paths, { toplevel, env, now, indexPath }) {
  if (paths.length === 0) return new Map();
  const result = await run(
    'git',
    ['check-attr', '--stdin', '-z', 'filter', 'linguist-generated'],
    {
      cwd: toplevel, env, now, readOnly: true, index: indexPath,
      input: Buffer.from(paths.map((p) => `${p}\0`).join(''), 'utf8'),
    },
  );
  if (result.code !== 0) throw new Error(`git check-attr failed (${result.code}): ${result.stderr}`);
  const fields = nulFields(result.stdout);
  const out = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i].toString('utf8');
    const attr = fields[i + 1].toString('utf8');
    const value = fields[i + 2].toString('utf8');
    const entry = out.get(path) ?? { filtered: false, generated: false };
    if (attr === 'filter' && value !== 'unspecified' && value !== 'unset') entry.filtered = true;
    // Linguist reads the bare form (`set`) and `=true` alike (review-CHG-10 finding 3).
    if (attr === 'linguist-generated' && (value === 'set' || value === 'true')) entry.generated = true;
    out.set(path, entry);
  }
  return out;
}

// One pinned `git diff -z --raw -p` call against the temporary index, `extra` appended,
// streamed into a diff reader. `attrs`: the `check-attr` results (CHG-10), threaded to
// `openSection` so a `filter`-attributed path's section opens as `kind: "filtered"`.
async function pinnedDiff(extra, { toplevel, env, now, indexPath }, attrs = new Map()) {
  const reader = createDiffReader(attrs);
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p', ...extra],
    { cwd: toplevel, env, now, readOnly: true, index: indexPath, onStdout: (chunk) => reader.push(chunk) },
  );
  if (result.code !== 0) {
    throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  }
  return reader;
}

// Q11 steps 1-3: copy, reset to HEAD (born) or start empty (unborn), `git add -N`.
async function buildTemporaryIndex({ storedLists, indexPath, unborn, toplevel, env, now }) {
  rmSync(indexPath, { force: true });
  if (!unborn) {
    const [realIndex] = await gitPath(['index'], { cwd: toplevel, env, now });
    if (existsSync(realIndex)) await copyIndex(realIndex, indexPath);
    const reset = await run('git', ['reset', '-q', '--', '.'], { cwd: toplevel, env, now, index: indexPath });
    if (reset.code !== 0) throw new Error(`git reset failed (${reset.code}): ${reset.stderr}`);
  }
  const present = (path) => existsInWorktree(toplevel, path);
  const plain = [
    ...storedLists.candidates,
    ...storedLists.stagedNew.filter((entry) => !entry.ignored).map((entry) => entry.path),
  ].filter(present);
  const forced = storedLists.stagedNew.filter((entry) => entry.ignored).map((entry) => entry.path).filter(present);
  await addIntentToAdd(plain, [], { toplevel, env, now, indexPath });
  await addIntentToAdd(forced, ['-f'], { toplevel, env, now, indexPath });
}

// Copies the real index, keeping its mtime (floored to the second) on the copy. git's racy-git
// check trusts an entry's stat data only when the entry is older than the index file itself:
// a fresh mtime on the copy would turn a racily clean entry (a same-size edit in the same
// second as the last index write) into a trusted clean one, and the snapshot would miss the
// edit. An older mtime only makes more entries racy, which git then checks by content.
async function copyIndex(realIndex, indexPath) {
  const seconds = Math.floor(statSync(realIndex).mtimeMs / 1000);
  await copyFile(realIndex, indexPath);
  await utimes(indexPath, seconds, seconds);
}

// One `git add -N` of `paths` from stdin into the temporary index; none spawns no git.
async function addIntentToAdd(paths, flags, { toplevel, env, now, indexPath }) {
  if (paths.length === 0) return;
  const result = await run(
    'git',
    ['add', '-N', ...flags, '--pathspec-from-file=-', '--pathspec-file-nul'],
    { cwd: toplevel, env, now, index: indexPath, input: Buffer.from(paths.map((p) => `${p}\0`).join(''), 'utf8') },
  );
  if (result.code !== 0) {
    // EXE-09: `gitOutput` is git's stdout and stderr verbatim, for `commit`'s exit 4
    // (C:commit-release); `plan` reports only the message.
    throw Object.assign(
      new Error(`git add failed (${result.code}): ${result.stderr}`),
      { domainCode: 'git-failed', gitOutput: `${result.stdout.toString('utf8')}${result.stderr}` },
    );
  }
}

// A stored path still in the worktree (`lstat`, so a dangling symlink counts).
function existsInWorktree(toplevel, path) {
  try {
    lstatSync(join(toplevel, path));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * The streamed patch pass (CHG-06, Q11 pass 4): a reader that takes one
 * `git diff -z --raw -p` call's stdout chunk by chunk (M2 `onStdout`) and builds the units.
 * Raw records are buffered (one per path); the patch text is split into lines as it
 * arrives, and only hunk lines are kept (the bodies, from which the added lines come), never
 * the section headers or the whole output. Section *i* belongs to raw record *i*: its
 * `diff --git` line must be exactly the one git prints for that record's paths, and an
 * extra or missing section or another header is an error (C:plan-hunks: `internal`), so no
 * path is ever taken from patch text. Exported so the pairing can be fed crafted bytes in
 * any chunking without spawning git.
 *
 * @param {Map<string, { filtered: boolean, generated: boolean }>} [attrs] the `check-attr`
 *   results (CHG-10), keyed by path: a `filtered` path's section opens with
 *   `entryKind: "filtered"` and every unit carries `generated`.
 * @returns {{ rediff: string[], push: (chunk: Buffer) => void, end: () => object[] }}
 *   `push` throws on the first pairing error and is not called again; `end` flushes the
 *   last line, checks the section count and returns the units in `snapshot`'s shape and
 *   order. `rediff`: the new paths of the renames whose old path is not UTF-8, in diff
 *   order (complete once `end` returns), which made no unit here.
 */
export function createDiffReader(attrs = new Map()) {
  const records = [];
  const units = [];
  const rediff = [];
  let raw = Buffer.alloc(0);
  let inPatch = false;
  let partial = [];
  let section = null;
  let sections = 0;
  // A type change's (`T`) record owns two consecutive sections, a delete and then a new
  // file, both under the record's own `diff --git` line (Q11 pass 8 amendment): while its
  // first section is open, this holds that line and the record's path for the error.
  let typeChange = null;

  const finishSection = () => {
    if (typeChange !== null) {
      throw new Error(`a type change (${typeChange.path}) has one patch section, not two`);
    }
    if (section !== null) units.push(...withScanLimit(unitsOf(section)));
    section = null;
  };
  const onLine = (line) => {
    if (startsWith(line, SECTION_START)) {
      if (typeChange !== null && line.equals(typeChange.header)) {
        typeChange = null;
        if (section.notUtf8 !== true) secondPart(section);
        return;
      }
      finishSection();
      const record = records[sections];
      sections += 1;
      if (record === undefined) {
        throw new Error(`the diff has more patch sections than its ${records.length} raw records`);
      }
      if (!line.equals(sectionHeader(record))) {
        throw new Error(`patch section ${sections} does not match raw record ${sections} (${escapeNonUtf8(record.pathBytes)})`);
      }
      section = openSection(record, attrs);
      if (section.notUtf8 === true && section.rediff !== null) rediff.push(section.rediff);
      if (record.status === 'T') typeChange = { header: Buffer.from(line), path: escapeNonUtf8(record.pathBytes) };
      return;
    }
    if (section === null) throw new Error('the diff patch text does not start with a section');
    sectionLine(section, line);
  };
  const patch = (buf) => {
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(LF, pos);
      if (nl === -1) {
        partial.push(Buffer.from(buf.subarray(pos)));
        return;
      }
      const tail = buf.subarray(pos, nl + 1);
      const line = partial.length === 0 ? tail : Buffer.concat([...partial, tail]);
      partial = [];
      onLine(line);
      pos = nl + 1;
    }
  };
  return {
    rediff,
    push(chunk) {
      if (inPatch) {
        patch(chunk);
        return;
      }
      const { done, rest } = readRaw(raw.length === 0 ? chunk : Buffer.concat([raw, chunk]), records);
      if (!done) {
        raw = Buffer.from(rest);
        return;
      }
      inPatch = true;
      raw = Buffer.alloc(0);
      patch(rest);
    },
    end() {
      if (raw.length > 0) throw new Error('a raw diff record is not NUL-terminated');
      if (partial.length > 0) {
        const line = Buffer.concat(partial);
        partial = [];
        onLine(line);
      }
      finishSection();
      if (sections !== records.length) {
        throw new Error(`the diff has ${sections} patch sections for ${records.length} raw records`);
      }
      // Sorted by path in UTF-8 byte order (the user's `diff.orderFile` never decides it,
      // Q11); the sort is stable, so one file's hunks stay in file order.
      return units
        .sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes))
        .map(({ pathBytes, ...unit }) => unit);
    },
  };
}

/**
 * Mints the unit IDs `h1…hN` in unit order (C:plan-hunks `id`).
 *
 * @template T
 * @param {T[]} units
 * @returns {Array<T & { id: string }>} new objects; the input is left as it is.
 */
export function assignIds(units) {
  return units.map((unit, i) => ({ id: `h${i + 1}`, ...unit }));
}

/**
 * M10 `matchIds` (EXE-02, C:commit-release phase (b)): every ID of `idMap` must name a hash
 * one of the current `units` (a fresh `snapshot` of the temporary index) carries.
 * CHG-19 (C:plan-hunks, a separate `plan --hunks`): with `exact`, the two hash sets must be
 * equal, so a current unit whose hash no ID names (a new hunk in a planned file) is listed
 * in `extra` by path and fails the match too.
 *
 * @template {{ hash: string }} T
 * @param {Record<string, string>} idMap unit ID → hash, as stored in `state.json`.
 * @param {T[]} units
 * @param {{ exact?: boolean }} [options]
 * @returns {{ ok: true, units: Array<T & { id: string }> }
 *   | { ok: false, code: 'unmatched', unmatched: string[], extra?: string[] }} on a match,
 *   the current units under their stored IDs, in `idMap` order (new objects); otherwise the
 *   IDs whose hash is missing, in `idMap` order, plus `extra` in exact mode only.
 */
export function matchIds(idMap, units, { exact = false } = {}) {
  const byHash = new Map(units.map((unit) => [unit.hash, unit]));
  const unmatched = Object.keys(idMap).filter((id) => !byHash.has(idMap[id]));
  const named = new Set(Object.values(idMap));
  const extra = exact ? units.filter((unit) => !named.has(unit.hash)).map((unit) => unit.path) : [];
  if (unmatched.length > 0 || extra.length > 0) {
    return { ok: false, code: 'unmatched', unmatched, ...(exact ? { extra } : {}) };
  }
  return { ok: true, units: Object.keys(idMap).map((id) => ({ id, ...byHash.get(idMap[id]) })) };
}

// One `git <args> -z --raw -p` diff with the pinned options, streamed through the patch-pass
// reader into units (the same pass `snapshot` runs). `attrs`: the `check-attr` results, so
// a filtered path is the same `filtered` unit `snapshot` made (CHG-10). review-CHG-15
// finding 5: shares `pinnedDiff`'s rediff step (a rename from a non-UTF-8 old path to a
// UTF-8 new path is dropped by `-M` and needs a `--no-renames` re-diff) with every caller,
// not only `split`'s own `pinnedDiff`; `allowRediff: false` stops the one re-diff pass from
// re-triggering itself.
async function diffUnits(args, { toplevel, env, now }, attrs = new Map(), { allowRediff = true } = {}) {
  const reader = createDiffReader(attrs);
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p', ...args],
    { cwd: toplevel, env, now, readOnly: true, onStdout: (chunk) => reader.push(chunk) },
  );
  if (result.code !== 0) throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  const units = reader.end();
  if (!allowRediff || reader.rediff.length === 0) return units;
  const rediff = new Set(reader.rediff);
  const again = (await diffUnits([...args, '--no-renames'], { toplevel, env, now }, attrs, { allowRediff: false }))
    .filter((unit) => rediff.has(unit.path));
  return [...units, ...again].sort((a, b) => byteOrder(a.path, b.path));
}

function sameHashes(units, hashes) {
  const a = units.map((unit) => unit.hash).sort();
  const b = [...hashes].sort();
  return a.length === b.length && a.every((hash, i) => hash === b[i]);
}

/**
 * M10 `stage` on the real index, the thin whole-file form (EXE-02; CHG-19 adds the patch
 * apply for hunk subsets): `git reset -q -- .` (the pathspec form, C:commit-release (c)),
 * then `git add -A` over every path of the group's units (both paths of a rename), on stdin
 * NUL-separated, never on argv; ignored paths in a separate `git add -A -f`. Then verifies
 * that the index diff against HEAD holds exactly the group's hashes (one `check-attr` call
 * over the group's paths first, so a filtered file hashes as its stored unit, CHG-10).
 *
 * @param {{ units: Array<{ path: string, oldPath: string | null, hash: string }>,
 *   ignoredPaths?: string[], toplevel: string, env: object, now?: () => number }} options
 *   `units`: the group's stored units; `ignoredPaths`: those of their paths `plan` stored
 *   with `ignored: true`.
 * @returns {Promise<{ ok: true } | { ok: false, code: 'mismatch' }
 *   | { ok: false, code: 'stage-failed', gitOutput: string }>}
 * @throws {Error} when the reset or the verify's diff fails.
 */
export async function stage({ units, ignoredPaths = [], toplevel, env, now }) {
  const reset = await run('git', ['reset', '-q', '--', '.'], { cwd: toplevel, env, now });
  if (reset.code !== 0) throw new Error(`git reset failed (${reset.code}): ${reset.stderr}`);
  const ignored = new Set(ignoredPaths);
  const paths = [...new Set(units.flatMap((unit) => (unit.oldPath === null ? [unit.path] : [unit.oldPath, unit.path])))];
  for (const [list, flags] of [[paths.filter((p) => !ignored.has(p)), []], [paths.filter((p) => ignored.has(p)), ['-f']]]) {
    if (list.length === 0) continue;
    const added = await run(
      'git',
      ['add', '-A', ...flags, '--pathspec-from-file=-', '--pathspec-file-nul'],
      { cwd: toplevel, env, now, input: Buffer.from(list.map((p) => `${p}\0`).join(''), 'utf8') },
    );
    if (added.code !== 0) {
      return { ok: false, code: 'stage-failed', gitOutput: `${added.stdout.toString('utf8')}${added.stderr}` };
    }
  }
  // The real index's attributes for the group's paths (CHG-10): without them a filtered
  // file's staged diff splits into `text` hunks that never match its stored unit.
  const attrs = await checkAttrs(units.map((unit) => unit.path), { toplevel, env, now });
  const staged = await diffUnits(['--cached'], { toplevel, env, now }, attrs);
  return sameHashes(staged, units.map((unit) => unit.hash)) ? { ok: true } : { ok: false, code: 'mismatch' };
}

/**
 * M10 `writeTree` (EXE-02): records the real index's tree (`git write-tree`).
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<string>} the tree ID.
 * @throws {Error} when `git write-tree` fails.
 */
export async function writeTree({ toplevel, env, now }) {
  return (await gitOk(['write-tree'], { cwd: toplevel, env, now })).toString('utf8').trim();
}

/**
 * M10 `treeDiffUnits` (EXE-02, thin: CHG-20 adds the attribute-hidden `--text` pass; the
 * shared `createDiffReader` already applies the CHG-16 1 MB scan limit here, same as
 * `snapshot`): the units of the diff from `fromTree` (the expected HEAD, or `null` for
 * the empty tree when unborn) to `toTree`, with the same pinned options and patch pass as
 * `snapshot`, so the backstop scans the recorded tree as `plan` scanned the snapshot.
 *
 * @param {string | null} fromTree
 * @param {string} toTree
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<object[]>} units in `snapshot`'s shape, `addedLines` included.
 * @throws {Error} when a git call fails or the sections do not pair with the records.
 */
export async function treeDiffUnits(fromTree, toTree, { toplevel, env, now }) {
  const from = fromTree ?? await emptyTreeId({ toplevel, env, now });
  return diffUnits([from, toTree], { toplevel, env, now });
}

// The empty tree's object ID (CHG-15, EXE-02): `git hash-object -t tree --stdin` on empty
// input, used as the diff's "from" side when there is no real tree to compare against (an
// unborn HEAD's backstop diff, or a `reword` of a root commit, Q20).
async function emptyTreeId({ toplevel, env, now }) {
  return (await gitOk(['hash-object', '-t', 'tree', '--stdin'], {
    cwd: toplevel, env, now, readOnly: true, input: Buffer.alloc(0),
  })).toString('utf8').trim();
}

// `git rev-parse --is-shallow-repository` (KD-R68, CHG-15): true in a shallow clone, where
// a boundary (graft) commit can misread as a root commit; false in a partial (filtered)
// clone, which is not shallow.
async function isShallowRepository({ toplevel, env, now }) {
  const out = await gitOk(['rev-parse', '--is-shallow-repository'], { cwd: toplevel, env, now, readOnly: true });
  return out.toString('utf8').trim() === 'true';
}

/**
 * M10 `commitGuarded`, the plain form (EXE-02): one `git commit` spawn through M2 in its
 * `commit` environment (GIT-06: only the redirecting `GIT_*` removed, no pins), with no
 * markers, no timeout kill and no `index.lock` handling yet (EXE-17, EXE-18, EXE-21).
 *
 * @param {{ args: string[], input: string, toplevel: string, env: object,
 *   now?: () => number, timeoutMs?: number }} options `args`: `git commit`'s argv after
 *   `git`; `input`: the message on stdin.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean,
 *   lockRemoved: false, lockLeft: false }>}
 */
export async function commitGuarded({ args, input, toplevel, env, now, timeoutMs }) {
  const result = await run('git', args, {
    cwd: toplevel, env, now, commit: true, input: Buffer.from(input, 'utf8'), timeoutMs,
  });
  return {
    code: result.code,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr,
    timedOut: result.timedOut,
    lockRemoved: false,
    lockLeft: false,
  };
}

// One `git status --porcelain -z --untracked-files=<untracked>` call, as `{ xy, path }`
// entries. The inventory passes `no`: its candidates come from `ls-files --others`, so the
// untracked walk would only be discarded. `renames: false` adds `--no-renames` (git 2.18);
// `ignoreSubmodules` adds `--ignore-submodules=<value>`.
async function statusEntries({ toplevel, env, now, untracked, renames = true, ignoreSubmodules, notUtf8 }) {
  const args = ['status', '--porcelain', '-z', `--untracked-files=${untracked}`];
  if (!renames) args.push('--no-renames');
  if (ignoreSubmodules !== undefined) args.push(`--ignore-submodules=${ignoreSubmodules}`);
  const result = await run('git', args, {
    cwd: toplevel,
    env,
    now,
    readOnly: true,
  });
  if (result.code !== 0) {
    throw new Error(`git status failed (${result.code}): ${result.stderr}`);
  }
  // Porcelain v1 `-z`: `XY <path>` records, NUL-terminated; a rename or copy (`R`/`C` in
  // either column) is followed by one more record holding its old path, skipped here.
  // With `notUtf8`, an entry whose path is not valid UTF-8 gets `path: null` and its bytes
  // are collected there (CHG-12); without it, such a path is written in its `\xNN` form
  // (`treeState`'s paths reach the reply, review-CHG-12 finding 6).
  const records = nulFields(result.stdout);
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const xy = records[i].toString('latin1', 0, 2);
    const bytes = records[i].subarray(3);
    if (/[RC]/.test(xy)) i += 1;
    const path = notUtf8 === undefined ? stringPath(bytes) : utf8Path(bytes, notUtf8);
    entries.push({ xy, path, bytes });
  }
  return entries;
}

// Reads the complete `--raw -z` records at the start of `buf` into `records`:
// `:<m1> <m2> <sha1> <sha2> <S>`, NUL, then the path and NUL (a rename or copy, `R`/`C`, has
// the old and then the new path). One more NUL, or any byte other than `:`, ends the raw
// part. `done`: the raw part has ended and `rest` starts the patch text; else `rest` is an
// incomplete record, completed by the next chunk.
function readRaw(buf, records) {
  let pos = 0;
  while (pos < buf.length && buf[pos] === COLON) {
    const fields = [];
    let at = pos;
    const want = () => (fields.length > 0 && /^[RC]/.test(fields[0].toString('latin1').split(' ')[4]) ? 3 : 2);
    while (fields.length < want()) {
      const end = buf.indexOf(NUL, at);
      if (end === -1) return { done: false, rest: buf.subarray(pos) };
      fields.push(buf.subarray(at, end));
      at = end + 1;
    }
    const [oldMode, newMode, , , status] = fields[0].toString('latin1').slice(1).split(' ');
    records.push({
      oldMode, newMode, status, pathBytes: Buffer.from(fields[fields.length - 1]),
      oldPathBytes: fields.length === 3 ? Buffer.from(fields[1]) : null,
    });
    pos = at;
  }
  if (pos >= buf.length) return { done: false, rest: buf.subarray(pos) };
  if (buf[pos] === NUL) pos += 1;
  return { done: true, rest: buf.subarray(pos) };
}

// The `diff --git` line git prints for a record: `a/<old path or path> b/<path>`, each side
// C-quoted as a whole, prefix included, when it holds a byte git quotes (git's `quote_two`;
// with `core.quotePath=false` only control bytes, DEL, `"` and `\`).
function sectionHeader({ pathBytes, oldPathBytes }) {
  return Buffer.concat([
    SECTION_START, quoteTwo('a/', oldPathBytes ?? pathBytes), Buffer.from(' '),
    quoteTwo('b/', pathBytes), Buffer.from('\n'),
  ]);
}

const C_ESCAPES = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 0x22: '"', 0x5c: '\\' };

function quoteTwo(prefix, bytes) {
  const quoted = (byte) => byte < 0x20 || byte === 0x7f || byte === 0x22 || byte === 0x5c;
  if (!bytes.some(quoted)) return Buffer.concat([Buffer.from(prefix), bytes]);
  const parts = [Buffer.from(`"${prefix}`)];
  for (const byte of bytes) {
    if (!quoted(byte)) parts.push(Buffer.from([byte]));
    else if (C_ESCAPES[byte] !== undefined) parts.push(Buffer.from(`\\${C_ESCAPES[byte]}`));
    else parts.push(Buffer.from(`\\${byte.toString(8).padStart(3, '0')}`));
  }
  parts.push(Buffer.from('"'));
  return Buffer.concat(parts);
}

function startsWith(buf, prefix) {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

// A section whose path (either side of a rename) is not valid UTF-8 (CHG-12, Q11): it is
// still paired with its raw record, but its lines are dropped and it makes no unit. The
// inventory reports such a path for `notIncluded` (its `notUtf8`). A rename from a
// non-UTF-8 path to a UTF-8 one carries its new path in `rediff`: `snapshot` diffs that
// path again without rename detection, so it becomes an `A` unit and is not lost
// (review-CHG-12 finding 1).
const NOT_UTF8_SECTION = Object.freeze({ notUtf8: true, rediff: null });

// Opens a section for its raw record. `M` (content edit), `A` (a new file from the
// temporary index's intent-to-add entries, old mode 000000), `D` (a deleted file, new mode
// 000000), `R<score>` (a rename, the score dropped), with or without a mode change between
// 100644 and 100755 (CHG-08), and `T` (a type change between a file, a symlink and a
// gitlink, CHG-09: `modes` holds both modes, and its second section is read into the same
// section by `secondPart`). `entryKind` (CHG-09): `submodule` when either side is a gitlink
// (160000), else `symlink` when either side is a symlink (120000), else `filtered` when the
// `check-attr` results mark the path with a `filter` attribute (CHG-10), else null.
// `generated`: the `linguist-generated` result, carried on every unit for M9 `summaryOnly`
// (CHG-17), independent of `entryKind`.
function openSection({ oldMode, newMode, status, pathBytes, oldPathBytes }, attrs = new Map()) {
  const path = utf8Path(pathBytes);
  const oldPath = oldPathBytes === null ? null : utf8Path(oldPathBytes);
  if (path === null) return NOT_UTF8_SECTION;
  if (oldPathBytes !== null && oldPath === null) return Object.freeze({ notUtf8: true, rediff: path });
  const kind = /^[MADT]$/.test(status) ? status : (/^R\d*$/.test(status) ? 'R' : null);
  if (kind === null) throw new Error(`an unexpected ${status} change (${path})`);
  const modes = [oldMode, newMode];
  for (const mode of modes) {
    if (mode !== NO_MODE && mode !== SYMLINK_MODE && mode !== GITLINK_MODE && !REGULAR_MODES.has(mode)) {
      throw new Error(`an unexpected ${mode} entry (${path})`);
    }
  }
  const attr = attrs.get(path);
  const entryKind = modes.includes(GITLINK_MODE)
    ? 'submodule'
    : (modes.includes(SYMLINK_MODE) ? 'symlink' : (attr?.filtered ? 'filtered' : null));
  return {
    path,
    pathBytes,
    oldPath: kind === 'R' ? oldPath : null,
    oldPathBytes,
    status: kind,
    entryKind,
    generated: attr?.generated ?? false,
    modes: kind !== 'A' && kind !== 'D' && oldMode !== newMode ? `${oldMode} ${newMode}` : null,
    // Which side of a `T` is a gitlink: its `Subproject commit` line is hashed, never scanned.
    gitlink: [oldMode === GITLINK_MODE, newMode === GITLINK_MODE],
    first: null,
    blobs: null,
    binary: false,
    hunks: [],
  };
}

// A type change's second section (its new side): what the first one read moves to `first`.
function secondPart(section) {
  section.first = { blobs: section.blobs, binary: section.binary, hunks: section.hunks };
  section.blobs = null;
  section.binary = false;
  section.hunks = [];
}

// One patch line of an open section. The header lines before the first `@@` are dropped;
// only the `index` line (its blob IDs, full under `--full-index`) and a `Binary files` line
// are noted. Each hunk keeps its own lines, copied out of the chunk so no chunk stays
// referenced.
function sectionLine(section, line) {
  if (section.notUtf8 === true) return;
  if (startsWith(line, HUNK_START)) {
    const m = HUNK_HEADER.exec(line.toString('latin1'));
    if (m === null) throw new Error(`an unreadable hunk header in ${section.path}`);
    section.hunks.push({ old: side(m[1], m[2]), new: side(m[3], m[4]), lines: [Buffer.from(line)] });
    return;
  }
  const hunk = section.hunks[section.hunks.length - 1];
  if (hunk === undefined) {
    if (startsWith(line, BINARY_PATCH)) section.binary = true;
    const m = INDEX_LINE.exec(line.toString('latin1'));
    if (m !== null) section.blobs = `${m[1]} ${m[2]}`;
    return;
  }
  hunk.lines.push(Buffer.from(line));
}

// The units of a closed section (Q11 hash table, CHG-08). A content-only `M`: one unit per
// hunk (Q11 hunk-level units), each with an occurrence index among the identical hunks
// before it in the file. Every other section is one whole-file unit whose identity key is
// its hash (a path has one whole-file unit): an `A`, `D` or `R` (`kind: "text"`), a mode
// change with or without content edits (`kind: "mode"`), and a file git reports as binary
// (`kind: "binary"`, also with a mode change: its body is none either way, C:plan-hunks),
// a symlink (`kind: "symlink"`, also an `M`: hashed and scanned over its old and new
// target lines) and a submodule pointer (`kind: "submodule"`: `commit <old> <new>` and a
// NUL after the path, no body, not scanned; CHG-09). A `T` is `typeChangeUnit`'s. The
// whole-file hash opens with the section's one-letter status (`A`, `D`, `M` or `R`) and
// a NUL, so none of what follows can pass for another status's framing (CHG-08 decision:
// without the tag, a pure rename to a path spelled like a mode or blob marker — for example
// `mode 100644 100755` — hashes byte for byte the same as that marker's own unit, since both
// are just path bytes followed by NUL). After the tag: `[old path, NUL,] path, NUL`, then
// `mode <old> <new>` and a NUL for a mode change, then `blob <old> <new>` and a NUL (the
// `index` line's full blob IDs, all zeros on the missing side) for a binary, else the `-`/`+`
// lines (which start with `-`, `+` or `\`, never `m` or `b`).
function unitsOf(section) {
  if (section.notUtf8 === true) return [];
  const { path, pathBytes, oldPath, oldPathBytes, status, entryKind, modes, blobs, binary, hunks, generated } = section;
  if (binary && blobs === null) throw new Error(`a binary section without an index line (${path})`);
  if (status === 'T') return [typeChangeUnit(section)];
  if (status === 'M' && entryKind === null && !binary && modes === null && hunks.length === 0) {
    throw new Error(`a modified section without a hunk (${path})`);
  }
  const kind = entryKind ?? (binary ? 'binary' : (modes === null ? 'text' : 'mode'));
  const base = { path, pathBytes, oldPath, status, kind, generated, binary };
  if (status === 'M' && kind === 'text') {
    const occurrences = new Map();
    const box = { total: 0 };
    return hunks.map((hunk) => {
      const identity = createHash('sha256').update(pathBytes).update(Buffer.from([NUL]));
      const counts = hashHunk(hunk, identity, box);
      const identityKey = identity.copy().digest('hex');
      const occurrence = occurrences.get(identityKey) ?? 0;
      occurrences.set(identityKey, occurrence + 1);
      const hash = identity.update(Buffer.from(`\0${occurrence}`)).digest('hex');
      return {
        ...base, hash, identityKey, ...counts, range: rangeOf([hunk]), body: Buffer.concat(hunk.lines),
      };
    });
  }
  const whole = createHash('sha256').update(Buffer.from(`${status}\0`));
  if (status === 'R') whole.update(oldPathBytes).update(Buffer.from([NUL]));
  whole.update(pathBytes).update(Buffer.from([NUL]));
  if (kind === 'submodule') {
    // The `index` line's full commit IDs, all zeros on the missing side; no body, not scanned.
    if (blobs === null) throw new Error(`a submodule section without an index line (${path})`);
    const hash = whole.update(Buffer.from(`commit ${blobs}\0`)).digest('hex');
    return [{
      ...base, hash, identityKey: hash, added: 0, deleted: 0, addedLines: [], range: '-0,0 +0,0', body: Buffer.alloc(0),
    }];
  }
  if (modes !== null) whole.update(Buffer.from(`mode ${modes}\0`));
  if (binary) whole.update(Buffer.from(`blob ${blobs}\0`));
  const counts = { added: 0, deleted: 0, addedLines: [] };
  const box = { total: 0 };
  for (const hunk of hunks) {
    const one = hashHunk(hunk, whole, box);
    counts.added += one.added;
    counts.deleted += one.deleted;
    counts.addedLines.push(...one.addedLines);
  }
  const hash = whole.digest('hex');
  // A section without a hunk: an empty new or deleted file, a pure rename, a mode-only
  // change, a binary file (Q11).
  const range = hunks.length === 0 ? '-0,0 +0,0' : rangeOf(hunks);
  return [{
    ...base, hash, identityKey: hash, ...counts, range, body: Buffer.concat(hunks.flatMap((hunk) => hunk.lines)),
  }];
}

// The 1 MB scan limit (CHG-16, Q10, M10): a section's units are one file's. Its added
// content is the raw bytes of its `+` lines without the `+`, plus one byte per line for the
// `\n`, summed over all its units' bodies (a gitlink side's `Subproject commit` line is in
// no body, so it does not count). Over the limit, collecting stops: every unit of the file
// carries `overScanLimit: true` and its `addedLines` are emptied, so M8 reports the path
// skipped even when each hunk alone stays under the limit.
const SCAN_LIMIT = 1048576;

function withScanLimit(units) {
  let total = 0;
  for (const { body } of units) {
    let start = 0;
    while (start < body.length && total <= SCAN_LIMIT) {
      const lf = body.indexOf(LF, start);
      const end = lf === -1 ? body.length : lf;
      if (body[start] === PLUS) total += end - start;
      start = end + 1;
    }
  }
  if (total <= SCAN_LIMIT) return units;
  return units.map((unit) => ({ ...unit, addedLines: [], overScanLimit: true }));
}

// A type change's one whole-file unit (CHG-09, Q11 pass 8 amendment), `kind` its
// `entryKind`: `T`, NUL, path, NUL, `mode <old> <new>` and a NUL, then each of its two
// parts in order (the delete, then the new file), as a whole-file unit hashes its one
// section (`blob <old> <new>` and a NUL for a binary part, else its `-`/`+` lines). The range
// spans the old side of the first part and the new side of the second. A gitlink side's
// `Subproject commit` line is hashed but neither counted, scanned nor in the body, so a
// file↔submodule `T`'s body is its file side (C:plan-hunks; review-CHG-09 finding 4).
function typeChangeUnit(section) {
  const { path, pathBytes, oldPath, entryKind, modes, gitlink, first, generated } = section;
  const parts = [first, { blobs: section.blobs, binary: section.binary, hunks: section.hunks }];
  const whole = createHash('sha256').update(Buffer.from('T\0')).update(pathBytes).update(Buffer.from([NUL]));
  whole.update(Buffer.from(`mode ${modes}\0`));
  const counts = { added: 0, deleted: 0, addedLines: [] };
  const body = [];
  parts.forEach((part, i) => {
    if (part.binary) {
      if (part.blobs === null) throw new Error(`a binary section without an index line (${path})`);
      whole.update(Buffer.from(`blob ${part.blobs}\0`));
      return;
    }
    for (const hunk of part.hunks) {
      const one = hashHunk(hunk, whole);
      if (gitlink[i]) continue;
      counts.added += one.added;
      counts.deleted += one.deleted;
      counts.addedLines.push(...one.addedLines);
      body.push(...hunk.lines);
    }
  });
  const hash = whole.digest('hex');
  const range = `-${parts[0].hunks[0]?.old.text ?? '0,0'} +${parts[1].hunks[0]?.new.text ?? '0,0'}`;
  return {
    path, pathBytes, oldPath, status: 'T', kind: entryKind, hash, identityKey: hash, ...counts, range,
    generated, binary: parts.some((part) => part.binary), body: Buffer.concat(body),
  };
}

// Feeds one hunk's `-`/`+` lines into `hash` and counts them. `\ No newline at end of file`
// (BACKSLASH) also follows an unchanged context line whose last line lacks a trailing
// newline on both sides; it is hashed only when it follows a `-`/`+` line, since context is
// otherwise excluded from the hash (Q11). `addedLines`: each `+` line's 1-based line number
// in the new file and its lossy decode without the `+` and `\n` (M10, for M8). `box`, shared
// across every hunk of one section (CHG-16 review finding 5), tracks the same running byte
// total `withScanLimit` recomputes from `body`: once it passes `SCAN_LIMIT`, decoding stops
// and no further line is pushed to `addedLines`, so a section already bound to be discarded
// never grows its decoded lines without limit. `added`/`deleted` and the hash itself are
// unaffected, and a section that stays under the limit collects every line exactly as before
// (the two measures use the same per-line length, so a cut here is always confirmed by
// `withScanLimit`'s own total).
function hashHunk(hunk, hash, box = { total: 0 }) {
  let added = 0;
  let deleted = 0;
  const addedLines = [];
  let newLine = hunk.new.start;
  let prevLead = null;
  for (const line of hunk.lines.slice(1)) {
    const lead = line[0];
    if (lead === PLUS || lead === MINUS) {
      hash.update(line);
      if (lead === MINUS) deleted += 1;
      if (lead === PLUS) {
        added += 1;
        const end = line[line.length - 1] === LF ? line.length - 1 : line.length;
        if (box.total <= SCAN_LIMIT) {
          addedLines.push({ line: newLine, text: LOSSY_UTF8.decode(line.subarray(1, end)) });
        }
        box.total += end;
      }
    } else if (lead === BACKSLASH && (prevLead === PLUS || prevLead === MINUS)) {
      hash.update(line);
    }
    if (lead === PLUS || lead === SPACE) newLine += 1;
    prevLead = lead;
  }
  return { added, deleted, addedLines };
}

// One side of a hunk header: `start[,len]`, the length 1 when git leaves it out.
function side(start, len) {
  return {
    start: Number(start),
    len: len === undefined ? 1 : Number(len),
    text: len === undefined ? start : `${start},${len}`,
  };
}

// One hunk: its header's ranges. Several: per side, the span from the first hunk's first
// line to the last hunk's last line (an empty side, length 0, sits after line `start`).
function rangeOf(hunks) {
  if (hunks.length === 1) return `-${hunks[0].old.text} +${hunks[0].new.text}`;
  const enclose = (key) => {
    const first = hunks[0][key];
    const last = hunks[hunks.length - 1][key];
    const begin = first.len === 0 ? first.start + 1 : first.start;
    const end = last.len === 0 ? last.start + 1 : last.start + last.len;
    return `${begin},${end - begin}`;
  };
  return `-${enclose('old')} +${enclose('new')}`;
}
