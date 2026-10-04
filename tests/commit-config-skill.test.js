'use strict';

// INF-08: `/commit-config` skill (docs/roadmap/14-infer-and-commit-config.md "INF-08").
// Static checks only: the frontmatter, the description's size budget, and that the skill
// text documents the `infer` call form, the `ok: false` and outcome branches, the repo/user
// choice, the write-after-confirmation rule, the per-layer errors case, the two write
// targets, and the under-20/under-50% guidance (Q6, Q7, Q14, C:infer, stories 128-134). The
// skill only runs the script and writes text it returns; its runtime behaviour is exercised
// by hand in INF-09.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseAgentFile } = require('./helpers/agent-frontmatter.js');
const { assertDescriptionBudget } = require('./helpers/description-budget.js');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, 'plugin', 'skills', 'commit-config', 'SKILL.md');

function readSkill() {
  return parseAgentFile(SKILL_PATH);
}

// AC: "A static test reads the skill frontmatter: disable-model-invocation: true (Q7)"
test('INF-08: the /commit-config skill is user-only', () => {
  const { attrs } = readSkill();
  assert.equal(attrs.name, 'commit-config');
  assert.equal(attrs['disable-model-invocation'], true);
});

// AC: "CI size test: description <= 200 characters."
test('INF-08: the description is at most 200 characters', () => {
  const { attrs } = readSkill();
  assertDescriptionBudget(attrs);
});

// AC: "A static test: the skill text names the script by the plugin-root path." The command
// must actually run in both shells: `node`, a quoted path, and a tool timeout above infer's
// own deadline (Q24, worker-input.md, README allow rule).
test('INF-08: the skill runs a quoted node command with a tool timeout', () => {
  const { body } = readSkill();
  assert.match(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/commit\.cjs" infer/);
  assert.match(body, /\btimeout\b[\s\S]{0,30}600000\s*ms/i);
});

// Low finding 3: an `ok: false` reply must still show something and write nothing.
test('INF-08: a failed reply shows the error and writes nothing', () => {
  const { body } = readSkill();
  assert.match(
    body,
    /\bok\b[\s\S]{0,20}false[\s\S]{0,120}error\.message[\s\S]{0,120}write\s+nothing/i,
  );
});

test('INF-08: the skill text branches on every infer outcome', () => {
  const { body } = readSkill();
  assert.match(body, /too-few-commits/);
  assert.match(body, /not-conventional/);
  assert.match(body, /`proposal`:/);
});

// "What to build": the proposal branch shows wouldFail/nonConventional/droppedTypes before
// asking repo or user (windowed to the proposal branch, not matched anywhere in the body).
test('INF-08: the proposal branch shows the numbers before asking repo or user', () => {
  const { body } = readSkill();
  assert.match(
    body,
    /`proposal`:[\s\S]{0,150}wouldFail[\s\S]{0,100}nonConventional[\s\S]{0,100}droppedTypes[\s\S]{0,300}ask\s+whether\s+to\s+write\s+it\s+at\s+`repo`\s+or\s+`user`\s+level/,
  );
});

test('INF-08: writes only configJson text verbatim, never composed by the model', () => {
  const { body } = readSkill();
  assert.match(body, /`configJson`/);
  assert.match(body, /verbatim/i);
  assert.match(body, /never compose config JSON yourself/i);
});

// Finding 6: "write nothing" occurs in three branches; pin it to the `{ errors }` branch
// specifically, not anywhere in the body.
test('INF-08: an invalid chosen layer shows errors and writes nothing', () => {
  const { body } = readSkill();
  assert.match(body, /\{\s*errors\s*\}[\s\S]{0,200}write\s+nothing/i);
});

test('INF-08: under 20 commits recommends the defaults', () => {
  const { body } = readSkill();
  assert.match(body, /too-few-commits[\s\S]{0,200}recommend\s+the\s+defaults/i);
});

// Medium finding: the opt-out must land under `enabledPlugins`, not a bare top-level key
// (Q14, docs/roadmap/15-release.md:78).
test('INF-08: under 50% points to the enabledPlugins opt-out', () => {
  const { body } = readSkill();
  assert.match(
    body,
    /not-conventional[\s\S]{0,500}"commit@commit":\s*false[\s\S]{0,100}enabledPlugins/,
  );
  assert.match(body, /\.claude\/settings\.local\.json/);
});

test('INF-08: nothing is written before the user confirms', () => {
  const { body } = readSkill();
  assert.match(body, /write\s+nothing\s+before\s+(this\s+call|infer)\s+returns/i);
  assert.match(body, /never\s+write\s+before\s+the\s+user\s+has[\s\S]{0,60}confirmed/i);
});

// Low finding 5: both write targets, resolved to an absolute path, plus Read-before-Write
// for an existing file (the Write tool refuses an unread overwrite).
test('INF-08: writes to both resolved target paths, reading an existing file first', () => {
  const { body } = readSkill();
  assert.match(body, /\.claude\/commit\.json/);
  assert.match(body, /git rev-parse --show-toplevel/);
  assert.match(body, /CLAUDE_CONFIG_DIR/);
  assert.match(body, /Read it first/i);
});

// No local paths or usernames anywhere in the skill text (privacy guard, Q15).
test('INF-08: the skill text holds no local paths or usernames', () => {
  const { source } = readSkill();
  assert.doesNotMatch(source, /[A-Za-z]:[\\/]Users[\\/]/);
  assert.doesNotMatch(source, /\/home\//);
  assert.doesNotMatch(source, /~[\\/](?!\.claude)/);
});
