'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

// The static check FND-01 asks for (story 203): a manifest lists no dependency fields.
// Kept as a small pure function so the check itself can be tested against fixtures,
// not only against this repo's own package.json.
function findDependencyFields(manifest) {
  return DEPENDENCY_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(manifest, field)
  );
}

const packageJsonPath = path.join(__dirname, '..', 'package.json');

function readManifest() {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

test('the package manifest lists no dependency fields', () => {
  const manifest = readManifest();
  assert.deepEqual(findDependencyFields(manifest), []);
});

test('the check fails a manifest that lists any dependency field', () => {
  for (const field of DEPENDENCY_FIELDS) {
    const manifestWithDependency = { name: 'example', [field]: { 'left-pad': '1.0.0' } };
    assert.deepEqual(findDependencyFields(manifestWithDependency), [field]);
  }
});

test('the package manifest declares the Node 22 floor and version 0.1.0', () => {
  const manifest = readManifest();
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.engines && manifest.engines.node, '>=22');
});
