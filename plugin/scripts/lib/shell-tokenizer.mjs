// G2 Shell tokenizer (docs/spec/modules-shared-and-guard.md; C:guard Parsing step 2). Pure.
//
// First the script-call exemption, then the blanket rule (fail closed): a command holding a
// construct whose end the tokenizer does not model is not tokenized, and the caller gets the
// trigger kind instead of segments. Otherwise the command is tokenized with the quoting
// rules of its shell and split into segments.

// The longest command G2 reads, in UTF-16 code units (256 Ki, about 256 KiB of ASCII): a
// longer one is the blanket kind 'size' (C:guard step 2, fail closed), exempt form or not.
// It bounds the time and memory the readings and the body walk can take, whose exhaustion
// fails the guard open (review GRD-04 round 10: about 2.8 MB at full pattern depth ran the
// heap out). Real commands stay far below it.
export const MAX_COMMAND_LENGTH = 256 * 1024;

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
 * from being tokenized, or null. A command longer than `MAX_COMMAND_LENGTH` is the kind
 * 'size' first, exempt form or not. Checked anywhere in the text, inside quotes or not. For
 * Bash it is checked on both readings of `bashReadings`, each with every escaped newline
 * (`\` then a newline) removed: the text with every NUL and carriage return removed, then
 * the text with only every NUL removed, where a `\` before a carriage return escapes that
 * carriage return and is no line continuation (so `<<` `\` CR LF `<` is a heredoc there, not
 * the here-string `<<<` of the first reading). For PowerShell it is checked on the text with
 * its escaped newlines removed.
 *
 * @param {string} command
 * @param {'bash'|'powershell'} shell
 * @returns {'size'|'substitution'|'heredoc'|'here-string'|'comment'|'typographic-quote'|null}
 */
export function blanketTrigger(command, shell) {
  if (command.length > MAX_COMMAND_LENGTH) return 'size';
  if (isExemptScriptCall(command, shell)) return null;
  if (shell !== 'bash') return triggerIn(command.replace(/`\r?\n/g, ''), false);
  const withoutNul = command.replace(/\0/g, '');
  const dropped = triggerIn(withoutNul.replace(/\r/g, '').replace(/\\\n/g, ''), true);
  if (dropped !== null || !withoutNul.includes('\r')) return dropped;
  return triggerIn(withoutNul.replace(/\\\n/g, ''), true);
}

// The blanket trigger kind found in one reading's text, or null.
function triggerIn(text, bash) {
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
 * G2 `segments`: the command's segments of tokens, or the blanket trigger kind. A Bash
 * `<(…)` or `>(…)` substitution inside an extglob pattern in an argument (C:guard step 2)
 * is the blanket kind 'substitution' too, found while tokenizing, and such a pattern whose
 * brackets nest deeper than `MAX_PATTERN_DEPTH` is the blanket kind 'nesting'.
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
  const out = tokenize(command, shell);
  return out.blanket === null ? out.segments : { blanket: out.blanket };
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
  const out = tokenize(command, shell);
  return out.blanket === null ? out.spans : null;
}

