'use strict';

// Shared by the Bash oracle tests (tests/guard-bash-oracle.test.js,
// tests/guard-bash-exec-oracle.test.js): finds a working bash and reports its version.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// On Windows `bash` on PATH may be the WSL launcher; Git for Windows' own bash sits next to
// git's install root, found from `git --exec-path`.
function bashCandidates() {
  if (process.platform !== 'win32') return ['bash'];
  const found = [];
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (exec.status === 0) {
    const root = exec.stdout.trim().replace(/[\\/](?:mingw64|mingw32|clangarm64)?[\\/]?libexec[\\/]git-core$/i, '');
    found.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  }
  return [...found.filter((p) => fs.existsSync(p)), 'bash'];
}

/**
 * Runs a bash script given on stdin.
 *
 * @param {string} bash
 * @param {string} script
 * @param {string} cwd
 */
function runBash(bash, script, cwd) {
  return spawnSync(bash, [], { input: script, cwd, env: { ...process.env, LC_ALL: 'C' } });
}

/**
 * The first working bash, or null: `{ path, version, major }` from `BASH_VERSION`.
 *
 * @param {string} cwd
 * @returns {{ path: string, version: string, major: number } | null}
 */
function findBash(cwd) {
  for (const bash of bashCandidates()) {
    const probe = runBash(bash, "printf '%s\\0' a 'b c' \"$BASH_VERSION\"\n", cwd);
    const out = probe.status === 0 ? probe.stdout.toString('utf8') : '';
    const m = /^a\0b c\0((\d+)\.[^\0]*)\0$/.exec(out);
    if (m) return { path: bash, version: m[1], major: Number(m[2]) };
  }
  return null;
}

/**
 * The bash for an oracle test, or null after skipping the test; fails on CI (`CI` set) when
 * no working bash is found. Reports the bash version as a test diagnostic.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} cwd
 */
function requireBash(t, cwd) {
  const bash = findBash(cwd);
  if (bash === null) {
    if (process.env.CI) throw new Error('no working bash found on CI');
    t.skip('no working bash found');
    return null;
  }
  t.diagnostic(`bash ${bash.version} (${bash.path})`);
  return bash;
}

module.exports = { bashCandidates, runBash, findBash, requireBash };
