// M7 Glob matcher (C:scanignore-globs). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument.
//
// A pattern compiles to its `/`-separated segments, cut into groups at each `**` segment.
// Within a segment, `*` is any run of characters and `?` exactly one (a segment never holds
// `/`, so neither crosses one); everything else is literal. Comparison is by UTF-16 code
// unit, so case-sensitive on every OS, and `?` stands for one code unit.
//
// Matching never backtracks: at both levels (chunks within a segment, groups within a path)
// each fixed-length piece between two wildcards is taken at its leftmost place, so a match
// costs O(pattern length * path length), linear in the path for a given pattern.

/**
 * @typedef {readonly string[]} Segment
 *   One pattern segment: its chunks split at `*` (`?` kept inside the chunks).
 * @typedef {{ readonly groups: readonly (readonly Segment[])[], readonly openEnd: boolean }} Matcher
 *   Opaque compiled pattern: its segments cut into groups at each `**` segment; `openEnd`
 *   when the pattern ends in `**`, which then takes at least one segment.
 */

/**
 * Compile a `scanIgnore` pattern into a matcher for `matches`.
 *
 * @param {string} pattern
 * @returns {{ ok: true, matcher: Matcher } | { ok: false, code: 'config' }}
 *   (the failure branch is the typed-result shape; no pattern takes it yet)
 */
export function compileGlob(pattern) {
  // A leading `/` is stripped (patterns are always relative to the repo root); a trailing
  // `/` means everything under that directory, the same as `dir/**`.
  const rooted = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const body = rooted.endsWith('/') ? `${rooted}**` : rooted;
  const groups = [[]];
  for (const segment of body.split('/')) {
    if (segment === '**') {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(Object.freeze(segment.split('*')));
    }
  }
  const openEnd = body === '**' || body.endsWith('/**');
  const matcher = { groups: Object.freeze(groups.map(Object.freeze)), openEnd };
  return { ok: true, matcher: Object.freeze(matcher) };
}

/**
 * Whether `path` (repo-relative, forward slashes) matches the whole compiled pattern.
 *
 * @param {Matcher} matcher
 * @param {string} path
 * @returns {boolean}
 */
export function matches(matcher, path) {
  const parts = path.split('/');
  const { groups } = matcher;
  const first = groups[0];
  if (groups.length === 1) {
    return parts.length === first.length && groupAt(first, parts, 0);
  }
  const last = groups[groups.length - 1];
  // A trailing `**` (then `last` is empty) matches what is under a directory, not the
  // directory itself: it keeps one segment back from the middle groups.
  const kept = matcher.openEnd ? 1 : 0;
  if (parts.length < first.length + last.length + kept) {
    return false;
  }
  if (!groupAt(first, parts, 0) || !groupAt(last, parts, parts.length - last.length)) {
    return false;
  }
  let position = first.length;
  const end = parts.length - last.length - kept;
  for (let index = 1; index < groups.length - 1; index += 1) {
    const found = findGroup(groups[index], parts, position, end);
    if (found === -1) {
      return false;
    }
    position = found + groups[index].length;
  }
  return true;
}

// The same leftmost scheme as within a segment, one level up: a group is a fixed run of
// segments between two `**`, so the first group is a prefix, the last a suffix, and each
// middle group is taken at its leftmost place after the previous one.
function groupAt(group, parts, start) {
  return group.every((chunks, index) => segmentMatches(chunks, parts[start + index]));
}

// Leftmost `start >= from` where `group` matches `parts` and ends by `end`, or -1.
function findGroup(group, parts, from, end) {
  for (let start = from; start + group.length <= end; start += 1) {
    if (groupAt(group, parts, start)) {
      return start;
    }
  }
  return -1;
}

// `chunks` is a segment split at `*`: one chunk means no `*` (a fixed-length piece).
// Otherwise the first chunk is a prefix, the last a suffix, and each middle chunk is taken
// at its leftmost place after the previous one; leftmost is always safe, since it leaves the
// most room for what follows.
function segmentMatches(chunks, part) {
  if (chunks.length === 1) {
    return part.length === chunks[0].length && chunkAt(chunks[0], part, 0);
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (part.length < first.length + last.length) {
    return false;
  }
  if (!chunkAt(first, part, 0) || !chunkAt(last, part, part.length - last.length)) {
    return false;
  }
  let position = first.length;
  const end = part.length - last.length;
  for (let index = 1; index < chunks.length - 1; index += 1) {
    const found = findChunk(chunks[index], part, position, end);
    if (found === -1) {
      return false;
    }
    position = found + chunks[index].length;
  }
  return true;
}

// Whether `chunk` matches `text` at `start`, `?` standing for any one code unit. The caller
// guarantees `start + chunk.length <= text.length`.
function chunkAt(chunk, text, start) {
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== '?' && chunk[index] !== text[start + index]) {
      return false;
    }
  }
  return true;
}

// Leftmost `start >= from` where `chunk` matches `text` and ends by `end`, or -1.
function findChunk(chunk, text, from, end) {
  if (!chunk.includes('?')) {
    const found = text.indexOf(chunk, from);
    return found === -1 || found + chunk.length > end ? -1 : found;
  }
  for (let start = from; start + chunk.length <= end; start += 1) {
    if (chunkAt(chunk, text, start)) {
      return start;
    }
  }
  return -1;
}
