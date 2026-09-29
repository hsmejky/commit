'use strict';

// Guard entry point: the PreToolUse hook (Q3, C:guard). Thin CommonJS over the ES module
// library, which it loads only dynamically, on the guarded line below (Q1, Q15). Written in
// syntax every Node since 12 parses: on a Node older than 22 it ends silently before loading
// the library, with no output and exit 0 (fail open). It resolves the environment once
// (Claude home, clock, env) and hands everything else to G1.

var major = Number(String(process.versions.node).split('.')[0]);

if (major >= 22) {
  import('./lib/hook-io.mjs').then(function (g1) {
    var env = process.env;
    var claudeHome = env.CLAUDE_CONFIG_DIR || require('node:path').join(require('node:os').homedir(), '.claude');
    return g1.main({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: env,
      claudeHome: claudeHome,
      now: Date.now,
    });
  }).then(null, function () {
    // Fail open: a crash anywhere ends with no output and exit 0 (C:guard Output). This
    // runs when the dynamic import itself rejects (the library never loaded, so it cannot
    // write its own debug line) or when main() rejects for some other reason; either way,
    // under debug this writes the one-line empty object itself (C:guard Output: "A crash …
    // logs the same way").
    if (process.env.COMMIT_GUARD_DEBUG === '1') process.stderr.write('{}\n');
    process.exitCode = 0;
  });
}
