// G1 Hook I/O (docs/spec/modules-shared-and-guard.md; C:guard Output and Parsing step 1).
//
// Reads the PreToolUse JSON from stdin to its end and decides what the hook prints. A
// command that does not mention `commit` ends early with no output. The guard's outputs are
// a deny or nothing (C:guard Output); a crash or unreadable input fails open.

import { Buffer } from 'node:buffer';
import { segments } from './shell-tokenizer.mjs';
import { classify } from './command-classifier.mjs';

const NO_OUTPUT = Object.freeze({ stdout: '', stderr: '' });

// C:guard's decision inputs: the only two shells the guard understands. Anything else is
// incomplete input (GRD-02), the same as a missing command.
const SHELL_OF = Object.freeze({ Bash: 'bash', PowerShell: 'powershell' });

/**
 * Whether stderr debug logging is enabled (C:guard Output).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function debugEnabled(env) {
  return Boolean(env && env.COMMIT_GUARD_DEBUG === '1');
}

/**
 * Formats one stderr debug line (C:guard Output; G1): a single JSON object holding whatever
 * fields are known, terminated by a newline, so a reader always sees exactly one line.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function formatDebugLine(fields) {
  return `${JSON.stringify(fields)}\n`;
}

// GRD-02: unreadable, malformed or incomplete input, and any throw inside the guard, end
// silently (fail open); under debug, one stderr line records whatever fields were known
// before giving up.
function failOpen(known, debug) {
  return debug ? { stdout: '', stderr: formatDebugLine(known) } : NO_OUTPUT;
}

/**
 * Runs the hook over the raw stdin text.
 *
 * @param {string} stdinText the PreToolUse JSON as read from stdin.
 * @param {{ env?: Record<string, string|undefined>, claudeHome?: string, now?: () => number }} [context]
 * @returns {{ stdout: string, stderr: string }}
 */
export function runHook(stdinText, context = {}) {
  const debug = debugEnabled(context.env);
  const known = {};
  try {
    const payload = JSON.parse(stdinText);
    if (payload && typeof payload === 'object' && typeof payload.agent_id === 'string') {
      known.agent_id = payload.agent_id;
    }
    const toolName = payload && payload.tool_name;
    if (typeof toolName !== 'string' || !Object.hasOwn(SHELL_OF, toolName)) {
      return failOpen(known, debug);
    }
    // `payload` is already known truthy here: `toolName` above is a string only when
    // `payload.tool_name` read that way, which requires `payload` itself to be truthy.
    const command = payload.tool_input && payload.tool_input.command;
    if (typeof command !== 'string') {
      return failOpen(known, debug);
    }
    if (!mentionsCommit(command)) return NO_OUTPUT;
    const shell = SHELL_OF[toolName];
    const parsed = segments(command, shell);
    const result = classify(parsed, { agentType: payload.agent_type, shell });
    if (result.decision === 'deny') return { stdout: denyOutput(result.message), stderr: '' };
    return NO_OUTPUT;
  } catch {
    return failOpen(known, debug);
  }
}

/**
 * The deny JSON on stdout (C:guard Output); the guard emits no other permission decision.
 *
 * @param {string} message
 * @returns {string}
 */
export function denyOutput(message) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  });
}

// The mention text, for the early-exit check only (C:guard Parsing step 1), in this order:
// every NUL and carriage return removed (bash drops every NUL of its input, the Windows bash
// every carriage return); every escaped newline of either shell (`\` or a backtick, then a
// newline) removed regardless of quotes; every `$` directly before a quote character
// removed; every `'`, `"`, `\`, backtick and typographic quote U+2018-U+201B, U+201C-U+201E
// removed. Parsing still sees the command as written, so a split `co''mmit`, `co$'m'mit` or
// `com\` plus newline plus `mit` reaches the tokenizer. One text covers both Bash readings
// (with and without carriage returns): it only ever removes characters that are not letters,
// and removes every character the carriage-return-kept reading's mention text would, so any
// `commit` there is also found here.
const NUL_OR_CR = /[\0\r]/g;
const ESCAPED_NEWLINE = /[\\`]\n/g;
const DOLLAR_BEFORE_QUOTE = /\$(?=['"\u2018-\u201E])/g;
const QUOTE_LIKE = /['"\\`\u2018-\u201E]/g;

/**
 * Whether the command skips the early exit: its mention text contains `commit`, compared
 * case-insensitively (ASCII letters only).
 *
 * @param {string} command
 * @returns {boolean}
 */
export function mentionsCommit(command) {
  const text = command.replace(NUL_OR_CR, '').replace(ESCAPED_NEWLINE, '').replace(DOLLAR_BEFORE_QUOTE, '').replace(QUOTE_LIKE, '');
  return /commit/i.test(text);
}

/**
 * Reads a stream to its end, asynchronously (a synchronous read of descriptor 0 throws on
 * Windows pipes), and decodes the joined bytes as UTF-8, so a character cut between two
 * chunks stays whole.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the hook's stdin and writes its result: the process-facing side of `runHook`.
 *
 * @param {{ stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream,
 *   stderr: NodeJS.WritableStream, env: Record<string, string|undefined>,
 *   claudeHome: string, now: () => number }} io
 * @returns {Promise<void>}
 */
export async function main({ stdin, stdout, stderr, env, claudeHome, now }) {
  let stdinText;
  try {
    stdinText = await readStdin(stdin);
  } catch {
    // GRD-02: a throw reading stdin happens before anything is known at all.
    if (debugEnabled(env)) stderr.write(formatDebugLine({}));
    return;
  }
  const result = runHook(stdinText, { env, claudeHome, now });
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
}
