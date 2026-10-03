// M11 Signing probe (docs/spec/modules-m10-m13.md, C:plan `signing`, Q18): whether a commit
// will be signed, and whether signing can go through without a prompt `plan` cannot see.
// Effectful (git config reads through M2, plus direct key-file reads for GIT-11); it never
// runs a signing program, so it never pops up a prompt.
//
// GIT-10 builds the enabled flag and the non-SSH formats: openpgp → `"prompt"`, x509 or a
// custom openpgp program → `"unknown"`, a custom `gpg.ssh.program` → `"prompt"`. SSH with
// the default program stays `"unknown"` until GIT-11 decides it from the key file (taking
// the injected OS home and the toplevel) and GIT-12 adds the `ssh-add -L` check (taking
// `execPath`); the per-call timeout from `deadline` is GIT-07's.
//
// GIT-11 resolves `user.signingKey` through the key-source table of C:plan (unset, a literal
// key, a `.pub` path, any other path; `~/` against the injected OS home, `~user/` unknown,
// a relative path against the toplevel) and reads the private key file's header (OpenSSH
// `openssh-key-v1` cipher, or a PEM `ENCRYPTED` marker) with no extra process. With no
// `ssh-add -L` check wired yet (GIT-12), every case but an unencrypted header is reported as
// `"unknown"` (the case table's last row: an untrusted `false` becomes `"unknown"`), never
// `false`.

import { run } from './process-adapter.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

// `git config -z --get-regexp` prints `key\nvalue\0` per entry, in config order.
function parseEntries(output) {
  const entries = [];
  for (const entry of (output ?? '').split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    if (newline === -1) entries.push([entry, 'true']);
    else entries.push([entry.slice(0, newline), entry.slice(newline + 1)]);
  }
  return entries;
}

// A later entry for the same key wins, as it does for git itself.
function lastValues(entries) {
  const values = new Map();
  for (const [key, value] of entries) values.set(key, value);
  return values;
}

// `gpg.program` and `gpg.openpgp.program` are one setting to git: whichever of the two keys
// comes last in config order wins, not "last per key".
function lastOpenpgpProgram(entries) {
  let value;
  for (const [key, entryValue] of entries) {
    if (key === 'gpg.program' || key === 'gpg.openpgp.program') value = entryValue;
  }
  return value;
}

