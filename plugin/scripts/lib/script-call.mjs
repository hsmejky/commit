// S2 ScriptCall (docs/spec/modules-shared-and-guard.md; C:guard Script call). Pure, imports
// nothing. The single definition of a script call: `recognise` reads one from a G2 segment,
// `build` emits the one quoted form every handback and worker runs (Q16, Q23, Q25).

/** The fixed subcommand list of a script call (C:guard Script call). */
export const SUBCOMMANDS = Object.freeze(['plan', 'check', 'commit', 'release', 'infer']);

const NODE = new Set(['node', 'node.exe']);
const ENTRY = 'commit.cjs';
// A word `build` may append: the step 2 exemption's word characters (C:guard step 2).
const WORD = /^[A-Za-z0-9._:=-]+$/;
// A Windows absolute path: a drive letter then a separator, or a UNC `\\` or `//` start.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

// The part of a token after its last `/` or `\`, in both shells (C:guard Script call).
function basename(token) {
  return token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
}

/**
 * S2 `recognise`: the script call a segment holds, or null. A segment is a script call when
 * its first token (optionally after `&`) has the basename `node` or `node.exe`, the next one
 * the basename `commit.cjs`, and the one after that is a subcommand of the fixed list, all
 * compared after quote removal (G2 already removed the quotes). Redirections are dropped
 * with their target; the arguments are the words after the subcommand up to the first
 * operator token (`(`, `)`, `{`, `}`, `cut`).
 *
 * @param {Array<string|object>} tokens one G2 segment.
 * @returns {{ subcommand: string, args: string[] } | null}
 */
export function recognise(tokens) {
  const words = tokens.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
  let i = words[0] === '&' ? 1 : 0;
  const [runner, script, subcommand] = words.slice(i, i + 3);
  if (typeof runner !== 'string' || !NODE.has(basename(runner))) return null;
  if (typeof script !== 'string' || basename(script) !== ENTRY) return null;
  if (typeof subcommand !== 'string' || !SUBCOMMANDS.includes(subcommand)) return null;
  const args = [];
  for (i += 3; i < words.length && typeof words[i] === 'string'; i += 1) args.push(words[i]);
  return { subcommand, args };
}

/**
 * S2 `build`: the one quoted form of a script call, `node "<path>" <subcommand> <args…>`,
 * which the anchored README allow rules match and C:guard's step 2 exemption covers. The
 * path is absolute; a Windows path (a drive letter or a UNC start) has its `\` separators
 * converted to `/`, while a `\` in a POSIX path is kept (the entry point refuses that install
 * path with `env`). Nothing is escaped: the entry point refuses an install path holding a
 * character a shell would expand or mangle (C:cli `env`).
 *
 * @param {{ scriptPath: string, subcommand: string, args?: string[] }} call
 * @returns {string}
 * @throws {TypeError} for a path that is not an absolute path to `commit.cjs`, a subcommand
 *   outside the fixed list, or an argument outside the exemption's word characters.
 */
export function build({ scriptPath, subcommand, args = [] }) {
  const windows = WINDOWS_ABSOLUTE.test(scriptPath);
  if (!windows && !scriptPath.startsWith('/')) throw new TypeError(`not an absolute path: ${scriptPath}`);
  const quoted = windows ? scriptPath.replaceAll('\\', '/') : scriptPath;
  if (!quoted.endsWith(`/${ENTRY}`)) throw new TypeError(`not the commit entry point: ${scriptPath}`);
  if (!SUBCOMMANDS.includes(subcommand)) throw new TypeError(`not a script-call subcommand: ${subcommand}`);
  for (const arg of args) {
    if (!WORD.test(arg)) throw new TypeError(`not a plain script-call word: ${JSON.stringify(arg)}`);
  }
  return [`node "${quoted}"`, subcommand, ...args].join(' ');
}
