'use strict';

// CFG-02 (docs/roadmap/04-config-and-attribution.md): M4's thin tracer, `loadConfig` reading
// only the repo layer from the worktree. Unit-level coverage of the loader itself; Seam 1
// coverage of the `plan` refusal it feeds lives in tests/plan-pre-folder-refusals.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');

let config;
beforeEach(async () => {
  config = await loadLib('config');
});

function tempToplevel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('loadConfig returns null when the repo has no config file at all', (t) => {
  const toplevel = tempToplevel(t);
  assert.equal(config.loadConfig({ toplevel }), null);
});

test('loadConfig returns null when the repo config is valid JSON', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": ["feat", "fix"] }');
  assert.equal(config.loadConfig({ toplevel }), null);
});

test('loadConfig reports an error naming the repo layer on unparseable JSON', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": [');

  const result = config.loadConfig({ toplevel });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /\.claude[/\\]commit\.json/);
});

test('REPO_CONFIG_PATH is .claude/commit.json (Q6)', () => {
  assert.equal(config.REPO_CONFIG_PATH, '.claude/commit.json');
});
