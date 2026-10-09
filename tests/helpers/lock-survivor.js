'use strict';

// Shared by tests/commit-guarded-lock.test.js (CHG-23) and tests/commit-all-reword-lock.test.js
// (EXE-21): a git hook that ignores SIGTERM and a detached survivor that re-creates `index.lock`
// while M2 kills the hook tree.

const fs = require('node:fs');
const path = require('node:path');

const slash = (p) => p.replace(/\\/g, '/');

function installHook(c, name, lines) {
  const hook = path.join(c.repoDir, '.git', 'hooks', name);
  fs.writeFileSync(hook, `#!/bin/sh\n${lines.join('\n')}\n`);
  fs.chmodSync(hook, 0o755);
}

const lockOf = (c) => path.join(c.repoDir, '.git', 'index.lock');

// The survivor outlives the killed tree (its launcher exits at once): once the second marker
// exists it waits 0.5 s, then makes sure `index.lock` exists and sets its mtime to
// `markerStart - startOffsetMs` or `markerKill + killOffsetMs`.
function installSurvivor(c, { startOffsetMs, killOffsetMs }) {
  const gitDir = path.join(c.repoDir, '.git');
  const survivor = path.join(c.root, 'survivor.js');
  const target = startOffsetMs === undefined ? `kill + ${killOffsetMs}` : `start - ${startOffsetMs}`;
  fs.writeFileSync(survivor, `
const fs = require('node:fs');
const dir = ${JSON.stringify(gitDir)};
const lock = dir + '/index.lock';
const deadline = Date.now() + 30000;
(function poll() {
  if (!fs.existsSync(dir + '/commit-guard-kill')) {
    if (Date.now() < deadline) setTimeout(poll, 20);
    return;
  }
  const giveUp = Date.now() + 2500;
  setTimeout(function create() {
    // git may still be cleaning up its own lock (POSIX removes it on SIGTERM): wait, bounded.
    if (fs.existsSync(lock) && Date.now() < giveUp) return setTimeout(create, 20);
    const start = fs.statSync(dir + '/commit-guard-start').mtimeMs;
    const kill = fs.statSync(dir + '/commit-guard-kill').mtimeMs;
    const at = ${target};
    if (!fs.existsSync(lock)) fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(at), new Date(at));
  }, 500);
})();
`);
  const launcher = path.join(c.root, 'launcher.js');
  fs.writeFileSync(launcher, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(survivor)}], { detached: true, stdio: 'ignore' }).unref();\n`);
  installHook(c, 'pre-commit', [
    `if [ -e '${slash(lockOf(c))}' ]; then : > '${slash(path.join(c.root, 'lock.seen'))}'; fi`,
    `'${slash(process.execPath)}' '${slash(launcher)}'`,
    'trap "" TERM',
    'sleep 120',
  ]);
}

module.exports = { slash, installHook, lockOf, installSurvivor };
