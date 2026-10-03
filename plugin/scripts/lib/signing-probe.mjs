// M11 Signing probe (docs/spec/modules-m10-m13.md, C:plan `signing`, Q18): whether a commit
// will be signed, and whether signing can go through without a prompt `plan` cannot see.
// Effectful (git config reads through M2); it never runs a signing program, so it never
// pops up a prompt.
//
// GIT-10 builds the enabled flag and the non-SSH formats: openpgp → `"prompt"`, x509 or a
// custom openpgp program → `"unknown"`, a custom `gpg.ssh.program` → `"prompt"`. SSH with
// the default program stays `"unknown"` until GIT-11 decides it from the key file (taking
// the injected OS home and the toplevel) and GIT-12 adds the `ssh-add -L` check (taking
// `execPath`); the per-call timeout from `deadline` is GIT-07's.

import { run } from './process-adapter.mjs';

// Each format's default program (git's `gpg-interface.c`): a configured program equal to
// it is not custom.
const DEFAULT_PROGRAMS = Object.freeze({ openpgp: 'gpg', x509: 'gpgsm', ssh: 'ssh-keygen' });

async function gitConfig(args, { toplevel, env, now }) {
  const result = await run('git', ['config', ...args], { cwd: toplevel, env, now, readOnly: true });
  if (result.code === 1) return null;
  if (result.code !== 0) {
    throw new Error(`git config ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout.toString('utf8');
}

// `git config -z --get-regexp` prints `key\nvalue\0` per entry, in config order: a later
// entry for the same key wins, as it does for git itself.
function lastValues(output) {
  const values = new Map();
  for (const entry of (output ?? '').split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    if (newline === -1) values.set(entry, 'true');
    else values.set(entry.slice(0, newline), entry.slice(newline + 1));
  }
  return values;
}

function isCustom(value, format) {
  return value !== undefined && value !== DEFAULT_PROGRAMS[format];
}

function readiness(format, values) {
  if (format === 'openpgp') {
    const custom = isCustom(values.get('gpg.program'), format)
      || isCustom(values.get('gpg.openpgp.program'), format);
    return custom ? 'unknown' : 'prompt';
  }
  if (format === 'ssh') return isCustom(values.get('gpg.ssh.program'), format) ? 'prompt' : 'unknown';
  return 'unknown';
}

/**
 * M11 `probeSigning` (GIT-10): reads `commit.gpgsign` with `--type=bool`, then, when it is
 * true, `gpg.format` and the signing programs, over the merged config (an exported
 * `GIT_CONFIG_SYSTEM` included, M2's keep-set). Spawns only git.
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options `toplevel`: git's
 *   working directory; `env`: the injected process environment; `now`: the injected clock.
 * @returns {Promise<{ enabled: false } | { enabled: true, format?: 'openpgp'|'ssh'|'x509',
 *   ready: true|false|'prompt'|'unknown' }>} `{ enabled: false }` when `commit.gpgsign` is
 *   unset or false. `format` defaults to `openpgp` (git's default) and is left out for a
 *   `gpg.format` git does not know (git refuses to sign with it), which gives `"unknown"`.
 *   `ready` is never `false` before GIT-11.
 * @throws {Error} when a `git config` read exits other than 0 or 1, e.g. a
 *   `commit.gpgsign` value that is not a boolean.
 */
export async function probeSigning({ toplevel, env, now }) {
  const at = { toplevel, env, now };
  const enabled = await gitConfig(['--type=bool', '--get', 'commit.gpgsign'], at);
  if (enabled === null || enabled.trim() !== 'true') return { enabled: false };
  const values = lastValues(await gitConfig(['-z', '--get-regexp', '^gpg\\.'], at));
  const format = values.get('gpg.format') ?? 'openpgp';
  if (!Object.hasOwn(DEFAULT_PROGRAMS, format)) return { enabled: true, ready: 'unknown' };
  return { enabled: true, format, ready: readiness(format, values) };
}
