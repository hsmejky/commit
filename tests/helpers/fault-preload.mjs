// FND-10 (docs/roadmap/01-foundation.md): a Node `--import` preload, loaded only from the
// test tree (docs/spec/testing-seams.md, "Fault-injection preload at Seam 1"), that injects
// failures a fixture cannot otherwise cause: `os.userInfo()` throwing, and a named fs
// boundary (`fs.linkSync`/`fs.renameSync`, plus the callback and promise forms the code path
// uses) failing for a target path whose basename matches a configured name. Never packaged:
// the shipped CLI reads these only through the real `fs`/`os` modules and gains no test-only
// switch to reach this (docs/spec/architectural-decisions.md, "Injected environment").
//
// Environment variables (all optional; none set means no fault and no log):
//   COMMIT_TEST_FAULT_USERINFO          set to any value: os.userInfo() throws.
//   COMMIT_TEST_FAULT_LINK_BASENAME     basename of the link *target* (the second argument
//                                       to fs.linkSync/fs.link/fs.promises.link) that fails.
//   COMMIT_TEST_FAULT_LINK_CODE         errno code for a failed link call (default EIO).
//   COMMIT_TEST_FAULT_RENAME_BASENAME   basename of the rename *target* (the second argument
//                                       to fs.renameSync/fs.rename/fs.promises.rename) that
//                                       fails.
//   COMMIT_TEST_FAULT_RENAME_CODE       errno code for a failed rename call (default EIO).
//   COMMIT_TEST_FAULT_LOG               a file path; every intercepted link/rename call
//                                       (whether or not it is made to fail) appends its
//                                       target path to this file, one per line, in call
//                                       order. Unset: no file is written.
//
// After patching `fs`, `fs.promises` and `os`, the preload calls
// `module.syncBuiltinESMExports()`, so a named ESM import (`import { renameSync } from
// 'node:fs'`) sees each fault the same way a property access on the module object does.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeModule from 'node:module';

const USERINFO_FAULT = process.env.COMMIT_TEST_FAULT_USERINFO !== undefined;
const LINK_BASENAME = process.env.COMMIT_TEST_FAULT_LINK_BASENAME || null;
const LINK_CODE = process.env.COMMIT_TEST_FAULT_LINK_CODE || 'EIO';
const RENAME_BASENAME = process.env.COMMIT_TEST_FAULT_RENAME_BASENAME || null;
const RENAME_CODE = process.env.COMMIT_TEST_FAULT_RENAME_CODE || 'EIO';
const LOG_FILE = process.env.COMMIT_TEST_FAULT_LOG || null;

function logCall(targetPath) {
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, `${targetPath}\n`);
}

// Builds an error shaped like Node's own fs errors for a failed link/rename: `code`,
// `errno`, `syscall`, `path` (the existing/old path) and `dest` (the target).
function makeFault(code, syscall, sourcePath, targetPath) {
  const magnitude = os.constants.errno[code];
  const err = new Error(
    `${code}: fault injected by fault-preload, ${syscall} '${sourcePath}' -> '${targetPath}'`,
  );
  err.code = code;
  err.errno = typeof magnitude === 'number' ? -magnitude : undefined;
  err.syscall = syscall;
  err.path = sourcePath;
  err.dest = targetPath;
  return err;
}

const originalUserInfo = os.userInfo;
os.userInfo = function userInfo(...args) {
  if (USERINFO_FAULT) {
    const err = new Error('fault injected by fault-preload: os.userInfo unavailable');
    err.code = 'ENOENT';
    err.syscall = 'uv_os_get_passwd';
    throw err;
  }
  return originalUserInfo.apply(this, args);
};

// --- fs.link / fs.linkSync / fs.promises.link -----------------------------------------------

const originalLinkSync = fs.linkSync;
fs.linkSync = function linkSync(existingPath, newPath, ...rest) {
  logCall(newPath);
  if (LINK_BASENAME && path.basename(newPath) === LINK_BASENAME) {
    throw makeFault(LINK_CODE, 'link', existingPath, newPath);
  }
  return originalLinkSync.call(this, existingPath, newPath, ...rest);
};

const originalLink = fs.link;
fs.link = function link(existingPath, newPath, callback) {
  logCall(newPath);
  if (LINK_BASENAME && path.basename(newPath) === LINK_BASENAME) {
    process.nextTick(callback, makeFault(LINK_CODE, 'link', existingPath, newPath));
    return;
  }
  originalLink.call(this, existingPath, newPath, callback);
};

const originalLinkPromise = fs.promises.link;
fs.promises.link = function link(existingPath, newPath) {
  logCall(newPath);
  if (LINK_BASENAME && path.basename(newPath) === LINK_BASENAME) {
    return Promise.reject(makeFault(LINK_CODE, 'link', existingPath, newPath));
  }
  return originalLinkPromise.call(this, existingPath, newPath);
};

// --- fs.rename / fs.renameSync / fs.promises.rename -----------------------------------------

const originalRenameSync = fs.renameSync;
fs.renameSync = function renameSync(oldPath, newPath, ...rest) {
  logCall(newPath);
  if (RENAME_BASENAME && path.basename(newPath) === RENAME_BASENAME) {
    throw makeFault(RENAME_CODE, 'rename', oldPath, newPath);
  }
  return originalRenameSync.call(this, oldPath, newPath, ...rest);
};

const originalRename = fs.rename;
fs.rename = function rename(oldPath, newPath, callback) {
  logCall(newPath);
  if (RENAME_BASENAME && path.basename(newPath) === RENAME_BASENAME) {
    process.nextTick(callback, makeFault(RENAME_CODE, 'rename', oldPath, newPath));
    return;
  }
  originalRename.call(this, oldPath, newPath, callback);
};

const originalRenamePromise = fs.promises.rename;
fs.promises.rename = function rename(oldPath, newPath) {
  logCall(newPath);
  if (RENAME_BASENAME && path.basename(newPath) === RENAME_BASENAME) {
    return Promise.reject(makeFault(RENAME_CODE, 'rename', oldPath, newPath));
  }
  return originalRenamePromise.call(this, oldPath, newPath);
};

nodeModule.syncBuiltinESMExports();
