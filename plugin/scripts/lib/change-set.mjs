// M10 Change-set engine (docs/spec/modules-m10-m13.md, Q11): the inventory, the temporary
// index, units and the tree state. Effectful; spawns only through M2.
//
// INT-01 builds the `treeState` every reply ends with; CHG-04 adds `indexFingerprint` and
// M17's "N files left" rendering of that tree state. CHG-03 builds the tracer `inventory` (unstaged
// modifications of tracked files only), `snapshot` in `split` (one whole-file unit per
// modified file, diffed against HEAD) and `assignIds`; CHG-05 adds the temporary index,
// CHG-06 the streamed hunk-level pass, CHG-08 onward the other change kinds.
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
 * The inventory (C:plan step 4, Q11). Read-only: four git calls, none writes the index.
 * - candidates: `git ls-files --others --exclude-standard -z` after `hideFilter`, each with
 *   its `lstat` size and `binary` (a NUL in the first 8000 bytes; `.gitattributes` is not
 *   read here, CHG-08/CHG-11).
 * - preStaged: every path of `git diff --cached --ita-visible-in-index --no-renames
 *   --name-status -z` but the intent-to-add ones (an empty index column, ` A` or ` D`
 *   when the worktree file is gone: no staged content); its `A` paths are the staged-new
 *   ones, a user's intent-to-add (`git add -N`) entries included (plain `diff --cached`
 *   hides them). A hidden staged-new path goes to `stagedExcluded`, the rest to
 *   `stagedNew` with `ignored`: listed by `git ls-files --cached --ignored
 *   --exclude-standard` (index entries an ignore rule matches; `git check-ignore`
 *   refuses M2's `GIT_LITERAL_PATHSPECS=1`).
 * - tracked: the `git status --untracked-files=no --no-renames` entries that are not
 *   staged-new (a rename's old path is its own deletion).
 * - caps (CHG-13): not this function's job. `collapsed` is always `[]` and `stagedExcluded`
 *   holds only the hidden entries here; the workflow calls M9 `applyCaps` itself, in `split`
 *   only, once the mode decision has counted these (pre-cap) lists (C:plan step 4 counts the
 *   mode decision's candidates "after the hidden rule and before the caps"; step 5 is the
 *   caps). `trackedDirectories` below is `applyCaps`'s third argument.
 * Unborn HEAD needs no other special case: `diff --cached` then lists every index entry as
 * `A`, as C:untracked-files asks.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<{ clean: boolean, tracked: string[], preStaged: string[],
 *   candidates: Array<{ path: string, size: number, binary: boolean }>,
 *   collapsed: Array<{ dir: string, count: number, bytes: number }>,
 *   hidden: { count: number, sample: string[] },
 *   stagedNew: Array<{ path: string, ignored: boolean }>,
 *   stagedExcluded: Array<{ path: string, reason: 'hidden' }
 *     | { dir: string, count: number, reason: 'collapsed' }>, notUtf8: string[] }>}
 *   `notUtf8` (CHG-12, Q11): every path of the three listings whose bytes are not valid
 *   UTF-8, left out of every other list (never a unit, never in the temporary index) and
 *   written by `escapeNonUtf8`, each once, in byte order, for `notIncluded` ("path is not
 *   UTF-8 — commit by hand"); like a hidden path it does not make the tree dirty. `hidden.sample`: the first
 *   5 hidden untracked paths in UTF-8 byte order. `clean`: no tracked change, candidate or
 *   staged-new path left (hidden-only trees are clean, C:plan; a caller that then collapses
 *   every remaining candidate and staged-new path away must recompute `clean`, since this
 *   function's own `clean` is pre-cap).
 * @throws {Error} when a git call fails.
 */
export async function inventory({ toplevel, env, now }) {
  const opts = { cwd: toplevel, env, now, readOnly: true };
  const notUtf8 = [];
  const untracked = nulFields(await gitOk(['ls-files', '--others', '--exclude-standard', '-z'], opts))
    .map((bytes) => utf8Path(bytes, notUtf8))
    .filter((path) => path !== null);
  const filtered = hideFilter(untracked);
  const candidates = candidateFacts(toplevel, filtered.candidates);
  const hidden = {
    count: filtered.hidden.length,
    sample: [...filtered.hidden].sort(byteOrder).slice(0, 5),
  };

  // `--no-renames`: a rename's old path is its own deletion, kept in `tracked` also when the
  // new path is staged-new or hidden (C:plan).
  const status = await statusEntries({ toplevel, env, now, untracked: 'no', renames: false, notUtf8 });
  // An intent-to-add entry (` A`: nothing in the index column) stages no content, so it is
  // staged-new but not pre-staged (C:plan).
  const intentToAdd = new Set(status.filter((entry) => entry.xy[0] === ' ').map((entry) => entry.path));
  const cached = nulFields(await gitOk(
    ['diff', '--cached', '--ita-visible-in-index', '--no-renames', '--name-status', '-z'], opts,
  ));
  const preStaged = [];
  const added = [];
  for (let i = 0; i + 1 < cached.length; i += 2) {
    const path = utf8Path(cached[i + 1], notUtf8);
    if (path === null) continue;
    if (!intentToAdd.has(path)) preStaged.push(path);
    if (cached[i].toString('latin1') === 'A') added.push(path);
  }
  const split = hideFilter(added);
  const stagedExcluded = split.hidden.map((path) => ({ path, reason: 'hidden' }));
  const ignored = new Set(split.candidates.length === 0 ? [] : nulList(
    await gitOk(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], opts),
  ));
  const stagedNew = split.candidates.map((path) => ({ path, ignored: ignored.has(path) }));

  const addedSet = new Set(added);
  const tracked = status
    .filter((entry) => !addedSet.has(entry.path))
    .map((entry) => entry.path);
  return {
    clean: tracked.length === 0 && candidates.length === 0 && stagedNew.length === 0,
    tracked, preStaged, candidates, collapsed: [], hidden, stagedNew, stagedExcluded,
    notUtf8: notUtf8List(notUtf8),
  };
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
 * `notUtf8` reports it).
 *
 * @param {{ mode: 'split', storedLists: { candidates: string[],
 *   stagedNew: Array<{ path: string, ignored: boolean }> }, indexPath: string,
 *   unborn: boolean, toplevel: string, env: object, now?: () => number }} options
 *   `storedLists`: the inventory's lists as stored in `state.json`; `indexPath`: the run
 *   folder's `git-index`.
 * @returns {Promise<Array<{ path: string, oldPath: string|null, status: 'M'|'A'|'R',
 *   kind: 'text', hash: string, added: number, deleted: number, range: string,
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
export async function snapshot({ mode, storedLists, indexPath, unborn, toplevel, env, now }) {
  if (mode !== 'split') throw new Error(`snapshot in ${mode} mode is not built yet (CHG-14, CHG-15)`);
  await buildTemporaryIndex({ storedLists, indexPath, unborn, toplevel, env, now });
  const reader = createDiffReader();
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p'],
    { cwd: toplevel, env, now, readOnly: true, index: indexPath, onStdout: (chunk) => reader.push(chunk) },
  );
  if (result.code !== 0) {
    throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  }
  return reader.end();
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
    throw Object.assign(
      new Error(`git add failed (${result.code}): ${result.stderr}`),
      { domainCode: 'git-failed' },
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
 * @returns {{ push: (chunk: Buffer) => void, end: () => object[] }} `push` throws on the
 *   first pairing error and is not called again; `end` flushes the last line, checks the
 *   section count and returns the units in `snapshot`'s shape and order.
 */
export function createDiffReader() {
  const records = [];
  const units = [];
  let raw = Buffer.alloc(0);
  let inPatch = false;
  let partial = [];
  let section = null;
  let sections = 0;

  const finishSection = () => {
    if (section !== null) units.push(...unitsOf(section));
    section = null;
  };
  const onLine = (line) => {
    if (startsWith(line, SECTION_START)) {
      finishSection();
      const record = records[sections];
      sections += 1;
      if (record === undefined) {
        throw new Error(`the diff has more patch sections than its ${records.length} raw records`);
      }
      if (!line.equals(sectionHeader(record))) {
        throw new Error(`patch section ${sections} does not match raw record ${sections} (${escapeNonUtf8(record.pathBytes)})`);
      }
      section = openSection(record);
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
 *
 * @param {Record<string, string>} idMap unit ID → hash, as stored in `state.json`.
 * @param {Array<{ hash: string }>} units
 * @returns {{ ok: true } | { ok: false, code: 'unmatched', unmatched: string[] }} the IDs
 *   whose hash is missing, in `idMap` order.
 */
export function matchIds(idMap, units) {
  const current = new Set(units.map((unit) => unit.hash));
  const unmatched = Object.keys(idMap).filter((id) => !current.has(idMap[id]));
  return unmatched.length === 0 ? { ok: true } : { ok: false, code: 'unmatched', unmatched };
}

// One `git <args> -z --raw -p` diff with the pinned options, streamed through the patch-pass
// reader into units (the same pass `snapshot` runs).
async function diffUnits(args, { toplevel, env, now }) {
  const reader = createDiffReader();
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p', ...args],
    { cwd: toplevel, env, now, readOnly: true, onStdout: (chunk) => reader.push(chunk) },
  );
  if (result.code !== 0) throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  return reader.end();
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
 * that the index diff against HEAD holds exactly the group's hashes.
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
  const staged = await diffUnits(['--cached'], { toplevel, env, now });
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
 * M10 `treeDiffUnits` (EXE-02, thin: CHG-20 adds the attribute-hidden `--text` pass and the
 * 1 MB scan limit): the units of the diff from `fromTree` (the expected HEAD, or `null` for
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
  const from = fromTree ?? (await gitOk(['hash-object', '-t', 'tree', '--stdin'], {
    cwd: toplevel, env, now, readOnly: true, input: Buffer.alloc(0),
  })).toString('utf8').trim();
  return diffUnits([from, toTree], { toplevel, env, now });
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
// untracked walk would only be discarded. `renames: false` adds `--no-renames` (git 2.18).
async function statusEntries({ toplevel, env, now, untracked, renames = true, notUtf8 }) {
  const args = ['status', '--porcelain', '-z', `--untracked-files=${untracked}`];
  if (!renames) args.push('--no-renames');
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
  // With `notUtf8`, an entry whose path is not valid UTF-8 is left out and its bytes
  // collected there (CHG-12); without it, the path is decoded lossily (a count only).
  const records = nulFields(result.stdout);
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const xy = records[i].toString('latin1', 0, 2);
    const bytes = records[i].subarray(3);
    if (/[RC]/.test(xy)) i += 1;
    const path = notUtf8 === undefined ? bytes.toString('utf8') : utf8Path(bytes, notUtf8);
    if (path !== null) entries.push({ xy, path });
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
// inventory reports such a path for `notIncluded` (its `notUtf8`).
const NOT_UTF8_SECTION = Object.freeze({ notUtf8: true });

// Opens a section for its raw record. `M` (content edit), `A` (a new file from the
// temporary index's intent-to-add entries, old mode 000000), `D` (a deleted file, new mode
// 000000) and `R<score>` (a rename, the score dropped) are built, with or without a mode
// change between 100644 and 100755 (CHG-08); every other status (`T`) and a non-regular
// entry (symlink, gitlink) throw for CHG-09.
function openSection({ oldMode, newMode, status, pathBytes, oldPathBytes }) {
  const path = utf8Path(pathBytes);
  const oldPath = oldPathBytes === null ? null : utf8Path(oldPathBytes);
  if (path === null || (oldPathBytes !== null && oldPath === null)) return NOT_UTF8_SECTION;
  const kind = /^[MAD]$/.test(status) ? status : (/^R\d*$/.test(status) ? 'R' : null);
  if (kind === null) throw new Error(`a ${status} change (${path}) is not built yet (CHG-09)`);
  for (const mode of [oldMode, newMode]) {
    if (mode !== NO_MODE && !REGULAR_MODES.has(mode)) {
      throw new Error(`a ${mode} entry (${path}) is not built yet (CHG-09)`);
    }
  }
  return {
    path,
    pathBytes,
    oldPath: kind === 'R' ? oldPath : null,
    oldPathBytes,
    status: kind,
    modes: (kind === 'M' || kind === 'R') && oldMode !== newMode ? `${oldMode} ${newMode}` : null,
    blobs: null,
    binary: false,
    hunks: [],
  };
}

// One patch line of an open section. The header lines before the first `@@` are dropped;
// only the `index` line (its blob IDs, full under `--full-index`) and a `Binary files` line
// are noted. Each hunk keeps its own lines, copied out of the chunk so no chunk stays
// referenced.
function sectionLine(section, line) {
  if (section === NOT_UTF8_SECTION) return;
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
// (`kind: "binary"`, also with a mode change: its body is none either way, C:plan-hunks).
// The whole-file hash opens with the section's one-letter status (`A`, `D`, `M` or `R`) and
// a NUL, so none of what follows can pass for another status's framing (CHG-08 decision:
// without the tag, a pure rename to a path spelled like a mode or blob marker — for example
// `mode 100644 100755` — hashes byte for byte the same as that marker's own unit, since both
// are just path bytes followed by NUL). After the tag: `[old path, NUL,] path, NUL`, then
// `mode <old> <new>` and a NUL for a mode change, then `blob <old> <new>` and a NUL (the
// `index` line's full blob IDs, all zeros on the missing side) for a binary, else the `-`/`+`
// lines (which start with `-`, `+` or `\`, never `m` or `b`).
function unitsOf(section) {
  if (section === NOT_UTF8_SECTION) return [];
  const { path, pathBytes, oldPath, oldPathBytes, status, modes, blobs, binary, hunks } = section;
  if (binary && blobs === null) throw new Error(`a binary section without an index line (${path})`);
  if (status === 'M' && !binary && modes === null && hunks.length === 0) {
    throw new Error(`a modified section without a hunk (${path})`);
  }
  const kind = binary ? 'binary' : (modes === null ? 'text' : 'mode');
  const base = { path, pathBytes, oldPath, status, kind };
  if (status === 'M' && kind === 'text') {
    const occurrences = new Map();
    return hunks.map((hunk) => {
      const identity = createHash('sha256').update(pathBytes).update(Buffer.from([NUL]));
      const counts = hashHunk(hunk, identity);
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
  if (modes !== null) whole.update(Buffer.from(`mode ${modes}\0`));
  if (binary) whole.update(Buffer.from(`blob ${blobs}\0`));
  const counts = { added: 0, deleted: 0, addedLines: [] };
  for (const hunk of hunks) {
    const one = hashHunk(hunk, whole);
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

// Feeds one hunk's `-`/`+` lines into `hash` and counts them. `\ No newline at end of file`
// (BACKSLASH) also follows an unchanged context line whose last line lacks a trailing
// newline on both sides; it is hashed only when it follows a `-`/`+` line, since context is
// otherwise excluded from the hash (Q11). `addedLines`: each `+` line's 1-based line number
// in the new file and its lossy decode without the `+` and `\n` (M10, for M8).
function hashHunk(hunk, hash) {
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
        addedLines.push({ line: newLine, text: LOSSY_UTF8.decode(line.subarray(1, end)) });
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
