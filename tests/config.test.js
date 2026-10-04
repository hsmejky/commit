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
const { createCase } = require('./helpers/process-seam.js');

let config;
let compileGlob;
beforeEach(async () => {
  config = await loadLib('config');
  ({ compileGlob } = await loadLib('glob-matcher'));
});

function tempToplevel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// CFG-04: every `loadConfig` call now also needs a `claudeHome`. Most of these tests are
// about the repo layer only, so they get a fresh, empty Claude home (no user `commit.json`
// at all): `loadConfig`'s own CFG-04 coverage further below uses a populated one.
// CFG-07: these temp toplevels are not git repos, so the calls pass `unborn: true` (no
// `scanIgnore` read at HEAD, no git spawned); the HEAD read has its own tests further below.
function tempClaudeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-claude-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('loadConfig returns the effective defaults when neither layer has a config file at all', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });
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

test('loadConfig returns the repo layer\'s types as effective, sourced to repo', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": ["feat", "fix"] }');
  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });
  assert.deepEqual(result.values.types, ['feat', 'fix']);
  assert.equal(result.sources.types, 'repo');
  assert.equal(result.sources.scope, 'default');
});

test('loadConfig reports an error naming the repo layer on unparseable JSON', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": [');

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /\.claude[/\\]commit\.json/);
});

// review-CFG-02 finding 3: the parser's own message, which carries the position, is appended
// so a typo is easier to find (story 110).
test('loadConfig appends the JSON parser error, including its position, to the message', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{"a": 1,}');

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.match(result.error, /position/i);
});

// review-CFG-02 finding 2, Q6 (amended): a leading UTF-8 BOM is stripped, matching Node's own
// JSON file parsing, so a file saved by Windows PowerShell 5.1 or Notepad still parses.
test('loadConfig strips a leading UTF-8 BOM before parsing', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(
    path.join(toplevel, config.REPO_CONFIG_PATH),
    Buffer.concat([bom, Buffer.from('{ "types": ["feat"] }', 'utf8')]),
  );

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });
  assert.deepEqual(result.values.types, ['feat']);
  assert.equal(result.sources.types, 'repo');
});

// review-CFG-02 finding 4, Q6 (amended): invalid UTF-8 is treated as unparseable (a `config`
// refusal), detected cheaply through a fatal-mode decoder rather than Node's default silent
// U+FFFD replacement.
test('loadConfig reports an error naming the repo layer on invalid UTF-8', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  // 0xFF is never valid anywhere in a UTF-8 byte sequence.
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), Buffer.from([0x7b, 0xff, 0x7d]));

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
  assert.match(result.error, /UTF-8/);
});

// CFG-03 (roadmap "a repo layer whose top level is not a JSON object"): CFG-02 was
// JSON-parseability only; a non-object top level now fails `validateLayer` and so
// `loadConfig` too, naming the repo layer.
test('loadConfig reports an error naming the repo layer for a non-object top level', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  for (const body of ['[]', 'null', '42', '"x"']) {
    fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), body);
    const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });
    assert.notEqual(result, null, body);
    assert.match(result.error, /repo config/, body);
    assert.match(result.error, /\.claude[/\\]commit\.json/, body);
  }
});

// review-CFG-02 finding 1(a): a read error other than ENOENT/ENOTDIR (here EISDIR, from the
// repo layer's path being a directory) is a `config` refusal naming the layer, not an
// uncaught throw that ends as `internal`.
test('loadConfig reports an error naming the repo layer when the path is a directory', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, config.REPO_CONFIG_PATH), { recursive: true });

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /repo config/);
});

// review-CFG-02 finding 10: a regular-file check plus a size cap (same style as the run-lock
// read) closes a self-DoS where a cloned repo commits an oversized `.claude/commit.json`.
test('loadConfig reports an error naming the repo layer for an oversized file, never reading it', async (t) => {
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

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

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

test('loadConfig returns the effective defaults when the user config is absent, even with no toplevel at all', async (t) => {
  const claudeHome = tempClaudeHome(t);
  const result = await config.loadConfig({ toplevel: null, claudeHome });
  assert.deepEqual(result.values, Q6_DEFAULT_VALUES);
  assert.equal(result.sources.types, 'default');
});

test('loadConfig returns the user layer\'s types as effective, sourced to user, when valid JSON', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": ["feat", "fix"] }');
  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });
  assert.deepEqual(result.values.types, ['feat', 'fix']);
  assert.equal(result.sources.types, 'user');
});

