'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_NAME = 'commit';
const MARKETPLACE_NAME = 'commit';
const VERSION = '0.1.0';

const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
const marketplaceJsonPath = path.join(__dirname, '..', '.claude-plugin', 'marketplace.json');
const packageJsonPath = path.join(__dirname, '..', 'package.json');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// FND-02 AC: the plugin name is `commit`, the marketplace name is `commit`, the
// marketplace lists the plugin's directory, and the plugin, marketplace entry and
// package all carry version 0.1.0 (Q8, Q15, C:manifests).

test('the plugin manifest names the plugin commit and carries version 0.1.0', () => {
  const plugin = readJson(pluginJsonPath);
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.equal(plugin.version, VERSION);
});

test('the marketplace manifest names the marketplace commit', () => {
  const marketplace = readJson(marketplaceJsonPath);
  assert.equal(marketplace.name, MARKETPLACE_NAME);
});

test("the marketplace lists the plugin's directory and carries version 0.1.0 on that entry", () => {
  const marketplace = readJson(marketplaceJsonPath);
  assert.ok(Array.isArray(marketplace.plugins), 'marketplace.plugins must be an array');

  const entry = marketplace.plugins.find((candidate) => candidate.name === PLUGIN_NAME);
  assert.ok(entry, 'marketplace must list a plugin entry named commit');
  assert.equal(entry.source, './plugin');
  assert.equal(entry.version, VERSION);
});

test('the package manifest carries version 0.1.0', () => {
  const manifest = readJson(packageJsonPath);
  assert.equal(manifest.version, VERSION);
});

test('the plugin, marketplace entry and package versions agree', () => {
  const plugin = readJson(pluginJsonPath);
  const marketplace = readJson(marketplaceJsonPath);
  const pkg = readJson(packageJsonPath);
  const entry = marketplace.plugins.find((candidate) => candidate.name === PLUGIN_NAME);

  assert.equal(plugin.version, VERSION);
  assert.equal(entry.version, VERSION);
  assert.equal(pkg.version, VERSION);
});
