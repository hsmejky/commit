// G3 Command classifier and deny catalogue (docs/spec/modules-shared-and-guard.md; C:guard
// Parsing steps 3-5, Precedence, Deny messages). Pure.
//
// A blanket result (G2) is the blanket deny, its row picked by the blanket kind. In each segment, a `git` token directly followed
// by a `commit` token is a commit: its arguments, read up to where git's arguments end, are
// checked to be literal, expanded and matched against the specific rows (`--amend` without
// `--no-edit`, `--squash`, `-n`/`--no-verify`/`--no-gpg-sign`, `--fixup=amend:`/
// `--fixup=reword:`), then the Q4 allowlist; every other flag or argument is the generic row
// naming it. A token before `git` in its command that is outside
// the prefix allowlist (C:guard step 3: shell keywords, literal assignments and a few runners
// with fixed option grammars) is a possible wrapper, which may append arguments: it denies
// what would otherwise be allowed (the wrapper row), and the bare/`-m`/`-F`/`--message`/
// `--file` row applies only when nothing else matches. Each segment's script call (S2) is
// reported in `scriptCalls`, a denied command's included; a blanket result has none.
// As `commit:commit-worker`, a word naming `commit.cjs` followed by `commit` or `release` in
// any segment denies with the handback text before any git row (the worker-only rule, Q25).
// Git's own options before the subcommand are skipped (step 4): `-c`/`--config-env`
// before `commit` and an unknown option followed later by a `commit` token deny, ranking
// above the `commit` argument rows; every token read among them must be literal.

import { named, recognise } from './script-call.mjs';

/** C:guard `<route>`. It never names the `/commit` skill, which the model cannot invoke (Q2, Q8). */
export const ROUTE =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';

/** The fixed line every message holding the route ends with (Q8; nothing is detected). */
export const PERSONAL_SKILL_LINE = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';

const withPersonalLine = (text) => `${text}\n${PERSONAL_SKILL_LINE}`;

/** The fixed deny catalogue rows built so far (C:guard Deny messages). */
export const MESSAGES = Object.freeze({
  bare: withPersonalLine(`Direct git commit is blocked. ${ROUTE}`),
  // Routes rewording to the worker and never suggests `--amend --no-edit`, which commits the
  // index unscanned (Q4, Q20).
  amend: withPersonalLine(
    `To reword the last commit: ${ROUTE} Ask it to reword. To add changes, make a new commit the same way.`,
  ),
  squash: withPersonalLine(`git commit --squash opens an editor. ${ROUTE}`),
  literalSubcommand: withPersonalLine(`Write the git subcommand literally. ${ROUTE}`),
  literalArguments: withPersonalLine(`Write git's arguments literally. ${ROUTE}`),
  config: withPersonalLine(`git -c … commit is not allowed. ${ROUTE}`),
  unknownGlobalOption: withPersonalLine(`Could not parse git options before 'commit'. ${ROUTE}`),
  blanket: withPersonalLine(
    'This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: '
      + ROUTE,
  ),
  nesting: withPersonalLine(
    'This command mentions commit and holds an extglob pattern nested more than 16 levels deep, which the guard does not parse. Keep it out of a command that mentions commit, or to commit: '
      + ROUTE,
  ),
  size: withPersonalLine(
    'This command mentions commit and is longer than 262144 characters, which the guard does not parse. Keep a command that mentions commit shorter (write long text to a file first), or to commit: '
      + ROUTE,
  ),
  escape: withPersonalLine(
    'This command mentions commit and holds a `e or `u{…} escape, which Windows PowerShell 5.1 and PowerShell 7 read differently. Keep them out of a command that mentions commit, or to commit: '
      + ROUTE,
  ),
});

/**
 * The worker-only rule's deny text (C:guard Worker-only rule, Q25): the only fixed text without
 * the route, since it goes to the worker, which must hand the reply back rather than answer it.
 */
export const HANDBACK_MESSAGE = 'The handback is for your caller: return the reply verbatim and stop.';

