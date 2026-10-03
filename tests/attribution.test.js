'use strict';

// CFG-08 (docs/roadmap/04-config-and-attribution.md): M5's thin tracer. No Claude settings
// are read yet (CFG-09 adds `attribution.commit`, CFG-10 the project/user layers, CFG-11 the
// managed layer); `resolveAttribution` always returns the fixed trailer, source `default`.
// Unit-level coverage of the resolver itself; Seam 1 coverage of `plan`'s `attribution`
// field awaits its wiring into `plan` step 1 and `state.json` (workflows.mjs, GIT-09's file,
// not touched by this slice).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');

let attribution;
beforeEach(async () => {
  attribution = await loadLib('attribution');
});

test('resolveAttribution returns the fixed trailer with source default, no settings read', () => {
  const result = attribution.resolveAttribution({});
  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: Claude <noreply@anthropic.com>',
    source: 'default',
    warnings: [],
  });
});

test('resolveAttribution works with no arguments at all', () => {
  assert.deepEqual(attribution.resolveAttribution(), {
    trailer: 'Co-Authored-By: Claude <noreply@anthropic.com>',
    source: 'default',
    warnings: [],
  });
});

// AC: "the trailer holds no model name and comes from no agent input (no flag or file the
// worker writes can change it)". Every field a later slice will actually read (CFG-09's
// `env`, CFG-10's `claudeHome`/`toplevel`, CFG-11's `managedDir`) is exercised here with
// values that would change the outcome if this tracer read them, to pin that it does not.
test('resolveAttribution ignores env, claudeHome, toplevel and managedDir', () => {
  const result = attribution.resolveAttribution({
    env: { CLAUDE_MODEL: 'opus', CLAUDE_CODE_MODEL: 'haiku', CLAUDE_CONFIG_DIR: '/nope' },
    claudeHome: '/some/claude/home',
    toplevel: '/some/repo',
    managedDir: '/some/managed/dir',
  });
  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: Claude <noreply@anthropic.com>',
    source: 'default',
    warnings: [],
  });
});

test('resolveAttribution returns a fresh object each call, not a shared mutable reference', () => {
  const first = attribution.resolveAttribution({});
  const second = attribution.resolveAttribution({});
  assert.notEqual(first, second);
  assert.notEqual(first.warnings, second.warnings);
});

// Backs the same AC structurally: a module with no imports and no ambient-state access
// cannot be swayed by any flag, file or environment variable, by construction.
test('attribution.mjs is pure: no imports, no ambient-state access', () => {
  const { assertPureSource } = require('./helpers/assert-pure-source');
  assertPureSource('attribution');
});
