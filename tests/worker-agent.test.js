'use strict';

// WRK-01: commit-worker agent definition and description (docs/roadmap/13-worker-and-skills.md
// "WRK-01"). Static checks only: the frontmatter values, the description's size and clause
// order, the agent's resolved name, and the model-equality check across every spawn
// instruction the plugin ships so far (story 42, 6, 228; Q2, Q24, Q25 as amended by the
// PRE-15 decision pass; C:reply-and-handback; C:guard; public-surface.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgentFile } = require('./helpers/agent-frontmatter.js');

const REPO_ROOT = path.join(__dirname, '..');
const AGENT_PATH = path.join(REPO_ROOT, 'plugin', 'agents', 'commit-worker.md');
const PLUGIN_JSON_PATH = path.join(REPO_ROOT, 'plugin', '.claude-plugin', 'plugin.json');
const PUBLIC_SURFACE_PATH = path.join(REPO_ROOT, 'docs', 'decisions', 'public-surface.md');
const REPLY_AND_HANDBACK_PATH = path.join(REPO_ROOT, 'docs', 'contracts', 'reply-and-handback.md');
const GUARD_CONTRACT_PATH = path.join(REPO_ROOT, 'docs', 'contracts', 'guard.md');
const WORKER_INPUT_PATH = path.join(REPO_ROOT, 'docs', 'contracts', 'worker-input.md');

function readAgent() {
  return parseAgentFile(AGENT_PATH);
}

// AC: "A static test reads the agent frontmatter: model: sonnet, omitClaudeMd: true,
// maxTurns: 25, tools exactly Bash, PowerShell, Read, Write (story 42)"
test('WRK-01: the commit-worker frontmatter carries the fixed runaway and identity values', () => {
  const { attrs } = readAgent();
  assert.equal(attrs.model, 'sonnet');
  assert.equal(attrs.omitClaudeMd, true);
  assert.equal(attrs.maxTurns, 25);
  // Split on commas so this still passes if the frontmatter switches to the YAML list
  // form Claude Code also accepts for `tools`, not just the comma-separated string.
  const tools =
    typeof attrs.tools === 'string' ? attrs.tools.split(',').map((t) => t.trim()) : attrs.tools;
  assert.deepEqual(tools, ['Bash', 'PowerShell', 'Read', 'Write']);
});

// AC: "CI size test: the description is ≤ 200 characters (story 228's budget as held by
// Q24, whatever the story's wording)"
test('WRK-01: the description is at most 200 characters', () => {
  const { attrs } = readAgent();
  assert.equal(typeof attrs.description, 'string');
  assert.ok(
    attrs.description.length <= 200,
    `description is ${attrs.description.length} characters, budget is 200`,
  );
});

