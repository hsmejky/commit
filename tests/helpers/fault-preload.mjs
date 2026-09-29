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
//   COMMIT_TEST_FAULT_LINK_BASENAME     one basename of the link *target* (the second
//                                       argument to fs.linkSync/fs.link/fs.promises.link)
//                                       that fails, or a comma-separated list of
//                                       `name[=code]` entries so different targets can fail
//                                       with different codes in the same run (KD-R24); an
//                                       entry without `=code` uses
//                                       COMMIT_TEST_FAULT_LINK_CODE (default EIO).
//   COMMIT_TEST_FAULT_LINK_CODE         default errno code for a failed link call whose
//                                       matching entry has no `=code` (default EIO).
//   COMMIT_TEST_FAULT_RENAME_BASENAME   same shape as COMMIT_TEST_FAULT_LINK_BASENAME, for
//                                       the rename *target* (the second argument to
//                                       fs.renameSync/fs.rename/fs.promises.rename).
//   COMMIT_TEST_FAULT_RENAME_CODE       default errno code for a failed rename call whose
//                                       matching entry has no `=code` (default EIO).
//   COMMIT_TEST_FAULT_LOG               a file path; every intercepted link/rename call
//                                       (whether or not it is made to fail) appends its
//                                       target path to this file, one per line, in call
//                                       order. Unset: no file is written.
//
// After patching `fs`, `fs.promises` and `os`, the preload calls
// `module.syncBuiltinESMExports()`, so a named ESM import (`import { renameSync } from
// 'node:fs'`, `import { rename } from 'node:fs/promises'`) sees each fault the same way a
// property access on the module object does.
//
// The injected link/rename error is shaped like Node's own fs errors (`code`, `errno`,
// `syscall`, `path`, `dest`); `errno` is looked up by code in the inverted
// `util.getSystemErrorMap()` rather than negated from `os.constants.errno`, because on
// Windows the live errno values are libuv codes (e.g. -4058 for ENOENT), not the POSIX
// values `os.constants.errno` reports.
//
// The injected `os.userInfo()` fault is shaped like the real failure: Node throws a
// `SystemError` with `code: 'ERR_SYSTEM_ERROR'`, `syscall: 'uv_os_get_passwd'` and an
// `info` object carrying the underlying `code` (`'ENOENT'`) and `errno`, so code that
// filters on `.code` sees the same shape under test as in production.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import nodeModule from 'node:module';

// Inverts `util.getSystemErrorMap()` (errno -> [code, message]) into code -> errno, so a
// configured code string (e.g. 'EIO', 'EPERM') can be turned into the live errno value for
// this platform.
const ERRNO_BY_CODE = (() => {
  const map = new Map();
  for (const [errno, [code]] of util.getSystemErrorMap()) {
    if (!map.has(code)) map.set(code, errno);
  }
  return map;
})();

// Parses `name[=code]` comma-separated entries into a Map from basename to either an
// explicit code override or `null` (use the boundary's default code). Keeps the plain
// single-name form working: `'state.json'` parses to `Map { 'state.json' => null }`.
function parseBasenameList(raw) {
  if (!raw) return null;
  const map = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) map.set(trimmed, null);
    else map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return map;
}

// Returns the code to fail with for `targetPath` against `basenames`, or `null` if it
// doesn't match any configured entry.
function matchFault(basenames, targetPath, defaultCode) {
  if (!basenames) return null;
  const name = path.basename(targetPath);
  if (!basenames.has(name)) return null;
  return basenames.get(name) || defaultCode;
}

const USERINFO_FAULT = process.env.COMMIT_TEST_FAULT_USERINFO !== undefined;
const LINK_BASENAMES = parseBasenameList(process.env.COMMIT_TEST_FAULT_LINK_BASENAME);
const LINK_CODE = process.env.COMMIT_TEST_FAULT_LINK_CODE || 'EIO';
const RENAME_BASENAMES = parseBasenameList(process.env.COMMIT_TEST_FAULT_RENAME_BASENAME);
const RENAME_CODE = process.env.COMMIT_TEST_FAULT_RENAME_CODE || 'EIO';
const LOG_FILE = process.env.COMMIT_TEST_FAULT_LOG || null;

