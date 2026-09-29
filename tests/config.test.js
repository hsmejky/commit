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

// review-CFG-02 finding 3: the parser's own message, which carries the position, is appended
// so a typo is easier to find (story 110).
test('loadConfig appends the JSON parser error, including its position, to the message', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{"a": 1,}');

  const result = config.loadConfig({ toplevel });

  assert.match(result.error, /position/i);
});

// review-CFG-02 finding 2, Q6 (amended): a leading UTF-8 BOM is stripped, matching Node's own
// JSON file parsing, so a file saved by Windows PowerShell 5.1 or Notepad still parses.
test('loadConfig strips a leading UTF-8 BOM before parsing', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(
    path.join(toplevel, config.REPO_CONFIG_PATH),
    Buffer.concat([bom, Buffer.from('{ "types": ["feat"] }', 'utf8')]),
  );

  assert.equal(config.loadConfig({ toplevel }), null);
});

// review-CFG-02 finding 4, Q6 (amended): invalid UTF-8 is treated as unparseable (a `config`
// refusal), detected cheaply through a fatal-mode decoder rather than Node's default silent
// U+FFFD replacement.
test('loadConfig reports an error naming the repo layer on invalid UTF-8', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  // 0xFF is never valid anywhere in a UTF-8 byte sequence.
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), Buffer.from([0x7b, 0xff, 0x7d]));

  const result = config.loadConfig({ toplevel });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /UTF-8/);
});

// CFG-03 (roadmap "a repo layer whose top level is not a JSON object"): CFG-02 was
// JSON-parseability only; a non-object top level now fails `validateLayer` and so
// `loadConfig` too, naming the repo layer.
test('loadConfig reports an error naming the repo layer for a non-object top level', (t) => {
  const toplevel = tempToplevel(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  for (const body of ['[]', 'null', '42', '"x"']) {
    fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), body);
    const result = config.loadConfig({ toplevel });
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
  fs.mkdirSync(path.join(toplevel, config.REPO_CONFIG_PATH), { recursive: true });

  const result = config.loadConfig({ toplevel });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
});

// review-CFG-02 finding 10: a regular-file check plus a size cap (same style as the run-lock
// read) closes a self-DoS where a cloned repo commits an oversized `.claude/commit.json`.
test('loadConfig reports an error naming the repo layer for an oversized file, never reading it', (t) => {
  const toplevel = tempToplevel(t);
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

  const result = config.loadConfig({ toplevel });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
});

test('REPO_CONFIG_PATH is .claude/commit.json (Q6)', () => {
  assert.equal(config.REPO_CONFIG_PATH, '.claude/commit.json');
});

// CFG-03 (docs/roadmap/04-config-and-attribution.md): pure `validateLayer(obj, layer)` over
// the Q6 value domains. Unit-level coverage of the function itself; the Seam 1 refusals it
// feeds (through `loadConfig`) live in tests/plan-pre-folder-refusals.test.js.

test('validateLayer rejects a non-object top level, naming the layer', () => {
  for (const body of [[], null, 42, 'x']) {
    const result = config.validateLayer(body, 'repo config (.claude/commit.json)');
    assert.notEqual(result, null, JSON.stringify(body));
    assert.match(result.error, /repo config \(\.claude\/commit\.json\)/, JSON.stringify(body));
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
    assert.match(result.error, /maxSubjectLength/, JSON.stringify(value));
  }
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
    assert.match(result.error, /types/, JSON.stringify(value));
  }
});

test('validateLayer accepts a well-formed types array', () => {
  assert.equal(config.validateLayer({ types: ['feat', 'fix', 'ci-cd'] }, 'repo config'), null);
});

// story 110: a wrong JSON type for scope, body or subjectCase is an error (an unknown value
// of the right type is CFG-06's warning, not this function's error).
test('validateLayer rejects a wrong-type scope, naming the key', () => {
  const result = config.validateLayer({ scope: 3 }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.error, /scope/);
});

test('validateLayer rejects a wrong-type subjectCase, naming the key', () => {
  const result = config.validateLayer({ subjectCase: true }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.error, /subjectCase/);
});

test('validateLayer rejects a wrong-type body, naming the key', () => {
  const result = config.validateLayer({ body: [] }, 'repo config');
  assert.notEqual(result, null);
  assert.match(result.error, /body/);
});

test('validateLayer accepts well-typed scope, body and subjectCase strings', () => {
  assert.equal(config.validateLayer({ scope: 'optional', body: 'forbidden', subjectCase: 'lower' }, 'repo config'), null);
});

// AC: a static test asserts `validateLayer` is exported, pure (no file reads in its source).
test('validateLayer is exported and its own source does no file reads or ambient-state access', () => {
  const { assertPureSourceText } = require('./helpers/assert-pure-source');
  assert.equal(typeof config.validateLayer, 'function');
  assertPureSourceText(config.validateLayer.toString(), 'validateLayer');
});