// AC: "The description holds the six Q2 clauses in order, starting with 'follow the
// reply's callerRule'; a static test asserts that clause comes first, so any shortening
// cuts from the bottom (story 6)"
test('WRK-01: the description holds the six Q2 clauses in order, trust clause first', () => {
  const { attrs } = readAgent();
  const description = attrs.description;

  // Clause 1 (trust, Q2): never cut, always first.
  assert.ok(
    /^follow the reply's callerrule/i.test(description),
    'description must start with "follow the reply\'s callerRule"',
  );

  const clausePatterns = [
    { name: '1 trust clause (callerRule)', re: /follow the reply's callerrule/i },
    { name: '2 triggers', re: /commit this/i },
    { name: '3 intent field', re: /intent:/i },
    { name: '4 edit no files until it replies', re: /edit no files until it replies/i },
    { name: '5 interactive field', re: /interactive:\s*false/i },
    { name: "6 don't read the diff first", re: /don'?t read the diff first/i },
  ];

  const indices = clausePatterns.map(({ name, re }) => {
    const m = re.exec(description);
    assert.ok(m, `description is missing clause ${name}: ${re}`);
    return m.index;
  });

  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(
      indices[i] > indices[i - 1],
      `clause ${clausePatterns[i].name} must come after clause ${clausePatterns[i - 1].name} ` +
        `(so a shortened description cuts from the bottom, never the trust clause)`,
    );
  }
});

// AC: "The agent resolves as commit:commit-worker from the plugin layout (static check of
// the agent file name against the public-surface name)"
test('WRK-01: the agent resolves as commit:commit-worker from the plugin layout', () => {
  assert.ok(fs.existsSync(AGENT_PATH), 'plugin/agents/commit-worker.md must exist');

  const plugin = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
  const agentFileName = path.basename(AGENT_PATH, '.md');
  const resolvedFileName = `${plugin.name}:${agentFileName}`;
  assert.equal(resolvedFileName, 'commit:commit-worker');

  const publicSurface = fs.readFileSync(PUBLIC_SURFACE_PATH, 'utf8');
  assert.ok(
    publicSurface.includes('commit:commit-worker'),
    'public-surface.md must name the agent commit:commit-worker for this check to mean anything',
  );

  // Claude Code resolves the agent type from the frontmatter `name`, not the file name, so
  // a wrong `name` must fail this test even though the file name happens to be right.
  const { attrs } = readAgent();
  assert.equal(attrs.name, 'commit-worker');
  const resolvedName = `${plugin.name}:${attrs.name}`;
  assert.equal(resolvedName, 'commit:commit-worker');
});

// AC: "A static test asserts that the frontmatter model equals the model named in every
// spawn instruction the plugin ships: the respawn text of the base callerRule
// (C:reply-and-handback) and the guard's deny route (C:guard) now, the /commit skill
// (WRK-05) and the README spawn line (REL-03) as those slices add them (story 42 as
// settled by PRE-15; Q24 as amended)"
//
// All sources below are doc-only as of this slice: plugin/scripts/lib has no guard
// deny-catalogue module yet (GRD-05, "ready-for-agent") and no `/commit` skill or README
// exist yet (WRK-05, REL-03), so this test extracts the model each source's contract text
// names and compares it to the frontmatter. WRK-05 and REL-03 append their own source to
// SPAWN_INSTRUCTION_SOURCES below once they ship; INT-01/GRD-05 may later move the guard
// entry to reading plugin/scripts/lib instead of the doc.
//
// Each `extractModel` uses `\s+` between words (not literal single spaces) and collects
// every match with `matchAll`, asserting at least one: a doc reflow, or a second respawn
// or deny route added later, must not silently pass or wrongly fail this check.
const SPAWN_INSTRUCTION_SOURCES = [
  {
    name: "the base callerRule's respawn text (C:reply-and-handback)",
    read: () => fs.readFileSync(REPLY_AND_HANDBACK_PATH, 'utf8'),
    extractModels: (text) => {
      const re = /spawn\s+commit:commit-worker\s+with\s+it\s+as\s+the\s+prompt,\s+model\s+(\w+)/g;
      const matches = [...text.matchAll(re)];
      assert.ok(
        matches.length > 0,
        'expected "spawn commit:commit-worker with it as the prompt, model <name>" in reply-and-handback.md',
      );
      return matches.map((m) => m[1]);
    },
  },
  {
    name: "the guard's deny route (C:guard)",
    read: () => fs.readFileSync(GUARD_CONTRACT_PATH, 'utf8'),
    extractModels: (text) => {
      const re = /Spawn\s+the\s+commit:commit-worker\s+agent\s+\(model:\s*(\w+);/g;
      const matches = [...text.matchAll(re)];
      assert.ok(matches.length > 0, 'expected "Spawn the commit:commit-worker agent (model: <name>;" in guard.md');
      return matches.map((m) => m[1]);
    },
  },
  {
    name: "the caller rule of C:worker-input (docs/contracts/worker-input.md)",
    read: () => fs.readFileSync(WORKER_INPUT_PATH, 'utf8'),
    extractModels: (text) => {
      const re = /`model:\s*"(\w+)"`/g;
      const matches = [...text.matchAll(re)];
      assert.ok(matches.length > 0, 'expected "`model: \\"<name>\\"`" in worker-input.md');
      return matches.map((m) => m[1]);
    },
  },
];

test('WRK-01: the frontmatter model equals the model named in every spawn instruction shipped so far', () => {
  const { attrs } = readAgent();
  assert.equal(typeof attrs.model, 'string');

  assert.ok(
    SPAWN_INSTRUCTION_SOURCES.length > 0,
    'the source list should never be emptied out; append to it, do not remove entries',
  );

  for (const source of SPAWN_INSTRUCTION_SOURCES) {
    const models = source.extractModels(source.read());
    for (const model of models) {
      assert.equal(
        model,
        attrs.model,
        `${source.name} names model "${model}", the agent frontmatter names "${attrs.model}"`,
      );
    }
  }
});
