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

  var injected = {
    now: function () { return Date.now(); },
    osHome: osHome,
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(osHome, '.claude'),
    osUser: osUser,
    scriptPath: __filename,
    env: process.env,
  };

  import(url.pathToFileURL(path.join(__dirname, 'lib', 'cli.mjs')).href)
    .then(function (cli) {
      return cli.main(process.argv.slice(2), injected);
    })
    .then(function (result) {
      writeResult(result.stdoutJson, result.exitCode);
    }, function (err) {
      process.stderr.write('commit: unexpected error\n' + ((err && err.stack) || String(err)) + '\n');
      writeResult(failure('internal', 'unexpected error: ' + ((err && err.message) || String(err))), 1);
    });
}
