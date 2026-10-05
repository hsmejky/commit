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
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { copyFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { hideFilter, summaryOnly } from './path-classifier.mjs';
import { gitPath, run } from './process-adapter.mjs';

// `snapshotBlob`'s (SCN-14) record of the last `snapshot()` call's `mode`/`toplevel`/`env`/
// `now`, so it can read the repo config's content "on the snapshot side" afterward without
// its own copy of the caller's context.
let lastSnapshotContext = null;

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
 * The inventory (C:plan step 4, Q11). Read-only: three to five git calls (two more when the
 * tree can hold a submodule), none writes the index.
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
 *   refuses M2's `GIT_LITERAL_PATHSPECS=1`; called only when there is a staged-new or an
 *   `indexOnly` path). A staged-new non-UTF-8 path goes through the hidden rule in its `\xNN`
 *   form: a hidden one is `stagedExcluded` (and not in `notUtf8`), the other staged non-UTF-8
 *   paths are `stagedNotUtf8` (CHG-14: `plan --staged` refuses them with `staged-hit`).
 * - indexOnly (CHG-14, C:run-folder): every status entry whose index content differs from
 *   both HEAD and the worktree (index column `M`/`A`/`T`, non-blank worktree column), in byte
 *   order, as `{ path, blob, ignored }`: the stage-0 blob ID from one `git ls-files --stage`
 *   call (only when the list is not empty), a non-UTF-8 path in its `\xNN` form.
 * - tracked: the `git status --untracked-files=no --no-renames --ignore-submodules=dirty`
 *   entries that are not staged-new (a rename's old path is its own deletion). The pin
 *   matches the pinned diff, so a submodule's `ignore=all` setting hides no pointer change
 *   and dirt alone is no entry.
 * - unstagedTracked (RUN-13): every status entry with a path and a non-blank
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
 *     | { dir: string, count: number, reason: 'collapsed' }>,
 *   indexOnly: Array<{ path: string, blob: string, ignored: boolean }>,
 *   stagedNotUtf8: string[], notUtf8: string[],
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
  // CHG-14: the staged (not intent-to-add) non-UTF-8 paths, escaped, with whether the cached
  // diff lists them as `A`: a staged-new one goes through the hidden rule in its `\xNN` form.
  const stagedNonUtf8 = [];
  for (let i = 0; i + 1 < cached.length; i += 2) {
    const bytes = cached[i + 1];
    const path = utf8Path(bytes, notUtf8);
    const isAdded = cached[i].toString('latin1') === 'A';
    // A staged non-UTF-8 path is no unit, but its staged content still counts for the mode
    // decision and the `unstaged` report: it is listed in its `\xNN` form (C:plan
    // `preStaged`, review-CHG-12 finding 2).
    if (!intentToAdd.has(bytes.toString('latin1'))) {
      preStaged.push(path ?? escapeNonUtf8(bytes));
      if (path === null) stagedNonUtf8.push({ escaped: escapeNonUtf8(bytes), bytes: Buffer.from(bytes), isAdded });
    }
    if (path !== null && isAdded) added.push(path);
  }
  const split = hideFilter(added);
  // CHG-14 (C:plan): the hidden rule matches a staged-new non-UTF-8 path in its `\xNN` form,
  // as it does an untracked one; a hidden one is `stagedExcluded` as hidden and leaves
  // `notUtf8`. The rest are `stagedNotUtf8`, which `plan --staged` refuses with `staged-hit`
  // (the staged set is committed as-is and cannot hold a path that is no unit).
  const hiddenNonUtf8 = new Set(hideFilter(stagedNonUtf8.filter((entry) => entry.isAdded)
    .map((entry) => entry.escaped)).hidden);
  const hiddenBytes = new Set();
  const stagedNotUtf8 = [];
  for (const entry of stagedNonUtf8) {
    if (entry.isAdded && hiddenNonUtf8.has(entry.escaped)) hiddenBytes.add(entry.bytes.toString('latin1'));
    else stagedNotUtf8.push(entry.bytes);
  }
  const stagedExcluded = [
    ...split.hidden,
    ...stagedNonUtf8.filter((entry) => hiddenBytes.has(entry.bytes.toString('latin1'))).map((entry) => entry.escaped),
  ].sort(byteOrder).map((path) => ({ path, reason: 'hidden' }));
  // CHG-14: `indexOnly`, every status entry whose index content differs from both HEAD (a
  // non-blank index column, `M`/`A`/`T`) and the worktree (a non-blank worktree column), in
  // byte order, with its index blob ID (one `ls-files --stage` call, only when there is one).
  const indexOnlyEntries = status
    .filter((entry) => 'MAT'.includes(entry.xy[0]) && entry.xy[1] !== ' ')
    .map((entry) => entry.bytes)
    .sort(Buffer.compare);
  const ignored = new Set(split.candidates.length === 0 && indexOnlyEntries.length === 0 ? [] : nulFields(
    await gitOk(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], opts),
  ).map((bytes) => bytes.toString('latin1')));
  const stagedNew = split.candidates.map((path) => ({
    path, ignored: ignored.has(Buffer.from(path, 'utf8').toString('latin1')),
  }));
  const indexOnly = await indexOnlyBlobs(indexOnlyEntries, ignored, opts);

  const staged = [];
  for (let i = 1; i < cached.length; i += 2) staged.push(stringPath(cached[i]));
  const dirtySubmodules = await dirtySubmodulePaths(staged, toplevel, opts);
  const notTracked = new Set(added);
  const tracked = status
    .filter((entry) => entry.path !== null && !notTracked.has(entry.path))
    .map((entry) => entry.path);
  // Every status entry with a worktree (unstaged) change, read from the same status entries'
  // `xy[1]` (RUN-13): a `git add -p`-style `MM` file is both staged and unstaged at
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
    indexOnly, stagedNotUtf8: notUtf8List(stagedNotUtf8),
    notUtf8: notUtf8List(notUtf8.filter((bytes) => !hiddenBytes.has(bytes.toString('latin1')))),
    dirtySubmodules, embeddedRepos,
  };
}

