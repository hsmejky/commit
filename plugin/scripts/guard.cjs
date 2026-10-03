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
    var claudeHome;
    try {
      // S1's one resolution (re-exported by G1), shared with the commit entry point, so
      // guard and `plan` find the same Claude home (C:guard Heartbeat, GRD-17).
      claudeHome = g1.resolveClaudeHome(env, require('node:os').homedir);
    } catch (e) {
      // The Claude home is only ever needed for the heartbeat write (S1); a lookup failure
      // here (e.g. no HOME/USERPROFILE and no passwd entry) must not drop the guard's
      // decision for every command. Passing no Claude home makes the inner catch in G1's
      // writePlanHeartbeat throw and swallow it instead (C:guard Heartbeat).
      claudeHome = undefined;
    }
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
