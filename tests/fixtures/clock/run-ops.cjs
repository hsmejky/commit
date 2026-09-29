'use strict';

// Stub entry point for the clock-preload self-test (FND-05): runs a small JSON "program" of
// Date.now() reads and side effects (creating a marker file, making a git commit) in
// argv[2], in order, and prints the recorded Date.now() values as the single JSON object a
// Seam 1 entry point writes to stdout. This lets a case drive the observable events
// (docs/spec/testing-seams.md, "Clock at Seam 1") the stepping clock schedule keys on,
// entirely inside one process, without any real waiting.
//
// Program ops:
//   { "op": "now" }                                  records Date.now()
//   { "op": "touch", "path": "<path>" }               creates an empty file (and its parents)
//   { "op": "commit", "cwd": "<repo>", "message": "x" } an empty git commit, to advance a reflog

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const program = JSON.parse(process.argv[2]);
const now = [];

for (const step of program) {
  switch (step.op) {
    case 'now':
      now.push(Date.now());
      break;
    case 'touch':
      fs.mkdirSync(path.dirname(step.path), { recursive: true });
      fs.writeFileSync(step.path, '');
      break;
    case 'commit':
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', step.message || 'x'], {
        cwd: step.cwd,
      });
      break;
    default:
      throw new Error(`run-ops: unknown op ${step.op}`);
  }
}

process.stdout.write(`${JSON.stringify({ now })}\n`);