// CHG-14: `indexOnly`'s entries (`{ path, blob, ignored }`), the paths' stage-0 blob IDs
// read from one `git ls-files --stage -z` call (records `<mode> <oid> <stage>\t<path>`),
// matched by the path bytes; a non-UTF-8 path in its `\xNN` form. `ignored`: the latin1-keyed
// set of index entries an ignore rule matches.
async function indexOnlyBlobs(entries, ignored, opts) {
  if (entries.length === 0) return [];
  const blobs = new Map();
  for (const record of nulFields(await gitOk(['ls-files', '--stage', '-z'], opts))) {
    const tab = record.indexOf(0x09);
    const [, oid, stage] = record.subarray(0, tab).toString('latin1').split(' ');
    if (stage === '0') blobs.set(record.subarray(tab + 1).toString('latin1'), oid);
  }
  return entries.map((bytes) => {
    const key = bytes.toString('latin1');
    return { path: utf8Path(bytes) ?? escapeNonUtf8(bytes), blob: blobs.get(key) ?? null, ignored: ignored.has(key) };
  });
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
  lastSnapshotContext = { mode, toplevel, env, now };
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
    const sizeOf = await bodyRuleSizes([from, head], opts, attrs, false);
    const units = await diffUnits([from, head], opts, attrs, { sizeOf });
    const ctx = { mode: 'reword', toplevel, env, now, head };
    // review-CHG-11 finding 5: the text pass keeps `diffUnits`' own rediff step.
    const runTextPass = (keep) => diffUnits([from, head, '--text'], opts, attrs, { keep, wholeFiles: true });
    return withBodyCap(await resolveHiddenBinaries(units, attrs, runTextPass, ctx, sizeOf));
  }
  if (mode === 'staged') {
    // CHG-14 (C:plan-hunks "what is diffed"): the index against HEAD (the empty tree when
    // unborn), `git diff --cached`, read-only: no temporary index, and the real index is
    // never written. The `check-attr` pass runs over a `--name-only` pass of the same diff.
    const opts = { toplevel, env, now };
    const names = nulFields(await gitOk(
      ['diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z'],
      { cwd: toplevel, env, now, readOnly: true },
    )).map((bytes) => utf8Path(bytes)).filter((path) => path !== null);
    const attrs = await checkAttrs(names, opts);
    const sizeOf = await bodyRuleSizes(['--cached'], opts, attrs, false);
    const units = await diffUnits(['--cached'], opts, attrs, { sizeOf });
    const ctx = { mode: 'staged', toplevel, env, now };
    const runTextPass = (keep) => diffUnits(['--cached', '--text'], opts, attrs, { keep, wholeFiles: true });
    return withBodyCap(await resolveHiddenBinaries(units, attrs, runTextPass, ctx, sizeOf));
  }
  if (mode !== 'split') throw new Error(`snapshot in ${mode} mode is not supported`);
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
  // CHG-17 (KD-R87): the `size` rule's sizes, read before the patch pass, so the reader
  // decides summary-only per file as each section closes.
  const sizeOf = await bodyRuleSizes([], opts, attrs, true);
  const reader = await pinnedDiff([], opts, attrs, { sizeOf });
  const units = reader.end();
  let all = units;
  if (reader.rediff.length > 0) {
    // A rename from a non-UTF-8 path: its UTF-8 new path, as the same diff shows it without
    // rename detection, is an `A` unit; the old path stays in `notUtf8` (review-CHG-12
    // finding 1). No pathspec (Q11: argv length), so the other paths' units are dropped.
    const rediff = new Set(reader.rediff);
    const again = (await pinnedDiff(['--no-renames'], opts, attrs, { sizeOf })).end().filter((unit) => rediff.has(unit.path));
    all = [...units, ...again].sort((a, b) => byteOrder(a.path, b.path));
  }
  const ctx = { mode: 'split', toplevel, env, now };
  const runTextPass = async (keep) => {
    const textReader = await pinnedDiff(['--text'], opts, attrs, { keep, wholeFiles: true });
    const textUnits = textReader.end();
    if (textReader.rediff.length === 0) return textUnits;
    // review-CHG-11 finding 5: the same `--no-renames` rediff as the main pass above.
    return [...textUnits, ...(await pinnedDiff(['--text', '--no-renames'], opts, attrs, { keep: new Set(textReader.rediff), wholeFiles: true })).end()];
  };
  return withBodyCap(await resolveHiddenBinaries(all, attrs, runTextPass, ctx, sizeOf));
}

/**
 * The worktree's changes against the real index, as units (CHG-14, C:plan `tracked` in
 * `staged` mode: "only the unstaged changes"): `git diff --no-renames` (no `--cached`), with
 * the same `check-attr` pass over a `--name-only` run of that diff. Read-only.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<Array<object>>} units shaped as `snapshot`'s.
 */
export async function unstagedUnits({ toplevel, env, now }) {
  const opts = { toplevel, env, now };
  const names = nulFields(await gitOk(
    ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z'],
    { cwd: toplevel, env, now, readOnly: true },
  )).map((bytes) => utf8Path(bytes)).filter((path) => path !== null);
  const attrs = await checkAttrs(names, opts);
  const sizeOf = await bodyRuleSizes(['--no-renames'], opts, attrs, true);
  const units = await diffUnits(['--no-renames'], opts, attrs, { sizeOf });
  // review-CHG-14 finding 5: this diffs the real index against the worktree, same as
  // `split`'s pinned diff; an attribute-hidden text file's new content is therefore the
  // worktree file, so the NUL sniff reads it straight off disk (`hiddenBinaryFacts`), never
  // the batch `cat-file` path (`newOid` is the worktree file's hash, but that object is not in the object database, unlike
  // `reword`/`staged`'s index-side diffs). `ctx.mode` is deliberately neither `reword` nor
  // `staged`, to take that disk-read branch in `resolveHiddenBinaries`.
  const ctx = { mode: 'unstaged', toplevel, env, now };
  const runTextPass = (keep) => diffUnits(['--no-renames', '--text'], opts, attrs, { keep, wholeFiles: true });
  return withBodyCap(await resolveHiddenBinaries(units, attrs, runTextPass, ctx, sizeOf));
}

/**
 * Reads the repo config's content "on the snapshot side of the last `snapshot()` call"
 * (SCN-14, M10, C:plan-hunks): the working-tree file in `split` mode (staged changes to it
 * are not reflected, since `split` units carry only the real tree's edits against HEAD);
 * the index entry's blob in `staged` mode (CHG-14: `git ls-files --stage`, then `git
 * cat-file blob`).
 *
 * @param {string} repoRelativePath path relative to the repo root (M4 `REPO_CONFIG_PATH`).
 * @returns {Promise<Buffer | null>} the file's raw bytes, or `null` when it is absent on the
 *   snapshot side.
 * @throws {Error} (a rejection) when called before any `snapshot()` call this process, in
 *   `reword` mode, or when a git call fails.
 */
