// M1 CLI and envelope (docs/spec/modules-m1-m9.md, C:cli-and-exit-codes, Q9).
//
// `main` peels the subcommand off argv and returns the single JSON object the entry point
// prints (`version: 1`) with its exit code. M1 alone owns the envelope and the kind → exit
// code map (architectural decisions "Typed results and one error table"); the domain code →
// kind side of that table is `lib/domain-codes.mjs` (M18, RPL-03). RPL-02 adds one strict
// `node:util` `parseArgs` per subcommand and the flag-combination rules of
// C:cli-and-exit-codes; every illegal combination and a malformed `planId` is refused
// `usage` here, before M18 (and everything below it, including any git call or the
// `.commit-plan` folder) is ever reached. A legal argv routes to its M18 workflow (INT-01:
// `plan`); a subcommand whose workflow is not built yet falls through to an `internal`
// placeholder.

import { parseArgs } from 'node:util';

import * as workflows from './workflows.mjs';

// The M18 workflow each subcommand routes to, as far as built. `plan --hunks` is its own
// synopsis form and not built yet, so `workflows.plan` refuses it.
const WORKFLOWS = Object.freeze({ plan: workflows.plan });

/** The subcommands of the synopsis in C:cli-and-exit-codes. */
const SUBCOMMANDS = Object.freeze(['plan', 'check', 'commit', 'release', 'infer']);

// `planId` is `crypto.randomUUID()` output (C:run-folder): a lowercase UUID v4, version
// nibble `4` and variant nibble `8`-`b` included, so an uppercase value, a path, or any
// other string that merely looks like a UUID is rejected.
const PLAN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Checks whether a value is a `planId` in the exact minted form (C:run-folder).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPlanId(value) {
  return typeof value === 'string' && PLAN_ID_PATTERN.test(value);
}

// One strict `parseArgs` options object per subcommand (C:cli-and-exit-codes synopsis).
// `no-user` is declared literally, as its own boolean flag: `node:util`'s `parseArgs` has no
// automatic `--no-<flag>` negation to opt out of, unlike some CLI-parsing libraries, so
// `--no-no-user` is simply an unrecognized flag under strict parsing, the same as any other
// typo. Exported (read-only) so a test can assert no flag name here ever mentions scanning
// (story 146: nothing here can gate the secret/path scan).
export const SUBCOMMAND_OPTIONS = Object.freeze({
  plan: Object.freeze({
    reword: { type: 'boolean' },
    dictated: { type: 'boolean' },
    staged: { type: 'boolean' },
    split: { type: 'boolean' },
    'take-over': { type: 'string' },
    'no-user': { type: 'boolean' },
    hunks: { type: 'boolean' },
    plan: { type: 'string' },
  }),
  check: Object.freeze({
    plan: { type: 'string' },
  }),
  commit: Object.freeze({
    plan: { type: 'string' },
    all: { type: 'boolean' },
    confirmed: { type: 'boolean' },
  }),
  release: Object.freeze({
    plan: { type: 'string' },
  }),
  infer: Object.freeze({}),
});

// Business rules `parseArgs` itself cannot express (it only knows a flag's type, not
// whether it is required or mutually exclusive with another). Each returns a usage message
// or `null` when `values` is legal. `plan`'s `confirmed` and `check`'s `all`/`confirmed` are
// not declared in SUBCOMMAND_OPTIONS at all, so passing them is already an unrecognized-flag
// `usage` refusal from `parseArgs` itself, before these rules run.
// Shared "--plan is required and must be a valid planId" rule for `check`, `commit` and
// `release` (RPL-02 review finding 6: this exact pair of checks appeared three times).
function requirePlanId(values) {
  if (values.plan === undefined) return '--plan <planId> is required';
  if (!isValidPlanId(values.plan)) return '--plan must be a lowercase UUID v4';
  return null;
}

// The flags of `plan`'s mint form (C:cli-and-exit-codes synopsis line 1), every one of which
// `--hunks` (line 2, its own separate form) excludes.
const MINT_FORM_FLAGS = ['reword', 'dictated', 'staged', 'split', 'take-over', 'no-user'];

