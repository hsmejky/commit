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

test('unparseable JSON in settings.json is treated as no settings, with a warning naming the problem', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{ not json');
  const result = attribution.resolveAttribution({ claudeHome });
  assert.equal(result.trailer, DEFAULT_TRAILER);
  assert.equal(result.source, 'default');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /not valid JSON/);
});

test('a non-object settings.json top level is treated as no settings, with a warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '[1, 2, 3]');
  const result = attribution.resolveAttribution({ claudeHome });
  assert.equal(result.trailer, DEFAULT_TRAILER);
  assert.equal(result.source, 'default');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /not a JSON object/);
});

test('settings.json that is not valid UTF-8 is treated as no settings, with a warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  // 0xff is not a valid UTF-8 continuation byte here, so the fatal-mode decoder rejects it.
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]));
  const result = attribution.resolveAttribution({ claudeHome });
  assert.equal(result.trailer, DEFAULT_TRAILER);
  assert.equal(result.source, 'default');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /not valid UTF-8/);
});

test('settings.json as a directory (unreadable as a file) is treated as no settings, with a warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(claudeHome, 'settings.json'));
  const result = attribution.resolveAttribution({ claudeHome });
  assert.equal(result.trailer, DEFAULT_TRAILER);
  assert.equal(result.source, 'default');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /cannot be read/);
});

test('settings.json with no read permission is treated as no settings, with a warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  const filePath = path.join(claudeHome, 'settings.json');
  writeSettings(claudeHome, { includeCoAuthoredBy: false });
  fs.chmodSync(filePath, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort restore so the temp dir cleanup can remove the file
    }
  });

  let reallyUnreadable = true;
  try {
    fs.readFileSync(filePath);
    reallyUnreadable = false;
  } catch {
    // expected: confirms chmod actually blocks reads on this platform
  }
  if (!reallyUnreadable) {
    t.skip('chmod 0o000 does not block reads for the owner on this platform (Windows)');
    return;
  }

  const result = attribution.resolveAttribution({ claudeHome });
  assert.equal(result.trailer, DEFAULT_TRAILER);
  assert.equal(result.source, 'default');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /cannot be read/);
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

// Findings 1/2 (review-CFG-09): each line of the value is tested on its own against M6's
// footer-line grammar, not grouped into paragraphs, so a trailer-shaped line is kept
// regardless of what runs alongside it.

test('attribution.commit keeps a trailing trailer line with no blank line before it', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: '🤖 Generated\nCo-Authored-By: A <a@b>' } });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.equal(result.trailer, 'Co-Authored-By: A <a@b>');
  assert.equal(result.warnings.length, 1);
});

test('attribution.commit keeps trailer-shaped lines from more than one paragraph', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, {
    attribution: { commit: 'Co-Authored-By: A <a@b>\n\nCo-Authored-By: B <b@c>' },
  });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.equal(result.trailer, 'Co-Authored-By: A <a@b>\nCo-Authored-By: B <b@c>');
  assert.equal(result.source, 'user');
  // the blank line between the two paragraphs is itself a dropped line
  assert.equal(result.warnings.length, 1);
});

test('attribution.commit normalises CRLF before splitting into lines', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, {
    attribution: { commit: 'Co-Authored-By: A <a@b>\r\nCo-Authored-By: B <b@c>' },
  });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: A <a@b>\nCo-Authored-By: B <b@c>',
    source: 'user',
    warnings: [],
  });
});

test('attribution.commit normalises a lone CR before splitting into lines', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, {
    attribution: { commit: 'Co-Authored-By: A <a@b>\rCo-Authored-By: B <b@c>' },
  });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: A <a@b>\nCo-Authored-By: B <b@c>',
    source: 'user',
    warnings: [],
  });
});

test('attribution.commit keeps several trailers with different allowed tokens', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: 'Co-Authored-By: A\nSigned-off-by: B' } });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: A\nSigned-off-by: B',
    source: 'user',
    warnings: [],
  });
});

// Finding 7: a whitespace-only value behaves like "", but is warned about since (unlike "")
// it looks like someone tried to set a trailer and every line of it was dropped.
test('attribution.commit that is whitespace-only resolves to no trailer, with a warning', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: '   ' } });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.equal(result.trailer, null);
  assert.equal(result.source, 'user');
  assert.equal(result.warnings.length, 1);
});

// Finding 8: `commit` appends the trailer with `--cleanup=verbatim`, so trailing whitespace
// in the setting would otherwise reach the commit verbatim.
test('attribution.commit right-trims a kept trailer-shaped line', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: 'Co-Authored-By: A <a@b>   ' } });

  const result = attribution.resolveAttribution({ claudeHome });

  assert.deepEqual(result, {
    trailer: 'Co-Authored-By: A <a@b>',
    source: 'user',
    warnings: [],
  });
});

// Finding 11: a non-string `attribution.commit` (the key is present but not usable) falls
// through to `includeCoAuthoredBy`/the default, exactly as if the key were absent.
test('a non-string attribution.commit falls through to includeCoAuthoredBy/the default', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: null } });

  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
    warnings: [],
  });
});

test('a numeric attribution.commit falls through to includeCoAuthoredBy/the default', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { attribution: { commit: 42 } });

  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
    source: 'default',
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

// Findings 4/6: `true` defines the key just as `false` does (Q5's "first layer that defines
// a key wins"), so `source` is `user` even though the resulting trailer text is the same
// text the `default` source would give.
test('includeCoAuthoredBy: true resolves to the default trailer, source user', (t) => {
  const claudeHome = tempClaudeHome(t);
  writeSettings(claudeHome, { includeCoAuthoredBy: true });

  assert.deepEqual(attribution.resolveAttribution({ claudeHome }), {
    trailer: DEFAULT_TRAILER,
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

// AC: a static test asserts M5's module imports M6's `isFooterLine` (footer-line grammar)
// and not `lint`, which M5 never uses (the trailer is kept or dropped whole, never linted).
// Finding 13: match only the import statement itself, not the whole source (comments
// included), so a future comment that happens to say "lint" does not break this test.
test('attribution.mjs imports message-grammar.mjs\'s isFooterLine, and not lint', () => {
  const source = fs.readFileSync(libPath('attribution'), 'utf8');
  const importMatch = source.match(/^import\s*\{([^}]*)\}\s*from\s*'\.\/message-grammar\.mjs';$/m);
  assert.notEqual(importMatch, null);
  const imported = importMatch[1];
  assert.match(imported, /\bisFooterLine\b/);
  assert.doesNotMatch(imported, /\blint\b/);
});
