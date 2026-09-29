// G2 Shell tokenizer (docs/spec/modules-shared-and-guard.md; C:guard Parsing step 2). Pure.
//
// First the script-call exemption, then the blanket rule (fail closed): a command holding a
// construct whose end the tokenizer does not model is not tokenized, and the caller gets the
// trigger kind instead of segments. Otherwise the command is tokenized with the quoting
// rules of its shell and split into segments. Bash only for now; the PowerShell tokenizer
// is GRD-06.

// The typographic quotes U+2018-U+201E, written as the characters themselves.
const TYPOGRAPHIC = /[‘-„]/;

// C:guard step 2: the one plain script call that skips the blanket rule. The quoted path
// holds no `"`, typographic double quote, `$`, backtick, `!` or control character and does
// not start with `-`; the words after the subcommand use a fixed character set only.
const EXEMPT_CALL = String.raw`node(?:\.exe)? "(?!-)[^"“”„$${'`'}!\x00-\x1F\x7F]*[/\\]commit\.cjs" (?:plan|check|commit|release|infer)(?: [A-Za-z0-9._:=-]+)* *$`;
const EXEMPT = {
  bash: new RegExp(`^ *${EXEMPT_CALL}`),
  powershell: new RegExp(`^ *(?:& )?${EXEMPT_CALL}`),
};

/**
 * Whether the command is, in full, one script call in C:guard's step 2 exempt form.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {boolean}
 */
export function isExemptScriptCall(command, shell) {
  return EXEMPT[shell].test(command);
}

/**
 * The blanket rule (C:guard step 2): the kind of construct that keeps a non-exempt command
 * from being tokenized, or null. Checked on the text with that shell's escaped newlines
 * removed regardless of quotes, anywhere in the text, inside quotes or not.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {'substitution'|'heredoc'|'here-string'|'comment'|'typographic-quote'|null}
 */
