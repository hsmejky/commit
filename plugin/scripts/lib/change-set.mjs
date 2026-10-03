// M10 Change-set engine (docs/spec/modules-m10-m13.md, Q11): the inventory, the temporary
// index, units and the tree state. Effectful; spawns only through M2.
//
// INT-01 builds the `treeState` every reply ends with; CHG-04 adds `indexFingerprint` and
// M17's "N files left" rendering of that tree state. CHG-03 builds the tracer `inventory` (unstaged
// modifications of tracked files only), `snapshot` in `split` (one whole-file unit per
// modified file, diffed against HEAD) and `assignIds`; CHG-05 adds the temporary index,
// CHG-06 the streamed hunk-level pass, CHG-08 onward the other change kinds.

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
];

const NUL = 0x00;
const LF = 0x0a;
const COLON = 0x3a;
const AT = 0x40;
const PLUS = 0x2b;
const MINUS = 0x2d;
const BACKSLASH = 0x5c;
const SECTION_START = Buffer.from('diff --git ');
const HUNK_START = Buffer.from('@@ ');
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const BINARY_SNIFF_BYTES = 8000;
const BINARY_PATCH = Buffer.from('Binary files ');

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
  const paths = (await statusEntries({ toplevel, env, now })).map((entry) => entry.path);
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
 *   --name-status -z`; its `A` paths are the staged-new ones, a user's intent-to-add
 *   (`git add -N`) entries included (plain `diff --cached` hides them). A hidden
 *   staged-new path goes to `stagedExcluded`, the rest to `stagedNew` with `ignored`:
 *   listed by `git ls-files --cached --ignored
 *   --exclude-standard` (index entries an ignore rule matches; `git check-ignore` refuses
 *   M2's `GIT_LITERAL_PATHSPECS=1`).
 * - tracked: the `git status` entries that are neither untracked nor staged-new.
 * Unborn HEAD needs no special case: `diff --cached` then lists every index entry as `A`,
 * as C:untracked-files asks.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<{ clean: boolean, tracked: string[], preStaged: string[],
 *   candidates: Array<{ path: string, size: number, binary: boolean }>,
 *   hidden: { count: number, sample: string[] },
 *   stagedNew: Array<{ path: string, ignored: boolean }>,
 *   stagedExcluded: Array<{ path: string, reason: 'hidden' }> }>} `hidden.sample`: the first
 *   5 hidden untracked paths in UTF-8 byte order. `clean`: no tracked change, candidate or
 *   staged-new path (hidden-only and `stagedExcluded`-only trees are clean, C:plan).
 * @throws {Error} when a git call fails.
 */
export async function inventory({ toplevel, env, now }) {
  const opts = { cwd: toplevel, env, now, readOnly: true };
  const untracked = nulList(await gitOk(['ls-files', '--others', '--exclude-standard', '-z'], opts));
  const filtered = hideFilter(untracked);
  const candidates = filtered.candidates.map((path) => fileFacts(toplevel, path));
  const hidden = {
    count: filtered.hidden.length,
    sample: [...filtered.hidden].sort(byteOrder).slice(0, 5),
  };

  const cached = nulList(await gitOk(
    ['diff', '--cached', '--ita-visible-in-index', '--no-renames', '--name-status', '-z'], opts,
  ));
  const preStaged = [];
  const added = [];
  for (let i = 0; i + 1 < cached.length; i += 2) {
    preStaged.push(cached[i + 1]);
    if (cached[i] === 'A') added.push(cached[i + 1]);
  }
  const split = hideFilter(added);
  const stagedExcluded = split.hidden.map((path) => ({ path, reason: 'hidden' }));
  const ignored = new Set(split.candidates.length === 0 ? [] : nulList(
    await gitOk(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], opts),
  ));
  const stagedNew = split.candidates.map((path) => ({ path, ignored: ignored.has(path) }));

  const addedSet = new Set(added);
  const tracked = (await statusEntries({ toplevel, env, now }))
    .filter((entry) => entry.xy !== '??' && !addedSet.has(entry.path))
    .map((entry) => entry.path);
  return {
    clean: tracked.length === 0 && candidates.length === 0 && stagedNew.length === 0,
    tracked, preStaged, candidates, hidden, stagedNew, stagedExcluded,
  };
}

// A candidate's size and `binary` sniff: a NUL in its first 8000 bytes (only a regular
// file is read; anything else is not binary).
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
 * `Buffer` and the hash is taken over bytes, never over a decode.
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
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p'],
    { cwd: toplevel, env, now, readOnly: true, index: indexPath },
  );
  if (result.code !== 0) {
    throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  }
  return unitsFromDiff(result.stdout);
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

// Pure: builds the sorted whole-file units from one `git diff -z --raw -p` call's raw
// stdout bytes (the raw records and the patch sections, paired by position). Split out of
// `snapshot` so the pairing and `unitOf` logic can be exercised directly with a crafted
// buffer, without spawning git (KD-R1-style in-process test).
export function unitsFromDiff(output) {
  const { records, patchStart } = parseRaw(output);
  const sections = splitSections(output, patchStart);
  if (sections.length !== records.length) {
    throw new Error(`the diff has ${sections.length} patch sections for ${records.length} raw records`);
  }
  return records
    .map((record, i) => ({ pathBytes: record.pathBytes, unit: unitOf(record, sections[i]) }))
    .sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes))
    .map(({ unit }) => unit);
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

// One `git status --porcelain -z --untracked-files=all` call, as `{ xy, path }` entries.
async function statusEntries({ toplevel, env, now }) {
  const result = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
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
  const records = result.stdout.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === '') continue;
    entries.push({ xy: record.slice(0, 2), path: record.slice(3) });
    if (/[RC]/.test(record.slice(0, 2))) i += 1;
  }
  return entries;
}

// Reads the `--raw -z` records at the start of the output: `:<m1> <m2> <sha1> <sha2> <S>`,
// NUL, then the path and NUL (a rename or copy, `R`/`C`, has the old and then the new path).
// One more NUL ends the raw part when a patch follows.
function parseRaw(out) {
  const records = [];
  let pos = 0;
  const field = () => {
    const end = out.indexOf(NUL, pos);
    if (end === -1) throw new Error('a raw diff record is not NUL-terminated');
    const bytes = out.subarray(pos, end);
    pos = end + 1;
    return bytes;
  };
  while (pos < out.length && out[pos] === COLON) {
    const [oldMode, newMode, , , status] = field().toString('latin1').slice(1).split(' ');
    const paths = [field()];
    if (/^[RC]/.test(status)) paths.push(field());
    records.push({
      oldMode, newMode, status, pathBytes: paths[paths.length - 1],
      oldPathBytes: paths.length === 2 ? paths[0] : null,
    });
  }
  if (pos < out.length && out[pos] === NUL) pos += 1;
  return { records, patchStart: pos };
}

// Splits the patch text into sections at lines starting `diff --git `. Only the boundary is
// read: nothing is taken out of a section header.
function splitSections(out, start) {
  const starts = linesOf(out.subarray(start))
    .reduce((acc, line) => {
      if (startsWith(line, SECTION_START)) acc.starts.push(acc.offset);
      acc.offset += line.length;
      return acc;
    }, { starts: [], offset: start }).starts;
  if (start < out.length && starts[0] !== start) {
    throw new Error('the diff patch text does not start with a section');
  }
  return starts.map((s, i) => out.subarray(s, i + 1 < starts.length ? starts[i + 1] : out.length));
}

// Splits a buffer into lines, each keeping its `\n` (the last one may lack it).
function linesOf(buf) {
  const lines = [];
  for (let pos = 0; pos < buf.length;) {
    const nl = buf.indexOf(LF, pos);
    const end = nl === -1 ? buf.length : nl + 1;
    lines.push(buf.subarray(pos, end));
    pos = end;
  }
  return lines;
}

function startsWith(buf, prefix) {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

function decodePath(bytes) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new Error('a path that is not UTF-8 is not built yet (CHG-12)');
  }
}

// `M` (content edit), `A` (a new file from the temporary index's intent-to-add entries,
// old mode 000000) and `R<score>` (a rename, the score dropped) are built; every other
// status, a mode change and a non-regular entry throw for CHG-08/CHG-09.
function unitOf({ oldMode, newMode, status, pathBytes, oldPathBytes }, section) {
  const path = decodePath(pathBytes);
  const kind = status === 'M' || status === 'A' ? status : (/^R\d*$/.test(status) ? 'R' : null);
  if (kind === null) throw new Error(`a ${status} change (${path}) is not built yet (CHG-08)`);
  if (kind !== 'A' && oldMode !== newMode) throw new Error(`a mode change (${path}) is not built yet (CHG-08)`);
  if (newMode !== '100644' && newMode !== '100755') {
    throw new Error(`a ${newMode} entry (${path}) is not built yet (CHG-09)`);
  }
  const oldPath = kind === 'R' ? decodePath(oldPathBytes) : null;

  const lines = linesOf(section);
  const first = lines.findIndex((line) => startsWith(line, HUNK_START));
  const binary = () => new Error(`a section without a text hunk (${path}: binary) is not built yet (CHG-08)`);
  if (first === -1 && (kind === 'M' || lines.some((line) => startsWith(line, BINARY_PATCH)))) throw binary();

  const hash = createHash('sha256');
  if (kind === 'R') hash.update(oldPathBytes).update(Buffer.from([NUL]));
  hash.update(pathBytes).update(Buffer.from([NUL]));
  // An `A`/`R` section without a hunk: an empty new file or a pure rename (Q11).
  if (first === -1) {
    return {
      path, oldPath, status: kind, kind: 'text', hash: hash.digest('hex'),
      added: 0, deleted: 0, range: '-0,0 +0,0', body: Buffer.alloc(0),
    };
  }
  const hunks = [];
  let added = 0;
  let deleted = 0;
  let bodyStart = 0;
  // `\ No newline at end of file` (BACKSLASH) also follows an unchanged context line whose
  // last line lacks a trailing newline on both sides; it is hashed only when it follows a
  // `-`/`+` line, since context is otherwise excluded from the hash (Q11).
  let prevLead = null;
  lines.forEach((line, i) => {
    if (i < first) {
      bodyStart += line.length;
      return;
    }
    const lead = line[0];
    if (lead === AT) {
      const m = HUNK_HEADER.exec(line.toString('latin1'));
      if (m === null) throw new Error(`an unreadable hunk header in ${path}`);
      hunks.push({ old: side(m[1], m[2]), new: side(m[3], m[4]) });
    } else if (lead === PLUS || lead === MINUS) {
      hash.update(line);
      if (lead === PLUS) added += 1;
      if (lead === MINUS) deleted += 1;
    } else if (lead === BACKSLASH && (prevLead === PLUS || prevLead === MINUS)) {
      hash.update(line);
    }
    prevLead = lead;
  });
  return {
    path,
    oldPath,
    status: kind,
    kind: 'text',
    hash: hash.digest('hex'),
    added,
    deleted,
    range: rangeOf(hunks),
    body: Buffer.from(section.subarray(bodyStart)),
  };
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