function basename(path) {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

// "Custom" (C:plan `signing`, Q18): openpgp compares the basename, case-insensitive with any
// `.exe` suffix stripped, against `gpg`/`gpg2` (so `gpg2`, an absolute path, and `gpg.exe`
// all still count as default); ssh keeps a literal compare against `ssh-keygen`, since a
// different path there likely talks to a different signing agent.
function isCustomOpenpgp(value) {
  if (value === undefined) return false;
  const name = basename(value).toLowerCase().replace(/\.exe$/, '');
  return name !== 'gpg' && name !== 'gpg2';
}

function isCustom(value, format) {
  return value !== undefined && value !== DEFAULT_PROGRAMS[format];
}

// GIT-11 key-source table (C:plan `signing`): `~/` expands against the injected OS home,
// `~user/` cannot be resolved (`null`), a relative path resolves against the toplevel.
function resolveKeyPath(raw, { osHome, toplevel }) {
  if (raw === '~') return osHome;
  if (raw.startsWith('~/')) return path.join(osHome, raw.slice(2));
  if (raw.startsWith('~')) return null;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(toplevel, raw);
}

// The OpenSSH `openssh-key-v1` magic (git's own `sshsig.c`/upstream OpenSSH format): the
// base64 body between the PEM-style armor decodes to this literal prefix, followed by a
// length-prefixed cipher name string (SSH wire format: 4-byte big-endian length then bytes).
const OPENSSH_MAGIC = 'openssh-key-v1\0';
const OPENSSH_ARMOR = /-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;
const PEM_ARMOR = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// Reads the cipher name out of an `openssh-key-v1` private key file's content, or `null`
// when the armor, the base64 or the magic does not parse (an unreadable header, C:plan).
function opensshCipherName(content) {
  const match = content.match(OPENSSH_ARMOR);
  if (match === null) return null;
  let body;
  try {
    body = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
  if (body.length < OPENSSH_MAGIC.length || body.toString('latin1', 0, OPENSSH_MAGIC.length) !== OPENSSH_MAGIC) {
    return null;
  }
  let offset = OPENSSH_MAGIC.length;
  if (offset + 4 > body.length) return null;
  const len = body.readUInt32BE(offset);
  offset += 4;
  if (offset + len > body.length) return null;
  return body.toString('utf8', offset, offset + len);
}

// The private key file's header, read with no extra process (C:plan "SSH readiness"):
// `true` for an OpenSSH key with cipher `none` or a PEM key without an `ENCRYPTED` marker,
// `false` for an OpenSSH key with another cipher or a PEM key with one, `'unknown'` when the
// file is missing or its header is neither recognised form.
async function keyHeaderReady(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return 'unknown';
  }
  if (OPENSSH_ARMOR.test(content)) {
    const cipher = opensshCipherName(content);
    if (cipher === null) return 'unknown';
    return cipher === 'none';
  }
  if (PEM_ARMOR.test(content)) return !content.includes('ENCRYPTED');
  return 'unknown';
}

// GIT-11 SSH readiness from the key file (C:plan "SSH readiness", case table): resolves
// `user.signingKey` through the key-source table, then the private key file's header. No
// `ssh-add -L` check is wired yet (GIT-12), so the table's last row applies: every case but
// an unencrypted header reports `"unknown"` rather than the table's `false`.
async function sshReadiness(format, values, context) {
  if (isCustom(values.get('gpg.ssh.program'), format)) return 'prompt';
  const raw = await gitConfig(['--get', 'user.signingKey'], context);
  if (raw === null) return 'unknown'; // unset, with or without gpg.ssh.defaultKeyCommand
  const signingKey = raw.replace(/\r?\n$/, '');
  if (signingKey.startsWith('key::') || signingKey.startsWith('ssh-')) return 'unknown'; // literal key, no private key file
  const resolved = resolveKeyPath(signingKey, context);
  if (resolved === null) return 'unknown'; // ~user/
  const privateKeyPath = signingKey.endsWith('.pub') ? resolved.slice(0, -4) : resolved;
  const ready = await keyHeaderReady(privateKeyPath);
  return ready === true ? true : 'unknown';
}

async function readiness(format, values, entries, context) {
  if (format === 'openpgp') return isCustomOpenpgp(lastOpenpgpProgram(entries)) ? 'unknown' : 'prompt';
  if (format === 'ssh') return sshReadiness(format, values, context);
  return 'unknown';
}

/**
 * M11 `probeSigning` (GIT-10): reads `commit.gpgsign` with `--type=bool`, then, when it is
 * true, `gpg.format` and the signing programs, over the merged config (an exported
 * `GIT_CONFIG_SYSTEM` included, M2's keep-set). Spawns only git.
 *
 * @param {{ toplevel: string, env: object, now?: () => number, osHome: string }} options
 *   `toplevel`: git's working directory; `env`: the injected process environment; `now`: the
 *   injected clock; `osHome` (GIT-11): the injected OS home, against which a `user.signingKey`
 *   starting with `~/` is expanded.
 * @returns {Promise<{ enabled: false } | { enabled: true, format?: 'openpgp'|'ssh'|'x509',
 *   ready: true|false|'prompt'|'unknown' }>} `{ enabled: false }` when `commit.gpgsign` is
 *   unset or false. `format` defaults to `openpgp` (git's default) and is left out for a
 *   `gpg.format` git does not know (git refuses to sign with it), which gives `"unknown"`.
 *   A `commit.gpgsign` value that is not a boolean is a case the probe cannot decide either:
 *   `{ enabled: true, ready: "unknown" }` (`git commit` reports git's own error, same as a
 *   `gpg.format` git does not know). `ready` is `false` only once GIT-12 wires the
 *   `ssh-add -L` check; until then an SSH key the header alone cannot clear is `"unknown"`.
 * @throws {Error} when the `gpg.*` config read exits other than 0 or 1.
 */
export async function probeSigning({ toplevel, env, now, osHome }) {
  const at = { toplevel, env, now, osHome };
  let enabled;
  try {
    enabled = await gitConfig(['--type=bool', '--get', 'commit.gpgsign'], at);
  } catch {
    return { enabled: true, ready: 'unknown' };
  }
  if (enabled === null || enabled.trim() !== 'true') return { enabled: false };
  const entries = parseEntries(await gitConfig(['-z', '--get-regexp', '^gpg\\.'], at));
  const values = lastValues(entries);
  const format = values.get('gpg.format') ?? 'openpgp';
  if (!Object.hasOwn(DEFAULT_PROGRAMS, format)) return { enabled: true, ready: 'unknown' };
  return { enabled: true, format, ready: await readiness(format, values, entries, at) };
}