function logCall(targetPath) {
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, `${targetPath}\n`);
}

// Builds an error shaped like Node's own fs errors for a failed link/rename: `code`,
// `errno`, `syscall`, `path` (the existing/old path) and `dest` (the target).
function makeFault(code, syscall, sourcePath, targetPath) {
  const err = new Error(
    `${code}: fault injected by fault-preload, ${syscall} '${sourcePath}' -> '${targetPath}'`,
  );
  err.code = code;
  err.errno = ERRNO_BY_CODE.get(code);
  err.syscall = syscall;
  err.path = sourcePath;
  err.dest = targetPath;
  return err;
}

// Builds an error shaped like Node's real `os.userInfo()` failure: a SystemError whose own
// `code` is `ERR_SYSTEM_ERROR`, with the underlying errno's code and value under `.info`
// (and mirrored onto `.errno`/`.syscall`, as the real SystemError's getters do).
function makeUserInfoFault() {
  const errno = ERRNO_BY_CODE.get('ENOENT');
  const err = new Error(
    "A system error occurred: uv_os_get_passwd returned ENOENT (fault injected by fault-preload)",
  );
  err.code = 'ERR_SYSTEM_ERROR';
  err.errno = errno;
  err.syscall = 'uv_os_get_passwd';
  err.info = {
    code: 'ENOENT',
    errno,
    syscall: 'uv_os_get_passwd',
    message: 'fault injected by fault-preload',
  };
  return err;
}

const originalUserInfo = os.userInfo;
os.userInfo = function userInfo(...args) {
  if (USERINFO_FAULT) throw makeUserInfoFault();
  return originalUserInfo.apply(this, args);
};

// --- fs.link / fs.linkSync / fs.promises.link -----------------------------------------------

const originalLinkSync = fs.linkSync;
fs.linkSync = function linkSync(existingPath, newPath, ...rest) {
  logCall(newPath);
  const code = matchFault(LINK_BASENAMES, newPath, LINK_CODE);
  if (code) throw makeFault(code, 'link', existingPath, newPath);
  return originalLinkSync.call(this, existingPath, newPath, ...rest);
};

const originalLink = fs.link;
fs.link = function link(existingPath, newPath, callback) {
  logCall(newPath);
  const code = matchFault(LINK_BASENAMES, newPath, LINK_CODE);
  if (code) {
    process.nextTick(callback, makeFault(code, 'link', existingPath, newPath));
    return;
  }
  originalLink.call(this, existingPath, newPath, callback);
};

const originalLinkPromise = fs.promises.link;
fs.promises.link = function link(existingPath, newPath) {
  logCall(newPath);
  const code = matchFault(LINK_BASENAMES, newPath, LINK_CODE);
  if (code) return Promise.reject(makeFault(code, 'link', existingPath, newPath));
  return originalLinkPromise.call(this, existingPath, newPath);
};

// --- fs.rename / fs.renameSync / fs.promises.rename -----------------------------------------

const originalRenameSync = fs.renameSync;
fs.renameSync = function renameSync(oldPath, newPath, ...rest) {
  logCall(newPath);
  const code = matchFault(RENAME_BASENAMES, newPath, RENAME_CODE);
  if (code) throw makeFault(code, 'rename', oldPath, newPath);
  return originalRenameSync.call(this, oldPath, newPath, ...rest);
};

const originalRename = fs.rename;
fs.rename = function rename(oldPath, newPath, callback) {
  logCall(newPath);
  const code = matchFault(RENAME_BASENAMES, newPath, RENAME_CODE);
  if (code) {
    process.nextTick(callback, makeFault(code, 'rename', oldPath, newPath));
    return;
  }
  originalRename.call(this, oldPath, newPath, callback);
};

const originalRenamePromise = fs.promises.rename;
fs.promises.rename = function rename(oldPath, newPath) {
  logCall(newPath);
  const code = matchFault(RENAME_BASENAMES, newPath, RENAME_CODE);
  if (code) return Promise.reject(makeFault(code, 'rename', oldPath, newPath));
  return originalRenamePromise.call(this, oldPath, newPath);
};

nodeModule.syncBuiltinESMExports();
