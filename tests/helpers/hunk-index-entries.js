'use strict';

// CHG-18 (review H1): past the stdout budget, `plan`'s `hunks.hunks` is spilled to
// `hunks.json` and `hunks.hunksIndexFile` names it instead. A test that only needs the
// index entries (not the budget behavior itself) reads through this helper so it keeps
// working whether or not its fixture happens to cross the budget.

const fs = require('node:fs');

/**
 * @param {object} hunks a `plan`/`plan --hunks` output's `hunks` object (C:plan-hunks).
 * @returns {object[]} every index entry, in ID order, whether inline or spilled.
 */
function hunkIndexEntries(hunks) {
  if (hunks.hunksIndexFile !== undefined) {
    return fs.readFileSync(hunks.hunksIndexFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }
  return hunks.hunks;
}

module.exports = { hunkIndexEntries };