export function blanketTrigger(command, shell) {
  if (isExemptScriptCall(command, shell)) return null;
  const bash = shell === 'bash';
  const text = command.replace(bash ? /\\\r?\n/g : /`\r?\n/g, '');
  if (text.includes('$(') || text.includes('${')) return 'substitution';
  if (bash ? text.includes('`') : text.includes('@(')) return 'substitution';
  if (text.includes('#')) return 'comment';
  if (bash) {
    // A run of two or more `<` other than exactly three (`<<<` is a here-string redirection).
    if ((text.match(/<{2,}/g) || []).some((run) => run.length !== 3)) return 'heredoc';
    if (TYPOGRAPHIC.test(text)) return 'typographic-quote';
  } else if (/@['"‘-„]/.test(text)) {
    return 'here-string';
  }
  return null;
}

/**
 * G2 `segments`: the command's segments of tokens, or the blanket trigger kind.
 *
 * A token is a word (a string, after quote removal), `{ op }` for `(` and `)`,
 * `{ redir, target }` for a redirection with its target word (null for a descriptor
 * duplication such as `2>&1`), or `{ heredoc, delim }`.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {Array<Array<string|object>> | { blanket: string }}
 */
export function segments(command, shell) {
  const kind = blanketTrigger(command, shell);
  if (kind !== null) return { blanket: kind };
  return tokenize(command, shell).segments;
}

/**
 * Each segment's span in the command text, `[start, end)`, from its first token to its
 * last; null for a blanket command. For the oracle cross-check, which lets the shell read
 * each span on its own.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {Array<[number, number]> | null}
 */
export function segmentSpans(command, shell) {
  if (blanketTrigger(command, shell) !== null) return null;
  return tokenize(command, shell).spans;
}

function tokenize(command, shell) {
  if (shell !== 'bash') throw new Error('the PowerShell tokenizer is not built yet (GRD-06)');
  return tokenizeBash(command);
}

// Characters that end an unquoted Bash word.
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
// An unquoted `(` right after one of these opens an extglob pattern (C:guard step 2).
const EXTGLOB = new Set(['@', '!', '+', '*', '?']);

function tokenizeBash(s) {
  const out = { segments: [], spans: [] };
  let seg = [];
  let start = 0;
  let end = 0;
  const push = (token, from, to) => {
    if (seg.length === 0) start = from;
    seg.push(token);
    end = to;
  };
  const endSegment = () => {
    if (seg.length > 0) {
      out.segments.push(seg);
      out.spans.push([start, end]);
    }
    seg = [];
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === ' ' || c === '\t') {
      i += 1;
    } else if (c === '\n' || c === ';') {
      endSegment();
      i += 1;
    } else if (c === '|') {
      endSegment();
      i += next === '|' || next === '&' ? 2 : 1;
    } else if (c === '&' && next === '>') {
      i = redirection(s, i, '', push);
    } else if (c === '&') {
      endSegment();
      i += next === '&' ? 2 : 1;
    } else if (c === '(' || c === ')') {
      push({ op: c }, i, i + 1);
      i += 1;
    } else if ((c === '<' || c === '>') && next === '(') {
      // Process substitution: read as a `(` token, not a redirection.
      push({ op: '(' }, i, i + 2);
      i += 2;
    } else {
      const fd = /\d*(?=[<>])/y;
      fd.lastIndex = i;
      const m = fd.exec(s);
      if (m) {
        i = redirection(s, i, m[0], push);
      } else {
        const w = readWord(s, i);
        if (w.started) push(w.value, i, w.end);
        if (w.extglob) push({ op: '(' }, w.end - 1, w.end);
        i = w.end;
      }
    }
  }
  endSegment();
  return out;
}

const REDIRECTION_OPS = ['&>>', '&>', '<<<', '<<-', '<<', '<&', '<>', '<', '>>', '>&', '>|', '>'];

// Reads a redirection at `from` (after its descriptor digits `fd`) and its target word;
// pushes one token; returns the index after it.
function redirection(s, from, fd, push) {
  let i = from + fd.length;
  const op = REDIRECTION_OPS.find((candidate) => s.startsWith(candidate, i));
  i += op.length;
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
  let target = null;
  let to = i;
  let extglob = false;
  if (j < s.length && !WORD_END.has(s[j])) {
    const w = readWord(s, j);
    if (w.started) {
      target = w.value;
      to = w.end;
      extglob = w.extglob;
    }
  }
  if (op === '<<' || op === '<<-') {
    push({ heredoc: op, delim: target === null ? '' : target }, from, to);
  } else if (op.endsWith('&') && target !== null && /^(?:\d+|-)$/.test(target)) {
    push({ redir: `${fd}${op}${target}`, target: null }, from, to);
  } else {
    push({ redir: `${fd}${op}`, target }, from, to);
  }
  if (extglob) push({ op: '(' }, to - 1, to);
  return to;
}

// Reads one Bash word from `i` up to an unquoted word-ending character, with quote removal.
// `started` is false when nothing but escaped newlines was read. `extglob` marks a word
// ended by an extglob `(`, which is kept in the word and is also a `(` token.
function readWord(s, i) {
  let value = '';
  let started = false;
  let prev = null; // the previous character, when it was an unquoted literal
  while (i < s.length) {
    const c = s[i];
    if (WORD_END.has(c)) {
      if (c === '(' && prev !== null && EXTGLOB.has(prev)) {
        return { value: `${value}(`, end: i + 1, started: true, extglob: true };
      }
      break;
    }
    let q = null;
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2;
        continue;
      }
      q = i + 1 < s.length ? { value: s[i + 1], end: i + 2 } : { value: '\\', end: i + 1 };
    } else if (c === "'") {
      q = readSingle(s, i + 1);
    } else if (c === '"') {
      q = readQuoted(readDouble, s, i + 1);
    } else if (c === '$' && s[i + 1] === "'") {
      q = readQuoted(readAnsiC, s, i + 2);
    } else if (c === '$' && s[i + 1] === '"') {
      // `$"…"` (locale translation) is read as `"…"` with the `$` removed.
      q = readQuoted(readDouble, s, i + 2);
    }
    started = true;
    if (q === null) {
      value += c;
      prev = c;
      i += 1;
    } else {
      value += q.value;
      prev = null;
      i = q.end;
    }
  }
  return { value, end: i, started, extglob: false };
}