function tokenize(command, shell) {
  if (shell !== 'bash') return tokenizePowerShell(command);
  const out = { segments: [], spans: [], blanket: null };
  for (const reading of bashReadings(command)) {
    const { text, origin } = join(reading);
    const result = tokenizeBash(text);
    out.blanket ??= result.blanket;
    append(out.segments, result.segments);
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
// the tokenizer finds them (`quoteEnd`). Its quote and `$`-run tracking mirrors `readWord`'s
// (both use `quoteKind` and `quoteEnd`): the two must agree, so change them together.
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

// Appends `items` to `target` one by one: `target.push(...items)` passes each item as an
// argument and throws a RangeError past the engine's argument limit, which a long command
// reaches (a crash fails the guard open).
function append(target, items) {
  for (const item of items) target.push(item);
}

// The deepest bracket nesting of an extglob pattern read as one word in an argument or a
// redirection target (C:guard step 2): an unquoted `(` that would open level 17 makes G2
// return the blanket kind 'nesting' (fail closed). It bounds the defense-in-depth body walk
// (`tokenizeBash`), which reads a body again at each level it is nested in: at most 17
// readings of any character, and at most 16 nested calls on the stack. Real patterns nest a
// few levels at most.
export const MAX_PATTERN_DEPTH = 16;

// Characters that end an unquoted Bash word.
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
// An unquoted `(` right after one of these opens an extglob pattern (C:guard step 2).
const EXTGLOB = new Set(['@', '!', '+', '*', '?']);
// Reserved words after which the next word is still in a command's first position, where
// `!` is the reserved word `!` (C:guard step 2). `time` may take `-p`, then `--`.
const COMMAND_PREFIX = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time']);
// Reserved words bash also takes where the tokenizer is in argument position: after `]]`,
// `}`, `fi`, `done` and `esac`, and `do` after `for NAME` or `select NAME` (C:guard step 2).
// Each opens a command's first position from any position, an argument's included (fail
// closed: an argument spelled so only reads the next word as a first word).
const CLAUSE_OPENERS = new Set(['then', 'do', 'else', 'elif']);

// The position of the word after `token`, read at position `at` (see `tokenizeBash`): true
// for a command's first word, 'time' right after a `time` there (a `-p` keeps it, a `--`
// opens the command), 'function' after a `function` there (its name, read as a first word,
// follows), 'coproc' after a `coproc` there (a name or the command follows), 'name' after
// that name, and false for an argument. After `coproc` and after the name of `function NAME`
// or `coproc NAME` bash still takes a reserved word: one that opens a command's first
// position anywhere opens it there too (fail closed).
function nextPosition(at, token) {
  if (CLAUSE_OPENERS.has(token)) return true;
  if (at === false) return false;
  if (at === 'function') return 'name';
  if (at === 'coproc' || at === 'name') {
    const opened = nextPosition(true, token);
    if (opened !== false) return opened;
    return at === 'coproc' ? 'name' : false;
  }
  if (at === 'time' && token === '-p') return 'time';
  if (at === 'time' && token === '--') return true;
  if (token === 'function' || token === 'coproc') return token;
  if (COMMAND_PREFIX.has(token)) return token === 'time' ? 'time' : true;
  return false;
}

// A `{name}` or `{name[subscript]}` word right before `<` or `>` names a descriptor variable
// (bash 4.1+), a redirection prefix like descriptor digits.
const VARIABLE_FD = /^\{[A-Za-z_][A-Za-z0-9_]*(?:\[[^]*\])?\}$/;

// Tokenizes one joined reading (no escaped newline outside single quotes and `$'…'`), or,
// at nesting `level` 1 and up, the body of an extglob pattern read as a command text.
// `blanket` is 'substitution' when an argument's extglob pattern holds a `<(…)` or `>(…)`
// substitution, 'nesting' when its brackets nest deeper than `MAX_PATTERN_DEPTH`
// (`readWord`), else null; tokenizing stops at the first blanket kind.
// Defense in depth (C:guard step 2): the body of each extglob pattern read as one word in an
// argument or a redirection target is also tokenized as a command text of its own, nested
// patterns included, and its segments follow the segment holding that word, so a `git` the
// body would run at a command's first position is a `git` token whatever position the
// tokenizer gave the word. A body sits inside each bracket of its enclosing patterns, so
// `level` never passes `MAX_PATTERN_DEPTH`; the check on it only keeps the stack bounded
// should that ever change.
function tokenizeBash(s, level = 0) {
  const out = { segments: [], spans: [], blanket: null };
  let seg = [];
  let start = 0;
  let end = 0;
  // The next word's position (`nextPosition`). A redirection leaves it as it is.
  let first = true;
  const push = (token, from, to) => {
    if (seg.length === 0) start = from;
    seg.push(token);
    end = to;
    if (typeof token === 'string') {
      first = nextPosition(first, token);
    } else if (Object.hasOwn(token, 'op')) {
      first = true;
    }
  };
  // The segments of the pattern bodies read so far in the current segment, with their spans.
  let bodies = { segments: [], spans: [] };
  const word = (from, argument) => {
    const w = readWord(s, from, argument);
    if (w.procsub) out.blanket = 'substitution';
    if (w.deep || (w.bodies && w.bodies.length > 0 && level >= MAX_PATTERN_DEPTH)) out.blanket ??= 'nesting';
    if (out.blanket !== null) return w;
    for (const [bodyStart, bodyEnd] of w.bodies || []) {
      const body = tokenizeBash(s.slice(bodyStart, bodyEnd), level + 1);
      out.blanket ??= body.blanket;
      append(bodies.segments, body.segments);
      for (const [a, b] of body.spans) bodies.spans.push([a + bodyStart, b + bodyStart]);
    }
    return w;
  };
  const endSegment = () => {
    if (seg.length > 0) {
      out.segments.push(seg);
      out.spans.push([start, end]);
    }
    append(out.segments, bodies.segments);
    append(out.spans, bodies.spans);
    bodies = { segments: [], spans: [] };
    seg = [];
    first = true;
  };
  let i = 0;
  while (i < s.length && out.blanket === null) {
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
      i = redirection(s, i, '', push, word);
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
        i = redirection(s, i, m[0], push, word);
      } else {
        const w = word(i, first === false || first === 'name');
        const raw = s.slice(i, w.end);
        if (VARIABLE_FD.test(raw) && (s[w.end] === '<' || s[w.end] === '>')) {
          i = redirection(s, i, raw, push, word);
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
// its target word (read by `word`, as `readWord` with the caller's bookkeeping), never a
// command's first word; pushes one token; returns the index after it.
function redirection(s, from, fd, push, word) {
  let i = from + fd.length;
  const op = REDIRECTION_OPS.find((candidate) => s.startsWith(candidate, i));
  i += op.length;
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
  let target = null;
  let to = i;
  if (j < s.length && !WORD_END.has(s[j])) {
    const w = word(j, true);
    target = w.value;
    to = w.end;
  }
  if (op.endsWith('&') && target !== null && /^(?:\d+|-)$/.test(target)) {
    push({ redir: `${fd}${op}${target}`, target: null }, from, to);
  } else {
    push({ redir: `${fd}${op}`, target }, from, to);
  }
  return to;
}

// Reads one Bash word from `i` (not a word-ending character) up to an unquoted word-ending
// character, with quote removal. An extglob `(` (C:guard step 2) in a command's first word
// ends the word, kept in it, and `extglob` marks it (it is also a `(` token: `!(…)` there is
// `!` and a subshell when `extglob` is off). In an argument (`argument`), the pattern is read
// on to its matching unquoted `)` as part of the word, its separators, spaces and brackets
// included, as bash reads it with `extglob` on, and in `[[ … ]]` even with it off; with no
// matching `)` (or an unterminated quote inside), the word ends after the `(` and no `(`
// token follows. An unquoted `<(` or `>(` inside the pattern, a substitution bash runs,
// ends the word there and `procsub` marks it (the caller denies); so does an unquoted `(`
// past `MAX_PATTERN_DEPTH` brackets, marked `deep`. `bodies` lists each
// balanced outermost pattern's body, `[start, end)` in `s` between its `(` and its `)`. Its
// quote and `$`-run tracking mirrors `join`'s: change them together.
function readWord(s, i, argument) {
  let value = '';
  let prev = null; // the previous character, when it was an unquoted literal
  let dollars = 0; // the run of unquoted literal `$` right before `i`
  let depth = 0; // the extglob brackets open in an argument
  let opener = null; // the word up to the outermost extglob `(` in an argument
  const bodies = [];
  while (i < s.length) {
    const c = s[i];
    // Bash runs a `<(…)` or `>(…)` inside a pattern: fail closed (`procsub`).
    if (depth > 0 && (c === '<' || c === '>') && s[i + 1] === '(') {
      return { value, end: i, extglob: false, procsub: true };
    }
    if (depth > 0 && (c === '(' || c === ')')) {
      if (c === '(' && depth === MAX_PATTERN_DEPTH) return { value, end: i, extglob: false, deep: true };
      depth += c === '(' ? 1 : -1;
      if (depth === 0) bodies.push([opener.end, i]);
    } else if (WORD_END.has(c) && depth === 0) {
      if (c !== '(' || prev === null || !EXTGLOB.has(prev)) break;
      if (!argument) return { value: `${value}(`, end: i + 1, extglob: true };
      opener = { value: `${value}(`, end: i + 1, extglob: false, bodies };
      depth = 1;
    }
    let q = null;
    if (c === '\\') {
      q = i + 1 < s.length ? { value: s[i + 1], end: i + 2, closed: true } : { value: '\\', end: i + 1, closed: true };
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
      if (depth > 0 && !q.closed) return opener;
      value += q.value;
      prev = null;
      dollars = 0;
      i = q.end;
    }
  }
  return depth > 0 ? opener : { value, end: i, extglob: false, bodies };
}

// A quote span's value, end and whether it is closed: the span is found first (`quoteEnd`),
// then its content is decoded on its own.
function readQuote(s, from, kind) {
  const { end, closed } = quoteEnd(s, from, kind);
  const content = s.slice(from, closed ? end - 1 : end);
  if (kind === 'single') return { value: content, end, closed };
  return { value: kind === 'double' ? decodeDouble(content) : decodeAnsiC(content), end, closed };
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

// PowerShell (C:guard step 2, PowerShell column). Whitespace splits words: space, tab, form
// feed, vertical tab, U+0085 and every Unicode separator (Zs, Zl, Zp, among them U+00A0 and
// U+2028), as PowerShell's tokenizer reads them; a carriage return or a newline ends the
// line, a lone carriage return included.
const PS_SPACE = /[ \t\f\v\x85\p{Z}]/u;
const isPsSpace = (c) => c === ' ' || PS_SPACE.test(c);
const isPsNewline = (c) => c === '\n' || c === '\r';
// Characters that end an unquoted word besides whitespace and newlines. `>` and `<` do not:
// PowerShell reads `a2>b` as one word and a redirection only at a token's start.
const PS_WORD_END = new Set([';', '|', '&', '(', ')', '{', '}']);
// The quote classes, written as the characters themselves: `"` and U+201C-U+201E, `'` and
// U+2018-U+201B. Any character of a class closes a string opened by any of them; two of them
// in a row inside it are one escaped quote, the second of the two.
const PS_DOUBLE = new Set(['"', '“', '”', '„']);
const PS_SINGLE = new Set(["'", '‘', '’', '‚', '‛']);
// The backtick escapes with a meaning of their own (PowerShell 7); any other escaped
// character is itself. `` `0 `` (a NUL) is handled by `psEscape`.
const PS_ESCAPES = { a: '\x07', b: '\b', e: '\x1B', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
// A redirection at a token's start: a stream duplication (`2>&1`, `*>&1`), an output
// redirection with an optional stream (`>`, `>>`, `2>`, `*>>`), or `<` (reserved in
// PowerShell, which then runs nothing).
const PS_REDIRECTION = /[1-6*]>&[12]|[1-6*]?>>?|</y;

// The backtick escape at `i`: its value and end, `nul` for a NUL (`` `0 `` or a zero
// `` `u{…} ``). A backtick before a newline (optionally after a carriage return) is an
// escaped newline and removed; a trailing backtick at the command's end is dropped.
function psEscape(s, i) {
  const n = s[i + 1];
  if (n === undefined) return { value: '', end: i + 1 };
  if (n === '\n') return { value: '', end: i + 2 };
  if (n === '\r' && s[i + 2] === '\n') return { value: '', end: i + 3 };
  if (n === '0') return { value: '', end: i + 2, nul: true };
  if (n === 'u') {
    const braces = /\{([0-9A-Fa-f]{1,6})\}/y;
    braces.lastIndex = i + 2;
    const hex = braces.exec(s);
    if (hex) {
      const code = parseInt(hex[1], 16);
      const end = i + 2 + hex[0].length;
      if (code === 0) return { value: '', end, nul: true };
      // Past U+10FFFF PowerShell rejects the command and runs nothing.
      return { value: code <= 0x10ffff ? String.fromCodePoint(code) : '', end };
    }
  }
  return { value: Object.hasOwn(PS_ESCAPES, n) ? PS_ESCAPES[n] : n, end: i + 2 };
}

// The end of the quoted string whose content starts at `from` (`kind`: PS_SINGLE or
// PS_DOUBLE): after the closing quote, found lexically (two quote characters of the class
// in a row are one escaped quote; in double quotes a backtick pairs with the next
// character). An unterminated string is the rest of its line (C:guard step 2): it ends
// before the first unescaped newline.
function psQuoteEnd(s, from, kind) {
  const double = kind === PS_DOUBLE;
  for (let i = from; i < s.length; i += 1) {
    if (double && s[i] === '`') {
      i += 1;
    } else if (kind.has(s[i])) {
      if (!kind.has(s[i + 1])) return { end: i + 1, closed: true };
      i += 1;
    }
  }
  for (let i = from; i < s.length; i += 1) {
    if (isPsNewline(s[i])) return { end: i, closed: false };
    if (double && s[i] === '`') i += s[i + 1] === '\r' && s[i + 2] === '\n' ? 2 : 1;
  }
  return { end: s.length, closed: false };
}

// A quoted string's value, end and `nul` (its value holds a NUL, which ends the value
// there: what follows the NUL is dropped).
function psQuote(s, from, kind) {
  const { end, closed } = psQuoteEnd(s, from, kind);
  const stop = closed ? end - 1 : end;
  let value = '';
  for (let i = from; i < stop;) {
    let part;
    if (kind === PS_DOUBLE && s[i] === '`') {
      part = psEscape(s, i);
      if (part.end > stop) part = { value: '', end: stop };
    } else if (kind.has(s[i])) {
      part = { value: s[i + 1], end: i + 2 };
    } else {
      part = { value: s[i], end: i + 1, nul: s[i] === '\0' };
    }
    if (part.nul) return { value, end, nul: true };
    value += part.value;
    i = part.end;
  }
  return { value, end, nul: false };
}

// Reads one PowerShell word from `i` up to unquoted whitespace, a newline or a PS_WORD_END
// character, with escape and quote removal. `quoted` marks a word with a quoted part (a
// quoted `'--%'` does not stop parsing); `cut` marks a NUL in its value, which ends the
// value there (the rest of the word is read and dropped).
function readPsWord(s, i) {
  let value = '';
  let quoted = false;
  let cut = false;
  while (i < s.length) {
    const c = s[i];
    if (isPsSpace(c) || isPsNewline(c) || PS_WORD_END.has(c)) break;
    let part;
    if (c === '`') {
      part = psEscape(s, i);
    } else if (PS_SINGLE.has(c) || PS_DOUBLE.has(c)) {
      quoted = true;
      part = psQuote(s, i + 1, PS_SINGLE.has(c) ? PS_SINGLE : PS_DOUBLE);
    } else if (c === '\0') {
      // A raw NUL cuts the native command line like `` `0 `` (verified with 5.1 and 7).
      part = { value: '', end: i + 1, nul: true };
    } else {
      part = { value: c, end: i + 1 };
    }
    if (!cut) value += part.value;
    cut ||= part.nul === true;
    i = part.end;
  }
  return { value, end: i, quoted, cut };
}

// The words after a stop-parsing `--%` (C:guard step 2): the rest of the line up to the next
// `|`, `&&` or `||`, split on whitespace only; every other character is a character of its
// word. Returns the index of the newline, `|` or `&&` that ends it, or the command's end.
function readStopParsing(s, i, push) {
  const ends = (at) => isPsNewline(s[at]) || s[at] === '|' || (s[at] === '&' && s[at + 1] === '&');
  while (i < s.length) {
    if (isPsSpace(s[i])) {
      i += 1;
    } else if (ends(i)) {
      return i;
    } else {
      const from = i;
      while (i < s.length && !isPsSpace(s[i]) && !ends(i)) i += 1;
      push(s.slice(from, i), from, i);
    }
  }
  return i;
}

// Splits a PowerShell command into segments on `&&`, `||`, `;`, `|`, a lone `&` and
// newlines outside quotes. An unquoted `(`, `)`, `{` or `}` is an operator token of its own,
// a script block passed as data included (`Start-Process -ArgumentList { … }`: its `{`
// starts a command, fail closed). The `&` call operator at a command's start (the segment's
// start or right after a `(` or `{` token) is the word `'&'` (C:guard step 3). A NUL in a
// word's value is followed by a `{ op: 'cut' }` token. Spans are indices in `s`.
function tokenizePowerShell(s) {
  const out = { segments: [], spans: [], blanket: null };
  let seg = [];
  let start = 0;
  let end = 0;
  // Whether the next token is at a command's start, where `&` is the call operator.
  let first = true;
  const push = (token, from, to) => {
    if (seg.length === 0) start = from;
    seg.push(token);
    end = to;
  };
  const close = () => {
    if (seg.length > 0) {
      out.segments.push(seg);
      out.spans.push([start, end]);
    }
    seg = [];
    first = true;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`' && (i + 1 === s.length || s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i = psEscape(s, i).end;
    } else if (isPsSpace(c)) {
      i += 1;
    } else if (isPsNewline(c) || c === ';') {
      close();
      i += 1;
    } else if (c === '|') {
      close();
      i += s[i + 1] === '|' ? 2 : 1;
    } else if (c === '&' && s[i + 1] !== '&' && first) {
      push('&', i, i + 1);
      first = false;
      i += 1;
    } else if (c === '&') {
      close();
      i += s[i + 1] === '&' ? 2 : 1;
    } else if (c === '(' || c === ')' || c === '{' || c === '}') {
      push({ op: c }, i, i + 1);
      first = c === '(' || c === '{';
      i += 1;
    } else {
      PS_REDIRECTION.lastIndex = i;
      const redir = PS_REDIRECTION.exec(s);
      if (redir === null) {
        const w = readPsWord(s, i);
        push(w.value, i, w.end);
        if (w.cut) push({ op: 'cut' }, w.end, w.end);
        first = false;
        i = w.end;
        if (!w.quoted && !w.cut && w.value === '--%') i = readStopParsing(s, i, push);
      } else {
        i = psRedirection(s, i, redir[0], push);
      }
    }
  }
  close();
  return out;
}

// Pushes the redirection `op` at `from` with its target word (null for a stream duplication
// such as `2>&1`, or when no word follows); returns the index after it.
function psRedirection(s, from, op, push) {
  let i = from + op.length;
  if (op.includes('&')) {
    push({ redir: op, target: null }, from, i);
    return i;
  }
  while (i < s.length && isPsSpace(s[i])) i += 1;
  if (i < s.length && !isPsNewline(s[i]) && !PS_WORD_END.has(s[i])) {
    const w = readPsWord(s, i);
    push({ redir: op, target: w.value }, from, w.end);
    return w.end;
  }
  push({ redir: op, target: null }, from, from + op.length);
  return from + op.length;
}
