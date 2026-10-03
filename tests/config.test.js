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
const { Q6_DEFAULT_VALUES } = require('./helpers/q6-defaults.js');

let config;
beforeEach(async () => {
  config = await loadLib('config');
});

function tempToplevel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// CFG-04: every `loadConfig` call now also needs a `claudeHome`. Most of these tests are
// about the repo layer only, so they get a fresh, empty Claude home (no user `commit.json`
// at all): `loadConfig`'s own CFG-04 coverage further below uses a populated one.
function tempClaudeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-claude-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('loadConfig returns the effective defaults when neither layer has a config file at all', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  const result = config.loadConfig({ toplevel, claudeHome });
  assert.deepEqual(result.values, Q6_DEFAULT_VALUES);
  assert.deepEqual(result.sources, {
    types: 'default',
    scope: 'default',
    body: 'default',
    maxSubjectLength: 'default',
    subjectCase: 'default',
    scanIgnore: 'default',
  });
});

test('loadConfig returns the repo layer\'s types as effective, sourced to repo', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": ["feat", "fix"] }');
  const result = config.loadConfig({ toplevel, claudeHome });
  assert.deepEqual(result.values.types, ['feat', 'fix']);
  assert.equal(result.sources.types, 'repo');
  assert.equal(result.sources.scope, 'default');
});

test('loadConfig reports an error naming the repo layer on unparseable JSON', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": [');

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /\.claude[/\\]commit\.json/);
});

// review-CFG-02 finding 3: the parser's own message, which carries the position, is appended
// so a typo is easier to find (story 110).
test('loadConfig appends the JSON parser error, including its position, to the message', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{"a": 1,}');

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.match(result.error, /position/i);
});

// review-CFG-02 finding 2, Q6 (amended): a leading UTF-8 BOM is stripped, matching Node's own
// JSON file parsing, so a file saved by Windows PowerShell 5.1 or Notepad still parses.
test('loadConfig strips a leading UTF-8 BOM before parsing', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(
    path.join(toplevel, config.REPO_CONFIG_PATH),
    Buffer.concat([bom, Buffer.from('{ "types": ["feat"] }', 'utf8')]),
  );

  const result = config.loadConfig({ toplevel, claudeHome });
  assert.deepEqual(result.values.types, ['feat']);
  assert.equal(result.sources.types, 'repo');
});

// review-CFG-02 finding 4, Q6 (amended): invalid UTF-8 is treated as unparseable (a `config`
// refusal), detected cheaply through a fatal-mode decoder rather than Node's default silent
// U+FFFD replacement.
test('loadConfig reports an error naming the repo layer on invalid UTF-8', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  // 0xFF is never valid anywhere in a UTF-8 byte sequence.
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), Buffer.from([0x7b, 0xff, 0x7d]));

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /UTF-8/);
});

// CFG-03 (roadmap "a repo layer whose top level is not a JSON object"): CFG-02 was
// JSON-parseability only; a non-object top level now fails `validateLayer` and so
// `loadConfig` too, naming the repo layer.
test('loadConfig reports an error naming the repo layer for a non-object top level', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  for (const body of ['[]', 'null', '42', '"x"']) {
    fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), body);
    const result = config.loadConfig({ toplevel, claudeHome });
    assert.notEqual(result, null, body);
    assert.match(result.error, /repo config/, body);
    assert.match(result.error, /\.claude[/\\]commit\.json/, body);
  }
});

// review-CFG-02 finding 1(a): a read error other than ENOENT/ENOTDIR (here EISDIR, from the
// repo layer's path being a directory) is a `config` refusal naming the layer, not an
// uncaught throw that ends as `internal`.
test('loadConfig reports an error naming the repo layer when the path is a directory', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, config.REPO_CONFIG_PATH), { recursive: true });

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
});

// review-CFG-02 finding 10: a regular-file check plus a size cap (same style as the run-lock
// read) closes a self-DoS where a cloned repo commits an oversized `.claude/commit.json`.
test('loadConfig reports an error naming the repo layer for an oversized file, never reading it', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  const configPath = path.join(toplevel, config.REPO_CONFIG_PATH);
  const fd = fs.openSync(configPath, 'w');
  try {
    // A sparse file well past the cap: if `loadConfig` ever read it whole, this test would
    // hang or exhaust memory instead of failing fast.
    fs.ftruncateSync(fd, 10 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
});

test('REPO_CONFIG_PATH is .claude/commit.json (Q6)', () => {
  assert.equal(config.REPO_CONFIG_PATH, '.claude/commit.json');
});

// CFG-04 (docs/roadmap/04-config-and-attribution.md, Q5, Q6, story 112): the user layer,
// read from `commit.json` directly under the injected Claude home, goes through the same
// pipeline as the repo layer and refuses the same way, naming the user layer.

test('USER_CONFIG_FILENAME is commit.json (Q5, Q6, public surface)', () => {
  assert.equal(config.USER_CONFIG_FILENAME, 'commit.json');
});

test('loadConfig returns the effective defaults when the user config is absent, even with no toplevel at all', (t) => {
  const claudeHome = tempClaudeHome(t);
  const result = config.loadConfig({ toplevel: null, claudeHome });
  assert.deepEqual(result.values, Q6_DEFAULT_VALUES);
  assert.equal(result.sources.types, 'default');
});

test('loadConfig returns the user layer\'s types as effective, sourced to user, when valid JSON', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": ["feat", "fix"] }');
  const result = config.loadConfig({ toplevel, claudeHome });
  assert.deepEqual(result.values.types, ['feat', 'fix']);
  assert.equal(result.sources.types, 'user');
});

