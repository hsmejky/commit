'use strict';

// Table-driven fixture generator (docs/spec/testing-seams.md, Seam 1): one temp repo per table
// row. CHG-13 drives it with directory shapes at, below and above each count cap of
// C:untracked-files; INT-16 is expected to reuse it for its own table. RUN-17's table
// (C:confirmation-triggers) is hand-written per row instead (same Seam 1, different fixture
// construction) — see RUN-17's roadmap text.
//
// A row:
//   trackedDirs: directories that exist at HEAD (each seeded with a `keep.txt`);
//   untracked:   { dir: count } new files written and left untracked (`"."` is the root);
//   staged:      { dir: count } new files written and staged with `git add`;
//   modify:      whether `seed.txt` is modified, so the tree is dirty whatever the caps do
//                (default true);
//   unborn:      skip the seed commit (and `modify`), leaving HEAD unborn (default false).
// Every new file holds `FILE_CONTENT`, so a collapsed directory's `bytes` is
// `count * FILE_CONTENT.length`.

const FILE_CONTENT = 'x\n';

// `count` file paths in `dir`, zero-padded so path order is numeric order.
function filesIn(dir, count, prefix = 'f') {
  const paths = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `${prefix}${String(i).padStart(3, '0')}.txt`;
    paths.push(dir === '.' ? name : `${dir}/${name}`);
  }
  return paths;
}

/**
 * Build the row's repo in `c` (a process-seam case): seed commit, then the new files.
 *
 * @param {object} c a `createCase` case.
 * @param {{ trackedDirs?: string[], untracked?: Record<string, number>,
 *   staged?: Record<string, number>, modify?: boolean, unborn?: boolean }} row
 */
function buildFixture(c, row) {
  if (row.unborn !== true) {
    const seed = ['seed.txt', ...(row.trackedDirs ?? []).map((dir) => `${dir}/keep.txt`)];
    for (const file of seed) c.writeFile(file, 'seed\n');
    c.git(['add', '--', ...seed]);
    c.git(['commit', '-q', '-m', 'seed']);
    if (row.modify !== false) c.writeFile('seed.txt', 'changed\n');
  }
  for (const [dir, count] of Object.entries(row.untracked ?? {})) {
    for (const file of filesIn(dir, count, 'u')) c.writeFile(file, FILE_CONTENT);
  }
  const staged = [];
  for (const [dir, count] of Object.entries(row.staged ?? {})) {
    for (const file of filesIn(dir, count, 's')) {
      c.writeFile(file, FILE_CONTENT);
      staged.push(file);
    }
  }
  if (staged.length > 0) c.git(['add', '--', ...staged]);
}

module.exports = { FILE_CONTENT, filesIn, buildFixture };