test('loadConfig reports an error naming the user layer on unparseable JSON, with no toplevel', async (t) => {
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": [');

  const result = await config.loadConfig({ toplevel: null, claudeHome });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
  assert.match(result.error, /commit\.json/);
});

test('loadConfig reports an error naming the user layer for a bad value, even with a valid repo layer', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": ["feat"] }');
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "maxSubjectLength": 0 }');

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
  assert.match(result.error, /maxSubjectLength/);
});

test('loadConfig reports the user-layer error even when the repo layer is also invalid', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), '{ "types": [');
  fs.writeFileSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), '{ "types": [');

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
});

// review-CFG-04 finding 6: the shared pipeline's label threading (`readLayer`'s early-return
// paths) was pinned for the repo layer only; these parametrise the same checks for the user
// layer, naming it instead of the repo layer.
test('loadConfig reports an error naming the user layer when the path is a directory', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(claudeHome, config.USER_CONFIG_FILENAME), { recursive: true });

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.notEqual(result, null);
  assert.match(result.error, /user config/);
});

test('loadConfig reports an error naming the user layer for an oversized file, never reading it', async (t) => {
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

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

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

// CFG-06 (docs/roadmap/04-config-and-attribution.md): unknown keys, unknown values of a
// known key, and a key in the wrong layer warn and fall back instead of refusing `plan`
// (Q6). Unit-level coverage of `loadConfig`'s warnings; Seam 1 coverage (stdout/stderr,
// `plan.warnings`) lives in tests/plan-config-warnings.test.js.
test('loadConfig warns and ignores an unknown key in the repo layer, with no effect on other keys', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(toplevel, config.REPO_CONFIG_PATH),
    JSON.stringify({ workerModel: 'haiku', types: ['feat'] }),
  );

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.deepEqual(result.values.types, ['feat']);
  assert.equal(result.warnings.length, 1);
  // Pins the exact text (review-CFG-06 finding 5): one shape, matching validateLayer's own
  // "the <layer> ..." wording, shared by every warning kind.
  assert.equal(
    result.warnings[0],
    "the repo config (.claude/commit.json) key 'workerModel' is unknown; ignored",
  );
});

test('loadConfig warns and falls back to the user layer when the repo layer has an unknown value for a known key', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(claudeHomeConfigPath(claudeHome), JSON.stringify({ body: 'optional' }));
  fs.writeFileSync(path.join(toplevel, config.REPO_CONFIG_PATH), JSON.stringify({ body: 'required' }));

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.equal(result.values.body, 'optional');
  assert.equal(result.sources.body, 'user');
  assert.equal(result.warnings.length, 1);
  assert.equal(
    result.warnings[0],
    'the repo config (.claude/commit.json) value "required" for body is unknown; ignored',
  );
});

test('loadConfig warns and ignores scanIgnore given in the user layer (repo only)', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.writeFileSync(claudeHomeConfigPath(claudeHome), JSON.stringify({ scanIgnore: ['*.log'] }));

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.equal(result.warnings.length, 1);
  assert.equal(
    result.warnings[0],
    "the user config (commit.json) key 'scanIgnore' is only valid in the repo layer; ignored",
  );
});

