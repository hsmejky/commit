// M11 Signing probe (docs/spec/modules-m10-m13.md, C:plan `signing`, Q18): whether a commit
// will be signed, and whether signing can go through without a prompt `plan` cannot see.
// Effectful (git config reads through M2, direct key-file reads, and one `ssh-add -L`); it
// never runs a signing program, so it never pops up a prompt.
//
// GIT-10 builds the enabled flag and the non-SSH formats: openpgp → `"prompt"`, x509 or a
// custom openpgp program → `"unknown"`, a custom `gpg.ssh.program` → `"prompt"`. The git
// calls' per-call timeout from `deadline` is GIT-07's.
//
// GIT-11 resolves `user.signingKey` through the key-source table of C:plan (unset, a literal
// key, a `.pub` path, any other path; `~/` against the injected OS home, `~user/` unknown,
// a relative path against the toplevel) and reads the private key file's header (OpenSSH
// `openssh-key-v1` cipher, or a PEM `ENCRYPTED` marker) with no extra process.
//
// GIT-12 adds the `ssh-add -L` check: `ssh-add` from the directory of the `ssh-keygen` git
// runs (`locateSshAdd`), its listing compared by key type and base64 blob, exit 1/2 as an
// empty list, any other exit or the fixed `SSH_ADD_TIMEOUT_MS` as "not run"; a `false`
// resting on a check that was not run is `"unknown"` (the case table's last row).

import { run } from './process-adapter.mjs';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
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
// base64 body between the PEM-style armor decodes to this literal prefix, followed by
// length-prefixed strings (SSH wire format: 4-byte big-endian length then bytes): the cipher
// name, the kdf name, the kdf options, then a key count and each public key blob, all in the
// clear even when the private section is encrypted.
const OPENSSH_MAGIC = 'openssh-key-v1\0';
// Cheap gate for "this is an OpenSSH-labelled key" (review-GIT-11 finding 1): a plain
// substring check, so a malformed armor (no `END` line, trailing whitespace on `BEGIN`,
// CR-only line endings) still gates on the PEM rule below, instead of falling through to
// it just because the stricter `OPENSSH_ARMOR` match below failed. It is also cheaper than
// running that regex twice (finding 8).
const OPENSSH_BEGIN_MARKER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const OPENSSH_ARMOR = /-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;
const PEM_ARMOR = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// A reader over SSH wire-format strings; each read returns `null` once past the end.
function wireReader(body, offset) {
  return {
    string() {
      if (offset + 4 > body.length) return null;
      const len = body.readUInt32BE(offset);
      if (offset + 4 + len > body.length) return null;
      const value = body.subarray(offset + 4, offset + 4 + len);
      offset += 4 + len;
      return value;
    },
    uint32() {
      if (offset + 4 > body.length) return null;
      const value = body.readUInt32BE(offset);
      offset += 4;
      return value;
    },
  };
}

// Parses an `openssh-key-v1` private key file's content into its cipher name and its first
// public key (`{ type, blob }`, the blob base64 as `ssh-add -L` prints it; `null` when that
// part does not parse), or returns `null` when the armor, the base64, the magic or the
// cipher name does not parse (an unreadable header, C:plan).
function parseOpensshKey(content) {
  const match = content.match(OPENSSH_ARMOR);
  if (match === null) return null;
  // `Buffer.from(_, 'base64')` never throws: invalid characters are skipped, not rejected.
  const body = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (body.length < OPENSSH_MAGIC.length || body.toString('latin1', 0, OPENSSH_MAGIC.length) !== OPENSSH_MAGIC) {
    return null;
  }
  const reader = wireReader(body, OPENSSH_MAGIC.length);
  const cipher = reader.string();
  if (cipher === null) return null;
  let publicKey = null;
  const kdfName = reader.string();
  const kdfOptions = kdfName === null ? null : reader.string();
  const count = kdfOptions === null ? null : reader.uint32();
  const blob = count === null || count < 1 ? null : reader.string();
  const type = blob === null ? null : wireReader(blob, 0).string();
  if (type !== null && type.length > 0) {
    publicKey = { type: type.toString('latin1'), blob: blob.toString('base64') };
  }
  return { cipher: cipher.toString('utf8'), publicKey };
}

