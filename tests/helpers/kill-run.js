'use strict';

// Real kill of a `commit --all` call during a pre-commit hook, shared by the Seam 1 files that
// need a killed run (tests/plan-killed-leftover.test.js, tests/domain-code-reachability.test.js).
// The order matters: node dies alone first (its `git commit` child would otherwise see the hook
// die first, fail, and the executor's cleanup would unstage the group), and only after node
// closed does the hook's own process tree go, so no `git commit` or `sleep` outlives the test.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { COMMIT_ENTRY } = require('./process-seam.js');

const slash = (p) => p.replace(/\\/g, '/');

async function untilExists(file, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function killProcessTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Runs `commit <args>` in the case's repo with a pre-commit hook that records its own PID and
 * sleeps, SIGKILLs the call once the hook runs, then kills the hook. Leaves the repo without
 * the hook, the lock and the run folder as the killed call left them.
 */
async function killCommitInHook(c, args) {
  const pidFile = path.join(c.root, 'hook.pid');
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  // Under Windows' sh `$$` is an MSYS pid; `/proc/$$/winpid` is the one taskkill knows.
  const lines = [
    `{ cat /proc/$$/winpid 2>/dev/null || echo $$; } > '${slash(pidFile)}.tmp'`,
    `mv '${slash(pidFile)}.tmp' '${slash(pidFile)}'`,
    'exec sleep 120',
  ];
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
  const child = spawn(process.execPath, [COMMIT_ENTRY, 'commit', ...args], {
    cwd: c.repoDir, env: c.env, stdio: 'ignore', windowsHide: true,
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await untilExists(pidFile);
  child.kill('SIGKILL');
  await closed;
  killProcessTree(Number(fs.readFileSync(pidFile, 'utf8').trim()));
  // git commit fails now that its hook is gone; let it finish before the test touches the index.
  const lock = path.join(c.repoDir, '.git', 'index.lock');
  const end = Date.now() + 10_000;
  while (fs.existsSync(lock) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(hook);
}

module.exports = { killCommitInHook, untilExists };
