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
 * from being tokenized, or null. Checked anywhere in the text, inside quotes or not: for
 * Bash on the text with every NUL and carriage return removed, then every escaped newline;
 * for PowerShell on the text with its escaped newlines removed.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {'substitution'|'heredoc'|'here-string'|'comment'|'typographic-quote'|null}
 */
export function blanketTrigger(command, shell) {
  if (isExemptScriptCall(command, shell)) return null;
  const bash = shell === 'bash';
  const text = bash ? command.replace(/[\0\r]/g, '').replace(/\\\n/g, '') : command.replace(/`\r?\n/g, '');
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
 * A token is a word (a string, after quote removal), `{ op }` for `(` and `)`, or
 * `{ redir, target }` for a redirection with its target word (null for a descriptor
 * duplication such as `2>&1`). A Bash command holding a carriage return has two readings
 * (see `bashReadings`); its segments are the first reading's followed by the second's.
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
 * Test seam: each segment's span in the command text, `[start, end)`, from its first token
 * to its last; null for a blanket command. For the oracle cross-check, which lets the shell
 * read each span on its own.
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
  const out = { segments: [], spans: [] };
  for (const reading of bashReadings(command)) {
    const { text, origin } = join(reading);
    const result = tokenizeBash(text);
    out.segments.push(...result.segments);
    for (const [start, end] of result.spans) out.spans.push([origin[start], origin[end - 1] + 1]);
  }
  return out;
}

// The Bash readings of a command, each `{ text, origin }` with `origin[k]` the index in the
// command of `text[k]`. Bash drops every NUL of its input. The Windows (Cygwin) bash drops
// every carriage return too, while other builds keep it as a word character: a command
// holding one is read both ways, so a construct either bash runs is seen (fail closed).
function bashReadings(command) {
  const kept = [];
  for (let i = 0; i < command.length; i += 1) if (command[i] !== '\0') kept.push(i);
  const at = (origin) => ({ text: origin.map((i) => command[i]).join(''), origin });
  if (!kept.some((i) => command[i] === '\r')) return [at(kept)];
  return [at(kept.filter((i) => command[i] !== '\r')), at(kept)];
}

// Removes each escaped newline (`\` then a newline) outside single quotes and `$'…'`, as
// bash's input reader does before its lexer, so one can split a word, an operator, a
// descriptor or a `$'` opener; and drops a trailing unquoted `\`. Quote spans are found as
// the tokenizer finds them (`quoteEnd`).
function join({ text: s, origin }) {
  let text = '';
  const map = [];
  const keep = (from, to) => {
    for (let k = from; k < to; k += 1) {
      text += s[k];
      map.push(origin[k]);
    }
  };
  let dollars = 0; // the run of unquoted literal `$` right before `i`
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && s[i + 1] !== '\n') {
        keep(i, i + 2);
        dollars = 0;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      const kind = quoteKind(c, dollars);
      const { end } = quoteEnd(s, i + 1, kind);
      if (kind === 'double') {
        keep(i, i + 1);
        let k = i + 1;
        while (k < end) {
          const step = s[k] === '\\' && k + 1 < end ? 2 : 1;
          if (!(step === 2 && s[k + 1] === '\n')) keep(k, k + step);
          k += step;
        }
      } else {
        keep(i, end);
      }
      dollars = 0;
      i = end;
    } else {
      keep(i, i + 1);
      dollars = c === '$' ? dollars + 1 : 0;
      i += 1;
    }
  }
  return { text, origin: map };
}

// The quote a `'` or `"` opens after a run of `dollars` unquoted `$`: a `$` opens `$'…'`
// (ANSI-C) only when it is not the second `$` of a `$$` pair; `$"…"` reads as `"…"`.
function quoteKind(c, dollars) {
  if (c === '"') return 'double';
  return dollars % 2 === 1 ? 'ansi' : 'single';
}

// The end of the quote span whose content starts at `from`: after the closing quote, found
// lexically (in double quotes and `$'…'` a `\` pairs with any next character, whatever it
// decodes to). An unterminated quote is the rest of its line (C:guard step 2): the span ends
// before the first newline, which in double quotes a `\` still escapes.
function quoteEnd(s, from, kind) {
  const close = kind === 'double' ? '"' : "'";
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === close) return { end: i + 1, closed: true };
    if (s[i] === '\\' && kind !== 'single') i += 1;
  }
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === '\n') return { end: i, closed: false };
    if (s[i] === '\\' && (kind === 'double' || (kind === 'ansi' && s[i + 1] !== '\n'))) i += 1;
  }
  return { end: s.length, closed: false };
}

// Characters that end an unquoted Bash word.
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
// An unquoted `(` right after one of these opens an extglob pattern (C:guard step 2).
const EXTGLOB = new Set(['@', '!', '+', '*', '?']);
// A `{name}` or `{name[subscript]}` word right before `<` or `>` names a descriptor variable
// (bash 4.1+), a redirection prefix like descriptor digits.
const VARIABLE_FD = /^\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^]*\])?\}$/;