// A public key line (`<type> <base64> [comment]`, as in a `.pub` file, a literal
// `user.signingKey` and each line of `ssh-add -L`) as `{ type, blob }`, or `null`.
function parsePublicKey(text) {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '');
  if (line === undefined) return null;
  const [type, blob] = line.trim().split(/\s+/);
  if (blob === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  return { type, blob };
}

// The probe only ever needs the armor header, so a read past this many bytes would be
// wasted (review-GIT-11 finding 4); OpenSSH's own key-file cap is 1 MiB, and this is well
// above any real header.
const MAX_KEY_HEADER_BYTES = 64 * 1024;

// Reads at most `MAX_KEY_HEADER_BYTES` of a key file as UTF-8. `MISSING` when no file is
// there (`ENOENT`, `ENOTDIR`: "no private key file" in C:plan), `null` when it is not a
// regular file, larger than the cap, or any other read failure — never throws
// (review-GIT-11 finding 4). `user.signingKey` can point at anything: a `stat` first means a
// FIFO is never `open`ed (which would block `plan` forever) and a device file or a huge
// file is never read in full (C:plan "the probe never stalls `plan`").
const MISSING = Symbol('missing');

async function readKeyFile(filePath) {
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? MISSING : null;
  }
  if (!stats.isFile() || stats.size > MAX_KEY_HEADER_BYTES) return null;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// The private key file's header, read with no extra process (C:plan "SSH readiness"):
// `true` for an OpenSSH key with cipher `none` or a PEM key without an `ENCRYPTED` marker,
// `false` for an OpenSSH key with another cipher or a PEM key with one, and for no file at
// all; `'unknown'` when the file is too large, not a regular file, or its header is neither
// recognised form or does not parse. A file labelled as an OpenSSH key (the `BEGIN` marker
// present anywhere) is always decided by `parseOpensshKey`, never by the PEM rule
// (review-GIT-11 finding 1): a malformed armor is its `null`, which is `'unknown'` here, not
// a fall through to a PEM match that the same `BEGIN` line can also satisfy.
function keyHeaderReady(content) {
  if (content === MISSING) return false;
  if (content === null) return 'unknown';
  if (content.includes(OPENSSH_BEGIN_MARKER)) {
    const parsed = parseOpensshKey(content);
    if (parsed === null) return 'unknown';
    return parsed.cipher === 'none';
  }
  if (PEM_ARMOR.test(content)) return !content.includes('ENCRYPTED');
  return 'unknown';
}

/**
 * The fixed timeout of the `ssh-add -L` call (Q18, C:plan "SSH readiness"): past it the
 * check counts as not run, so a wedged agent cannot stall `plan`.
 */
export const SSH_ADD_TIMEOUT_MS = 5_000;

