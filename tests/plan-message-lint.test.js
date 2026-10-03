'use strict';

// PLN-06 (docs/roadmap/08-plan-validation.md): each group's message runs through M6 `lint`
// against the stored config values and M8 `scanText`; errors carry the group number, and a
// scan error carries the `scanText` spans (never the matched value) for M17's future
// redaction. A lint reason quoting a message fragment (type, scope, footer token) that
// overlaps a scan-hit span quotes `[<pattern-id>]` instead (C:check). Built on PLN-01's
// file-level tracer. Until CFG-05 wires `plan`'s real layered
// config into `state.json`, `validatePlan` falls back to the Q6 defaults (see
// plan-validator.mjs's DEFAULT_MESSAGE_VALUES): 11 standard types, scope/body forbidden,
// maxSubjectLength 72, subjectCase lower.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');
const { loadLib } = require('./helpers/load-lib.js');

const PRELOAD = pathToFileURL(path.join(__dirname, 'helpers', 'fault-preload.mjs')).href;

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

// A repo with one committed, then modified, file and a `plan` run holding the lock.
async function plannedRun(t, runOptions = {}) {
  const c = createCase(t);
  c.writeFile('a.txt', 'one\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'one\nmore\n');
  const planned = await runCommit(c, ['plan'], runOptions);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  return { c, planId, runDir };
}

function writeWorkerPlan(runDir, header, body) {
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({
    version: 1,
    source: 'worker',
    groups: [{ header, body, files: ['a.txt'], hunks: [] }],
    notIncluded: [],
  }));
}

test('a header that is not type(scope)!: description fails lint with group 1, no type check', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'Feat: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "header is not 'type(scope)!: description'" },
  ]);
});

test('a type not in the default types fails lint with group 1', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'wip: x', null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "type 'wip' not in types" },
  ]);
});

test('a scan hit in the message fails with message contains `local-path`, never the matched text', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  // Built at run time so this file holds no literal hit (SCN-05 convention); a footer line
  // (allowed token `Refs`) keeps `body: forbidden` (the Q6 default) from also firing, so
  // this is the only lint error.
  const homePath = '/ho' + 'me/jdoe-fixture/app';
  writeWorkerPlan(runDir, 'feat: x', `Refs: see ${homePath}`);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  // The span covers `/home/<name>`, as an offset into `feat: x\n\nRefs: see <path>`.
  const start = 'feat: x\n\nRefs: see '.length;
  assert.deepEqual(checked.json.errors, [{
    group: 1,
    reason: 'message contains `local-path`',
    spans: [{ patternId: 'local-path', start, end: start + homePath.length - '/app'.length }],
  }]);
  assert.equal(checked.stdout.includes(homePath), false, detail(checked));
  assert.equal(checked.stdout.includes('jdoe-fixture'), false, detail(checked));
});

test('a scan hit in the scope is redacted in the scope lint error too', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  const homePath = '/ho' + 'me/jdoe-fixture/app';
  writeWorkerPlan(runDir, `feat(${homePath}): x`, null);

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [
    { group: 1, reason: "scope '[local-path]' not allowed (scope: forbidden)" },
    {
      group: 1,
      reason: 'message contains `local-path`',
      spans: [{ patternId: 'local-path', start: 'feat('.length, end: `feat(${homePath}`.length - '/app'.length }],
    },
  ]);
  assert.equal(checked.stdout.includes('jdoe-fixture'), false, detail(checked));
});

test('a footer with a disallowed token fails lint', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'feat: x', 'Note: see #12');

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.equal(checked.json.errors.length, 1);
  assert.equal(checked.json.errors[0].group, 1);
  assert.match(
    checked.json.errors[0].reason,
    /^`Note` is not an allowed footer token\. If this is body text, rephrase it or add a non-footer line to the paragraph\.$/,
  );
});

