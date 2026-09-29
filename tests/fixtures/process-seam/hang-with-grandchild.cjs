'use strict';

// Stub entry point for the process-seam self-test (FND-04): spawns a grandchild that does
// not exit on its own, records its pid to the file named by argv[2], then hangs forever
// itself, so a SIGKILL of only this direct child leaves the grandchild running and proves
// the harness's timeout must kill the whole tree, not just the direct child.
//
// On POSIX the grandchild is left plain (like git, spawned by an entry point with no special
// options): it inherits the direct child's process group, which is what the harness's
// tree-kill targets. On Windows a plain grandchild would already be torn down by the job
// object a plain child_process.spawn puts it in when the direct child's handles close, which
// would pass even without a tree-kill; `detached: true` takes it out of that job (as a
// breakaway helper process can do in practice), so only `taskkill /T` reaches it.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform === 'win32',
  stdio: 'ignore',
});
grandchild.unref();
fs.writeFileSync(pidFile, String(grandchild.pid));

setInterval(() => {}, 1000);
