'use strict';

// INF-08: `/commit-config` skill (docs/roadmap/14-infer-and-commit-config.md "INF-08").
// Static checks only: the frontmatter, the description's size budget, and that the skill
// text documents the `infer` outcomes, the repo/user choice, the write-after-confirmation
// rule, the per-layer errors case, and the under-20/under-50% guidance (Q6, Q7, Q14,
// C:infer, stories 128-134). The skill only runs the script and writes text it returns;
// its runtime behaviour is exercised by hand in INF-09.

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

// AC: "A static test: the skill text names the script by the plugin-root path."
test('INF-08: the skill text names the script by the plugin-root path', () => {
  const { body } = readSkill();
  assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/commit\.cjs/);
  assert.match(body, /\binfer\b/);
});

// "What to build": runs infer, shows the proposal with its numbers (wouldFail,
// nonConventional, dropped types), asks repo or user, and after confirmation writes that
// layer's configJson text verbatim; shows errors and writes nothing for an invalid layer;
// recommends the defaults under 20 commits; points to the opt-out below 50%.
test('INF-08: the skill text branches on every infer outcome', () => {
  const { body } = readSkill();
  assert.match(body, /too-few-commits/);
  assert.match(body, /not-conventional/);
  assert.match(body, /\bproposal\b/);
});

test('INF-08: the skill text shows the proposal numbers before asking', () => {
  const { body } = readSkill();
  assert.match(body, /wouldFail/);
  assert.match(body, /nonConventional/);
  assert.match(body, /droppedTypes/);
});

test('INF-08: the skill text asks repo or user, then writes only configJson text verbatim', () => {
  const { body } = readSkill();
  assert.match(body, /\brepo\b.*\buser\b|\buser\b.*\brepo\b/is);
  assert.match(body, /`configJson`/);
  assert.match(body, /verbatim/i);
  assert.match(body, /never compose config JSON yourself/i);
});

test('INF-08: an invalid chosen layer shows errors and writes nothing', () => {
  const { body } = readSkill();
  assert.match(body, /\{\s*errors\s*\}/);
  assert.match(body, /write\s+nothing/i);
});

test('INF-08: under 20 commits recommends the defaults; under 50% points to the opt-out', () => {
  const { body } = readSkill();
  // too-few-commits branch recommends defaults
  assert.match(body, /too-few-commits[\s\S]{0,200}recommend\s+the\s+defaults/i);
  // not-conventional branch points to the opt-out (Q14)
  assert.match(body, /not-conventional[\s\S]{0,400}opt-out/i);
  assert.match(body, /"commit@commit":\s*false/);
  assert.match(body, /\.claude\/settings\.local\.json/);
});

test('INF-08: nothing is written before the user confirms', () => {
  const { body } = readSkill();
  assert.match(body, /[Ww]rite\s+nothing\s+before\s+this\s+call\s+returns/);
  assert.match(
    body,
    /[Nn]ever\s+write\s+before\s+the\s+user\s+has\s+both\s+seen\s+the\s+proposal\s+and\s+confirmed/,
  );
});

// No local paths or usernames anywhere in the skill text (privacy guard, Q15).
test('INF-08: the skill text holds no local paths or usernames', () => {
  const { source } = readSkill();
  assert.doesNotMatch(source, /[A-Za-z]:[\\/]Users[\\/]/);
  assert.doesNotMatch(source, /\/home\//);
  assert.doesNotMatch(source, /~[\\/](?!\.claude)/);
});