test('an allowed footer token passes lint', async (t) => {
  const { c, planId, runDir } = await plannedRun(t);
  writeWorkerPlan(runDir, 'feat: x', 'Closes #12');

  const checked = await runCommit(c, ['check', '--plan', planId]);

  assert.equal(checked.exitCode, 0, detail(checked));
});

// Static: validatePlan threads `osUser` straight through to M8 `scanText` (EXE-01 item 1).
test('validatePlan passes osUser through to scanText', async () => {
  const { validatePlan } = await loadLib('plan-validator');
  const units = [{ id: 'h1', path: 'a.txt', status: 'M' }];
  const bytes = Buffer.from(JSON.stringify({
    groups: [{ header: 'feat: x', body: 'Refs: /srv/jdoe-fixture/x', files: ['a.txt'] }],
  }));

  const withOsUser = validatePlan(bytes, { mode: 'split', units }, { osUser: 'jdoe-fixture' });
  assert.equal(withOsUser.ok, false);
  assert.equal(withOsUser.errors[0].reason, 'message contains `local-path`');

  const withoutOsUser = validatePlan(bytes, { mode: 'split', units }, {});
  assert.equal(withoutOsUser.ok, true);
});

function validateMessage(validatePlan, header, body) {
  const units = [{ id: 'h1', path: 'a.txt', status: 'M' }];
  const bytes = Buffer.from(JSON.stringify({ groups: [{ header, body, files: ['a.txt'] }] }));
  return validatePlan(bytes, { mode: 'split', units });
}

// Built at run time so this file holds no literal hit.
const SLACK_TOKEN = 'xo' + 'xb-1234567890abcdef';
const HOME_ROOT = '/ho' + 'me/jdoe-fixture';

test('a scan hit in the type is quoted as its pattern ID in the type lint error', async () => {
  const { validatePlan } = await loadLib('plan-validator');

  const result = validateMessage(validatePlan, `${SLACK_TOKEN}: x`, null);

  assert.deepEqual(result.errors, [
    { group: 1, reason: "type '[slack-token]' not in types" },
    {
      group: 1,
      reason: 'message contains `slack-token`',
      spans: [{ patternId: 'slack-token', start: 0, end: SLACK_TOKEN.length }],
    },
  ]);
});

test('a scan hit in a footer token is quoted as its pattern ID in the footer lint error', async () => {
  const { validatePlan } = await loadLib('plan-validator');

  const result = validateMessage(validatePlan, 'feat: x', `${SLACK_TOKEN}: y`);

  const start = 'feat: x\n\n'.length;
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].reason, /^`\[slack-token\]` is not an allowed footer token\./);
  assert.deepEqual(result.errors[1], {
    group: 1,
    reason: 'message contains `slack-token`',
    spans: [{ patternId: 'slack-token', start, end: start + SLACK_TOKEN.length }],
  });
  assert.equal(JSON.stringify(result).includes(SLACK_TOKEN), false);
});

test('a lint reason quoting a fragment that overlaps no span keeps it verbatim', async () => {
  const { validatePlan } = await loadLib('plan-validator');

  const result = validateMessage(validatePlan, 'wip: x', `Refs: ${HOME_ROOT}`);

  assert.deepEqual(result.errors.map((error) => error.reason), [
    "type 'wip' not in types",
    'message contains `local-path`',
  ]);
});

// review-PLN-06-r2 finding 1 ("Small leak"): a scope that both holds a hit and starts with
// `'` used to let the redaction regex match starting at the type reason's opening quote
// (shared text between the scope fragment and the quoted type), leaving the end of the type
// value (`abcdef`) on stdout: `type [slack-token]abcdef' not in types`. Quoting only the
// slot `lint` embeds the type in removes the shared-text coincidence entirely.
test('a scan hit in the type leaves no leftover tail even when a scope hit shares its prefix', async () => {
  const { validatePlan } = await loadLib('plan-validator');
  const type = SLACK_TOKEN; // used as the type below: letters, digits and hyphens only.
  const scope = `'${SLACK_TOKEN.slice(0, -'abcdef'.length)}`; // a leading quote, no "abcdef" tail.

  const result = validateMessage(validatePlan, `${type}(${scope}): x`, null);

  assert.deepEqual(result.errors[0], { group: 1, reason: "type '[slack-token]' not in types" });
  assert.equal(JSON.stringify(result).includes('abcdef'), false, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes(SLACK_TOKEN), false, JSON.stringify(result));
});