// Tokenizes one joined reading (no escaped newline outside single quotes and `$'…'`).
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
        const raw = s.slice(i, w.end);
        if (VARIABLE_FD.test(raw) && (s[w.end] === '<' || s[w.end] === '>')) {
          i = redirection(s, i, raw, push);
        } else {
          push(w.value, i, w.end);
          if (w.extglob) push({ op: '(' }, w.end - 1, w.end);
          i = w.end;
        }
      }
    }
  }
  endSegment();
  return out;
}

// `<<` and `<<-` (heredocs) never reach the tokenizer: the blanket rule catches them first.
const REDIRECTION_OPS = ['&>>', '&>', '<<<', '<&', '<>', '<', '>>', '>&', '>|', '>'];

// Reads a redirection at `from` (after its descriptor prefix `fd`: digits or `{name}`) and
// its target word; pushes one token; returns the index after it.
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
    target = w.value;
    to = w.end;
    extglob = w.extglob;
  }
  if (op.endsWith('&') && target !== null && /^(?:\d+|-)$/.test(target)) {
    push({ redir: `${fd}${op}${target}`, target: null }, from, to);
  } else {
    push({ redir: `${fd}${op}`, target }, from, to);
  }
  if (extglob) push({ op: '(' }, to - 1, to);
  return to;
}

// Reads one Bash word from `i` (not a word-ending character) up to an unquoted word-ending
// character, with quote removal. `extglob` marks a word ended by an extglob `(`, which is
// kept in the word and is also a `(` token.
function readWord(s, i) {
  let value = '';
  let prev = null; // the previous character, when it was an unquoted literal
  let dollars = 0; // the run of unquoted literal `$` right before `i`
  while (i < s.length) {
    const c = s[i];
    if (WORD_END.has(c)) {
      if (c === '(' && prev !== null && EXTGLOB.has(prev)) {
        return { value: `${value}(`, end: i + 1, extglob: true };
      }
      break;
    }
    let q = null;
    if (c === '\\') {
      q = i + 1 < s.length ? { value: s[i + 1], end: i + 2 } : { value: '\\', end: i + 1 };
    } else if (c === "'" || c === '"') {
      q = readQuote(s, i + 1, quoteKind(c, dollars));
    } else if (c === '$' && (s[i + 1] === "'" || s[i + 1] === '"') && dollars % 2 === 0) {
      // The `$` opens `$'…'` or `$"…"` (read as `"…"`, the `$` removed).
      q = readQuote(s, i + 2, quoteKind(s[i + 1], 1));
    }
    if (q === null) {
      value += c;
      prev = c;
      dollars = c === '$' ? dollars + 1 : 0;
      i += 1;
    } else {
      value += q.value;
      prev = null;
      dollars = 0;
      i = q.end;
    }
  }
  return { value, end: i, extglob: false };
}

// A quote span's value and end: the span is found first (`quoteEnd`), then its content is
// decoded on its own.
function readQuote(s, from, kind) {
  const { end, closed } = quoteEnd(s, from, kind);
  const content = s.slice(from, closed ? end - 1 : end);
  if (kind === 'single') return { value: content, end };
  return { value: kind === 'double' ? decodeDouble(content) : decodeAnsiC(content), end };
}

// Double quotes: `\` escapes only `"`, `\`, `$` and a backtick; any other `\` stays. (An
// escaped newline was removed before tokenizing.)
function decodeDouble(t) {
  return t.replace(/\\([\s\S])/g, (pair, n) => (n === '"' || n === '\\' || n === '$' || n === '`' ? n : pair));
}

// ANSI-C quotes: escapes are decoded as Bash does, and a decoded NUL ends the value there.
function decodeAnsiC(t) {
  let value = '';
  let i = 0;
  while (i < t.length) {
    let text = t[i];
    if (text === '\\' && i + 1 < t.length) {
      const d = ansiEscape(t, i + 1);
      text = d.text;
      i = d.end;
    } else {
      i += 1;
    }
    if (text === '\0') break;
    value += text;
  }
  return value;
}

const SIMPLE_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1B', E: '\x1B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// Decodes the escape whose letter is at `p` (after the `\`) in a span's content; an unknown
// or incomplete escape keeps its `\`. `\nnn` and `\xHH` at 0x80 and above decode to U+0080-
// U+00FF, where bash emits the raw byte: this only matters to the oracle, not to security.
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
  // `\c` at the span's end has no character to take and stays `\c`.
  if (c === 'c' && p + 1 < s.length) {
    const x = s[p + 1];
    const skip = x === '\\' && s[p + 2] === '\\' ? 2 : 1;
    const code = x === '?' ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f;
    return { text: String.fromCharCode(code), end: p + 1 + skip };
  }
  return { text: `\\${c}`, end: p + 1 };
}
