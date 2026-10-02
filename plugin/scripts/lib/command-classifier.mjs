// G3 Command classifier and deny catalogue (docs/spec/modules-shared-and-guard.md; C:guard
// Parsing steps 3-5, Precedence, Deny messages). Pure.
//
// A blanket result (G2) is the blanket deny. In each segment, a `git` token directly followed
// by a `commit` token is a commit: its arguments, read up to where git's arguments end, are
// checked to be literal, expanded and matched against the Q4 allowlist; every other flag or
// argument is the generic row naming it. An argument-appending wrapper (`xargs`, `parallel`)
// before `git` in the segment denies what would otherwise be allowed (the wrapper row), and
// the bare/`-m`/`-F`/`--message`/`--file` row applies only when nothing else matches. Git's
// own options before the subcommand, the specific rows and script calls (S2) follow in later
// slices.

/** C:guard `<route>`. It never names the `/commit` skill, which the model cannot invoke (Q2, Q8). */
export const ROUTE =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';

/** The fixed line every message holding the route ends with (Q8; nothing is detected). */
export const PERSONAL_SKILL_LINE = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';

const withPersonalLine = (text) => `${text}\n${PERSONAL_SKILL_LINE}`;

/** The deny catalogue rows built so far (C:guard Deny messages). */
export const MESSAGES = Object.freeze({
  bare: withPersonalLine(`Direct git commit is blocked. ${ROUTE}`),
  literalArguments: withPersonalLine(`Write git's arguments literally. ${ROUTE}`),
  blanket: withPersonalLine(
    'This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: '
      + ROUTE,
  ),
});

/**
 * The generic row (C:guard Deny messages, "any other flag or argument"), naming the flag.
 *
 * @param {string} flag
 * @returns {string}
 */
function genericMessage(flag) {
  return withPersonalLine(`git commit ${flag} is not allowed here. ${ROUTE}`);
}

/**
 * The wrapper row (C:guard step 3): an argument-appending wrapper before `git` in the segment.
 *
 * @param {string} wrapper
 * @returns {string}
 */
function wrapperMessage(wrapper) {
  return withPersonalLine(`git commit run by ${wrapper} is not allowed: it can append arguments. ${ROUTE}`);
}

// A `git` token: basename `git` or `git.exe` after the last `/` or `\`, case-insensitive.
const GIT = /(?:^|[/\\])git(?:\.exe)?$/i;
const COMMIT = /^commit$/i;
// An argument-appending wrapper (C:guard step 3): basename `xargs`, `gxargs` or `parallel`,
// optionally `.exe`, case-insensitive. It appends words from its input (or its own
// arguments) to the command it runs, so an allowlisted form under it may carry `-n` or `-m`.
const WRAPPER = /(?:^|[/\\])(xargs|gxargs|parallel)(?:\.exe)?$/i;

// The first wrapper among the tokens before `end`, by its lower-case name, or undefined.
function wrapperBefore(tokens, end) {
  for (let i = 0; i < end; i += 1) {
    const match = typeof tokens[i] === 'string' ? WRAPPER.exec(tokens[i]) : null;
    if (match !== null) return match[1].toLowerCase();
  }
  return undefined;
}

const isOp = (token, op) => typeof token === 'object' && token.op === op;

// C:guard step 4: git's arguments end at the segment's end, a `cut` token, a `)` token or,
// in PowerShell, a `}` token.
function endsArguments(token, shell) {
  return isOp(token, 'cut') || isOp(token, ')') || (shell === 'powershell' && isOp(token, '}'));
}

