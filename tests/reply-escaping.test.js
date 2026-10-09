'use strict';

// RPL-06 (docs/roadmap/11-reply-and-cli.md): control characters in a path are written as
// `\xNN` in `reply.text`; git and hook output relayed through `text` keeps `\n` and `\t`,
// escapes the rest and is capped at its last 2000 characters behind a "[… N characters cut]"
// marker, while the full output stays in `gitOutput`. Seam 1 only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCase, runCommit } = require('./helpers/process-seam.js');

function detail(result) {
  return `stdout ${result.stdout}\nstderr ${result.stderr}`;
}

const POSIX_ONLY = process.platform === 'win32' && 'file names with a newline or ESC are POSIX-only';

// A repo with a seed commit and a live `release` lock, so `release --plan` answers from it.
function releaseCase(t) {
  const c = createCase(t);
  c.writeFile('seed.txt', 'seed\n');
  c.git(['add', '--', 'seed.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  fs.appendFileSync(path.join(c.repoDir, '.git', 'info', 'exclude'), '/.commit-plan\n');
  const runDir = path.join(c.repoDir, '.commit-plan');
  const planId = crypto.randomUUID();
  fs.mkdirSync(path.join(runDir, planId), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'lock'), JSON.stringify({ planId, created: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(runDir, planId, 'state.json'), '{"version":1}\n');
  return { c, planId };
}

test('a file named with a newline and an ESC is written as backslash-x escapes, no forged clean line', { skip: POSIX_ONLY }, async (t) => {
  const { c, planId } = releaseCase(t);
  c.writeFile('a\nworking tree clean\x1b[31mb.txt', 'x\n');

  const planned = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(planned.exitCode, 0, detail(planned));
  const { text } = planned.json.reply;
  assert.equal(text.split('\n').length, 2, 'the name forged no extra line');
  assert.ok(text.includes('a\\x0aworking tree clean\\x1b[31mb.txt'), text);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

test('a file named with U+0085 and DEL (legal on every platform) is written as backslash-x escapes', async (t) => {
  const { c, planId } = releaseCase(t);
  c.writeFile('a\u0085b\x7fc.txt', 'x\n');

  const planned = await runCommit(c, ['release', '--plan', planId]);

  assert.equal(planned.exitCode, 0, detail(planned));
  const { text } = planned.json.reply;
  assert.ok(text.includes('a\\xc2\\x85b\\x7fc.txt'), text);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

// A lint message repeats the path of a unit (`<id> (<path>) not placed ...`); it is escaped
// like the path itself, so a name cannot forge a line of the `lintFailed` text.
async function lintFailedFor(t, name) {
  const c = createCase(t);
  c.writeFile('seed.txt', 'seed\n');
  c.git(['add', '--', 'seed.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile(name, 'x\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify({ version: 1, source: 'user', groups: [], notIncluded: [] }));
  return runCommit(c, ['check', '--plan', planId]);
}

test('a lintFailed text escapes the control characters of a path in a lint message', async (t) => {
  const checked = await lintFailedFor(t, 'a\u0085b\x7fc.txt');

  assert.equal(checked.exitCode, 2, detail(checked));
  const { text } = checked.json.reply;
  assert.equal(checked.json.reply.handback.kind, 'lintFailed');
  assert.ok(text.includes('a\\xc2\\x85b\\x7fc.txt'), text);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

test('a lintFailed text: a newline in a path forges no line', { skip: POSIX_ONLY }, async (t) => {
  const checked = await lintFailedFor(t, 'a\nforged line\x1b[31m.txt');

  assert.equal(checked.exitCode, 2, detail(checked));
  const { text } = checked.json.reply;
  assert.ok(text.includes('a\\x0aforged line\\x1b[31m.txt'), text);
  assert.ok(!text.split('\n').includes('forged line.txt'), text);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});

// A zero-groups worker plan lists the embedded repository the validator added, whose reason
// repeats its path.
test('a zero-groups not-included reason escapes the control characters of a path', async (t) => {
  const c = createCase(t);
  c.writeFile('seed.txt', 'seed\n');
  c.git(['add', '--', 'seed.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('seed.txt', 'seed\nmore\n');
  const dir = path.join(c.repoDir, 'e\u0085m\x7fb');
  fs.mkdirSync(dir);
  c.git(['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const plan = { version: 1, source: 'worker', groups: [], notIncluded: [{ path: 'seed.txt', hunks: null, reason: 'later' }] };
  fs.writeFileSync(path.join(runDir, 'plan.groups.json'), JSON.stringify(plan));

  const checked = await runCommit(c, ['check', '--plan', planId]);

  const text = checked.json.reply?.text ?? '';
  assert.ok(text.includes('e\\xc2\\x85m\\x7fb is an embedded git repository'), detail(checked));
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
});


test('a hook printing ANSI and 5000 characters -> ESC escaped, last 2000 kept behind the marker, gitOutput whole', async (t) => {
  const c = createCase(t);
  c.writeFile('a.txt', 'a\n');
  c.git(['add', '--', 'a.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('a.txt', 'a\nmore\n');
  const planned = await runCommit(c, ['plan', '--split']);
  assert.equal(planned.exitCode, 0, detail(planned));
  const { planId, runDir } = planned.json;
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.groups = [{ n: 1, units: state.units.map((unit) => unit.id), header: 'feat: change a', body: null, committed: false }];
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);

  const scriptPath = path.join(c.root, 'pre-commit-hook.js');
  fs.writeFileSync(scriptPath, [
    "process.stderr.write('\\x1b[31mhead\\x1b[0m\\tkept\\n' + 'x'.repeat(4980) + '\\x1b[31mEND\\x1b[0m\\n');",
    'process.exit(1);',
    '',
  ].join('\n'));
  const slash = (p) => p.replace(/\\/g, '/');
  const hook = path.join(c.repoDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(scriptPath)}"\n`);
  fs.chmodSync(hook, 0o755);

  const result = await runCommit(c, ['commit', '--plan', planId, '--all']);

  assert.equal(result.exitCode, 4, detail(result));
  assert.ok(result.json.gitOutput.startsWith('\x1b[31mhead\x1b[0m\tkept\n'), 'gitOutput is whole and unescaped');
  assert.ok(result.json.gitOutput.length > 4990);
  const { text } = result.json.reply;
  assert.equal(result.json.reply.status, 'failed');
  assert.match(text, /^git commit failed for group 1\n\[… \d+ characters cut\]\n/);
  const cut = Number(/\[… (\d+) characters cut\]/.exec(text)[1]);
  const tail = text.split('\n').slice(2).join('\n');
  const raw = result.json.gitOutput.replace(/\n+$/, '');
  assert.equal(cut, raw.length - 2000, 'N counts raw characters');
  const expected = `${'x'.repeat(2000 - '\x1b[31mEND\x1b[0m'.length)}\\x1b[31mEND\\x1b[0m`;
  assert.ok(tail.startsWith(expected), 'the last 2000 raw characters are kept, ESC escaped, no escape split');
  assert.doesNotMatch(text, /\x1b/);
});
