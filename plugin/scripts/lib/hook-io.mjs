// G1 Hook I/O (docs/spec/modules-shared-and-guard.md; C:guard Output and Parsing step 1).
//
// Reads the PreToolUse JSON from stdin to its end and decides what the hook prints. A
// command that does not mention `commit` ends early with no output. The guard's outputs are
// a deny or nothing (C:guard Output); a crash or unreadable input fails open.

import { Buffer } from 'node:buffer';

const NO_OUTPUT = Object.freeze({ stdout: '', stderr: '' });

/**
 * Runs the hook over the raw stdin text.
 *
 * @param {string} stdinText the PreToolUse JSON as read from stdin.
 * @param {{ env?: Record<string, string|undefined>, claudeHome?: string, now?: () => number }} [context]
 * @returns {{ stdout: string, stderr: string }}
 */
export function runHook(stdinText, context = {}) {
  let command;
  try {
    command = JSON.parse(stdinText).tool_input.command;
  } catch {
    return NO_OUTPUT;
  }
  if (typeof command !== 'string' || !mentionsCommit(command)) return NO_OUTPUT;
  // Tokenizing (G2) and classifying (G3) follow here (GRD-03); until they exist, a command
  // that mentions `commit` ends with no output too.
  return NO_OUTPUT;
}

// The characters removed for the early-exit check only (C:guard Parsing step 1): `'`, `"`,
// `\`, backtick, and the typographic quotes U+2018-U+201B and U+201C-U+201E. Parsing still
// sees the command as written, so a split `co''mmit` reaches the tokenizer.
const QUOTE_LIKE = /['"\\`\u2018-\u201E]/g;

/**
 * Whether the command skips the early exit: with every quote-like character removed, it
 * contains `commit`, compared case-insensitively (ASCII letters only).
 *
 * @param {string} command
 * @returns {boolean}
 */
export function mentionsCommit(command) {
  return /commit/i.test(command.replace(QUOTE_LIKE, ''));
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
  const stdinText = await readStdin(stdin);
  const result = runHook(stdinText, { env, claudeHome, now });
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
}
