// M10 Change-set engine (docs/spec/modules-m10-m13.md, Q11): the inventory, the temporary
// index, units and the tree state. Effectful; spawns only through M2.
//
// INT-01 builds the thinnest `treeState` the walking skeleton needs; CHG-04 completes it
// (the tree state every reply ends with) and CHG-03 onward build the inventory proper.

import { run } from './process-adapter.mjs';

/**
 * Reads the working tree's state: every path `git status` reports (tracked changes and
 * untracked, non-ignored files).
 *
 * @param {{ toplevel: string, env: object, now?: () => number }} options `now`: the
 *   injected clock, passed on to M2.
 * @returns {Promise<{ clean: true } | { count: number, paths: string[] }>}
 * @throws {Error} when `git status` exits non-zero.
 */
export async function treeState({ toplevel, env, now }) {
  const result = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: toplevel,
    env,
    now,
    readOnly: true,
  });
  if (result.code !== 0) {
    throw new Error(`git status failed (${result.code}): ${result.stderr}`);
  }
  // Porcelain v1 `-z`: `XY <path>` records, NUL-terminated; a rename or copy (`R`/`C` in
  // either column) is followed by one more record holding its old path, skipped here.
  const records = result.stdout.toString('utf8').split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === '') continue;
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) i += 1;
  }
  return paths.length === 0 ? { clean: true } : { count: paths.length, paths };
}