function envValue(env, name) {
  const key = Object.keys(env ?? {}).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(filePath, platform) {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== 'win32') accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where M11 takes `ssh-add` from (GIT-12, C:plan "SSH readiness"): the directory of the
 * `ssh-keygen` git runs, so it talks to the same agent. That `ssh-keygen` is the first one
 * on git's own `PATH`: git's exec path, then `PATH`; on Windows, Git for Windows' `usr/bin`
 * (three levels above the exec path `<prefix>/mingw64/libexec/git-core`) comes first. A
 * `PATH` `ssh-add` anywhere else (such as Windows OpenSSH, which talks to another agent) is
 * never used. Relative `PATH` entries are skipped.
 *
 * @param {{ execPath?: string|null, env: object, platform?: string }} options `execPath`:
 *   `git --exec-path`'s output, `null` when it could not be read; `env`: the injected
 *   environment (`PATH` matched case-insensitively); `platform`: defaults to the host's.
 * @returns {string|null} the `ssh-add` path, or `null` when no `ssh-keygen` is found or none
 *   sits next to the first one (the check is then not run).
 */
export function locateSshAdd({ execPath, env, platform = process.platform }) {
  const exe = platform === 'win32' ? '.exe' : '';
  const dirs = [];
  if (execPath) {
    if (platform === 'win32') dirs.push(path.resolve(execPath, '..', '..', '..', 'usr', 'bin'));
    dirs.push(execPath);
  }
  for (const dir of (envValue(env, 'PATH') ?? '').split(path.delimiter)) {
    if (path.isAbsolute(dir)) dirs.push(dir);
  }
  for (const dir of dirs) {
    if (!isExecutableFile(path.join(dir, `ssh-keygen${exe}`), platform)) continue;
    const sshAdd = path.join(dir, `ssh-add${exe}`);
    return isExecutableFile(sshAdd, platform) ? sshAdd : null;
  }
  return null;
}

// Runs `ssh-add -L` through M2 under `SSH_ADD_TIMEOUT_MS` with the injected environment
// (so the agent socket is the caller's) and stdin closed, so it can never prompt. Resolves
// the listed keys (`{ type, blob }[]`), `[]` for exit 1 (no identities) or exit 2 (no agent
// reachable), or `null` when the check did not run: a spawn error, any other exit, or the
// timeout.
async function listAgentKeys(file, { toplevel, env, now }) {
  let result;
  try {
    result = await run(file, ['-L'], { cwd: toplevel, env, now, timeoutMs: SSH_ADD_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (result.timedOut) return null;
  if (result.code === 1 || result.code === 2) return [];
  if (result.code !== 0) return null;
  const lines = result.stdout.toString('utf8').split(/\r?\n/);
  return lines.map(parsePublicKey).filter((key) => key !== null);
}

// `git --exec-path`, trimmed, or `null` when git cannot say.
async function gitExecPath({ toplevel, env, now }) {
  try {
    const result = await run('git', ['--exec-path'], { cwd: toplevel, env, now, readOnly: true });
    const value = result.stdout.toString('utf8').trim();
    return result.code === 0 && value !== '' ? value : null;
  } catch {
    return null;
  }
}

// The `ssh-add -L` check (GIT-12): the agent's keys, or `null` when the check is not run
// (no `ssh-add` next to git's `ssh-keygen`, `listAgentKeys`' own `null`, or — on Windows,
// where the locator's first step depends on it — an exec path that could not be read: with
// no `usr/bin` step to try, the locator would otherwise fall through to a `PATH` search,
// which can land on Windows OpenSSH and its own agent, a probe step that never finished
// deciding `false` on Q18's say (review-GIT-12 finding 1)).
async function agentKeys(context) {
  const execPath = context.execPath !== undefined ? context.execPath : await gitExecPath(context);
  if (execPath === null && process.platform === 'win32') return null;
  const sshAdd = locateSshAdd({ execPath, env: context.env });
  return sshAdd === null ? null : listAgentKeys(sshAdd, context);
}

const LITERAL_PREFIX = 'key::';

// The key-source table (C:plan `signing`): the public key (`{ type, blob }` or `null`) and
// the private key file's readiness from its header (`true`, `false`, `'unknown'`), or
// `null` when the key source cannot be resolved (`~user/`).
async function keySource(signingKey, context) {
  if (signingKey.startsWith(LITERAL_PREFIX) || signingKey.startsWith('ssh-')) {
    const literal = signingKey.startsWith(LITERAL_PREFIX) ? signingKey.slice(LITERAL_PREFIX.length) : signingKey;
    return { publicKey: parsePublicKey(literal), fileReady: false }; // no private key file
  }
  const resolved = resolveKeyPath(signingKey, context);
  if (resolved === null) return null;
  const isPub = signingKey.endsWith('.pub');
  const privateKeyPath = isPub ? resolved.slice(0, -4) : resolved;
  const publicText = await readKeyFile(isPub ? resolved : `${resolved}.pub`);
  const content = await readKeyFile(privateKeyPath);
  let publicKey = typeof publicText === 'string' ? parsePublicKey(publicText) : null;
  if (!isPub && publicText === MISSING && typeof content === 'string' && content.includes(OPENSSH_BEGIN_MARKER)) {
    publicKey = parseOpensshKey(content)?.publicKey ?? null;
  }
  return { publicKey, fileReady: keyHeaderReady(content) };
}

// SSH readiness (C:plan "SSH readiness", case table, in order): the public key listed by
// `ssh-add -L` → `true`; an unencrypted header → `true`; an encrypted header or no private
// key file → `false`; a header neither form → `"unknown"`; and a `false` while the
// `ssh-add -L` check was not run → `"unknown"`. The check is skipped when it cannot change
// the answer: an unencrypted header is `true` either way, and with no public key there is
// nothing to compare (the check counts as not run).
async function sshReadiness(format, values, context) {
  if (isCustom(values.get('gpg.ssh.program'), format)) return 'prompt';
  const raw = await gitConfig(['--get', 'user.signingKey'], context);
  if (raw === null) return 'unknown'; // unset, with or without gpg.ssh.defaultKeyCommand
  const source = await keySource(raw.replace(/\r?\n$/, ''), context);
  if (source === null) return 'unknown'; // ~user/
  const { publicKey, fileReady } = source;
  if (fileReady === true) return true;
  if (publicKey === null) return 'unknown';
  const keys = await agentKeys(context);
  if (keys === null) return 'unknown';
  if (keys.some((key) => key.type === publicKey.type && key.blob === publicKey.blob)) return true;
  return fileReady;
}

async function readiness(format, values, entries, context) {
  if (format === 'openpgp') return isCustomOpenpgp(lastOpenpgpProgram(entries)) ? 'unknown' : 'prompt';
  if (format === 'ssh') return sshReadiness(format, values, context);
  return 'unknown';
}

/**
 * M11 `probeSigning` (GIT-10): reads `commit.gpgsign` with `--type=bool`, then, when it is
 * true, `gpg.format` and the signing programs, over the merged config (an exported
 * `GIT_CONFIG_SYSTEM` included, M2's keep-set). Spawns only git and, for an SSH key the
 * header alone cannot clear, the `ssh-add` next to git's `ssh-keygen` (GIT-12).
 *
 * @param {{ toplevel: string, env: object, now?: () => number, osHome: string,
 *   execPath?: string|null }} options
 *   `toplevel`: git's working directory; `env`: the injected process environment; `now`: the
 *   injected clock; `osHome` (GIT-11): the injected OS home, against which a `user.signingKey`
 *   starting with `~/` is expanded; `execPath` (GIT-12): `git --exec-path`, asked of git
 *   when left out.
 * @returns {Promise<{ enabled: false } | { enabled: true, format?: 'openpgp'|'ssh'|'x509',
 *   ready: true|false|'prompt'|'unknown' }>} `{ enabled: false }` when `commit.gpgsign` is
 *   unset or false. `format` defaults to `openpgp` (git's default) and is left out for a
 *   `gpg.format` git does not know (git refuses to sign with it), which gives `"unknown"`.
 *   A `commit.gpgsign` value that is not a boolean is a case the probe cannot decide either:
 *   `{ enabled: true, ready: "unknown" }` (`git commit` reports git's own error, same as a
 *   `gpg.format` git does not know). `ready` is `false` only for an SSH key with a
 *   passphrase (or no private key file) that a trusted `ssh-add -L` does not list.
 * @throws {Error} when the `gpg.*` config read exits other than 0 or 1.
 */
export async function probeSigning({ toplevel, env, now, osHome, execPath }) {
  const at = { toplevel, env, now, osHome, execPath };
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