// review-CFG-06 finding 1 (Medium): no test asserted that a *repo-layer* scanIgnore (the
// right layer) produces no warning and keeps its value and source. A mutant that dropped
// `&& kind !== 'repo'` from the wrong-layer check in `collectConfigWarnings` (so it warns
// and strips scanIgnore in every layer, repo included) passed the whole suite before this
// test existed. Every other known key is included too, each with a valid value, so this
// also covers finding 7 (the previous version of this test wrote no layers at all).
test('loadConfig returns an empty warnings array when every key is known, valid and in the right layer', async (t) => {
  const toplevel = tempToplevel(t);
  const claudeHome = tempClaudeHome(t);
  fs.mkdirSync(path.join(toplevel, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(toplevel, config.REPO_CONFIG_PATH),
    JSON.stringify({
      types: ['feat'],
      scope: 'optional',
      body: 'optional',
      maxSubjectLength: 50,
      subjectCase: 'any',
      scanIgnore: ['a/**'],
    }),
  );

  const result = await config.loadConfig({ toplevel, claudeHome, unborn: true });

  assert.deepEqual(result.warnings, []);
  // CFG-07: the worktree's scanIgnore is validated but never used; the effective value is
  // read at HEAD only, and this toplevel has none (no git repo, passed as unborn).
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
});

function claudeHomeConfigPath(claudeHome) {
  return path.join(claudeHome, config.USER_CONFIG_FILENAME);
}

// CFG-07 (docs/roadmap/04-config-and-attribution.md, Q6, Q10 as amended by CFG-01,
// C:scanignore-globs): `validateLayer` compiles every `scanIgnore` pattern with M7
// `compileGlob` itself, `loadConfig` reads `scanIgnore` at HEAD only, and M4 exports
// `isRepoConfigPath`. Seam 1 coverage lives in tests/plan-config-scanignore.test.js.

const REPO_LAYER_LABEL = 'repo config (.claude/commit.json)';

test('validateLayer, called directly, rejects a scanIgnore glob error, naming the pattern', () => {
  for (const pattern of ['**', '**/*', 'src/{a,b}.js', 'a**b', '../x', '!x', '']) {
    const result = config.validateLayer({ scanIgnore: [pattern] }, REPO_LAYER_LABEL);
    assert.notEqual(result, null, JSON.stringify(pattern));
    assert.equal(result.errors.length, 1, JSON.stringify(pattern));
    assert.ok(
      result.errors[0].startsWith(`the ${REPO_LAYER_LABEL} scanIgnore pattern ${JSON.stringify(pattern)} `),
      result.errors[0],
    );
  }
});

test('validateLayer reports every bad scanIgnore pattern, one error each', () => {
  const result = config.validateLayer({ scanIgnore: ['**', 'ok/**', '[ab]'] }, REPO_LAYER_LABEL);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /"\*\*"/);
  assert.match(result.errors[1], /"\[ab\]"/);
});

test('validateLayer rejects a scanIgnore that is not an array of strings, naming the key', () => {
  for (const value of ['dist/**', ['dist/**', 3], null, {}]) {
    const result = config.validateLayer({ scanIgnore: value }, REPO_LAYER_LABEL);
    assert.notEqual(result, null, JSON.stringify(value));
    assert.equal(result.errors.length, 1, JSON.stringify(value));
    assert.equal(
      result.errors[0],
      `the ${REPO_LAYER_LABEL} scanIgnore must be an array of strings, not ${JSON.stringify(value)}`,
    );
  }
});

test('validateLayer accepts valid scanIgnore patterns, and an empty array', () => {
  assert.equal(config.validateLayer({ scanIgnore: ['dist/**', '/build/', '*.log', 'a/?.txt'] }, REPO_LAYER_LABEL), null);
  assert.equal(config.validateLayer({ scanIgnore: [] }, REPO_LAYER_LABEL), null);
});

// review-CFG-06 finding 6 (forward note): a repo-only key in the user layer is CFG-06's
// warn-and-ignore, never a `config` refusal, even when its value would not validate.
test('loadConfig warns, never refuses, for an invalid scanIgnore given in the user layer', async (t) => {
  for (const value of ['dist/**', ['**'], ['x', 3]]) {
    const claudeHome = tempClaudeHome(t);
    fs.writeFileSync(claudeHomeConfigPath(claudeHome), JSON.stringify({ scanIgnore: value }));

    const result = await config.loadConfig({ toplevel: null, claudeHome });

    assert.equal(result.error, undefined, JSON.stringify(value));
    assert.deepEqual(result.values.scanIgnore, [], JSON.stringify(value));
    assert.deepEqual(result.warnings, [
      "the user config (commit.json) key 'scanIgnore' is only valid in the repo layer; ignored",
    ], JSON.stringify(value));
  }
});

