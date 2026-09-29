'use strict';

// Stub for the kill-backstop self-test (FND-04): spawns a grandchild that inherits this
// process's stdout pipe but escapes into its own POSIX session (`detached: true`, i.e.
// `setsid`), then hangs forever itself. killTree's tree-kill signals only the process group
// the harness's direct child leads (`process.kill(-pid, 'SIGKILL')`, tests/helpers/
// process-seam.js); a grandchild in its own session is not a member of that group, so the
// signal kills the direct child but leaves the grandchild running with stdout still open.
// The child's `close` event then never fires, and runEntry's kill backstop must reject
// instead of hanging forever.
//
// The grandchild's pid is written to the file named by argv[2] (after the grandchild has
// been spawned) so the test that drives this stub can SIGKILL it in cleanup: nothing else
// ever reaps it, since it has escaped both the process group killTree targets and this
// process's own lifetime. As a second line of defence against leaking an immortal node
// process (e.g. if the test process itself is killed before cleanup runs), the grandchild
// self-exits after 30s instead of hanging forever.
//
// POSIX only (see the test that drives this stub): the tree-kill mechanism it defeats is
// POSIX process groups; on win32 killTree uses `taskkill /T`, which walks the OS's own
// parent/child records rather than a process group and is exercised by the plain-tree-kill
// self-test instead.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const pidFile = process.argv[2];

const grandchild = spawn(
  process.execPath,
  ['-e', 'setTimeout(() => {}, 30000)'],
  {
    detached: true,
    stdio: ['ignore', 'inherit', 'ignore'],
  },
);
grandchild.unref();
if (pidFile) fs.writeFileSync(pidFile, String(grandchild.pid));

setInterval(() => {}, 1000);
