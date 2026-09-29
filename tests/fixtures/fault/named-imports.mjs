// Stub library for the fault-preload self-test (FND-10): stands in for a library module
// (`plugin/scripts/lib/*.mjs`) that reaches `fs`/`os` through named ESM imports, the way
// `docs/spec/testing-seams.md` ("Fault-injection preload at Seam 1") requires the preload to
// support (`module.syncBuiltinESMExports()` after patching). Driven by
// `tests/fixtures/fault/run-named-imports.cjs`, a `.cjs` stub entry point, like the real
// entry points (Architectural decisions, "Module type fixed by extension").
//
// Same program/outcome shape as tests/fixtures/fault/run-ops.cjs, reached here through named
// imports instead of property access on the module object. The link/rename promise forms are
// imported from `node:fs/promises` (KD-R29), not `node:fs`'s `promises` property, so the
// preload's patch is checked against both module specifiers.

import { linkSync, renameSync, link, rename } from 'node:fs';
import { link as linkPromise, rename as renamePromise } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

export async function runProgram(program) {
  const results = [];
  for (const step of program) {
    switch (step.op) {
      case 'write':
        mkdirSync(dirname(step.path), { recursive: true });
        writeFileSync(step.path, step.content || '');
        results.push({ op: step.op, ok: true });
        break;
      case 'mkdir':
        mkdirSync(step.path, { recursive: true });
        results.push({ op: step.op, ok: true });
        break;
      case 'userInfo':
        results.push(outcome(step.op, () => userInfo()));
        break;
      case 'linkSync':
        results.push(outcome(step.op, () => linkSync(step.existing, step.newPath)));
        break;
      case 'renameSync':
        results.push(outcome(step.op, () => renameSync(step.oldPath, step.newPath)));
        break;
      case 'link':
        results.push(await callbackOutcome(step.op, (cb) => link(step.existing, step.newPath, cb)));
        break;
      case 'rename':
        results.push(await callbackOutcome(step.op, (cb) => rename(step.oldPath, step.newPath, cb)));
        break;
      case 'linkPromise':
        results.push(await promiseOutcome(step.op, () => linkPromise(step.existing, step.newPath)));
        break;
      case 'renamePromise':
        results.push(await promiseOutcome(step.op, () => renamePromise(step.oldPath, step.newPath)));
        break;
      default:
        throw new Error(`named-imports: unknown op ${step.op}`);
    }
  }
  return results;
}
