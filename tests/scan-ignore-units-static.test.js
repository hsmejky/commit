'use strict';

// SCN-14 static check (docs/roadmap/05-scanner.md, last SCN-14 AC): M18 (`workflows.mjs`)
// is the only place that wires `scanIgnoreChanged`'s repo-config units together — it must
// import `isRepoConfigPath` and `REPO_CONFIG_PATH` from M4 (`config.mjs`) and pass the
// first to M8's `scanUnits` and the second to M10's `snapshotBlob`. M8 (`scanner.mjs`)
// must not import M4 at all (it only ever receives `isRepoConfigPath` as a parameter), and
// neither module may hardcode the repo config's own filename.

const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { libPath } = require('./helpers/load-lib');

const workflowsSource = fs.readFileSync(libPath('workflows'), 'utf8');
const scannerSource = fs.readFileSync(libPath('scanner'), 'utf8');

test('workflows.mjs imports isRepoConfigPath and REPO_CONFIG_PATH from config.mjs', () => {
  const importLine = workflowsSource
    .split('\n')
    .find((line) => line.includes("from './config.mjs'"));
  assert.ok(importLine, 'workflows.mjs has no import from ./config.mjs');
  assert.match(importLine, /\bisRepoConfigPath\b/);
  assert.match(importLine, /\bREPO_CONFIG_PATH\b/);
});

test('workflows.mjs passes isRepoConfigPath into a scanUnits( call', () => {
  const callStart = workflowsSource.indexOf('scanUnits(');
  assert.ok(callStart !== -1, 'workflows.mjs never calls scanUnits(');
  const callEnd = workflowsSource.indexOf(');', callStart);
  const call = workflowsSource.slice(callStart, callEnd);
  assert.match(call, /\bisRepoConfigPath\b/);
});

test('workflows.mjs calls snapshotBlob(REPO_CONFIG_PATH)', () => {
  assert.match(workflowsSource, /\bsnapshotBlob\(REPO_CONFIG_PATH\)/);
});

test('scanner.mjs does not import config.mjs', () => {
  assert.doesNotMatch(scannerSource, /from\s*['"]\.\/config\.mjs['"]/);
});

test('neither workflows.mjs nor scanner.mjs hardcodes the repo config filename', () => {
  for (const source of [workflowsSource, scannerSource]) {
    assert.doesNotMatch(source, /\.claude\/commit\.json/);
    assert.doesNotMatch(source, /['"]commit\.json['"]/);
  }
});
