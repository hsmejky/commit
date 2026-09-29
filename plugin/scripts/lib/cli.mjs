// M1 CLI and envelope (docs/spec/modules-m1-m9.md, C:cli-and-exit-codes, Q9).
//
// `main` peels the subcommand off argv and returns the single JSON object the entry point
// prints (`version: 1`) with its exit code. M1 alone owns the envelope and the kind → exit
// code map (architectural decisions "Typed results and one error table"); the domain code →
// kind side of that table is `lib/domain-codes.mjs` (M18, RPL-03). This is still the RPL-01/
// RPL-02 tracer for argv: no or an unknown subcommand is a `usage` refusal; per-subcommand
// argv parsing (RPL-02) and the routing to the M18 workflows come later.

/** The subcommands of the synopsis in C:cli-and-exit-codes. */
const SUBCOMMANDS = Object.freeze(['plan', 'check', 'commit', 'release', 'infer']);

// Kind → exit code, the exit table of C:cli-and-exit-codes, 0-6 (0 is `ok`, carried by the
// caller building a success envelope directly; there is no failure kind for it here).
const EXIT_CODES = Object.freeze({
  usage: 1,
  config: 1,
  env: 1,
  internal: 1,
  lint: 2,
  scan: 3,
  git: 4,
  timeout: 5,
  state: 6,
  signing: 6,
  pushed: 6,
  'staged-hit': 6,
  lock: 6,
  'index-lock': 6,
  'diff-changed': 6,
  'head-moved': 6,
});

/**
 * Builds the shared failure shape and its exit code.
 *
 * @param {string} kind a CLI error kind (C:cli-and-exit-codes).
 * @param {string} message
 * @returns {{ stdoutJson: object, exitCode: number }}
 * @throws {Error} when `kind` has no entry in `EXIT_CODES`: an unmapped kind would otherwise
 *   silently exit 0 with `ok: false` (`EXIT_CODES[kind]` reading `undefined`).
 */
export function failure(kind, message) {
  const exitCode = EXIT_CODES[kind];
  if (exitCode === undefined) {
    throw new Error(`no exit code mapped for kind ${JSON.stringify(kind)}`);
  }
  return {
    stdoutJson: { version: 1, ok: false, error: { kind, message } },
    exitCode,
  };
}

/**
 * Runs one CLI call.
 *
 * @param {string[]} argv the arguments after the script path.
 * @param {object} env the injected environment the entry point resolved once
 *   (docs/spec/architectural-decisions.md "Injected environment"): `now`, `osHome`,
 *   `claudeHome`, `osUser`, `scriptPath`, `env`.
 * @returns {Promise<{ stdoutJson: object, exitCode: number }>} the single JSON object to
 *   print on stdout and the exit code.
 */
export async function main(argv, env) {
  const subcommand = argv[0];
  const expected = `expected one of ${SUBCOMMANDS.join(', ')}`;
  if (subcommand === undefined) {
    return failure('usage', `missing subcommand; ${expected}`);
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    return failure('usage', `unknown subcommand ${JSON.stringify(subcommand)}; ${expected}`);
  }
  // RPL-02+: every subcommand routes to M18 once its argv parsing and workflow exist.
  return failure('internal', `subcommand ${JSON.stringify(subcommand)} is not built yet`);
}