// C:guard step 4: a token the shell may turn into another word or into several arguments
// is not literal: a `(` or `{` token, a token holding `$`, a backtick, `{`, `(` or a glob
// character and, in PowerShell, one holding `,` or `@`, or equal to `--%`.
function isLiteral(token, shell) {
  if (typeof token !== 'string') return false;
  if (/[$`{(*?[]/.test(token)) return false;
  return !(shell === 'powershell' && (/[,@]/.test(token) || token === '--%'));
}

// `commit`'s short options that take a value: attached (`-mfoo`) or the next argument.
const SHORT_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);
// Short options whose optional value can only be attached (`-S<keyid>`, `-u<mode>`).
const SHORT_WITH_ATTACHED_VALUE = new Set(['S', 'u']);
// Long options whose value is the next argument when it is not attached with `=`. Only the
// ones the allowlist and the bare row read need to be known: any other long option is
// denied by its own name, ahead of whatever follows it.
const LONG_WITH_VALUE = new Set(['--message', '--file', '--fixup']);

/**
 * Expands `commit`'s arguments (C:guard step 5): `-am` → `-a -m`, `-mfoo` → `-m foo`,
 * `--opt=v` → `--opt v`. Each item is an option with its value, or a plain argument
 * (a pathspec, `--` and everything after it).
 *
 * @param {string[]} args
 * @returns {Array<{ flag: string, value?: string } | { argument: string }>}
 */
function expandCommitArgs(args) {
  const items = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      for (const rest of args.slice(i)) items.push({ argument: rest });
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) items.push({ flag: arg.slice(0, eq), value: arg.slice(eq + 1) });
      else if (LONG_WITH_VALUE.has(arg) && i + 1 < args.length) items.push({ flag: arg, value: args[(i += 1)] });
      else items.push({ flag: arg });
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j += 1) {
        const flag = `-${arg[j]}`;
        const rest = arg.slice(j + 1);
        if (SHORT_WITH_ATTACHED_VALUE.has(arg[j])) {
          items.push(rest ? { flag, value: rest } : { flag });
          break;
        }
        if (SHORT_WITH_VALUE.has(arg[j])) {
          if (rest) items.push({ flag, value: rest });
          else if (i + 1 < args.length) items.push({ flag, value: args[(i += 1)] });
          else items.push({ flag });
          break;
        }
        items.push({ flag });
      }
    } else {
      items.push({ argument: arg });
    }
  }
  return items;
}

// The bare/`-m`/`-F`/`--message`/`--file` row: it names no flag and applies last.
const BARE_ROW = new Set(['-m', '-F', '--message', '--file']);
const QUIET = new Set(['-q', '--quiet']);
// A `--fixup` value that opens an editor (`amend:`, `reword:`) is not the plain form.
const isPlainFixup = (item) =>
  item.flag === '--fixup' && item.value !== undefined && !/^(?:amend|reword):/.test(item.value);
// What each form allows besides itself. A flag that takes no value is outside the form when
// given one (`--no-edit=x`, `--quiet=x`).
const isQuiet = (item) => item.value === undefined && QUIET.has(item.flag);
const fitsNoEdit = (item) =>
  isQuiet(item) || (item.value === undefined && (item.flag === '--no-edit' || item.flag === '--amend'));
const fitsFixup = (item) => isQuiet(item) || isPlainFixup(item);

/**
 * The Q4 allowlist over expanded `commit` arguments: `--no-edit` with `--amend` and
 * `-q`/`--quiet`, or plain `--fixup=<commit>` with `-q`/`--quiet`. The form is set by the
 * first `--no-edit` or plain `--fixup` in argv order. Any item outside it is the generic row,
 * naming the first such item, except a bare-row option (and `-q`/`--quiet` with no form),
 * which gives the bare row only when nothing else matches (C:guard Precedence).
 *
 * @param {ReturnType<typeof expandCommitArgs>} items
 * @returns {string | null} the deny message, or null when the form is allowed.
 */
function allowlistDecision(items) {
  const form = items.find((item) => item.flag === '--no-edit' || isPlainFixup(item));
  if (form === undefined) {
    const other = items.find((item) => !BARE_ROW.has(item.flag) && !QUIET.has(item.flag));
    return other === undefined ? MESSAGES.bare : genericMessage(nameOf(other));
  }
  const fits = form.flag === '--no-edit' ? fitsNoEdit : fitsFixup;
  const other = items.find((item) => !fits(item) && !BARE_ROW.has(item.flag));
  if (other !== undefined) return genericMessage(nameOf(other));
  return items.some((item) => BARE_ROW.has(item.flag)) ? MESSAGES.bare : null;
}

// The name the generic row gives an item: its flag, or the argument (an empty one as `""`).
const nameOf = (item) => (item.flag !== undefined ? item.flag : item.argument || '""');

// One `git commit` invocation, its `git` token at `at` and its arguments starting at `start`
// (after `commit`): the deny message, or null when allowed. Every argument read must be
// literal (C:guard step 4). A wrapper before `git` denies what would otherwise be allowed or
// the bare row; its row ranks just above the bare row (C:guard Precedence).
function commitDecision(tokens, at, start, shell) {
  const args = [];
  for (let i = start; i < tokens.length && !endsArguments(tokens[i], shell); i += 1) {
    if (!isLiteral(tokens[i], shell)) return MESSAGES.literalArguments;
    args.push(tokens[i]);
  }
  const message = allowlistDecision(expandCommitArgs(args));
  if (message !== null && message !== MESSAGES.bare) return message;
  const wrapper = wrapperBefore(tokens, at);
  return wrapper === undefined ? message : wrapperMessage(wrapper);
}

/**
 * G3 `classify`: the guard's decision for G2's result.
 *
 * @param {Array<Array<string|object>> | { blanket: string }} parsed G2 `segments` output.
 * @param {{ agentType?: string, shell?: 'bash'|'powershell' }} [context]
 * @returns {{ decision: 'deny'|'none', message?: string, scriptCalls: object[] }}
 */
export function classify(parsed, context = {}) {
  const { shell = 'bash' } = context;
  if (!Array.isArray(parsed)) return { decision: 'deny', message: MESSAGES.blanket, scriptCalls: [] };
  for (const segment of parsed) {
    // Redirections are dropped with their target (C:guard step 2).
    const tokens = segment.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
    // Every `git` token is classified; the segment is denied when any of them is (step 3).
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const [token, next] = [tokens[i], tokens[i + 1]];
      if (typeof token === 'string' && GIT.test(token) && typeof next === 'string' && COMMIT.test(next)) {
        const message = commitDecision(tokens, i, i + 2, shell);
        if (message !== null) return { decision: 'deny', message, scriptCalls: [] };
      }
    }
  }
  return { decision: 'none', scriptCalls: [] };
}
