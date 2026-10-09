// S2 ScriptCall (docs/spec/modules-shared-and-guard.md; C:guard Script call). Pure, imports
// nothing. The definition of a script call, in two widths: `recognise` reads one from a G2
// segment widely, for the guard's denies and heartbeat only; `named` scans wider still, for
// the worker-only rule; `build` emits the one narrow
// quoted form every handback and worker runs and the caller's shape check accepts (Q16,
// Q23, Q25).

/** The fixed subcommand list of a script call (C:guard Script call). */
export const SUBCOMMANDS = Object.freeze(['plan', 'check', 'commit', 'release', 'infer']);

const NODE = new Set(['node', 'node.exe']);
const ENTRY = 'commit.cjs';
// A word `build` may append: the step 2 exemption's word characters (C:guard step 2).
const WORD = /^[A-Za-z0-9._:=-]+$/;
// A Windows absolute path: a drive letter then a separator, or a UNC `\\` or `//` start.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
// A character the step 2 exemption keeps out of the quoted path: a double quote of either
// shell (`"`, U+201C-U+201E), `$`, a backtick, `!` or a control character (C:guard step 2).
const PATH_REFUSED = /["“”„$`!\x00-\x1F\x7F]/;

// The part of a token after its last `/` or `\`, in both shells (C:guard Script call).
function basename(token) {
  return token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
}

// Leading words skipped before `node`: they cannot change what node runs (C:guard Script
// call). Bash's `{` group opener and `!`, `time` (with `-p`), PowerShell's `&` and `.` call
// operators; a `(` or `{` operator token is skipped too. Never an assignment or a runner
// (`X=1`, `env`, `command`, `exec`): those can.
const PREFIX = new Set(['{', '!', 'time', '&', '.']);

// The index of the first word after the leading prefixes and group openers.
function afterPrefix(words) {
  let i = 0;
  for (;;) {
    const word = words[i];
    if (typeof word === 'object' && (word.op === '(' || word.op === '{')) i += 1;
    else if (PREFIX.has(word)) i += word === 'time' && words[i + 1] === '-p' ? 2 : 1;
    else return i;
  }
}

/**
 * S2 `recognise`: the script call a segment holds, or null. The wide recogniser, used for
 * the worker-only rule and the heartbeat only (C:guard Script call): a segment is a script
 * call when, after any leading prefixes and group openers (`afterPrefix`), a token has the
 * basename `node` or `node.exe`, the next one the basename `commit.cjs`, both compared
 * case-insensitively, and the one after that is a subcommand of the fixed list, compared
 * exactly; all after quote removal (G2 already removed the quotes). Redirections are dropped
 * with their target; the arguments are the words after the subcommand up to the first
 * operator token (`(`, `)`, `{`, `}`, `cut`).
 *
 * @param {Array<string|object>} tokens one G2 segment.
 * @returns {{ subcommand: string, args: string[] } | null}
 */
export function recognise(tokens) {
  const words = tokens.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
  let i = afterPrefix(words);
  const [runner, script, subcommand] = words.slice(i, i + 3);
  if (typeof runner !== 'string' || !NODE.has(basename(runner).toLowerCase())) return null;
  if (typeof script !== 'string' || basename(script).toLowerCase() !== ENTRY) return null;
  if (typeof subcommand !== 'string' || !SUBCOMMANDS.includes(subcommand)) return null;
  const args = [];
  for (i += 3; i < words.length && typeof words[i] === 'string'; i += 1) args.push(words[i]);
  return { subcommand, args };
}

/**
 * S2 `named`: the subcommands that directly follow a token naming the entry point, in a G2
 * segment. The worker-only rule's own wider, fail-closed scan (C:guard Worker-only rule):
 * any word with the basename `commit.cjs`, compared case-insensitively, wherever it stands,
 * whatever word starts the command (an assignment, a runner, a keyword, `--`, `cmd /c`);
 * the next word counts when it is a subcommand of the fixed list, compared exactly.
 * Redirections are dropped with their target, as in `recognise`.
 *
 * @param {Array<string|object>} tokens one G2 segment.
 * @returns {string[]}
 */
export function named(tokens) {
  const words = tokens.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
  const found = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const [word, next] = [words[i], words[i + 1]];
    if (typeof word !== 'string' || basename(word).toLowerCase() !== ENTRY) continue;
    if (typeof next === 'string' && SUBCOMMANDS.includes(next)) found.push(next);
  }
  return found;
}

/**
 * S2 `build`: the one quoted form of a script call, `node "<path>" <subcommand> <args…>`,
 * which the anchored README allow rules match and C:guard's step 2 exemption covers. The
 * path is absolute; a Windows path (a drive letter or a UNC start) has its `\` separators
 * converted to `/`, while a `\` in a POSIX path is kept (the entry point refuses that install
 * path with `env`). Nothing is escaped: a path holding a character the exemption keeps out of
 * the quoted path throws, so the output is always in the exemption form (the entry point
 * refuses most of them earlier, C:cli `env`).
 *
 * @param {{ scriptPath: string, subcommand: string, args?: string[] }} call
 * @returns {string}
 * @throws {TypeError} for a path that is not an absolute path to `commit.cjs` or holds a
 *   character outside the exemption's quoted path, a subcommand outside the fixed list, or
 *   an argument outside the exemption's word characters.
 */
export function build({ scriptPath, subcommand, args = [] }) {
  const windows = WINDOWS_ABSOLUTE.test(scriptPath);
  if (!windows && !scriptPath.startsWith('/')) throw new TypeError(`not an absolute path: ${scriptPath}`);
  const quoted = windows ? scriptPath.replaceAll('\\', '/') : scriptPath;
  if (!quoted.endsWith(`/${ENTRY}`)) throw new TypeError(`not the commit entry point: ${scriptPath}`);
  if (PATH_REFUSED.test(quoted)) throw new TypeError(`a path character outside the exemption form: ${JSON.stringify(scriptPath)}`);
  if (!SUBCOMMANDS.includes(subcommand)) throw new TypeError(`not a script-call subcommand: ${subcommand}`);
  for (const arg of args) {
    if (!WORD.test(arg)) throw new TypeError(`not a plain script-call word: ${JSON.stringify(arg)}`);
  }
  return [`node "${quoted}"`, subcommand, ...args].join(' ');
}

/**
 * RPL-08 (C:cli-and-exit-codes `env`, C:reply-and-handback `run`): the `env` refusal message for
 * an install path `build` could not emit unescaped, or null. Checked on the path with Windows
 * separators converted to `/` (the form `build` emits), so a native Windows path is not
 * refused for its separators; a `\` left after the conversion is part of a POSIX file name.
 * Besides `build`'s own forbidden characters, `\` is refused here.
 *
 * @param {string} scriptPath the entry point's own path.
 * @returns {string | null}
 */
export function installPathRefusal(scriptPath) {
  const quoted = WINDOWS_ABSOLUTE.test(scriptPath) ? scriptPath.replaceAll('\\', '/') : scriptPath;
  if (!PATH_REFUSED.test(quoted) && !quoted.includes('\\')) return null;
  return 'the install path of commit.cjs holds a character a shell would read specially ($, a backtick, '
    + '", \\, a typographic double quote, ! or a control character); install the plugin under a '
    + 'path without one';
}
