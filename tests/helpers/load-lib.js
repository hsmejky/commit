'use strict';

// Loads a shared-library module (`plugin/scripts/lib/<name>.mjs`) from a CommonJS test.
// The library is ES modules and tests stay CommonJS, so they reach it only through a
// dynamic `import()` of a file URL (architectural decisions: module type fixed by
// extension); `require` cannot load a `.mjs` on Node 22.0-22.11.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'lib');

function libPath(name) {
  return path.join(LIB_DIR, `${name}.mjs`);
}

function loadLib(name) {
  return import(pathToFileURL(libPath(name)).href);
}

module.exports = { libPath, loadLib };
