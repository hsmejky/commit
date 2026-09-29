// M1 CLI and envelope (docs/spec/modules-m1-m9.md, C:cli-and-exit-codes, Q9).
//
// `main` peels the subcommand off argv and returns the single JSON object the entry point
// prints (`version: 1`) with its exit code. M1 alone owns the envelope and the kind → exit
// code map. This is the RPL-01 tracer: no or an unknown subcommand is a `usage` refusal;
// per-subcommand argv parsing (RPL-02), the full exit table (RPL-03) and the routing to the
// M18 workflows come later.

/** The subcommands of the synopsis in C:cli-and-exit-codes. */
const SUBCOMMANDS = Object.freeze(['plan', 'check', 'commit', 'release', 'infer']);

// Kind → exit code, C:cli-and-exit-codes. Only the kinds this tracer can produce so far.
const EXIT_CODES = Object.freeze({
  usage: 1,
  internal: 1,
});

/**
 * Builds the shared failure shape and its exit code.
 *
 * @param {string} kind a CLI error kind (C:cli-and-exit-codes).
 * @param {string} message
 * @returns {{ stdoutJson: object, exitCode: number }}
 */
function failure(kind, message) {
  return {
    stdoutJson: { version: 1, ok: false, error: { kind, message } },
    exitCode: EXIT_CODES[kind],
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
  return failure('internal', `subcommand ${JSON.stringify(subcommand)} is not built yet`);
}
