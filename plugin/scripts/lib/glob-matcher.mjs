// M7 Glob matcher (C:scanignore-globs). Pure: no I/O, no imports, no ambient state;
// every input arrives as an argument.
//
// A pattern compiles to one entry per `/`-separated segment; a path matches when it has as
// many segments and each one matches its entry. Within a segment, `*` is any run of
// characters (a segment never holds `/`, so `*` never crosses one); everything else is
// literal. Comparison is by UTF-16 code unit, so case-sensitive on every OS.

/**
 * @typedef {{ readonly segments: readonly (readonly string[])[] }} Matcher
 *   Opaque compiled pattern: per segment, its literal chunks split at `*`.
 */

/**
 * Compile a `scanIgnore` pattern into a matcher for `matches`.
 *
 * @param {string} pattern
 * @returns {{ ok: true, matcher: Matcher } | { ok: false, code: 'config' }}
 *   (the failure branch is the typed-result shape; no pattern takes it yet)
 */
export function compileGlob(pattern) {
  const segments = pattern.split('/').map((segment) => Object.freeze(segment.split('*')));
  return { ok: true, matcher: Object.freeze({ segments: Object.freeze(segments) }) };
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
  if (parts.length !== matcher.segments.length) {
    return false;
  }
  return matcher.segments.every((chunks, index) => segmentMatches(chunks, parts[index]));
}

// `chunks` is a segment split at `*`: one chunk means no `*` (an exact literal). Otherwise
// the first chunk is a prefix, the last a suffix, and each middle chunk is taken at its
// leftmost place after the previous one; leftmost is always safe, since it leaves the most
// room for what follows.
function segmentMatches(chunks, part) {
  if (chunks.length === 1) {
    return part === chunks[0];
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (part.length < first.length + last.length) {
    return false;
  }
  if (!part.startsWith(first) || !part.endsWith(last)) {
    return false;
  }
  let position = first.length;
  const end = part.length - last.length;
  for (let index = 1; index < chunks.length - 1; index += 1) {
    const found = part.indexOf(chunks[index], position);
    if (found === -1 || found + chunks[index].length > end) {
      return false;
    }
    position = found + chunks[index].length;
  }
  return true;
}
