'use strict';

// CFG-09 (docs/roadmap/04-config-and-attribution.md): M5 reads the user settings layer
// (`<claudeHome>/settings.json`) for `attribution.commit` (trailer-shaped lines kept, the
// rest dropped with a warning; empty string = no trailer), then the deprecated
// `includeCoAuthoredBy: false`; otherwise the CFG-08 default. Unit-level coverage of the
// resolver itself; Seam 1 coverage of `plan`'s `attribution`/`warnings` fields lives in
// plan-attribution.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib, libPath } = require('./helpers/load-lib.js');

const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

let attribution;
beforeEach(async () => {
  attribution = await loadLib('attribution');
});

function tempClaudeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-claude-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function writeSettings(claudeHome, value) {
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(value));
}

test('resolveAttribution returns the fixed trailer with source default when no settings file exists', (t) => {
  const claudeHome = tempClaudeHome(t);
  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('resolveAttribution works with no arguments at all', () => {
  assert.deepEqual(attribution.resolveAttribution(), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('an unreadable or unparseable user settings.json is treated as no settings, not an error', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{ not json');
  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('a non-object settings.json top level is treated as no settings', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '[1, 2, 3]');
  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('attribution.commit: "" resolves to no trailer, source user', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: '' } });
  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: null,
    source: 'user',
    warnings: [],
  });
});

// Q5, M4 "dropped with a warning"; no source fixes the warning count, so only the trailer
// and the presence of a warning are pinned.
test('attribution.commit with a non-trailer line keeps only the trailer-shaped line, warns about the rest', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, {
    attribution: { commit: '🤖 line\n\nCo-Authored-By: X <x@y>' },
  });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.equal(result.trailer, 'Co-Authored-By: X <x@y>');
  assert.equal(result.source, 'user');
  assert.equal(result.warnings.length, 1);
});

test('attribution.commit with only a trailer line produces no warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: 'Co-Authored-By: X <x@y>' } });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: X <x@y>',
    source: 'user',
    warnings: [],
  });
});

test('includeCoAuthoredBy: false resolves to no trailer, source user, when attribution.commit is unset', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { includeCoAuthoredBy: false });

  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: null,
    source: 'user',
    warnings: [],
  });
});

test('attribution.commit wins over includeCoAuthoredBy: false when both are set', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, {
    attribution: { commit: 'Co-Authored-By: X <x@y>' },
    includeCoAuthoredBy: false,
  });

  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: 'Co-Authored-By: X <x@y>',
    source: 'user',
    warnings: [],
  });
});

test('resolveAttribution ignores env, toplevel and managedDir (CFG-10/CFG-11 fields)', (t) => {
  const claudeHome = tempClaudeHome(t);
  const result = attribution.resolveAttribution({
    env: { CLAUDE_MODEL: 'opus', CLAUDE_CODE_MODEL: 'haiku' },
    claudeHome,
    toplevel: '/some/repo',
    managedDir: '/some/managed/dir',
  });
  assert.deepEqual(result, {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('resolveAttribution returns a fresh warnings array each call, not a shared mutable reference', (t) => {
  const claudeHome = tempClaudeHome(t);
  const first = attribution.resolveAttribution({ claudeHome });
  const second = attribution.resolveAttribution({ claudeHome });
  assert.notEqual(first.warnings, second.warnings);
});

// AC: a static test asserts M5's module imports M6's `parse` (footer grammar) and not
// `lint`, which M5 never uses (the trailer is kept or dropped whole, never linted).
test('attribution.mjs imports message-grammar.mjs\'s parse, and not lint', () => {
  const source = fs.readFileSync(libPath('attribution'), 'utf8');
  assert.match(source, /import\s*\{\s*parse\s*\}\s*from\s*'\.\/message-grammar\.mjs'/);
  assert.doesNotMatch(source, /\blint\b/);
});
