'use strict';

// RPL-09 (docs/roadmap/11-reply-and-cli.md, C:reply-and-handback `respawn`): no respawn holds
// `intent` or `reword` (the script never sees them), and an `edit` respawn marks the user's
// words as `{text}`.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');

let replyLib;
beforeEach(async () => {
  replyLib = await loadLib('reply');
});

const PLAN_ID = '3f9a1c00-0000-4000-8000-000000000000';
const HOLDER_ID = '11111111-1111-4111-8111-111111111111';
const SCRIPT = '/p/commit.cjs';

function respawnsOf(facts) {
  const { handback } = replyLib.reply(facts);
  return handback.answers.filter((a) => a.respawn !== undefined);
}

test('no respawn of any handback kind holds intent or reword; edit respawns carry {text}', () => {
  const all = [
    ...respawnsOf({ status: 'handback', kind: 'confirm', planId: PLAN_ID, scriptPath: SCRIPT, mode: 'split',
      groups: [{ n: 1, header: 'a', files: [] }, { n: 2, header: 'b', files: [] }] }),
    ...respawnsOf({ status: 'handback', kind: 'lintFailed', planId: PLAN_ID, scriptPath: SCRIPT,
      errors: ['x'] }),
    ...respawnsOf({ status: 'handback', kind: 'lock', holder: { planId: HOLDER_ID }, modeFlag: 'staged',
      hhmm: '13:58', idleSeconds: 60 }),
    ...respawnsOf({ status: 'handback', kind: 'modeChoice', staged: 1, other: 1 }),
  ];
  assert.ok(all.length >= 6, JSON.stringify(all));
  for (const a of all) assert.doesNotMatch(a.respawn, /^(intent|reword):/m, a.respawn);
  const edits = all.filter((a) => a.label === 'edit');
  assert.ok(edits.length >= 1);
  for (const a of edits) assert.match(a.respawn, /^edit: \{text\}$/m);
});