test('loadConfig reports an error naming the user layer on unparseable JSON, with no toplevel', (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": [');

  const result = config.loadConfig({ toplevel: null, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
  assert.match(result.error, /commit\.json/);
});

test('loadConfig reports an error naming the user layer for a bad value, even with a valid repo layer', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": ["feat"] }');
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "maxSubjectLength": 0 }');

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
  assert.match(result.error, /maxSubjectLength/);
});

test('loadConfig reports the user-layer error even when the repo layer is also invalid', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": [');
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": [');

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
});

// review-CFG-04 finding 6: the shared pipeline's label threading (`readLayer`'s early-return
// paths) was pinned for the repo layer only; these parametrise the same checks for the user
// layer, naming it instead of the repo layer.
test('loadConfig reports an error naming the user layer when the path is a directory', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), { recursive: true });

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
});

test('loadConfig reports an error naming the user layer for an oversized file, never reading it', (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  const configPath = path.join(claudeHome, config.USER_CONFIG_FILENAME);
  const fd = fs.openSync(configPath, 'w');
  try {
    // A sparse file well past the cap: if `loadConfig` ever read it whole, this test would
    // hang or exhaust memory instead of failing fast.
    fs.ftruncateSync(fd, 10 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }

  const result = config.loadConfig({ toplevel, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
});

// CFG-03 (docs/roadmap/04-config-and-attribution.md): pure `validateLayer(obj, layer)` over
// the Q6 value domains. Unit-level coverage of the function itself; the Seam 1 refusals it
// feeds (through `loadConfig`) live in tests/plan-pre-folder-refusals.test.js.

test('validateLayer rejects a non-object top level, naming the layer', () => {
  for (const body of [[], null, 42, 'x']) {
    const result = config.validateLayer(body, 'repo config (.claude/commit.json)');
    assert.notEqual(result, null, JSON.stringify(body));
    assert.equal(result.errors.length, 1, JSON.stringify(body));
    assert.match(result.errors[0], /repo config \(\.claude\/commit\.json\)/, JSON.stringify(body));
  }
});

test('validateLayer accepts an empty object (no keys to check)', () => {
  assert.equal(config.validateLayer({}, 'repo config (.claude/commit.json)'), null);
});

// story 106, 110: maxSubjectLength is an integer 20-200 (code points of the header).
test('validateLayer rejects a wrong-type or out-of-range maxSubjectLength, naming the key', () => {
  for (const value of ['72', 19, 201, 0, 72.5]) {
    const result = config.validateLayer({ maxSubjectLength: value }, 'repo config');
    assert.notEqual(result, null, JSON.stringify(value));
    assert.match(result.errors[0], /maxSubjectLength/, JSON.stringify(value));
  }
});

// review-CFG-03 finding 4: JSON.stringify prints Infinity as `null`, which would misleadingly
// read "... not null" for a value that parsed but is wildly out of range.
test('validateLayer names an out-of-range Infinity maxSubjectLength as Infinity, not null', () => {
  const result = config.validateLayer({ maxSubjectLength: 1e400 }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.errors[0], /Infinity/);
  assert.doesNotMatch(result.errors[0], /not null/);
});

test('validateLayer accepts maxSubjectLength at both range boundaries (20 and 200)', () => {
  assert.equal(config.validateLayer({ maxSubjectLength: 20 }, 'repo config'), null);
  assert.equal(config.validateLayer({ maxSubjectLength: 200 }, 'repo config'), null);
});

// story 106, 110: types is a non-empty array of `^[a-z][a-z0-9-]*$` entries.
test('validateLayer rejects an empty, malformed or wrong-type types value, naming the key', () => {
  for (const value of [[], ['Feat'], ['1x'], 'feat']) {
    const result = config.validateLayer({ types: value }, 'repo config');
    assert.notEqual(result, null, JSON.stringify(value));
    assert.match(result.errors[0], /types/, JSON.stringify(value));
  }
});

// review-CFG-03 finding 5: the old wording ("a non-empty array of lowercase type names")
// did not explain why `["1x"]` is rejected, since "1x" is already lowercase. The message
// now states the actual rule.
test('validateLayer states the starts-with-a-letter rule for a malformed types entry', () => {
  const result = config.validateLayer({ types: ['1x'] }, 'repo config');
  assert.match(result.errors[0], /starting with a letter/);
  assert.match(result.errors[0], /\^\[a-z\]\[a-z0-9-\]\*\$/);
});

test('validateLayer accepts a well-formed types array', () => {
  assert.equal(config.validateLayer({ types: ['feat', 'fix', 'ci-cd'] }, 'repo config'), null);
});

// story 110: a wrong JSON type for scope, body or subjectCase is an error (an unknown value
// of the right type is CFG-06's warning, not this function's error).
test('validateLayer rejects a wrong-type scope, naming the key', () => {
  const result = config.validateLayer({ scope: 3 }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.errors[0], /scope/);
});

test('validateLayer rejects a wrong-type subjectCase, naming the key', () => {
  const result = config.validateLayer({ subjectCase: true }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.errors[0], /subjectCase/);
});

test('validateLayer rejects a wrong-type body, naming the key', () => {
  const result = config.validateLayer({ body: [] }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.errors[0], /body/);
});

// review-CFG-03 finding 2: validateLayer collects every applicable error in one pass
// (docs/contracts/infer.md's `{ errors }` shape), not only the first.
test('validateLayer collects every applicable error, not only the first', () => {
  const result = config.validateLayer({ maxSubjectLength: 0, scope: 3, body: [] }, 'repo config');
  assert.notEqual(result, null);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /maxSubjectLength/);
  assert.match(result.errors[1], /scope/);
  assert.match(result.errors[2], /body/);
});

test('validateLayer accepts well-typed scope, body and subjectCase strings', () => {
  assert.equal(config.validateLayer({ scope: 'optional', body: 'forbidden', subjectCase: 'lower' }, 'repo config'), null);
});

// AC: a static test asserts `validateLayer` is exported, pure (no file reads in its source).
//
// review-CFG-03 finding 1: `assertPureSourceText`'s ordinary `AMBIENT_STATE` bans do not
// include `fs`, `path` or a `*Sync` read, and only check the import statements of the text
// handed to it; `Function.prototype.toString()` never reproduces an `import` statement (the
// importing module's, not the function's own), so the whole-module import check can never
// fire here either. A function body reaches `config.mjs`'s module-level `fs`/`path` imports
// as plain identifiers, so `validateLayer`'s and `describeType`'s own text is checked
// against those identifiers directly via `extraBans`. `describeType` is checked too, since
// `validateLayer.toString()` does not include the body of a function it calls
// (`Function.prototype.toString()` is per-function, not transitive).
const FILE_READ_BANS = [
  [/\bfs\b/, 'fs'],
  [/\bpath\b/, 'path'],
  [/\b(read|open|stat|lstat|exists)\w*Sync\b/, 'a *Sync read'],
];

test('validateLayer is exported and its own source does no file reads or ambient-state access', () => {
  const { assertPureSourceText } = require('./helpers/assert-pure-source');
  assert.equal(typeof config.validateLayer, 'function');
  assertPureSourceText(config.validateLayer.toString(), 'validateLayer', { extraBans: FILE_READ_BANS });
});

test('describeType is exported and its own source does no file reads or ambient-state access', () => {
  const { assertPureSourceText } = require('./helpers/assert-pure-source');
  assert.equal(typeof config.describeType, 'function');
  assertPureSourceText(config.describeType.toString(), 'describeType', { extraBans: FILE_READ_BANS });
});

// Self-check (review-CFG-03 finding 1): proves the purity check above actually catches a
// file read, rather than passing vacuously the way the plain `assertPureSourceText` call
// did before `extraBans` existed (it has no `import` statement and never mentions `fs` or
// `path` as banned words on its own).
test('the purity check fails on a validateLayer-shaped body that calls fs.readFileSync(path.join(...))', () => {
  const { assertPureSourceText } = require('./helpers/assert-pure-source');
  const impureBody = [
    'function validateLayer(obj, layer) {',
    '  const text = fs.readFileSync(path.join(layer, "x"), "utf8");',
    '  return text ? null : { errors: ["bad"] };',
    '}',
  ].join('\n');

  // Without extraBans this body passes today (the vacuous check review-CFG-03 found).
  assert.doesNotThrow(() => assertPureSourceText(impureBody, 'validateLayer'));
  // With extraBans (what the real test above uses) it must fail.
  assert.throws(
    () => assertPureSourceText(impureBody, 'validateLayer', { extraBans: FILE_READ_BANS }),
    assert.AssertionError,
  );
});