test('isRepoConfigPath is true only for the exact repo config path', () => {
  assert.equal(config.REPO_CONFIG_PATH, '.claude/commit.json');
  assert.equal(config.isRepoConfigPath('.claude/commit.json'), true);
  assert.equal(config.isRepoConfigPath('sub/.claude/commit.json'), false);
  assert.equal(config.isRepoConfigPath('.claude/commit.JSON'), false);
});

// The HEAD read, against a real temp repo (createCase: fixed author and dates, isolated env).

function headCase(t, headText, worktreeText) {
  const c = createCase(t);
  c.writeFile('.claude/commit.json', headText);
  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'seed']);
  if (worktreeText !== undefined) c.writeFile('.claude/commit.json', worktreeText);
  return c;
}

function loadAtHead(c, unborn = false) {
  return config.loadConfig({
    toplevel: c.repoDir, claudeHome: c.claudeHome, unborn, env: c.env, now: () => 0,
  });
}

test('loadConfig reads scanIgnore at HEAD, sourced to repo@HEAD, with compiled matchers', async (t) => {
  const c = headCase(t, JSON.stringify({ scanIgnore: ['dist/**', '*.log'] }), JSON.stringify({ scanIgnore: ['other/**'] }));

  const result = await loadAtHead(c);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.values.scanIgnore, ['dist/**', '*.log']);
  assert.equal(result.sources.scanIgnore, 'repo@HEAD');
  assert.equal(result.scanIgnore.length, 2);
  assert.deepEqual(result.scanIgnore[0], compileGlob('dist/**').matcher);
});

test('loadConfig ignores a scanIgnore present only in the worktree (not yet committed)', async (t) => {
  const c = headCase(t, JSON.stringify({ types: ['feat'] }), JSON.stringify({ types: ['fix'], scanIgnore: ['dist/**'] }));

  const result = await loadAtHead(c);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.scanIgnore, []);
  assert.deepEqual(result.values.types, ['fix']);
});

// A trace2 `normalTarget` in a global config of its own (copied from
// tests/plan-step7.test.js): `commands()` lists the argv of every git process started, one
// `start` line each. Works from git 2.34 on all three OSes.
function traceGit(c) {
  const log = path.join(c.root, 'trace2.log');
  const traceConfig = path.join(c.root, 'trace.gitconfig');
  fs.writeFileSync(traceConfig, `[trace2]\n\tnormalTarget = ${log.split(path.sep).join('/')}\n`);
  return {
    env: { ...c.env, GIT_CONFIG_GLOBAL: traceConfig },
    commands() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter((line) => / start /.test(line));
    },
  };
}

function loadTraced(c, trace, unborn = false) {
  return config.loadConfig({
    toplevel: c.repoDir, claudeHome: c.claudeHome, unborn, env: trace.env, now: () => 0,
  });
}

// review-CFG-07 finding 5: on a born repo with a valid `scanIgnore` at HEAD, `unborn: true`
// alone must keep the HEAD read from running (an unborn repo would fail the read anyway, so
// the result alone cannot tell), checked on the git calls actually started.
test('loadConfig spawns no HEAD read when unborn: worktree keys apply, scanIgnore is []', async (t) => {
  const c = headCase(t, JSON.stringify({ scanIgnore: ['other/**'] }), JSON.stringify({ types: ['feat'], scanIgnore: ['dist/**'] }));
  const trace = traceGit(c);

  const result = await loadTraced(c, trace, true);

  assert.deepEqual(trace.commands(), []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.values.types, ['feat']);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
});

const HEAD_INVALID = [
  ['unparseable JSON', '{ "scanIgnore": ['],
  ['a non-object top level', '[]'],
  ['a bare string', JSON.stringify({ scanIgnore: 'dist/**' })],
  ['a non-string entry', JSON.stringify({ scanIgnore: ['dist/**', 3] })],
  ['a glob error', JSON.stringify({ scanIgnore: ['dist/**', '**/*'] })],
];

