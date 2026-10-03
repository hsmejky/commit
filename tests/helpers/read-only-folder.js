'use strict';

// A folder whose entries cannot be unlinked (mode 0o555, one file inside), for the sweep's
// removal-error tests (RUN-08). The sweep passes the removal's error code through to its
// notice, and that code is the platform's: Linux reports EACCES, while macOS on Node 24
// (whose recursive `rmSync` is native) reports ENOTEMPTY. `removalErrorCode` derives the
// expected code by making the same removal on a probe folder, so the tests keep asserting
// the notice text exactly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Makes `dir` with one file inside, then takes away its write permission. */
function makeReadOnlyFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested'), 'x');
  fs.chmodSync(dir, 0o555);
  return dir;
}

/** The error code this platform's recursive `rmSync` (with the sweep's options) gives for such a folder. */
function removalErrorCode() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-probe-'));
  const probe = makeReadOnlyFolder(path.join(parent, 'probe'));
  try {
    fs.rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw new Error('the probe folder was removed: this platform cannot make a removal fail this way');
  } catch (err) {
    if (!err.code) throw err;
    return err.code;
  } finally {
    if (fs.existsSync(probe)) fs.chmodSync(probe, 0o755);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

module.exports = { makeReadOnlyFolder, removalErrorCode };