// An unterminated quote is the rest of its line (C:guard step 2): read to the end of the
// command first, and only when no closing quote comes, again up to the line's end.
function readQuoted(reader, s, from) {
  const whole = reader(s, from, false);
  return whole.closed ? whole : reader(s, from, true);
}

function readSingle(s, from) {
  const close = s.indexOf("'", from);
  if (close >= 0) return { value: s.slice(from, close), end: close + 1 };
  const newline = s.indexOf('\n', from);
  const end = newline < 0 ? s.length : newline;
  return { value: s.slice(from, end), end };
}

// Double quotes: `\` escapes only `"`, `\`, `$` and a backtick; `\` plus newline is removed;
// any other `\` stays.
function readDouble(s, from, toLineEnd) {
  let value = '';
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { value, end: i + 1, closed: true };
    if (toLineEnd && c === '\n') return { value, end: i, closed: false };
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === '\n') {
        i += 2;
        continue;
      }
      if (n === '"' || n === '\\' || n === '$' || n === '`') {
        value += n;
        i += 2;
        continue;
      }
    }
    value += c;
    i += 1;
  }
  return { value, end: i, closed: false };
}

// ANSI-C quotes: the span ends at the first `'` not escaped by `\`; escapes are decoded as
// Bash does, and a decoded NUL ends the span's value there (the rest of the span is read
// but dropped).
function readAnsiC(s, from, toLineEnd) {
  let value = '';
  let cut = false;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") return { value, end: i + 1, closed: true };
    if (toLineEnd && c === '\n') return { value, end: i, closed: false };
    let text = c;
    if (c === '\\' && i + 1 < s.length && !(toLineEnd && s[i + 1] === '\n')) {
      const d = ansiEscape(s, i + 1);
      text = d.text;
      i = d.end;
    } else {
      i += 1;
    }
    if (text === '\0') cut = true;
    if (!cut) value += text;
  }
  return { value, end: i, closed: false };
}

const SIMPLE_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1B', E: '\x1B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// Decodes the escape whose letter is at `p` (after the `\`); an unknown or incomplete escape
// keeps its `\`.
function ansiEscape(s, p) {
  const c = s[p];
  if (Object.hasOwn(SIMPLE_ESCAPES, c)) return { text: SIMPLE_ESCAPES[c], end: p + 1 };
  const digits = (re, at) => {
    re.lastIndex = at;
    const m = re.exec(s);
    return m ? m[0] : '';
  };
  const octal = digits(/[0-7]{1,3}/y, p);
  if (octal) return { text: String.fromCharCode(parseInt(octal, 8) & 0xff), end: p + octal.length };
  const hexWidth = { x: 2, u: 4, U: 8 }[c];
  if (hexWidth) {
    const hex = digits(new RegExp(`[0-9A-Fa-f]{1,${hexWidth}}`, 'y'), p + 1);
    const code = parseInt(hex, 16);
    if (hex && c === 'x') return { text: String.fromCharCode(code), end: p + 1 + hex.length };
    if (hex && code <= 0x10ffff) return { text: String.fromCodePoint(code), end: p + 1 + hex.length };
  }
  // `\c` right before the closing `'` has no character to take: the `'` ends the span.
  if (c === 'c' && p + 1 < s.length && s[p + 1] !== "'") {
    const x = s[p + 1];
    const skip = x === '\\' && s[p + 2] === '\\' ? 2 : 1;
    const code = x === '?' ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f;
    return { text: String.fromCharCode(code), end: p + 1 + skip };
  }
  return { text: `\\${c}`, end: p + 1 };
}
