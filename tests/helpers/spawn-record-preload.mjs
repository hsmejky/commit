// GIT-01 (docs/roadmap/06-git-adapters.md): a Node `--import` preload, loaded only from the
// test tree like the clock and fault preloads (docs/spec/testing-seams.md), that records
// every process the entry point spawns, so a Seam 1 case can assert how M2 spawns (every
// spawn sets `windowsHide`; an asynchronous spawn's stdout is never decoded) and who spawns
// (the calling library module). It changes no behavior. Never packaged.
//
// Environment variable:
//   COMMIT_TEST_SPAWN_LOG   a file path; every `node:child_process` call appends one JSON
//                           line `{ api, file, args, windowsHide, encoding, caller }`, and a
//                           `setEncoding` call on an asynchronous child's stdout appends
//                           `{ api: 'stdout.setEncoding', encoding, caller }`. For an
//                           asynchronous `spawn`, each stdout `'data'` chunk also appends
//                           `{ api: 'stdout.data', isBuffer, caller }` (proves the chunk stays
//                           a `Buffer`, never a decoded string) and the child's `'spawn'`
//                           event appends `{ api: 'child.spawn-event', caller }` (proves the
//                           event `spawnedAt` depends on actually fires). Unset: the preload
//                           patches nothing.
//
// `caller` is the base name of the first stack frame under `plugin/scripts/`, i.e. the
// library module (or entry point) that made the call. After patching, the preload calls
// `module.syncBuiltinESMExports()`, so a named ESM import (`import { spawn } from
// 'node:child_process'`) sees the wrapper.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import nodeModule from 'node:module';

const LOG_FILE = process.env.COMMIT_TEST_SPAWN_LOG || null;

function callerModule() {
  const frames = String(new Error().stack).split('\n').slice(1);
  for (const frame of frames) {
    const normalized = frame.replace(/\\/g, '/');
    const match = /plugin\/scripts\/((?:lib\/)?[^/:)]+\.(?:mjs|cjs))/.exec(normalized);
    if (match) return match[1];
  }
  return null;
}

function log(entry) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

// Node's signatures: (file, args?, options?); `args` may be omitted.
function splitArgs(rest) {
  if (Array.isArray(rest[0])) return { args: rest[0], options: rest[1] || {} };
  return { args: [], options: (rest[0] && typeof rest[0] === 'object') ? rest[0] : {} };
}

function wrap(api) {
  const original = childProcess[api];
  childProcess[api] = function recorded(file, ...rest) {
    const { args, options } = splitArgs(rest);
    const caller = callerModule();
    log({
      api,
      file: String(file),
      args: args.map(String),
      windowsHide: options.windowsHide === true,
      encoding: options.encoding === undefined ? null : options.encoding,
      caller,
    });
    const result = original.call(this, file, ...rest);
    if (api === 'spawn' && result && result.stdout) {
      const originalSetEncoding = result.stdout.setEncoding;
      result.stdout.setEncoding = function setEncoding(encoding) {
        log({ api: 'stdout.setEncoding', encoding, caller: callerModule() });
        return originalSetEncoding.call(this, encoding);
      };
      const originalStdoutOn = result.stdout.on;
      result.stdout.on = function on(event, listener) {
        if (event !== 'data') return originalStdoutOn.call(this, event, listener);
        // Captured at registration time: the 'data' event itself fires later, off the
        // registering module's own call stack.
        const registeredBy = callerModule();
        const wrapped = (chunk) => {
          log({ api: 'stdout.data', isBuffer: Buffer.isBuffer(chunk), caller: registeredBy });
          return listener(chunk);
        };
        return originalStdoutOn.call(this, event, wrapped);
      };
      const originalOn = result.on;
      result.on = function on(event, listener) {
        if (event !== 'spawn') return originalOn.call(this, event, listener);
        // Same reasoning: capture at registration time, not when 'spawn' actually fires.
        const registeredBy = callerModule();
        const wrapped = (...args) => {
          log({ api: 'child.spawn-event', caller: registeredBy });
          return listener(...args);
        };
        return originalOn.call(this, event, wrapped);
      };
    }
    return result;
  };
}

if (LOG_FILE) {
  for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    wrap(api);
  }
  nodeModule.syncBuiltinESMExports();
}