// review-PLN-06-r2 finding 1 ("Garbled reasons"): a short redacted fragment (here the type
// `e`, which also occurs inside "home" and inside the fixed word "types") used to rewrite
// the fixed wording wherever that character occurred in the reason:
// "typ[local-path] '[local-path]' not in typ[local-path]s". Quoting only the type's own slot
// leaves the surrounding fixed text alone.
test('a one-character type that recurs in the fixed wording redacts only its own slot', async () => {
  const { validatePlan } = await loadLib('plan-validator');

  const result = validateMessage(validatePlan, 'e: x', `Refs: ${HOME_ROOT}`);

  assert.deepEqual(result.errors[0], { group: 1, reason: "type '[local-path]' not in types" });
});

test('two different patterns give one scan error each, in hit order, each with its own spans', async () => {
  const { validatePlan } = await loadLib('plan-validator');
  const token = 'gh' + 'p_' + 'a'.repeat(36);
  const body = `Refs: ${HOME_ROOT}/app ${token} ${HOME_ROOT}/lib`;
  const message = `feat: x\n\n${body}`;

  const result = validateMessage(validatePlan, 'feat: x', body);

  const first = message.indexOf(HOME_ROOT);
  const second = message.lastIndexOf(HOME_ROOT);
  const tokenAt = message.indexOf(token);
  assert.deepEqual(result.errors, [
    {
      group: 1,
      reason: 'message contains `local-path`',
      spans: [
        { patternId: 'local-path', start: first, end: first + HOME_ROOT.length },
        { patternId: 'local-path', start: second, end: second + HOME_ROOT.length },
      ],
    },
    {
      group: 1,
      reason: 'message contains `github-token`',
      spans: [{ patternId: 'github-token', start: tokenAt, end: tokenAt + token.length }],
    },
  ]);
});

// FND-10 Seam 1: os.userInfo() throws, so commit.cjs falls back to USER/USERNAME; `osUser`
// reaches M14 unchanged and `state.json` never stores it (EXE-01 item 1).
// Every call, `plan` included, runs under the fallback, and a passing `check` (which writes the
// stored groups) follows the failing one, so a regression storing `osUser` from any of the
// three calls would put `jdoe1` into `state.json`.
test('FND-10: os.userInfo() throwing falls back to USER/USERNAME for the message scan', async (t) => {
  const fallback = {
    nodeArgs: ['--import', PRELOAD],
    env: { COMMIT_TEST_FAULT_USERINFO: '1', USER: 'jdoe1', USERNAME: 'jdoe1' },
  };
  const { c, planId, runDir } = await plannedRun(t, fallback);
  writeWorkerPlan(runDir, 'feat: x', 'Refs: /srv/jdoe1/x');

  const checked = await runCommit(c, ['check', '--plan', planId], fallback);

  assert.equal(checked.exitCode, 2, detail(checked));
  assert.deepEqual(checked.json.errors, [{
    group: 1,
    reason: 'message contains `local-path`',
    spans: [{
      patternId: 'local-path',
      start: 'feat: x\n\nRefs: /srv'.length,
      end: 'feat: x\n\nRefs: /srv/jdoe1'.length,
    }],
  }]);

  writeWorkerPlan(runDir, 'feat: x', null);
  const passed = await runCommit(c, ['check', '--plan', planId], fallback);
  assert.equal(passed.exitCode, 0, detail(passed));
  const state = fs.readFileSync(path.join(runDir, 'state.json'), 'utf8');
  assert.equal(JSON.parse(state).groups.length, 1, state);
  assert.equal(state.includes('jdoe1'), false, state);
});
