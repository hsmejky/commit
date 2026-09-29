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
// POSIX only (see the test that drives this stub): the tree-kill mechanism it defeats is
// POSIX process groups; on win32 killTree uses `taskkill /T`, which walks the OS's own
// parent/child records rather than a process group and is exercised by the plain-tree-kill
// self-test instead.

const { spawn } = require('node:child_process');

spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
}).unref();

setInterval(() => {}, 1000);
