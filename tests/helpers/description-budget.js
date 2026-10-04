'use strict';

// Shared <= 200-character budget check for an agent or skill frontmatter `description`
// (WRK-01's size check, reused as-is by WRK-05's `/commit` skill and INF-08's
// `/commit-config` skill, so the budget and its failure message are asserted in one
// place rather than duplicated per test file).

const assert = require('node:assert/strict');

const DESCRIPTION_BUDGET = 200;

// `attrs` is the parsed frontmatter object (see helpers/agent-frontmatter.js).
function assertDescriptionBudget(attrs) {
  assert.equal(typeof attrs.description, 'string');
  assert.ok(
    attrs.description.length <= DESCRIPTION_BUDGET,
    `description is ${attrs.description.length} characters, budget is ${DESCRIPTION_BUDGET}`,
  );
}

module.exports = { DESCRIPTION_BUDGET, assertDescriptionBudget };
