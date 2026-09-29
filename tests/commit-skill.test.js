'use strict';

// WRK-05: `/commit` skill (docs/roadmap/13-worker-and-skills.md "WRK-05"). Static checks
// only: the frontmatter, the size budgets, and that the skill text documents the Q2
// argument mapping, the "edit no files" rule and the `model: "sonnet"` spawn (Q2, Q24 as
// amended by the PRE-15 decision pass, Q25, C:worker-input, "Prompt-only and manifest
// blocks" -> "/commit skill", stories 2-5, 7, 9, 228). The skill only spawns the worker
// (docs/spec/README behaviour is exercised by hand in WRK-06); this file cannot run the
// skill itself, since a skill body is prompt text interpreted by a model, not code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgentFile } = require('./helpers/agent-frontmatter.js');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, 'plugin', 'skills', 'commit', 'SKILL.md');

function readSkill() {
  return parseAgentFile(SKILL_PATH);
}

// AC: "Frontmatter disable-model-invocation: true; a static test asserts it (story 7)"
test('WRK-05: the /commit skill is user-only', () => {
  const { attrs } = readSkill();
  assert.equal(attrs.name, 'commit');
  assert.equal(attrs['disable-model-invocation'], true);
});

// AC: "CI size tests: SKILL.md <= 1.5 kB, description <= 200 characters (story 228's
// budgets as held by Q24)"
test('WRK-05: the skill stays within its size budgets', () => {
  const { source, attrs } = readSkill();
  const bytes = Buffer.byteLength(source, 'utf8');
  assert.ok(bytes <= 1536, `SKILL.md is ${bytes} bytes, budget is 1.5 kB (1536 bytes)`);

  assert.equal(typeof attrs.description, 'string');
  assert.ok(
    attrs.description.length <= 200,
    `description is ${attrs.description.length} characters, budget is 200`,
  );
});

// AC: "The text maps bare -> no intent, text -> intent: <text>, reword -> reword: true,
// reword <text> -> reword: <text>, and never adds an intent of its own (stories 2-5)"
test('WRK-05: the skill text maps every Q2 argument form and adds no intent of its own', () => {
  const { body } = readSkill();

  // bare -> no `intent` line
  assert.match(body, /empty:\s*no\s*`intent`\s*line/i);
  // free text -> `intent: <text>`
  assert.match(body, /`intent:\s*<text>`/);
  // `reword` (no text) -> `reword: true`
  assert.match(body, /`reword`:\s*`reword:\s*true`/);
  // `reword <text>` -> `reword: <text>`
  assert.match(body, /`reword\s*<text>`:\s*`reword:\s*<text>`/);

  // Never invents an intent of its own (Q2's rejected alternative: filling intent from
  // the session).
  assert.match(body, /never\s+add\s+an\s+`?intent`?\s+of\s+(its|your)\s+own/i);
});

// AC: "The text says to edit no files until the worker's reply and to follow its
// callerRule"
test('WRK-05: the skill text carries the edit-no-files and callerRule rules', () => {
  const { body } = readSkill();
  assert.match(body, /edit\s+no\s+files\s+until\s+the\s+worker'?s\s+reply/i);
  assert.match(body, /follow\s+the\s+reply'?s\s+`?callerRule`?/i);
});

// AC: "The spawn names model: 'sonnet', and the SKILL.md joins WRK-01's model-equality
// test (Q24 as amended by PRE-15)"
test('WRK-05: the spawn names model: "sonnet"', () => {
  const { body } = readSkill();
  const re = /spawn\s+`?commit:commit-worker`?\s+with\s+`?model:\s*"(\w+)"`?/i;
  const match = re.exec(body);
  assert.ok(match, 'expected a "spawn commit:commit-worker with model: \\"<name>\\"" line in SKILL.md');
  assert.equal(match[1], 'sonnet');
});

// No local paths or usernames anywhere in the skill text (privacy guard, Q15).
test('WRK-05: the skill text holds no local paths or usernames', () => {
  const { source } = readSkill();
  assert.doesNotMatch(source, /[A-Za-z]:[\\/]Users[\\/]/);
  assert.doesNotMatch(source, /\/home\//);
  assert.doesNotMatch(source, /~[\\/]/);
});