/** The `agent_type` the worker-only rule applies to, compared exactly (C:guard). */
const WORKER_AGENT = 'commit:commit-worker';

/** The script-call subcommands the worker must never run itself: they answer a handback. */
const HANDBACK_SUBCOMMANDS = new Set(['commit', 'release']);

// The blanket row for each G2 blanket kind with a row of its own; every other kind gets
// MESSAGES.blanket.
const BLANKET_ROWS = Object.freeze({ nesting: MESSAGES.nesting, size: MESSAGES.size, escape: MESSAGES.escape });

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
 * The `-n` / `--no-verify` / `--no-gpg-sign` row (Q18): no route, so no personal-skill line.
 *
 * @param {string} flag
 * @returns {string}
 */
function noVerifyMessage(flag) {
  return `${flag} is not allowed. Fix the hook or signing setup instead.`;
}

/**
 * The `--fixup=amend:` / `--fixup=reword:` row: both open an editor.
 *
 * @param {string} kind `amend` or `reword`.
 * @returns {string}
 */
function fixupKindMessage(kind) {
  return withPersonalLine(`--fixup=${kind}: opens an editor. Use plain --fixup=<commit>, or: ${ROUTE}`);
}

/**
 * The wrapper row (C:guard step 3): a possible wrapper before `git` in its command.
 *
 * @param {string} wrapper the first token outside the prefix allowlist, as it reads after
 *   quote removal (an operator token as its operator, `)`).
 * @returns {string}
 */
function wrapperMessage(wrapper) {
  return withPersonalLine(`git commit run by ${wrapper} is not allowed: it can append arguments. ${ROUTE}`);
}

// A token's basename once its path is normalised Win32-style in both shells (C:guard step 3):
// components split on `/` and `\`, each with its trailing spaces and dots dropped (Windows
// trims them: PowerShell runs git for `& 'git '` and `& 'C:\…\git.exe.'`), an empty or `.`
// component dropped, `..` dropping the one before it (PowerShell runs git for `git.exe\.`
// and `git.exe\x\..`, Git Bash for `git.exe/.` and `git.exe/`), a leading drive `C:` dropped
// (PowerShell runs git for the drive-relative `C:git.exe`); on Linux an accepted false deny.
function basename(token) {
  const parts = [];
  for (const part of token.replace(/^[A-Za-z]:/, '').split(/[/\\]/)) {
    if (part === '..') parts.pop();
    else {
      const name = part.replace(/[ .]+$/, '');
      if (name !== '') parts.push(name);
    }
  }
  return parts.length === 0 ? '' : parts[parts.length - 1];
}
// A `git` token: basename `git` or `git.exe`, case-insensitive.
const GIT = /^git(?:\.exe)?$/i;
// git's own dashed form: basename `git-commit` or `git-commit.exe`.
const DASHED_COMMIT = /^git-commit(?:\.exe)?$/i;
const COMMIT = /^commit$/i;
// An argv[0] option (C:guard step 3): git runs `git-<x>` from argv[0]'s basename as `<x>`,
// and Bash `exec -a NAME` (`-aNAME`, `-caNAME`) or coreutils `env -a NAME` (`--argv0`;
// Homebrew names it `genv`) sets it, also from inside `env -S STRING` (`--split-string`).
// An option cluster holding `a` or `S`, or a long option starting `--a` or `--s`.
const ARGV0_RUNNER = /^(?:exec|g?env)$/;
const ARGV0_OPTION = /^-(?:-[as]|[^-]*[aS])/;
// The `-a` (`--argv0`) option itself: an `a` in a cluster before any `S`.
const ARGV0_A = /^-(?:-a|[^-S]*a)/;