export async function snapshotBlob(repoRelativePath) {
  if (lastSnapshotContext === null) {
    throw new Error('snapshotBlob called before any snapshot (M10)');
  }
  const { mode, toplevel, env, now } = lastSnapshotContext;
  if (mode === 'split') {
    try {
      return readFileSync(join(toplevel, repoRelativePath));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return null;
      throw err;
    }
  }
  if (mode === 'staged') {
    const opts = { cwd: toplevel, env, now, readOnly: true };
    const record = nulFields(await gitOk(['ls-files', '--stage', '-z', '--', repoRelativePath], opts))
      .find((field) => field.toString('latin1').split('\t')[0].endsWith(' 0'));
    if (record === undefined) return null;
    const oid = record.toString('latin1').split(' ')[1];
    return gitOk(['cat-file', 'blob', oid], opts);
  }
  throw new Error(`snapshotBlob in ${mode} mode is not supported`);
}

// One `git check-attr --stdin -z filter linguist-generated diff binary` call (CHG-10,
// CHG-11, Q11): paths go on stdin, NUL-separated, never argv. Runs through M2's `run`, which
// strips every inherited `GIT_*` variable outside the keep-set (GIT-05), so a decoy
// `GIT_ATTR_SOURCE` cannot redirect which `.gitattributes` this call reads. Returns a
// `Map<path, { filtered: boolean, generated: boolean, hidden: boolean }>`; a path with no
// row (not in `paths`) is absent. `hidden` (CHG-11, Q10): `diff` is `unset` (`-diff`) or a
// custom driver name (anything but `unspecified`/`set`), or the `binary` macro is `set` —
// each hides a path's diff behind a binary rendering whatever its real content is.
async function checkAttrs(paths, { toplevel, env, now, indexPath }) {
  if (paths.length === 0) return new Map();
  const result = await run(
    'git',
    ['check-attr', '--stdin', '-z', 'filter', 'linguist-generated', 'diff', 'binary'],
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
    const entry = out.get(path) ?? { filtered: false, generated: false, hidden: false };
    if (attr === 'filter' && value !== 'unspecified' && value !== 'unset') entry.filtered = true;
    // Linguist reads the bare form (`set`) and `=true` alike (review-CHG-10 finding 3).
    if (attr === 'linguist-generated' && (value === 'set' || value === 'true')) entry.generated = true;
    if (attr === 'diff' && value !== 'unspecified' && value !== 'set') entry.hidden = true;
    if (attr === 'binary' && value === 'set') entry.hidden = true;
    out.set(path, entry);
  }
  return out;
}