for (const [label, headText] of HEAD_INVALID) {
  test(`loadConfig uses [] and warns, naming the repo config at HEAD, for ${label} at HEAD`, async (t) => {
    const c = headCase(t, headText, JSON.stringify({ scanIgnore: ['dist/**'] }));

    const result = await loadAtHead(c);

    assert.equal(result.error, undefined);
    assert.deepEqual(result.values.scanIgnore, []);
    assert.deepEqual(result.scanIgnore, []);
    assert.equal(result.sources.scanIgnore, 'default');
    assert.equal(result.warnings.length, 1);
    assert.ok(
      result.warnings[0].startsWith('the repo config at HEAD (.claude/commit.json) '),
      result.warnings[0],
    );
    assert.match(result.warnings[0], /scanIgnore is ignored \(\[\] used\)$/);
  });
}

// review-CFG-07 finding 3: only the file being absent at HEAD is silent. Checked end to end
// against real git, through the HEAD read's own calls, on a born repo where the file was
// never committed.
test('loadConfig is silent when the repo config was never committed (file absent at HEAD)', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'readme\n');
  c.git(['add', '--', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.claude/commit.json', JSON.stringify({ scanIgnore: ['dist/**'] }));

  const result = await loadAtHead(c);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.scanIgnore, []);
});

// review-CFG-07 finding 4: like `readLayer`'s stat-before-read, an oversized blob at HEAD is
// refused on its size alone, its content never read.
test('loadConfig warns for an oversized repo config at HEAD, never reading its content', async (t) => {
  const c = createCase(t);
  c.writeFile('.claude/commit.json', `${' '.repeat(1024 * 1024)}{}`);
  c.git(['add', '--', '.claude/commit.json']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('.claude/commit.json', '{}');
  const trace = traceGit(c);

  const result = await loadTraced(c, trace);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.warnings, [
    'the repo config at HEAD (.claude/commit.json) is larger than 65536 bytes; its scanIgnore is ignored ([] used)',
  ]);
  const contentReads = trace.commands().filter((line) => / show | cat-file blob /.test(line));
  assert.deepEqual(contentReads, []);
});

// review-CFG-07 finding 3: a HEAD read that fails for any other reason than the file being
// absent (here a corrupt blob) warns instead of silently falling back to [] (still
// fail-closed, never a `config` refusal).
test('loadConfig warns, never refuses, when the repo config blob at HEAD is corrupt', async (t) => {
  const c = headCase(t, JSON.stringify({ scanIgnore: ['dist/**'] }));
  const sha = c.git(['rev-parse', 'HEAD:.claude/commit.json']).trim();
  const objectPath = path.join(c.repoDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  fs.chmodSync(objectPath, 0o600);
  fs.writeFileSync(objectPath, 'not a valid zlib stream, deliberately corrupted'.padEnd(64, 'x'));

  const result = await loadAtHead(c);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.equal(result.warnings.length, 1);
  assert.ok(
    result.warnings[0].startsWith('the repo config at HEAD (.claude/commit.json) could not be read'),
    result.warnings[0],
  );
});

// review-CFG-07 finding 3: a path at HEAD that is not a file (here a directory) warns.
test('loadConfig warns when the repo config at HEAD is not a regular file', async (t) => {
  const c = createCase(t);
  c.writeFile('.claude/commit.json/inner.txt', 'x\n');
  c.git(['add', '--', '.claude/commit.json/inner.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, '.claude', 'commit.json'), { recursive: true });

  const result = await loadAtHead(c);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.warnings, [
    'the repo config at HEAD (.claude/commit.json) is not a regular file; its scanIgnore is ignored ([] used)',
  ]);
});

// review-CFG-07 r2 finding 4: a symlink (mode 120000) at HEAD warns too; its blob holds the
// link target text, not JSON, even though `git ls-tree` reports it as type `blob`.
test('loadConfig warns when the repo config at HEAD is a symlink', async (t) => {
  const c = createCase(t);
  c.writeFile('.claude/commit.json', 'target');
  const sha = c.git(['hash-object', '-w', '--', '.claude/commit.json']).trim();
  c.git(['update-index', '--add', '--cacheinfo', `120000,${sha},.claude/commit.json`]);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.rmSync(path.join(c.repoDir, '.claude', 'commit.json'));

  const result = await loadAtHead(c);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.warnings, [
    'the repo config at HEAD (.claude/commit.json) is not a regular file; its scanIgnore is ignored ([] used)',
  ]);
});

// review-CFG-07 r2 finding 4: a gitlink (mode 160000, type `commit`) at HEAD warns the same
// way as a directory, caught by the `type !== 'blob'` check alone.
test('loadConfig warns when the repo config at HEAD is a gitlink', async (t) => {
  const c = createCase(t);
  c.writeFile('README.md', 'readme\n');
  c.git(['add', '--', 'README.md']);
  c.git(['commit', '-q', '-m', 'seed']);
  const headSha = c.git(['rev-parse', 'HEAD']).trim();
  c.git(['update-index', '--add', '--cacheinfo', `160000,${headSha},.claude/commit.json`]);
  c.git(['commit', '-q', '-m', 'gitlink']);

  const result = await loadAtHead(c);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.values.scanIgnore, []);
  assert.equal(result.sources.scanIgnore, 'default');
  assert.deepEqual(result.warnings, [
    'the repo config at HEAD (.claude/commit.json) is not a regular file; its scanIgnore is ignored ([] used)',
  ]);
});

// SCN-14 (docs/roadmap/05-scanner.md, M4): pure `scanIgnoreChanged(headPatterns,
// snapshotBlob)`, compared against M10 `snapshotBlob`'s result on the snapshot side.

test('scanIgnoreChanged: equal patterns (both empty, or both the same list) is false', async () => {
  assert.equal(config.scanIgnoreChanged([], null), false);
  assert.equal(config.scanIgnoreChanged([], Buffer.from('{}')), false);
  assert.equal(
    config.scanIgnoreChanged(['dist/**'], Buffer.from(JSON.stringify({ scanIgnore: ['dist/**'] }))),
    false,
  );
});

test('scanIgnoreChanged: a different list, order included, is true', async () => {
  assert.equal(
    config.scanIgnoreChanged(['a/**'], Buffer.from(JSON.stringify({ scanIgnore: ['b/**'] }))),
    true,
  );
  assert.equal(
    config.scanIgnoreChanged(
      ['a/**', 'b/**'],
      Buffer.from(JSON.stringify({ scanIgnore: ['b/**', 'a/**'] })),
    ),
    true,
  );
  assert.equal(config.scanIgnoreChanged([], Buffer.from(JSON.stringify({ scanIgnore: ['a/**'] }))), true);
  assert.equal(config.scanIgnoreChanged(['a/**'], null), true);
});

test('scanIgnoreChanged: a missing file or key on the snapshot side is no patterns, not invalid', async () => {
  assert.equal(config.scanIgnoreChanged([], null), false);
  assert.equal(config.scanIgnoreChanged([], Buffer.from(JSON.stringify({ types: ['feat'] }))), false);
  assert.equal(config.scanIgnoreChanged([], Buffer.from(JSON.stringify(['a', 'b']))), false);
});

test('scanIgnoreChanged: unparseable JSON or a non-array scanIgnore on the snapshot side counts as changed', async () => {
  assert.equal(config.scanIgnoreChanged([], Buffer.from('{ "scanIgnore": [')), true);
  assert.equal(config.scanIgnoreChanged([], Buffer.from(JSON.stringify({ scanIgnore: 'dist/**' }))), true);
  assert.equal(
    config.scanIgnoreChanged([], Buffer.from(JSON.stringify({ scanIgnore: ['dist/**', 3] }))),
    true,
  );
  // Even against HEAD's own `[]` (Q6, CFG-01 item 5): a fixed copy with patterns still
  // counts as changed, so edits to an invalid-at-HEAD scanIgnore are not silently missed.
  assert.equal(
    config.scanIgnoreChanged([], Buffer.from(JSON.stringify({ scanIgnore: ['dist/**'] }))),
    true,
  );
});
