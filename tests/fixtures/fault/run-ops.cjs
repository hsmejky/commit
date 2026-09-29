'use strict';

// Stub entry point for the fault-preload self-test (FND-10): runs a small JSON "program" of
// fs/os operations in argv[2], in order, through ordinary property access on the modules
// (`fs.linkSync(...)`, `os.userInfo()`, ...), and prints one JSON object with each op's
// outcome. This drives the preload's patches (docs/spec/testing-seams.md, "Fault-injection
// preload at Seam 1") the same way the plugin's own CommonJS-facing code would reach them.
//
// Program ops:
//   { "op": "write", "path": "<path>", "content": "<text>" }   writes a file (and its parents)
//   { "op": "mkdir", "path": "<path>" }                        creates a directory
//   { "op": "userInfo" }
//   { "op": "linkSync", "existing": "<path>", "newPath": "<path>" }
//   { "op": "renameSync", "oldPath": "<path>", "newPath": "<path>" }
//   { "op": "link", "existing": "<path>", "newPath": "<path>" }        (callback form)
//   { "op": "rename", "oldPath": "<path>", "newPath": "<path>" }       (callback form)
//   { "op": "linkPromise", "existing": "<path>", "newPath": "<path>" }
//   { "op": "renamePromise", "oldPath": "<path>", "newPath": "<path>" }
//
// Each op that can fail is recorded as `{ op, ok: true }` or
// `{ op, ok: false, code, syscall, path, dest }`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function outcome(op, fn) {
  try {
    fn();
    return { op, ok: true };
  } catch (err) {
    return {
      op,
      ok: false,
      code: err.code,
      syscall: err.syscall,
      path: err.path,
      dest: err.dest,
      info: err.info,
    };
  }
}

function callbackOutcome(op, run) {
  return new Promise((resolve) => {
    run((err) => {
      if (err) {
        resolve({
          op,
          ok: false,
          code: err.code,
          syscall: err.syscall,
          path: err.path,
          dest: err.dest,
          info: err.info,
        });
      } else resolve({ op, ok: true });
    });
  });
}

async function promiseOutcome(op, run) {
  try {
    await run();
    return { op, ok: true };
  } catch (err) {
    return {
      op,
      ok: false,
      code: err.code,
      syscall: err.syscall,
      path: err.path,
      dest: err.dest,
      info: err.info,
    };
  }
}

async function runProgram(program) {
  const results = [];
  for (const step of program) {
    switch (step.op) {
      case 'write':
        fs.mkdirSync(path.dirname(step.path), { recursive: true });
        fs.writeFileSync(step.path, step.content || '');
        results.push({ op: step.op, ok: true });
        break;
      case 'mkdir':
        fs.mkdirSync(step.path, { recursive: true });
        results.push({ op: step.op, ok: true });
        break;
      case 'userInfo':
        results.push(outcome(step.op, () => os.userInfo()));
        break;
      case 'linkSync':
        results.push(outcome(step.op, () => fs.linkSync(step.existing, step.newPath)));
        break;
      case 'renameSync':
        results.push(outcome(step.op, () => fs.renameSync(step.oldPath, step.newPath)));
        break;
      case 'link':
        results.push(await callbackOutcome(step.op, (cb) => fs.link(step.existing, step.newPath, cb)));
        break;
      case 'rename':
        results.push(await callbackOutcome(step.op, (cb) => fs.rename(step.oldPath, step.newPath, cb)));
        break;
      case 'linkPromise':
        results.push(await promiseOutcome(step.op, () => fs.promises.link(step.existing, step.newPath)));
        break;
      case 'renamePromise':
        results.push(await promiseOutcome(step.op, () => fs.promises.rename(step.oldPath, step.newPath)));
        break;
      default:
        throw new Error(`run-ops: unknown op ${step.op}`);
    }
  }
  return results;
}

runProgram(JSON.parse(process.argv[2])).then((results) => {
  process.stdout.write(`${JSON.stringify({ results })}\n`);
}, (err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