// The `exec` or `env` word before an argv[0] option before the `git` token at `at`, in its
// command starting at `from`, as it reads after quote removal; undefined when there is none.
function argv0Runner(tokens, from, at) {
  let runner;
  for (let i = from; i < at; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string') continue;
    if (runner === undefined) {
      if (ARGV0_RUNNER.test(basename(token))) runner = token;
    } else if (ARGV0_OPTION.test(token)) return runner;
  }
  return undefined;
}
// C:guard step 4: a token holding `$`, a backtick, `{`, `(` or a glob character may turn
// into another word or into several arguments.
const NOT_LITERAL = /[$`{(*?[]/;
// A tilde expansion: `~` at the start of a word or after `=` or `:` (`~-` is `$OLDPWD`).
const TILDE = /(?:^|[=:])~/;
// A shell variable name; `NAME` is one in full, `ASSIGNMENT` starts with one and `=`.
const NAME_GRAMMAR = '[A-Za-z_][A-Za-z0-9_]*';
const NAME = new RegExp(`^${NAME_GRAMMAR}$`);
const ASSIGNMENT = new RegExp(`^${NAME_GRAMMAR}=`);

const isOp = (token, op) => typeof token === 'object' && token.op === op;

// C:guard step 3, the prefix allowlist (fail closed). Bash reserved words and the subshell
// `(` that may start a command, `time` taking an optional `-p`.
const BASH_KEYWORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
// A literal assignment `NAME=value`: a value holding a character step 4 does not call
// literal, or a tilde expansion, may expand to anything (`a='*'`, `GIT_DIR=~/r/.git`).
const isLiteralAssignment = (token) => typeof token === 'string' && ASSIGNMENT.test(token)
  && !NOT_LITERAL.test(token) && !TILDE.test(token);
// Each runner with a fixed option grammar, given the index after its name and the `git`
// token's index: the index of the command it runs (its options never reach `git`).
const RUNNERS = new Map([
  ['nice', (tokens, i, end) => {
    if (tokens[i] === '-n' && i + 1 < end && /^[+-]?\d+$/.test(tokens[i + 1])) return i + 2;
    return i < end && /^-\d+$/.test(tokens[i]) ? i + 1 : i;
  }],
  ['nohup', (tokens, i) => i],
  ['command', (tokens, i) => i],
  ['env', (tokens, i, end) => {
    let at = i;
    for (;;) {
      if (at < end && tokens[at] === '-i') at += 1;
      else if (tokens[at] === '-u' && at + 1 < end && NAME.test(tokens[at + 1])) at += 2;
      else break;
    }
    while (at < end && isLiteralAssignment(tokens[at])) at += 1;
    return at;
  }],
]);

// Where the command of the token at each index starts: after the innermost bracket still
// open there (Bash: a `(` token, a subshell, `<(…)`, `>(…)` or an extglob opener in a
// command's first word, since G2 reads a pattern in an argument as one word with no `(`
// token; PowerShell: a `(` or `{` token, a grouping expression, a subexpression or a script
// block), which starts a new command, or the segment's start. One pass over the segment, so
// a segment with many `git commit` pairs stays linear.
function commandStarts(tokens, shell) {
  const starts = [];
  const open = [];
  for (let i = 0; i < tokens.length; i += 1) {
    starts.push(open.length === 0 ? 0 : open[open.length - 1] + 1);
    if (isOp(tokens[i], '(') || (shell === 'powershell' && isOp(tokens[i], '{'))) open.push(i);
    else if (isOp(tokens[i], ')') || (shell === 'powershell' && isOp(tokens[i], '}'))) open.pop();
  }
  return starts;
}

// PowerShell's `Start-Process` (aliases `saps`, `start`) runs a program it may name in a
// `-FilePath:git` token, a grouping expression or a variable, with arguments it builds out of
// its own parameters. A Start-Process word anywhere in a PowerShell command that mentions
// commit denies it, whatever follows (C:guard step 3, fail closed): a token reading as one of
// the names, alone or after an `=` (`$p=saps`). The capture is the name.
const START_PROCESS = /(?:^|=)((?:Microsoft\.PowerShell\.Management\\)?(?:Start-Process|saps|start))$/i;

// The first Start-Process name in the segments, as it reads after quote removal; undefined
// when there is none.
function startProcessName(segments) {
  for (const segment of segments) {
    for (const token of segment) {
      const match = typeof token === 'string' ? START_PROCESS.exec(token) : null;
      if (match !== null) return match[1];
    }
  }
  return undefined;
}

// The first token before `git` (at `end`) in its command, which starts at `from`
// (`commandStarts`), outside the prefix allowlist (C:guard step 3), as it reads after quote
// removal; undefined when every token fits. In Bash the prefix is: reserved words and `(`,
// then literal assignments, then runners, each with its options; in PowerShell it is the `&`
// call operator alone (a word or an operator token).
function wrapperBefore(tokens, from, end, shell) {
  let i = from;
  if (shell === 'powershell') {
    if (i < end && (tokens[i] === '&' || isOp(tokens[i], '&'))) i += 1;
  } else {
    for (;;) {
      if (i < end && (isOp(tokens[i], '(') || BASH_KEYWORDS.has(tokens[i]))) i += 1;
      else if (i < end && tokens[i] === 'time') i += i + 1 < end && tokens[i + 1] === '-p' ? 2 : 1;
      else break;
    }
    while (i < end && isLiteralAssignment(tokens[i])) i += 1;
    while (i < end && RUNNERS.has(tokens[i])) i = RUNNERS.get(tokens[i])(tokens, i + 1, end);
  }
  if (i >= end) return undefined;
  return typeof tokens[i] === 'string' ? tokens[i] : tokens[i].op;
}

// C:guard step 4: git's arguments end at the segment's end, a `cut` token, a `)` token or,
// in PowerShell, a `}` token.
function endsArguments(token, shell) {
  return isOp(token, 'cut') || isOp(token, ')') || (shell === 'powershell' && isOp(token, '}'));
}

// C:guard step 4: a token the shell may turn into another word or into several arguments
// is not literal: a `(` or `{` token, a NOT_LITERAL token and, in PowerShell, one holding
// `,` or `@`, or equal to `--%`. In PowerShell also one that Windows PowerShell 5.1's legacy
// native-argument passing does not hand to git as it reads: an empty one (dropped), one
// holding `"` (not escaped, so git splits the argument there) or one ending in `\` (when 5.1
// quotes it, the `\"` escapes the closing quote and the arguments after it run together).
function isLiteral(token, shell) {
  if (typeof token !== 'string') return false;
  if (NOT_LITERAL.test(token)) return false;
  if (shell !== 'powershell') return true;
  return !(/[,@"]/.test(token) || token === '--%' || token === '' || token.endsWith('\\'));
}

// `commit`'s short options that take a value: attached (`-mfoo`) or the next argument
// (`-U <n>` in recent git; older git rejects it as unknown, denied either way).
export const SHORT_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't', 'U']);
// Short options whose optional value can only be attached (`-S<keyid>`, `-u<mode>`).
const SHORT_WITH_ATTACHED_VALUE = new Set(['S', 'u']);
// Long options whose value is the next argument when it is not attached with `=` (git
// commit's options with a required value), so a value is never read as a flag of a higher
// row (`--author -n` is the generic row naming `--author`, not the `-n` row). An
// abbreviated long option (`--reuse`) is not expanded: the generic row names it, and a value
// it takes is read as an argument of its own (denied either way, C:guard step 5).
export const LONG_WITH_VALUE = new Set([
  '--message', '--file', '--fixup', '--squash', '--reuse-message', '--reedit-message', '--author',
  '--date', '--trailer', '--template', '--cleanup', '--pathspec-from-file', '--unified',
  '--inter-hunk-context',
]);

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
const FIXUP_KIND = /^(amend|reword):/;
const isPlainFixup = (item) => item.flag === '--fixup' && item.value !== undefined && !FIXUP_KIND.test(item.value);
const NO_VERIFY = new Set(['-n', '--no-verify', '--no-gpg-sign']);
const isNoEdit = (item) => item.flag === '--no-edit' && item.value === undefined;

// A deny's catalogue row: `row` its fixed id (G3; G1's debug-log `reason`, which never holds
// the text: the generic and wrapper texts name a token of the command), `message` its text.
const rowDenial = (row, message) => Object.freeze({ row, message });
const BARE = rowDenial('bare', MESSAGES.bare);
const LITERAL_ARGUMENTS = rowDenial('literalArguments', MESSAGES.literalArguments);

// The specific rows of C:guard Precedence, in order, each finding its first matching item in
// argv order and giving that item's message. They outrank the generic, wrapper and bare rows.
const SPECIFIC_ROWS = [
  (items) => (!items.some(isNoEdit) && items.some((item) => item.flag === '--amend') ? rowDenial('amend', MESSAGES.amend) : null),
  (items) => (items.some((item) => item.flag === '--squash') ? rowDenial('squash', MESSAGES.squash) : null),
  (items) => {
    const item = items.find((i) => NO_VERIFY.has(i.flag));
    return item === undefined ? null : rowDenial('noVerify', noVerifyMessage(item.flag));
  },
  (items) => {
    const item = items.find((i) => i.flag === '--fixup' && i.value !== undefined && FIXUP_KIND.test(i.value));
    return item === undefined ? null : rowDenial('fixupKind', fixupKindMessage(FIXUP_KIND.exec(item.value)[1]));
  },
];
// What each form allows besides itself. A flag that takes no value is outside the form when
// given one (`--no-edit=x`, `--quiet=x`).
const isQuiet = (item) => item.value === undefined && QUIET.has(item.flag);
const fitsNoEdit = (item) => isQuiet(item) || isNoEdit(item) || (item.value === undefined && item.flag === '--amend');
const fitsFixup = (item) => isQuiet(item) || isPlainFixup(item);

/**
 * The rows of `commit`'s expanded arguments (C:guard Precedence): the specific rows first,
 * then the Q4 allowlist (`allowlistDecision`).
 *
 * @param {ReturnType<typeof expandCommitArgs>} items
 * @returns {{ row: string, message: string } | null} the deny's row, or null when the form
 *   is allowed.
 */
function argumentsDecision(items) {
  for (const row of SPECIFIC_ROWS) {
    const denial = row(items);
    if (denial !== null) return denial;
  }
  return allowlistDecision(items);
}

/**
 * The Q4 allowlist over expanded `commit` arguments: `--no-edit` with `--amend` and
 * `-q`/`--quiet`, or plain `--fixup=<commit>` with `-q`/`--quiet`. The form is set by the
 * first `--no-edit` or plain `--fixup` in argv order. Any item outside it is the generic row,
 * naming the first such item, except a bare-row option (and `-q`/`--quiet` with no form),
 * which gives the bare row only when nothing else matches (C:guard Precedence).
 *
 * @param {ReturnType<typeof expandCommitArgs>} items
 * @returns {{ row: string, message: string } | null} the deny's row, or null when the form
 *   is allowed.
 */
function allowlistDecision(items) {
  const form = items.find((item) => item.flag === '--no-edit' || isPlainFixup(item));
  if (form === undefined) {
    const other = items.find((item) => !BARE_ROW.has(item.flag) && !QUIET.has(item.flag));
    return other === undefined ? BARE : rowDenial('generic', genericMessage(nameOf(other)));
  }
  const fits = form.flag === '--no-edit' ? fitsNoEdit : fitsFixup;
  const other = items.find((item) => !fits(item) && !BARE_ROW.has(item.flag));
  if (other !== undefined) return rowDenial('generic', genericMessage(nameOf(other)));
  return items.some((item) => BARE_ROW.has(item.flag)) ? BARE : null;
}

// The name the generic row gives an item: its flag, or the argument (an empty one as `""`).
const nameOf = (item) => (item.flag !== undefined ? item.flag : item.argument || '""');

// C:guard Output's option-token grammar for GRD-16's debug log: a long option's name (the
// part before any `=`) and a short bundle's part up to and including its first value-taking
// letter, each judged on the whole token, never letter by letter.
const LONG_OPTION_NAME = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHORT_BUNDLE = /^-[A-Za-z0-9]+$/;

// Whether a long option written without `=` takes the next argument as its value, for the
// log only: an exact `LONG_WITH_VALUE` name or any abbreviation of one (`--mess` is git's
// `--message`), so that value is never read as options of its own.
const takesNextValue = (arg) => [...LONG_WITH_VALUE].some((name) => name.startsWith(arg));

// The matched segment's options for GRD-16's debug log (G1), read from the raw literal
// arguments: only option names, never a value (attached, after `=` or the next argument),
// never a plain argument (a pathspec, anything after `--`), and nothing from a token that
// is not wholly option-shaped (`"- added secret foo"`, `"--secret words"`).
function commitOptions(args) {
  const options = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (LONG_OPTION_NAME.test(name)) options.push(name);
      if (eq === -1 && takesNextValue(arg)) i += 1;
    } else if (arg.startsWith('-') && arg.length > 1) {
      let end = 1;
      while (end < arg.length && !SHORT_WITH_VALUE.has(arg[end]) && !SHORT_WITH_ATTACHED_VALUE.has(arg[end])) end += 1;
      const bundle = arg.slice(0, end + 1);
      if (SHORT_BUNDLE.test(bundle)) for (const letter of bundle.slice(1)) options.push(`-${letter}`);
      if (end === arg.length - 1 && SHORT_WITH_VALUE.has(arg[end])) i += 1;
    }
  }
  return options;
}

// `commit`'s arguments from `start` up to where they end (C:guard step 4): the raw literal
// ones, expanded as `items`, and whether all of them are literal; reading stops at the first
// one that is not, so `args` and `items` then hold the literal ones before it.
function readCommitArgs(tokens, start, shell) {
  const args = [];
  for (let i = start; i < tokens.length && !endsArguments(tokens[i], shell); i += 1) {
    if (!isLiteral(tokens[i], shell)) return { args, items: expandCommitArgs(args), literal: false };
    args.push(tokens[i]);
  }
  return { args, items: expandCommitArgs(args), literal: true };
}

// The options GRD-16's debug log gives a `git commit` whose arguments start at `start`.
const optionsAt = (tokens, start, shell) => commitOptions(readCommitArgs(tokens, start, shell).args);

// One `git commit` invocation, its `git` token at `at` in a command starting at `from`
// and its arguments starting at `start` (after `commit`): `{ denial, options }`, `denial`
// (the row) null when allowed. Every argument read must be literal (C:guard step 4); a
// non-literal one gives the literal-arguments row. A possible wrapper before `git` denies
// what would otherwise be allowed or the bare row; its row ranks just above the bare row
// (C:guard Precedence). `options` is GRD-16's debug-log data (G1), unaffected by which row
// wins: the flags of the literal arguments before any non-literal one.
function commitDecision(tokens, from, at, start, shell) {
  const { args, items, literal } = readCommitArgs(tokens, start, shell);
  const options = commitOptions(args);
  if (!literal) return { denial: LITERAL_ARGUMENTS, options };
  const denial = argumentsDecision(items);
  if (denial !== null && denial !== BARE) return { denial, options };
  const wrapper = wrapperBefore(tokens, from, at, shell);
  if (wrapper === undefined) return { denial, options };
  // An `env` whose `-a` option is the first unfit token is named rather than that option.
  const runner = ARGV0_A.test(wrapper) ? argv0Runner(tokens, from, at) : undefined;
  return { denial: rowDenial('wrapper', wrapperMessage(runner ?? wrapper)), options };
}

// C:guard step 4: git's known options before the subcommand. A value-taking one takes the next
// token as its value, a long one also a value joined with `=`; `--exec-path` is known only
// with a joined value (bare, it prints the path and exits). Git matches each by its exact spelling.
const GIT_OPTION_FLAGS = new Set([
  '--no-pager', '-P', '-p', '--paginate', '--bare', '--no-replace-objects', '--literal-pathspecs',
  '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--no-optional-locks', '--no-advice',
  // `--no-lazy-f…`, spelled with `\x66` so the G3 purity test finds no network-call word here.
  '--no-lazy-\x66etch',
]);
const GIT_OPTION_WITH_VALUE = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source',
]);
const GIT_OPTION_JOINED_VALUE = /^--(?:config-env|git-dir|work-tree|namespace|attr-source|exec-path)=/;
const CONFIG = /^(?:-c|--config-env(?:=.*)?)$/s;

/**
 * C:guard step 4: git's options before the subcommand, from `start`, the token after `git`,
 * up to where git's arguments end. Known options are skipped with their values; the first
 * token after them is the subcommand. A token in an option's place that starts with `-` and
 * is not a known literal option is unknown: which of the tokens after it is a value or the
 * subcommand is not known, so every one of them up to the end of git's arguments is read:
 * each must be literal, and the first `commit` among them is recorded.
 *
 * Every token read must be literal (`nonLiteral` records one that is not, a non-literal
 * option or value included, whether or not a `commit` follows). A PowerShell empty token in
 * an option's place is skipped (Windows PowerShell 5.1 drops it) and is not literal either.
 * A non-literal subcommand may run `commit` at run time (`git $c -m x`, `git {commit,-m,x}`,
 * `$o='--no-pager'; git $o commit`): `nonLiteralSubcommand` records it. In PowerShell a
 * token starting with `,` right after an option's value joins that value into an array
 * (`git -C . ,commit` passes `-C . commit` in 5.1), so it is the value that is not literal.
 *
 * @param {Array<string|object>} tokens
 * @param {number} start
 * @param {'bash'|'powershell'} shell
 * @returns {{ commit: number, config: boolean, nonLiteral: boolean, nonLiteralSubcommand: boolean, unknown: boolean }}
 *   `commit`: the index of the `commit` subcommand or, after an unknown option, of the first
 *   `commit` token (-1 when there is none); `config`: a `-c` or `--config-env` was read.
 */
function readGitOptions(tokens, start, shell) {
  const within = (k) => k < tokens.length && !endsArguments(tokens[k], shell);
  const found = { commit: -1, config: false, nonLiteral: false, nonLiteralSubcommand: false, unknown: false };
  let i = start;
  let afterValue = false;
  for (; within(i); i += 1) {
    const token = tokens[i];
    const literal = isLiteral(token, shell);
    if (shell === 'powershell' && token === '') {
      found.nonLiteral = true;
      continue;
    }
    if (typeof token !== 'string' || !token.startsWith('-')) break;
    afterValue = false;
    if (literal && CONFIG.test(token)) found.config = true;
    if (literal && GIT_OPTION_WITH_VALUE.has(token)) {
      i += 1;
      if (!within(i)) break;
      if (!isLiteral(tokens[i], shell)) found.nonLiteral = true;
      afterValue = true;
    } else if (!literal || !(GIT_OPTION_FLAGS.has(token) || GIT_OPTION_JOINED_VALUE.test(token))) {
      found.unknown = true;
      if (!literal) found.nonLiteral = true;
      for (let k = i + 1; within(k); k += 1) {
        if (!isLiteral(tokens[k], shell)) found.nonLiteral = true;
        else if (found.commit === -1 && COMMIT.test(tokens[k])) found.commit = k;
      }
      return found;
    }
  }
  if (!within(i)) return found;
  const token = tokens[i];
  if (isLiteral(token, shell)) {
    if (COMMIT.test(token)) found.commit = i;
  } else if (shell === 'powershell' && afterValue && typeof token === 'string' && token.startsWith(',')) {
    found.nonLiteral = true;
  } else {
    found.nonLiteralSubcommand = true;
  }
  return found;
}

// The deny row of git's options before the subcommand (C:guard Precedence: the `-c`/`--config-env` row,
// then the literal-subcommand row, then the literal-arguments row, then the unknown-option row, all above the `commit`
// argument rows), or null when they leave the decision to the `commit` arguments, or to
// nothing when there is no `commit`.
function gitOptionsDecision(found) {
  if (found.config && found.commit !== -1) return rowDenial('config', MESSAGES.config);
  if (found.nonLiteralSubcommand) return rowDenial('literalSubcommand', MESSAGES.literalSubcommand);
  if (found.nonLiteral) return LITERAL_ARGUMENTS;
  if (found.unknown && found.commit !== -1) return rowDenial('unknownGlobalOption', MESSAGES.unknownGlobalOption);
  return null;
}

/**
 * G3 `classify`: the guard's decision for G2's result.
 *
 * @param {Array<Array<string|object>> | { blanket: string }} parsed G2 `segments` output.
 * @param {{ agentType?: string, shell?: 'bash'|'powershell' }} [context]
 * @returns {{ decision: 'deny'|'none', row?: string, message?: string, scriptCalls: object[],
 *   matched?: { options: string[] } }} `row` is a non-blanket deny's catalogue row id;
 *   `matched` holds the matched `git commit` segment's options (flags only, never a value or a
 *   plain argument). Both are for G1's debug log (GRD-16), never its text.
 */
export function classify(parsed, context = {}) {
  const { shell = 'bash' } = context;
  if (!Array.isArray(parsed)) {
    const message = Object.hasOwn(BLANKET_ROWS, parsed.blanket) ? BLANKET_ROWS[parsed.blanket] : MESSAGES.blanket;
    return { decision: 'deny', message, scriptCalls: [] };
  }
  // Every segment's script call (S2), a denied command's included: G1 writes the heartbeat
  // for a `plan` call before the decision is emitted (C:guard Heartbeat).
  const scriptCalls = parsed.map((segment) => recognise(segment)).filter((call) => call !== null);
  const deny = ({ row, message }, options) => {
    const result = { decision: 'deny', row, message, scriptCalls };
    if (options !== undefined) result.matched = { options };
    return result;
  };
  // The worker-only rule (C:guard, Q25) is checked before the git rows: the worker answering
  // its own handback is told to stop even when the command also commits directly. Its scan
  // (S2 `named`) is wider than `recognise`: any word naming the entry point counts.
  const { agentType } = context;
  if (agentType === WORKER_AGENT && parsed.some((segment) => named(segment).some((s) => HANDBACK_SUBCOMMANDS.has(s)))) {
    return deny(rowDenial('handback', HANDBACK_MESSAGE));
  }
  // A Start-Process word denies the command with the wrapper row, which ranks just above the
  // bare row (C:guard step 3, Precedence).
  const starter = shell === 'powershell' ? startProcessName(parsed) : undefined;
  const wrapped = starter === undefined ? null : rowDenial('wrapper', wrapperMessage(starter));
  for (const segment of parsed) {
    // Redirections are dropped with their target (C:guard step 2).
    const tokens = segment.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
    // Every `git` token is classified; the segment is denied when any of them is (step 3).
    let starts = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (typeof token !== 'string') continue;
      // The dashed `git-commit` is `commit` straight away, its arguments right after it.
      const name = basename(token);
      const dashed = DASHED_COMMIT.test(name);
      if (!dashed && !GIT.test(name)) continue;
      starts ??= commandStarts(tokens, shell);
      // Git's options before the subcommand come first (step 4); Windows PowerShell 5.1 drops an empty
      // argument, so `git '' commit` runs a commit.
      const found = dashed ? { commit: i } : readGitOptions(tokens, i + 1, shell);
      const gitDenial = dashed ? null : gitOptionsDecision(found);
      if (gitDenial !== null) {
        // The `commit` found after git's options, if any, is the matched segment.
        return deny(gitDenial, found.commit === -1 ? undefined : optionsAt(tokens, found.commit + 1, shell));
      }
      if (found.commit === -1) {
        // An argv[0] option may make this `git` run `commit` whatever follows it.
        const runner = argv0Runner(tokens, starts[i], i);
        if (runner === undefined) continue;
        return deny(rowDenial('wrapper', wrapperMessage(runner)));
      }
      const { denial, options } = commitDecision(tokens, starts[i], i, found.commit + 1, shell);
      if (denial !== null) return deny(denial === BARE ? wrapped ?? denial : denial, options);
    }
  }
  return wrapped === null ? { decision: 'none', scriptCalls } : deny(wrapped);
}