// CHG-11 (Q10, Q11, C:plan "Binary is decided by attributes first, then content"): for a
// `split` candidate path `attrs` marks `hidden`, the new content's size against the 1 MB scan
// limit, checked before any NUL sniff so a huge file never needs its content read at all;
// `overLimit: true` skips the NUL check outright (the caller flags the unit `overScanLimit`
// and leaves it `kind: "binary"`, never guessing whether it was really text). Under the
// limit, `binary` is whether the first 8000 bytes hold a NUL (git's own heuristic, Q10). The
// new content is the worktree file (what the pinned diff actually compares against the
// temporary index), read straight off disk like `fileFacts`. A path that is no longer a
// regular file has no content to sniff and stays binary (`binary: true`, git's own call).
// `reword` has no worktree side; its candidates are resolved in one batch by
// `hiddenBinaryFactsBatch` instead (review-CHG-11 finding 9).
function hiddenBinaryFacts(path, { toplevel }) {
  const full = join(toplevel, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { overLimit: false, binary: true };
  }
  if (!stat.isFile()) return { overLimit: false, binary: true };
  if (stat.size > SCAN_LIMIT) return { overLimit: true, binary: null };
  const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
  const fd = openSync(full, 'r');
  let read;
  try {
    read = readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  return { overLimit: false, binary: buf.subarray(0, read).includes(NUL) };
}

// review-CHG-11 finding 9 (Low; r2's corrections to the handoff design): `reword`'s
// candidates are resolved in a constant two `git cat-file` spawns in all, however many
// candidates there are, instead of two per candidate. Each candidate's new blob ID is already
// on its unit (`newOid`, parsed from the main pass's own `index <old>..<new>` line — no extra
// names pass needed). One `cat-file --batch-check=%(objectsize)` call sizes every candidate
// against the 1 MB scan limit; the under-limit OIDs then go through one streamed
// `cat-file --batch=%(objectsize)` call, sniffing only the first 8000 bytes of each object's
// content for a NUL and discarding the rest as it arrives (`streamCatFileBatch`), the same
// bounded-memory shape as the keep-set `--text` pass (review-CHG-11 finding 2).
async function hiddenBinaryFactsBatch(candidates, { toplevel, env, now }) {
  const opts = { cwd: toplevel, env, now, readOnly: true };
  const sizesOut = await gitOk(['cat-file', '--batch-check=%(objectsize)'], {
    ...opts, input: Buffer.from(candidates.map((unit) => `${unit.newOid}\n`).join('')),
  });
  const sizeLines = sizesOut.toString('utf8').split('\n');
  const facts = new Map();
  const underLimit = [];
  candidates.forEach((unit, i) => {
    const line = sizeLines[i];
    if (line === undefined || line.endsWith(' missing')) {
      throw new Error(`git cat-file reports ${unit.path} (${unit.newOid}) missing`);
    }
    const size = Number(line);
    if (size > SCAN_LIMIT) {
      facts.set(unit.path, { overLimit: true, binary: null });
    } else {
      underLimit.push(unit);
    }
  });
  if (underLimit.length === 0) return facts;
  for (const [path, binary] of await streamCatFileBatch(underLimit, opts)) {
    facts.set(path, { overLimit: false, binary });
  }
  return facts;
}

// Streams one `git cat-file --batch=%(objectsize)` call for `units` (in the order given, the
// same order git answers them in): each object's output is `<size>\n<content bytes><LF>`. Only
// the first `BINARY_SNIFF_BYTES` of `<content>` are kept per object (the NUL sniff); the rest
// is counted and skipped as chunks arrive, never buffered, so memory stays bounded by one
// sniff window regardless of how large an object or how many candidates there are.
async function streamCatFileBatch(units, opts) {
  const results = [];
  let state = 'header';
  let headerBuf = Buffer.alloc(0);
  let remaining = 0;
  let sniff = [];
  let sniffed = 0;
  let index = 0;

  const onChunk = (chunk) => {
    let pos = 0;
    while (pos < chunk.length) {
      if (state === 'header') {
        const lf = chunk.indexOf(LF, pos);
        if (lf === -1) {
          headerBuf = Buffer.concat([headerBuf, chunk.subarray(pos)]);
          return;
        }
        const text = Buffer.concat([headerBuf, chunk.subarray(pos, lf)]).toString('utf8');
        headerBuf = Buffer.alloc(0);
        pos = lf + 1;
        if (!/^\d+$/.test(text)) {
          throw new Error(`git cat-file gave an unreadable size (${JSON.stringify(text)}) for ${units[index]?.path}`);
        }
        remaining = Number(text);
        state = remaining === 0 ? 'trailing' : 'content';
        continue;
      }
      if (state === 'content') {
        const take = Math.min(remaining, chunk.length - pos);
        if (sniffed < BINARY_SNIFF_BYTES) {
          const want = Math.min(take, BINARY_SNIFF_BYTES - sniffed);
          sniff.push(Buffer.from(chunk.subarray(pos, pos + want)));
          sniffed += want;
        }
        remaining -= take;
        pos += take;
        if (remaining === 0) state = 'trailing';
        continue;
      }
      // 'trailing': the one LF byte git appends after every object's content.
      results.push([units[index].path, Buffer.concat(sniff).includes(NUL)]);
      index += 1;
      sniff = [];
      sniffed = 0;
      pos += 1;
      state = 'header';
    }
  };

  const result = await run('git', ['cat-file', '--batch=%(objectsize)'], {
    ...opts, input: Buffer.from(units.map((unit) => `${unit.newOid}\n`).join('')), onStdout: onChunk,
  });
  if (result.code !== 0) throw new Error(`git cat-file failed (${result.code}): ${result.stderr}`);
  if (results.length !== units.length) {
    throw new Error(`git cat-file --batch returned ${results.length} objects for ${units.length} requested`);
  }
  return results;
}

// CHG-11: resolves every `kind: "binary"` unit whose path `attrs` marks `hidden` (Q10, Q11,
// C:plan), except a deletion (`D`): it has no new content, so it stays binary (review-CHG-11
// findings 1 and 3: `reword` would find no such path in `head`, `split` none on disk). A unit over the 1 MB scan limit is flagged `overScanLimit: true` and stays
// `kind: "binary"` (its hash, body and range are unaffected: scanner.mjs already reports it
// skipped by the flag alone, ahead of the binary kind). A unit under the limit with no NUL in
// its first 8000 bytes is attribute-hidden text: it keeps its whole-file hash, body (empty,
// "no block" like a summary-only unit, C:plan-hunks), range and git's raw `binary: true` from
// the main pass (review-CHG-11 finding 4: hunk-index renders a binary `text` unit with no
// block) — only its `kind` and added-lines fields change — with `added`/`deleted`/`addedLines`
// read from `runTextPass(keep)`'s matching section, the one streamed
// `git diff -z --raw -p --text` pass run only when at least one such file exists (Q11 pass 5),
// whose reader builds units for the `keep` paths alone and discards every other section as
// it arrives (C:plan; review-CHG-11 finding 2: `--text` turns every real binary in the change
// set into text lines). A unit under the limit with a NUL stays genuinely binary, untouched.
//
// CHG-17 (KD-R87): the main pass's reader decided summary-only on the binary unit's own
// counts (zero); a unit turned `text` here is decided again on its text counts with the same
// `sizeOf`, as it would have been had its section been text. Its body is empty either way
// (a binary section has no hunk lines), so nothing is held for this. The `--text` pass's
// reader is a `wholeFiles` one: each kept file is one bodiless unit whose counts and added
// lines cover all its hunks (before, a multi-hunk file kept only its last hunk's).
async function resolveHiddenBinaries(units, attrs, runTextPass, ctx, sizeOf) {
  const candidates = units.filter((unit) => (
    unit.kind === 'binary' && unit.status !== 'D' && attrs.get(unit.path)?.hidden === true
  ));
  if (candidates.length === 0) return units;
  const facts = ctx.mode === 'reword' || ctx.mode === 'staged'
    ? await hiddenBinaryFactsBatch(candidates, ctx)
    : new Map(candidates.map((unit) => [unit.path, hiddenBinaryFacts(unit.path, ctx)]));
  const overLimit = new Set([...facts].filter(([, f]) => f.overLimit).map(([p]) => p));
  const hiddenTextPaths = new Set([...facts].filter(([, f]) => !f.overLimit && f.binary === false).map(([p]) => p));
  const textUnits = new Map();
  if (hiddenTextPaths.size > 0) {
    for (const unit of await runTextPass(hiddenTextPaths)) {
      if (hiddenTextPaths.has(unit.path)) textUnits.set(unit.path, unit);
    }
  }
  return units.map((unit) => {
    if (overLimit.has(unit.path)) return { ...unit, overScanLimit: true, addedLines: [] };
    const textUnit = textUnits.get(unit.path);
    if (textUnit === undefined) return unit;
    const { summaryOnly: decided, ...text } = {
      ...unit, kind: 'text', added: textUnit.added, deleted: textUnit.deleted, addedLines: textUnit.addedLines,
    };
    const reason = summaryOnly(text.path, {
      added: text.added, deleted: text.deleted, generated: text.generated, size: sizeOf(text) ?? 0,
    });
    return reason === null ? text : { ...text, summaryOnly: reason };
  });
}

// One pinned `git diff -z --raw -p` call against the temporary index, `extra` appended,
// streamed into a diff reader. `attrs`: the `check-attr` results (CHG-10), threaded to
// `openSection` so a `filter`-attributed path's section opens as `kind: "filtered"`. `keep`:
// the reader's keep-set (`createDiffReader`), null for every path. `sizeOf`: the reader's
// summary-only sizes (`bodyRuleSizes`), null for none (a `--text` pass).
async function pinnedDiff(extra, { toplevel, env, now, indexPath }, attrs = new Map(), { keep = null, sizeOf = null, wholeFiles = false } = {}) {
  const reader = createDiffReader(attrs, { keep, sizeOf, wholeFiles });
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
 * @param {{ keep?: Set<string> | null, sizeOf?: ((unit: object) => number | undefined) | null, wholeFiles?: boolean, headers?: boolean }} [options]
 *   `keep` (CHG-11's `--text` pass): only
 *   these paths make units; every other section is still paired with its record, but its
 *   lines are discarded as they arrive, like a non-UTF-8 one's, and a rename from a non-UTF-8
 *   path goes to `rediff` only when its new path is kept. Null (the default): every path.
 *   `sizeOf` (CHG-17, KD-R87): the `size` rule's sizes from `bodyRuleSizes` (the size pass,
 *   run before this one); non-null, each file is decided summary-only (M9 `summaryOnly`). A
 *   file bound to be summary-only streams (`startFold`): at its first hunk when a size-free
 *   rule or `size` marks it, at its 1001st changed line for `lines`; its lines are dropped
 *   as they arrive, so a summary-only file never buffers more than 1000 changed lines. A
 *   file decided only at its close (no hunk) goes through `summaryOnlyFile`. Null (the
 *   default): no decision (a `--text` pass, crafted bytes).
 *   `wholeFiles` (KD-R87, a `--text` pass): every kept file with a hunk streams the same way
 *   from its first hunk, as one whole-file unit with no body and no decision.
 *   `headers` (CHG-20, `stage`'s patch): each hunk unit of a content-only `M` also carries
 *   `header`, its section's header lines (`diff --git` up to the first `@@`) as git wrote
 *   them, so a patch built from them quotes every path exactly as git does.
 * @returns {{ rediff: string[], push: (chunk: Buffer) => void, end: () => object[] }}
 *   `push` throws on the first pairing error and is not called again; `end` flushes the
 *   last line, checks the section count and returns the units in `snapshot`'s shape and
 *   order. `rediff`: the new paths of the renames whose old path is not UTF-8, in diff
 *   order (complete once `end` returns), which made no unit here.
 */
export function createDiffReader(attrs = new Map(), { keep = null, sizeOf = null, wholeFiles = false, headers = false } = {}) {
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
    if (section === null) return;
    if (section.fold !== undefined && section.fold !== null) {
      const unit = foldedUnit(section);
      section = null;
      if (sizeOf === null) {
        units.push(unit);
        return;
      }
      const reason = summaryOnly(unit.path, { added: unit.added, deleted: unit.deleted, generated: unit.generated, size: sizeOf(unit) ?? 0 });
      if (reason === null) throw new Error(`a streamed section is not summary-only (${unit.path})`);
      units.push({ ...unit, summaryOnly: reason });
      return;
    }
    const made = withScanLimit(unitsOf(section));
    section = null;
    units.push(...(sizeOf === null ? made : summaryOnlyFile(made, sizeOf)));
  };
  // KD-R87: a section that may stream (`startFold`): with summary-only decisions or
  // `wholeFiles`, any UTF-8 section but a submodule pointer (whose hash takes no hunk lines).
  const foldable = (s) => (sizeOf !== null || wholeFiles) && s.notUtf8 !== true
    && (s.status === 'T' || s.entryKind !== 'submodule');
  // The summary-only rules on what is known so far: the name rules and `generated` at once,
  // `size` once the `index` line is read (the first hunk), `lines` as changed lines arrive.
  const bound = (s) => summaryOnly(s.path, {
    added: s.changed,
    deleted: 0,
    generated: s.generated,
    size: sizeOf({ path: s.path, status: s.status, kind: s.entryKind ?? (s.modes === null ? 'text' : 'mode'), blobs: s.blobs }) ?? 0,
  }) !== null;
  const hunkLine = (line) => {
    if (!foldable(section)) {
      sectionLine(section, line);
      return;
    }
    if (section.fold !== null) {
      foldLine(section, line);
      return;
    }
    const before = section.changed;
    const first = !section.checked && startsWith(line, HUNK_START);
    sectionLine(section, line);
    if (first) section.checked = true;
    if (wholeFiles ? first : ((first || section.changed !== before) && bound(section))) startFold(section);
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
      if (keep !== null && !keep.has(section.notUtf8 === true ? section.rediff : section.path)) section = NOT_UTF8_SECTION;
      if (headers && section.notUtf8 !== true) section.header = [Buffer.from(line)];
      if (section.notUtf8 === true && section.rediff !== null) rediff.push(section.rediff);
      if (record.status === 'T') typeChange = { header: Buffer.from(line), path: escapeNonUtf8(record.pathBytes) };
      return;
    }
    if (section === null) throw new Error('the diff patch text does not start with a section');
    hunkLine(line);
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
// re-triggering itself. `keep`: the reader's keep-set (`createDiffReader`), null for every
// path; the re-diff keeps only the rediff paths. `sizeOf`: the reader's summary-only sizes
// (`bodyRuleSizes` over the same `args`), null for none; the re-diff reuses them (its `A`
// unit's new side is the rename's).
async function diffUnits(args, { toplevel, env, now }, attrs = new Map(), { allowRediff = true, keep = null, sizeOf = null, wholeFiles = false, headers = false } = {}) {
  const reader = createDiffReader(attrs, { keep, sizeOf, wholeFiles, headers });
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p', ...args],
    { cwd: toplevel, env, now, readOnly: true, onStdout: (chunk) => reader.push(chunk) },
  );
  if (result.code !== 0) throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  const units = reader.end();
  if (!allowRediff || reader.rediff.length === 0) return units;
  const rediff = new Set(reader.rediff);
  const again = (await diffUnits([...args, '--no-renames'], { toplevel, env, now }, attrs, { allowRediff: false, keep: rediff, sizeOf, wholeFiles, headers }))
    .filter((unit) => rediff.has(unit.path));
  return [...units, ...again].sort((a, b) => byteOrder(a.path, b.path));
}

function sameHashes(units, hashes) {
  const a = units.map((unit) => unit.hash).sort();
  const b = [...hashes].sort();
  return a.length === b.length && a.every((hash, i) => hash === b[i]);
}

/**
 * M10 `stage` on the real index (EXE-02, CHG-20): `git reset -q -- .` (the pathspec form,
 * C:commit-release (c)), then the group's hunk units through one built patch and its other
 * units as whole files. A hunk unit (a content-only `M` of kind `text` that is not
 * summary-only; a capped one keeps its body, CHG-17) is staged from the **current** diff of
 * the reset index against the working tree: the patch holds, per file in path order, git's
 * own header lines of that diff verbatim (`diff --git`, `index`, `---`, `+++`; a path git
 * quotes is never formatted here) followed by the group's hunks as raw bytes at their
 * current ranges, applied with `git apply --cached --whitespace=nowarn` on stdin, so an
 * `apply.whitespace=error|fix` config neither rejects nor changes a planned hunk (Q11, Q18).
 * A hunk whose hash that diff no longer holds is `mismatch`. Every other unit is staged with
 * `git add -A` over its paths (both paths of a rename), on stdin NUL-separated, never on argv;
 * ignored paths in a separate `git add -A -f`. Then verifies that the index diff against HEAD
 * holds exactly the group's hashes (one `check-attr` call over the group's paths first, so a
 * filtered file hashes as its stored unit, CHG-10).
 *
 * @param {{ units: Array<{ path: string, oldPath: string | null, hash: string, status?: string,
 *   kind?: string, summaryOnly?: string }>, ignoredPaths?: string[], toplevel: string,
 *   env: object, now?: () => number }} options
 *   `units`: the group's own units, as phase (b) matched them in the current snapshot
 *   (`status`, `kind` and `summaryOnly` decide hunk or whole file); `ignoredPaths`: those of
 *   their paths `plan` stored with `ignored: true`.
 * @returns {Promise<{ ok: true } | { ok: false, code: 'mismatch' }
 *   | { ok: false, code: 'stage-failed', gitOutput: string }>}
 * @throws {Error} when the reset, the current diff or the verify's diff fails.
 */
export async function stage({ units, ignoredPaths = [], toplevel, env, now }) {
  const reset = await run('git', ['reset', '-q', '--', '.'], { cwd: toplevel, env, now });
  if (reset.code !== 0) throw new Error(`git reset failed (${reset.code}): ${reset.stderr}`);
  // review-CHG-20 High-1: an attribute-hidden binary file resolved to `kind: "text"`
  // (`resolveHiddenBinaries`) keeps git's own raw binary bit (`binary: true`, review-CHG-11
  // finding 4); a genuine per-hunk `M text` unit from `unitsOf` always has `binary` falsy (a
  // `kind: "text"` unit there implies git itself did not call the diff binary). Re-diffing a
  // hidden-binary-resolved file with `--text` dropped would make git call it binary again and
  // fail the group with `mismatch`; it stays a whole-file unit, staged below with `git add -A`.
  // `fileHash` cannot discriminate instead: `withBodyCap` strips it from every unit `snapshot`
  // returns, including real hunk units, before `stage` ever sees them.
  const hunkLevel = (unit) => (
    unit.status === 'M' && unit.kind === 'text' && unit.summaryOnly === undefined && unit.binary !== true
  );
  const hunks = units.filter(hunkLevel);
  if (hunks.length > 0) {
    const patch = await hunkPatch(hunks, { toplevel, env, now });
    if (patch === null) return { ok: false, code: 'mismatch' };
    const applied = await run(
      'git',
      ['apply', '--cached', '--whitespace=nowarn', '-'],
      { cwd: toplevel, env, now, input: patch },
    );
    if (applied.code !== 0) {
      return { ok: false, code: 'stage-failed', gitOutput: `${applied.stdout.toString('utf8')}${applied.stderr}` };
    }
  }
  const ignored = new Set(ignoredPaths);
  const paths = [...new Set(units.filter((unit) => !hunkLevel(unit))
    .flatMap((unit) => (unit.oldPath === null ? [unit.path] : [unit.oldPath, unit.path])))];
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
  // review-CHG-17 Medium 1: sized off disk (`worktree: true`), as the split `snapshot` that
  // produced the stored units was: the group's files were just `git add`ed from there, and a
  // blob size can fall on the other side of 256 KB (eol=crlf, core.autocrlf,
  // working-tree-encoding), turning a stored whole-file hash into per-hunk ones.
  const sizeOf = await bodyRuleSizes(['--cached'], { toplevel, env, now }, attrs, true);
  const staged = withBodyCap(await diffUnits(['--cached'], { toplevel, env, now }, attrs, { sizeOf }));
  return sameHashes(staged, units.map((unit) => unit.hash)) ? { ok: true } : { ok: false, code: 'mismatch' };
}

// CHG-20: the patch for `stage`'s hunk units, or null when the current diff of the (reset)
// real index against the working tree no longer holds one of their hashes. The diff is the
// pinned one, its reader keeping only the hunk units' paths and their header lines; the
// patch is each file's header followed by the group's hunks of that file, in diff order.
async function hunkPatch(hunks, { toplevel, env, now }) {
  const wanted = new Set(hunks.map((unit) => unit.hash));
  const current = (await diffUnits([], { toplevel, env, now }, new Map(), {
    allowRediff: false, keep: new Set(hunks.map((unit) => unit.path)), headers: true,
  })).filter((unit) => wanted.has(unit.hash) && unit.header !== undefined);
  if (current.length !== wanted.size) return null;
  const parts = [];
  current.forEach((unit, i) => {
    if (i === 0 || current[i - 1].path !== unit.path) parts.push(unit.header);
    parts.push(unit.body);
  });
  return Buffer.concat(parts);
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
  const sizeOf = await bodyRuleSizes([from, toTree], { toplevel, env, now }, new Map(), false);
  return withBodyCap(await diffUnits([from, toTree], { toplevel, env, now }, new Map(), { sizeOf }));
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
    const [oldMode, newMode, oldOid, newOid, status] = fields[0].toString('latin1').slice(1).split(' ');
    records.push({
      oldMode, newMode, oldOid, newOid, status, pathBytes: Buffer.from(fields[fields.length - 1]),
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
// (review-CHG-12 finding 1). A section outside a reader's keep-set reuses this same
// no-unit shape (CHG-11).
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
    // KD-R87: the changed lines buffered so far (a gitlink side's not counted), whether the
    // summary-only rules were checked at the first hunk, and the streamed state once the
    // section is bound to be summary-only (`startFold`).
    changed: 0,
    checked: false,
    fold: null,
  };
}

// A type change's second section (its new side): what the first one read moves to `first`.
function secondPart(section) {
  section.first = { blobs: section.blobs, binary: section.binary, hunks: section.hunks };
  section.blobs = null;
  section.binary = false;
  section.hunks = [];
  if (section.fold !== null) section.fold.inHunk = false;
}

// One patch line of an open section. The header lines before the first `@@` are dropped;
// only the `index` line (its blob IDs, full under `--full-index`) and a `Binary files` line
// are noted. Each hunk keeps its own lines, copied out of the chunk so no chunk stays
// referenced.
function sectionLine(section, line) {
  if (section.notUtf8 === true) return;
  if (startsWith(line, HUNK_START)) {
    section.hunks.push({ ...hunkHeader(section, line), lines: [Buffer.from(line)] });
    return;
  }
  const hunk = section.hunks[section.hunks.length - 1];
  if (hunk === undefined) {
    headerLine(section, line);
    section.header?.push(Buffer.from(line));
    return;
  }
  hunk.lines.push(Buffer.from(line));
  if ((line[0] === PLUS || line[0] === MINUS) && !section.gitlink[section.first === null ? 0 : 1]) section.changed += 1;
}

function hunkHeader(section, line) {
  const m = HUNK_HEADER.exec(line.toString('latin1'));
  if (m === null) throw new Error(`an unreadable hunk header in ${section.path}`);
  return { old: side(m[1], m[2]), new: side(m[3], m[4]) };
}

// A section header line before its first `@@`: only a `Binary files` line and the `index`
// line are noted.
function headerLine(section, line) {
  if (startsWith(line, BINARY_PATCH)) section.binary = true;
  const m = INDEX_LINE.exec(line.toString('latin1'));
  if (m !== null) section.blobs = `${m[1]} ${m[2]}`;
}

// KD-R87 (CHG-17, Q11, M10): a section bound to be summary-only, or every kept section of a
// `wholeFiles` reader, stops buffering. Its buffered hunks (and a type change's first part)
// are replayed into one running whole-file hash, the summed counts and the added lines (cut
// at the 1 MB scan limit as `hashHunk` cuts them), then dropped; every later line goes
// straight there (`foldLine`), so from here on only the first and last hunk headers are
// held. The hash prefix is `unitsOf`'s whole-file one (a content-only `M`'s whole-file hash
// is the same bytes) or `typeChangeUnit`'s; `foldedUnit` builds the unit at the close.
function startFold(section) {
  const hash = createHash('sha256');
  const typeChange = section.status === 'T';
  hash.update(Buffer.from(`${section.status}\0`));
  if (section.status === 'R') hash.update(section.oldPathBytes).update(Buffer.from([NUL]));
  hash.update(section.pathBytes).update(Buffer.from([NUL]));
  if (section.modes !== null) hash.update(Buffer.from(`mode ${section.modes}\0`));
  const fold = {
    hash, box: { total: 0 }, counted: true, added: 0, deleted: 0, addedLines: [], newLine: 0, prevLead: null,
    inHunk: false, hunks: 0, first: null, last: null, parts: [null, null],
  };
  section.fold = fold;
  const part = section.first === null ? 0 : 1;
  if (typeChange && part === 1) {
    const { first } = section;
    if (first.binary) {
      if (first.blobs === null) throw new Error(`a binary section without an index line (${section.path})`);
      hash.update(Buffer.from(`blob ${first.blobs}\0`));
    }
    for (const hunk of first.hunks) foldHunk(section, hunk, 0, hunk.lines.slice(1));
    section.first = { blobs: first.blobs, binary: first.binary, hunks: [] };
  }
  const { hunks } = section;
  section.hunks = [];
  for (const hunk of hunks) foldHunk(section, hunk, part, hunk.lines.slice(1));
}

function foldHunk(section, { old, new: next }, part, lines) {
  const { fold } = section;
  const header = { old, new: next };
  fold.hunks += 1;
  fold.first ??= header;
  fold.last = header;
  fold.parts[part] ??= header;
  fold.newLine = next.start;
  fold.prevLead = null;
  fold.counted = !section.gitlink[part];
  fold.inHunk = true;
  for (const line of lines) hashLine(fold, line);
}

// One patch line of a streamed section (`startFold`).
function foldLine(section, line) {
  if (startsWith(line, HUNK_START)) {
    foldHunk(section, hunkHeader(section, line), section.first === null ? 0 : 1, []);
  } else if (section.fold.inHunk) {
    hashLine(section.fold, line);
  } else {
    headerLine(section, line);
  }
}

// A streamed section's one unit, in the shape and key order `unitsOf` (or `typeChangeUnit`)
// and `withScanLimit` give a whole-file unit, with no body.
function foldedUnit(section) {
  const { path, pathBytes, oldPath, status, entryKind, modes, generated, blobs, binary, fold } = section;
  if (binary && blobs === null) throw new Error(`a binary section without an index line (${path})`);
  if (status === 'T' && binary) fold.hash.update(Buffer.from(`blob ${blobs}\0`));
  const hash = fold.hash.digest('hex');
  const over = fold.box.total > SCAN_LIMIT;
  const counts = { added: fold.added, deleted: fold.deleted, addedLines: over ? [] : fold.addedLines };
  const limit = over ? { overScanLimit: true } : {};
  if (status === 'T') {
    const range = `-${fold.parts[0]?.old.text ?? '0,0'} +${fold.parts[1]?.new.text ?? '0,0'}`;
    return {
      path, pathBytes, oldPath, status, kind: entryKind, hash, identityKey: hash, ...counts, range,
      generated, binary: section.first.binary || binary, body: Buffer.alloc(0), ...limit,
    };
  }
  const kind = entryKind ?? (modes === null ? 'text' : 'mode');
  const range = rangeOf(fold.hunks === 1 ? [fold.first] : [fold.first, fold.last]);
  return {
    path, pathBytes, oldPath, status, kind, generated, binary, hash, identityKey: hash, ...counts, range,
    body: Buffer.alloc(0), blobs, ...limit,
  };
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
    // CHG-17: the same lines also feed the file's whole-file hash (`M`, NUL, path, NUL, then
    // every hunk's `-`/`+` lines, as a whole-file unit hashes), which the file's one unit
    // takes if it turns out summary-only (`summaryOnlyFile`).
    const file = createHash('sha256').update(Buffer.from('M\0')).update(pathBytes).update(Buffer.from([NUL]));
    const units = hunks.map((hunk) => {
      const identity = createHash('sha256').update(pathBytes).update(Buffer.from([NUL]));
      const both = { update(bytes) { identity.update(bytes); file.update(bytes); return both; } };
      const counts = hashHunk(hunk, both, box);
      const identityKey = identity.copy().digest('hex');
      const occurrence = occurrences.get(identityKey) ?? 0;
      occurrences.set(identityKey, occurrence + 1);
      const hash = identity.update(Buffer.from(`\0${occurrence}`)).digest('hex');
      return {
        ...base, hash, identityKey, ...counts, range: rangeOf([hunk]), body: Buffer.concat(hunk.lines), blobs,
      };
    });
    const fileHash = file.digest('hex');
    const fileRange = rangeOf(hunks);
    // CHG-20: a `headers` reader's section keeps git's own header lines (`diff --git` to the
    // line before the first `@@`) for `stage`'s patch; no other reader sets `header`.
    const header = section.header === undefined ? {} : { header: Buffer.concat(section.header) };
    return units.map((unit) => ({ ...unit, fileHash, fileRange, ...header }));
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
  // review-CHG-11 finding 9 (Low): a binary unit's new blob ID, already parsed from this
  // section's `index <old>..<new>` line (full under `--full-index`, pinned), is exposed so a
  // caller resolving hidden-binary candidates (`reword`) can read their content by OID in one
  // batched `git cat-file` pass instead of spawning one per path.
  return [{
    ...base, hash, identityKey: hash, ...counts, range, body: Buffer.concat(hunks.flatMap((hunk) => hunk.lines)),
    ...(binary ? { newOid: blobs.split(' ')[1] } : {}), blobs,
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

// The body cap (CHG-17, C:summary-only-files, Q19): changed lines summed over the files that
// are not summary-only, in path order.
const BODY_CAP_LINES = 3000;
const ZERO_OID = /^0+$/;

// CHG-17 (C:summary-only-files, M10, KD-R87): M9 `summaryOnly` over one closed section's
// units (one file), decided in the reader as the section closes. A summary-only file
// becomes one whole-file unit carrying `summaryOnly` (the reason): a content-only `M`'s hunk
// units fold into its whole-file hash, range and summed counts; its `addedLines` stay for
// the scan (C:summary-only-files: the scan ignores summary-only status), its `body` is
// dropped. `sizeOf` (`bodyRuleSizes`) gives the `size` rule's size, read before the pass.
function summaryOnlyFile(units, sizeOf) {
  if (units.length === 0) return units;
  const [first] = units;
  const added = units.reduce((sum, unit) => sum + unit.added, 0);
  const deleted = units.reduce((sum, unit) => sum + unit.deleted, 0);
  const reason = summaryOnly(first.path, { added, deleted, generated: first.generated, size: sizeOf(first) ?? 0 });
  if (reason === null) return units;
  const folded = first.fileHash === undefined ? first : {
    ...first,
    hash: first.fileHash,
    identityKey: first.fileHash,
    added,
    deleted,
    addedLines: units.flatMap((unit) => unit.addedLines),
    range: first.fileRange,
  };
  return [{ ...folded, body: Buffer.alloc(0), summaryOnly: reason }];
}

// The body cap (CHG-17, C:summary-only-files, Q19, M10) over a unit list sorted by path (one
// file's units are consecutive), after the reader's summary-only decision: in path order,
// the changed lines of the files that are not summary-only are summed; the first file taking
// the sum over 3000 and every later one keep each unit (own hash, range, counts,
// `addedLines`, `body`) with `capped: true`: the cap limits the worker's context, not the
// tool output (Q19), so the body stays for a split by ranges (CHG-20) and only M13 leaves
// its block out (review-CHG-17 Medium 2). The internal `blobs`, `fileHash` and `fileRange`
// are stripped.
function withBodyCap(units) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < units.length;) {
    let j = i + 1;
    while (j < units.length && units[j].path === units[i].path) j += 1;
    const file = units.slice(i, j).map(({ blobs, fileHash, fileRange, ...unit }) => unit);
    i = j;
    if (file[0].summaryOnly !== undefined) {
      out.push(...file);
      continue;
    }
    if (sum <= BODY_CAP_LINES) sum += file.reduce((total, unit) => total + unit.added + unit.deleted, 0);
    if (sum > BODY_CAP_LINES) out.push(...file.map((unit) => ({ ...unit, capped: true })));
    else out.push(...file);
  }
  return out;
}

// The `size` rule's sizes (CHG-17, KD-R87), read in the size pass: one `git diff -z --raw`
// call over the same `args` (and index) as the patch pass that follows (not the raw records
// at the head of the patch pass itself), so the reader decides summary-only per file while
// streaming instead of holding every body until a size read after the stream. It repeats
// the patch pass's `-M` rename detection (accepted, M10). Only a file no size-free rule (lockfile, minified, sourcemap, generated) already
// marks is sized: its new content off disk when the new side is the worktree (`worktree`),
// else its blob (the old one for a deletion), all through one `cat-file --batch-check`. A
// type change, symlink or submodule, a missing side, a non-UTF-8 path or an unreadable file
// gets no size (the `size` rule then never matches). Returns `sizeOf(unit)` for a unit of
// the patch pass: by path off disk, else by the blob ID of the unit's own `index` line (none
// without one, as for a pure rename).
async function bodyRuleSizes(args, { toplevel, env, now, indexPath }, attrs, worktree) {
  const out = await gitOk(
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '--no-abbrev', '-z', '--raw', ...args],
    { cwd: toplevel, env, now, readOnly: true, index: indexPath },
  );
  const records = [];
  readRaw(out, records);
  const byPath = new Map();
  const byOid = new Map();
  const oids = new Set();
  for (const record of records) {
    const path = utf8Path(record.pathBytes);
    if (path === null || record.status === 'T') continue;
    const modes = [record.oldMode, record.newMode];
    if (modes.includes(SYMLINK_MODE) || modes.includes(GITLINK_MODE)) continue;
    const generated = attrs.get(path)?.generated ?? false;
    if (summaryOnly(path, { added: 0, deleted: 0, generated, size: 0 }) !== null) continue;
    if (record.status !== 'D' && worktree) {
      try {
        const stat = lstatSync(join(toplevel, path));
        if (stat.isFile()) byPath.set(path, stat.size);
      } catch {
        // Unreadable: no size.
      }
      continue;
    }
    const oid = record.status === 'D' ? record.oldOid : record.newOid;
    if (oid && !ZERO_OID.test(oid)) oids.add(oid);
  }
  if (oids.size > 0) {
    const list = [...oids];
    const sizes = await gitOk(['cat-file', '--batch-check=%(objectsize)'], {
      cwd: toplevel, env, now, readOnly: true, input: Buffer.from(list.map((oid) => `${oid}\n`).join('')),
    });
    const lines = sizes.toString('utf8').split('\n');
    list.forEach((oid, i) => {
      if (/^\d+$/.test(lines[i] ?? '')) byOid.set(oid, Number(lines[i]));
    });
  }
  return (unit) => {
    if (unit.status === 'T' || unit.kind === 'symlink' || unit.kind === 'submodule') return undefined;
    if (unit.status !== 'D' && worktree) return byPath.get(unit.path);
    const oid = typeof unit.blobs === 'string' ? unit.blobs.split(' ')[unit.status === 'D' ? 0 : 1] : null;
    return oid ? byOid.get(oid) : undefined;
  };
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
  const state = { hash, box, counted: true, added: 0, deleted: 0, addedLines: [], newLine: hunk.new.start, prevLead: null };
  for (const line of hunk.lines.slice(1)) hashLine(state, line);
  return { added: state.added, deleted: state.deleted, addedLines: state.addedLines };
}

// One hunk line into `state` (`hashHunk`'s loop body, shared with a streamed section's
// `foldLine`): `hash`, `box`, the running `added`/`deleted`/`addedLines`, and the hunk's
// `newLine`/`prevLead`. `counted: false` (a type change's gitlink side) hashes the line but
// neither counts nor collects it.
function hashLine(state, line) {
  const lead = line[0];
  if (lead === PLUS || lead === MINUS) {
    state.hash.update(line);
    if (state.counted && lead === MINUS) state.deleted += 1;
    if (state.counted && lead === PLUS) {
      state.added += 1;
      const end = line[line.length - 1] === LF ? line.length - 1 : line.length;
      if (state.box.total <= SCAN_LIMIT) {
        state.addedLines.push({ line: state.newLine, text: LOSSY_UTF8.decode(line.subarray(1, end)) });
      }
      state.box.total += end;
    }
  } else if (lead === BACKSLASH && (state.prevLead === PLUS || state.prevLead === MINUS)) {
    state.hash.update(line);
  }
  if (lead === PLUS || lead === SPACE) state.newLine += 1;
  state.prevLead = lead;
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