const RULE_CHECKS = Object.freeze({
  plan(values) {
    const modeFlags = ['reword', 'staged', 'split'].filter((flag) => values[flag]);
    if (modeFlags.length > 1) {
      return `at most one of --reword, --staged or --split (got ${modeFlags.map((f) => `--${f}`).join(', ')})`;
    }
    if (values.dictated && !values.reword) {
      return '--dictated requires --reword';
    }
    if (values['no-user']) {
      if (values.staged) return '--no-user cannot be combined with --staged';
      if (values['take-over'] !== undefined) return '--no-user cannot be combined with --take-over';
      if (!values.split && !values.reword) return '--no-user requires --split or --reword';
    }
    // `plan --hunks --plan <planId>` is a separate synopsis form from the mint form above,
    // not a variant of it (RPL-02 review finding 1): `--hunks` excludes every mint-form flag,
    // and `--plan` itself belongs only to the `--hunks` form, never the mint form.
    if (values.hunks) {
      const mintFlagsSet = MINT_FORM_FLAGS.filter(
        (flag) => values[flag] !== undefined && values[flag] !== false,
      );
      if (mintFlagsSet.length > 0) {
        return `--hunks cannot be combined with ${mintFlagsSet.map((f) => `--${f}`).join(', ')}`;
      }
      if (values.plan === undefined) {
        return '--hunks requires --plan <planId>';
      }
    } else if (values.plan !== undefined) {
      return '--plan requires --hunks';
    }
    if (values.plan !== undefined && !isValidPlanId(values.plan)) {
      return '--plan must be a lowercase UUID v4';
    }
    if (values['take-over'] !== undefined && !isValidPlanId(values['take-over'])) {
      return '--take-over must be a lowercase UUID v4';
    }
    return null;
  },
  check: requirePlanId,
  commit(values) {
    const planError = requirePlanId(values);
    if (planError !== null) return planError;
    if (!values.all) return '--all is required';
    return null;
  },
  release: requirePlanId,
  infer() {
    return null;
  },
});

// Kind → exit code, the exit table of C:cli-and-exit-codes, 0-6 (0 is `ok`, carried by the
// caller building a success envelope directly; there is no failure kind for it here).
// Exported (read-only) so a test can assert its key set against the documented one instead
// of duplicating it (tests/cli.test.js).
export const EXIT_CODES = Object.freeze({
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
 *   silently exit 0 with `ok: false` (`EXIT_CODES[kind]` reading `undefined`), or, for a kind
 *   spelled like an inherited property (e.g. `toString`), resolve to that inherited value
 *   instead of being rejected (`Object.hasOwn` checks ownership, not just presence).
 */
export function failure(kind, message) {
  if (!Object.hasOwn(EXIT_CODES, kind)) {
    throw new Error(`no exit code mapped for kind ${JSON.stringify(kind)}`);
  }
  const exitCode = EXIT_CODES[kind];
  return {
    stdoutJson: { version: 1, ok: false, error: { kind, message } },
    exitCode,
  };
}

/**
 * Parses and validates one subcommand's argv: pure and side-effect free (no process, no
 * filesystem, no git), reachable directly at Seam 3. `main` builds the failure shape from
 * its result; a test can assert against the result itself instead of spawning a subprocess
 * for every legal synopsis line, which would otherwise depend on repo or index state the
 * argv rules themselves never need (RPL-02 review finding 2).
 *
 * @param {string} subcommand one of SUBCOMMANDS.
 * @param {string[]} args argv after the subcommand.
 * @returns {{ ok: true, values: object } | { ok: false, message: string }}
 */
export function parseArgv(subcommand, args) {
  // One strict parseArgs per subcommand (RPL-02): unknown flags, a flag given the wrong
  // shape (e.g. `--plan` with no value), and any other malformed argv all throw here, before
  // any git call and before a run folder could exist. `allowPositionals: false` rejects a
  // stray bare argument the synopsis never has room for.
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: SUBCOMMAND_OPTIONS[subcommand],
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { ok: false, message: `${subcommand}: ${err.message}` };
  }

  const ruleError = RULE_CHECKS[subcommand](values);
  if (ruleError !== null) {
    return { ok: false, message: `${subcommand}: ${ruleError}` };
  }

  return { ok: true, values };
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

  const parsed = parseArgv(subcommand, argv.slice(1));
  if (!parsed.ok) {
    return failure('usage', parsed.message);
  }

  const workflow = WORKFLOWS[subcommand];
  if (workflow === undefined) {
    // Every subcommand routes to M18 once its workflow exists; a legal argv is parsed and
    // validated here already.
    return failure('internal', `subcommand ${JSON.stringify(subcommand)} is not built yet`);
  }
  const result = await workflow(parsed.values, env, { cwd: process.cwd() });
  return { stdoutJson: { version: 1, ok: true, ...result.output }, exitCode: 0 };
}
