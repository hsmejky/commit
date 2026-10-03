'use strict';

// Commit entry point (Q1, Q15; docs/spec/architectural-decisions.md "Entry points survive
// an old Node", "Injected environment", "Module type fixed by extension").
//
// A thin CommonJS shell with no domain logic: it checks the Node version first, resolves
// the injected environment once, loads M1 (`lib/cli.mjs`) with a dynamic `import()`, and
// writes the one JSON object M1 returns to stdout with M1's exit code. Written in syntax
// every Node since 12 parses, so an old Node gets the `env` refusal, not a SyntaxError.
// Debug output goes to stderr only. It never reads stdin.

var MIN_NODE_MAJOR = 22;

function writeResult(stdoutJson, exitCode) {
  process.stdout.write(JSON.stringify(stdoutJson) + '\n');
  // Never `process.exit()`: it can cut a piped stdout short on Windows.
  process.exitCode = exitCode;
}

// The failure shape of C:cli-and-exit-codes, for the two outcomes that happen before or
// without M1: an old Node (`env`) and a library that fails to load or throws (`internal`).
function failure(kind, message) {
  return { version: 1, ok: false, error: { kind: kind, message: message } };
}

var nodeVersion = String(process.versions.node);
var nodeMajor = parseInt(nodeVersion.split('.')[0], 10);

if (!(nodeMajor >= MIN_NODE_MAJOR)) {
  writeResult(failure('env', 'Node ' + nodeVersion + ' is older than ' + MIN_NODE_MAJOR
    + '; /commit needs Node ' + MIN_NODE_MAJOR + ' or newer'), 1);
} else {
  var path = require('path');
  var os = require('os');
  var url = require('url');

  var osHome = os.homedir();
  var osUser;
  try {
    osUser = os.userInfo().username || null;
  } catch (err) {
    osUser = null;
  }
  if (!osUser) osUser = process.env.USER || process.env.USERNAME || null;

  // M5's managed layer (CFG-11, Q5 Amended, PRE-16): the fixed, platform-derived directory
  // holding `managed-settings.json` (its drop-in directory is not read in 0.1.0). Derived
  // from `process.platform` only, never from `env`, so an agent cannot redirect the highest
  // settings layer; there is no env knob for it, matching the "no test-only switch" rule
  // (docs/spec/architectural-decisions.md). PRE-16's recorded paths: macOS
  // `/Library/Application Support/ClaudeCode`; Linux and WSL (both report `linux`)
  // `/etc/claude-code`; Windows `C:\Program Files\ClaudeCode` (not the legacy
  // `C:\ProgramData\ClaudeCode`, which Claude Code no longer reads).
  function resolveManagedDir(platform) {
    if (platform === 'darwin') return path.join('/Library', 'Application Support', 'ClaudeCode');
    if (platform === 'win32') return path.join('C:\\', 'Program Files', 'ClaudeCode');
    return path.join('/etc', 'claude-code');
  }

  var injected = {
    now: function () { return Date.now(); },
    osHome: osHome,
    // Set once S1 (`lib/heartbeat.mjs`) has loaded, below: its `resolveClaudeHome` is the
    // one resolution the guard entry point uses too (C:guard Heartbeat, GRD-17).
    claudeHome: null,
    managedDir: resolveManagedDir(process.platform),
    osUser: osUser,
    cwd: process.cwd(),
    // M5's project layers (CFG-10, Q5, PRE-11): the project directory is `CLAUDE_PROJECT_DIR`
    // when set, else this process's own cwd; no walk-up to a git toplevel. Resolved once
    // here, like `claudeHome`, and injected: M5 never reads `env` or the cwd itself to find
    // it.
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    // The reply contract (docs/contracts/reply-and-handback.md "run") names
    // `process.argv[1]`, not `__filename`: they can differ through a symlink (e.g. a
    // plugin cache linked into place), and the `run` command must match the path the
    // process was actually invoked with.
    scriptPath: process.argv[1],
    env: process.env,
    // CFG-06: M18's `loadConfigLayers` writes each config warning here as it queues it onto
    // `plan.warnings` (Q6 "Warnings go to plan.warnings and stderr"); the real stream,
    // injected like every other ambient fact instead of read from `process` deep inside the
    // library.
    stderr: process.stderr,
  };

  // Every step from here on runs inside the chain, including the `JSON.stringify` of M1's
  // result: a stub `main` that resolves `undefined`, or a result holding a BigInt, throws
  // there, not in a handler outside the chain, so a single `.catch` below is the only place
  // that needs to turn a throw into the `internal` shape. A rejection handler passed as a
  // `.then` call's 2nd argument only catches a rejection of the promise it is chained from,
  // never a throw from that same `.then` call's own success handler, so building the output
  // string in the same handler that would throw, then a dedicated `.catch`, is what keeps
  // every throw path making it to the one final write below.
  Promise.all([
    import(url.pathToFileURL(path.join(__dirname, 'lib', 'cli.mjs')).href),
    import(url.pathToFileURL(path.join(__dirname, 'lib', 'heartbeat.mjs')).href),
  ])
    .then(function (modules) {
      injected.claudeHome = modules[1].resolveClaudeHome(process.env, function () { return osHome; });
      return modules[0].main(process.argv.slice(2), injected);
    })
    .then(function (result) {
      return { text: JSON.stringify(result.stdoutJson) + '\n', code: result.exitCode };
    })
    .catch(function (err) {
      process.stderr.write('commit: unexpected error\n' + ((err && err.stack) || String(err)) + '\n');
      return {
        text: JSON.stringify(failure('internal', 'unexpected error: ' + ((err && err.message) || String(err)))) + '\n',
        code: 1,
      };
    })
    .then(function (output) {
      process.stdout.write(output.text);
      // Never `process.exit()`: it can cut a piped stdout short on Windows.
      process.exitCode = output.code;
    });
}
