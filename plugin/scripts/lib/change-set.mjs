// M10 Change-set engine (docs/spec/modules-m10-m13.md, Q11): the inventory, the temporary
// index, units and the tree state. Effectful; spawns only through M2.
//
// INT-01 builds the thinnest `treeState` the walking skeleton needs; CHG-04 completes it
// (the tree state every reply ends with). CHG-03 builds the tracer `inventory` (unstaged
// modifications of tracked files only), `snapshot` in `split` (one whole-file unit per
// modified file, diffed against HEAD) and `assignIds`; CHG-05 adds the temporary index,
// CHG-06 the streamed hunk-level pass, CHG-08 onward the other change kinds.

import { createHash } from 'node:crypto';
import { run } from './process-adapter.mjs';

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
 * The inventory (C:plan step 4). Tracer (CHG-03): only unstaged modifications of tracked
 * files (`git status` XY ` M`) are built. Any other entry (untracked, staged, deleted,
 * renamed, type change, unmerged) throws, for CHG-05, CHG-08 and CHG-14 to build.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<{ clean: boolean, tracked: string[] }>} `tracked`: the modified paths in
 *   `git status` order; `clean` when there are none.
 * @throws {Error} when `git status` fails, or on an entry kind not built yet.
 */
export async function inventory({ toplevel, env, now }) {
  const entries = await statusEntries({ toplevel, env, now });
  const unbuilt = entries.find((entry) => entry.xy !== ' M');
  if (unbuilt !== undefined) {
    throw new Error(
      `plan on a working tree with changes is not built yet: status ${JSON.stringify(unbuilt.xy)}`
      + ' (CHG-05, CHG-08, CHG-14)',
    );
  }
  const tracked = entries.map((entry) => entry.path);
  return { clean: tracked.length === 0, tracked };
}

/**
 * Takes the snapshot's units (Q11, M10). Tracer (CHG-03): `split` only, diffed against HEAD
 * (CHG-05 swaps in the temporary index), one whole-file unit per modified text file.
 *
 * One pinned `git diff -z --raw -p HEAD` call from the toplevel, with no pathspecs. Paths
 * come from the `--raw -z` records only, never from patch text (a header such as
 * `diff --git a/a b/c b/a b/c` is ambiguous); section *i* belongs to record *i*, and a count
 * mismatch is `internal` (C:plan-hunks). Output stays raw bytes: the body is a `Buffer`
 * and the hash is taken over bytes, never over a decode.
 *
 * @param {{ mode: 'split', toplevel: string, env: object, now?: () => number }} options
 * @returns {Promise<Array<{ path: string, oldPath: null, status: 'M', kind: 'text',
 *   hash: string, added: number, deleted: number, range: string, body: Buffer }>>} sorted
 *   by path in UTF-8 byte order (the user's `diff.orderFile` never decides the order, Q11).
 *   `hash`: SHA-256 hex over the path bytes, a NUL, then every hunk line starting `-` or `+`
 *   with its `\n`, plus a following `\` (`\ No newline at end of file`) line only when it
 *   follows one of those (no context, Q11; the `\` marker keeps a newline-at-EOF edit apart
 *   from the same lines with a newline, but one that follows an unchanged context line is
 *   excluded like the rest of that context). `added`/`deleted`: the
 *   `+`/`-` hunk lines. `range`: the hunk header's ranges for one hunk, else the span
 *   enclosing every hunk. `body`: the section's bytes from its first `@@` line on.
 * @throws {Error} when the diff fails, the sections do not pair with the records, or on a
 *   change kind not built yet (anything but a content edit of a regular text file).
 */
export async function snapshot({ mode, toplevel, env, now }) {
  if (mode !== 'split') throw new Error(`snapshot in ${mode} mode is not built yet (CHG-14, CHG-15)`);
  const result = await run(
    'git',
    [...PINNED_CONFIG, 'diff', ...PINNED_DIFF_OPTIONS, '-z', '--raw', '-p', 'HEAD'],
    { cwd: toplevel, env, now },
  );
  if (result.code !== 0) {
    throw new Error(`git diff failed (${result.code}): ${result.stderr}`);
  }
  return unitsFromDiff(result.stdout);
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
    records.push({ oldMode, newMode, status, pathBytes: paths[paths.length - 1] });
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

function unitOf({ oldMode, newMode, status, pathBytes }, section) {
  let path;
  try {
    path = STRICT_UTF8.decode(pathBytes);
  } catch {
    throw new Error('a path that is not UTF-8 is not built yet (CHG-12)');
  }
  if (status !== 'M') throw new Error(`a ${status} change (${path}) is not built yet (CHG-08)`);
  if (oldMode !== newMode) throw new Error(`a mode change (${path}) is not built yet (CHG-08)`);
  if (newMode !== '100644' && newMode !== '100755') {
    throw new Error(`a ${newMode} entry (${path}) is not built yet (CHG-09)`);
  }

  const lines = linesOf(section);
  const first = lines.findIndex((line) => startsWith(line, HUNK_START));
  if (first === -1) {
    throw new Error(`a section without a text hunk (${path}: binary) is not built yet (CHG-08)`);
  }

  const hash = createHash('sha256').update(pathBytes).update(Buffer.from([NUL]));
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
    oldPath: null,
    status: 'M',
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
