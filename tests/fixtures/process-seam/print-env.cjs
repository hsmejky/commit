'use strict';

// Stub entry point for the process-seam self-test (FND-04): prints, as the single JSON
// object a Seam 1 entry point writes, what the spawned process can see of its environment,
// so the test can prove no host git config, Claude settings or identity leaks in.

const { spawnSync } = require('node:child_process');
const os = require('node:os');

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

const keys = Object.keys(process.env);
process.stdout.write(`${JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  homedir: os.homedir(),
  env: process.env,
  claudeKeys: keys.filter((key) => key.startsWith('CLAUDE_')).sort(),
  gitKeys: keys.filter((key) => key.startsWith('GIT_')).sort(),
  gitAuthorIdent: git(['var', 'GIT_AUTHOR_IDENT']).trim(),
  gitConfigOrigins: git(['config', '--list', '--show-origin']).split('\n').filter(Boolean),
})}\n`);
