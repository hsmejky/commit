'use strict';

// CHG-12 (docs/roadmap/07-change-set.md): raw bytes and non-UTF-8 paths (Q11, C:plan, M10).
// Diff output stays a `Buffer` end to end, so a unit's hash is the hash of the bytes git
// printed, never of a decode; a path whose bytes are not valid UTF-8 is not a unit and is
// stored for `notIncluded` with each bad byte written as `\xNN` (story 219).
//
// Whether a file name may hold a non-UTF-8 byte depends on the filesystem, not on git:
// NTFS stores names as UTF-16 (Node writes such a byte as U+FFFD) and APFS refuses them.
// The real-git cases probe the temp directory and skip with that reason where the name
// cannot be held; the crafted-bytes and `escapeNonUtf8` cases run everywhere.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadLib } = require('./helpers/load-lib.js');
const { createCase, runCommit } = require('./helpers/process-seam.js');

let changeSet;

beforeEach(async () => {
  changeSet = await loadLib('change-set');
});

const NOW = () => Date.UTC(2026, 0, 1);

function snapshot(c, storedLists = { candidates: [], stagedNew: [] }) {
  return changeSet.snapshot({
    mode: 'split', storedLists, indexPath: path.join(c.root, 'git-index'), unborn: false,
    toplevel: c.repoDir, env: c.env, now: NOW,
  });
}

function inventory(c) {
  return changeSet.inventory({ toplevel: c.repoDir, env: c.env, now: NOW });
}

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

// A file name given as raw bytes, relative to the repo.
function writeRaw(c, nameBytes, content) {
  fs.writeFileSync(Buffer.concat([Buffer.from(c.repoDir + path.sep), nameBytes]), content);
}

// Whether `dir`'s filesystem keeps a name with a non-UTF-8 byte exactly as written.
function holdsNonUtf8Names(dir) {
  const name = Buffer.from('probe-\xff', 'latin1');
  const full = Buffer.concat([Buffer.from(dir + path.sep), name]);
  try {
    fs.writeFileSync(full, '');
  } catch {
    return false;
  }
  const held = fs.readdirSync(dir, { encoding: 'buffer' }).some((entry) => entry.equals(name));
  for (const entry of fs.readdirSync(dir, { encoding: 'buffer' })) {
    if (entry.toString('latin1').startsWith('probe-')) {
      fs.rmSync(Buffer.concat([Buffer.from(dir + path.sep), entry]));
    }
  }
  return held;
}

const NO_NON_UTF8_NAMES = 'the filesystem cannot hold a file name that is not valid UTF-8';

test('escapeNonUtf8 writes each byte outside a well-formed UTF-8 sequence as \\xNN', () => {
  const cases = [
    ['plain/path.txt', 'plain/path.txt'],
    ['bad\xff.txt', 'bad\\xff.txt'],
    // A valid "é" (C3 A9) kept, a Latin-1 "é" (E9) escaped.
    ['\xc3\xa9-\xe9', 'é-\\xe9'],
    // An overlong NUL, a surrogate, a truncated 3-byte sequence, a code point above U+10FFFF.
    ['\xc0\x80', '\\xc0\\x80'],
    ['\xed\xa0\x80', '\\xed\\xa0\\x80'],
    ['a\xe2\x82', 'a\\xe2\\x82'],
    ['\xf4\x90\x80\x80', '\\xf4\\x90\\x80\\x80'],
    // A 4-byte character and a lone continuation byte.
    ['\xf0\x9f\x98\x80\x80', '\u{1F600}\\x80'],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(changeSet.escapeNonUtf8(Buffer.from(bytes, 'latin1')), expected);
  }
});

test('snapshot: a section whose path is not UTF-8 is paired but makes no unit', () => {
  const sha = '0'.repeat(40);
  const output = Buffer.concat([
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0bad\xff.txt\0`, 'latin1'),
    Buffer.from(`:100644 100644 ${sha} ${sha} R100\0old\xe9.txt\0new.txt\0`, 'latin1'),
    Buffer.from(`:100644 100644 ${sha} ${sha} M\0ok.txt\0\0`, 'latin1'),
    Buffer.from('diff --git a/bad\xff.txt b/bad\xff.txt\n@@ -1 +1 @@\n-a\n+b\n', 'latin1'),
    Buffer.from('diff --git a/old\xe9.txt b/new.txt\n', 'latin1'),
    Buffer.from('diff --git a/ok.txt b/ok.txt\n@@ -1 +1 @@\n-a\n+b\n', 'latin1'),
  ]);
  const reader = changeSet.createDiffReader();
  for (let i = 0; i < output.length; i += 1) reader.push(output.subarray(i, i + 1));

  const units = reader.end();

  assert.deepEqual(units.map((u) => [u.path, u.status, u.added, u.deleted]), [['ok.txt', 'M', 1, 1]]);
});

test('snapshot: Latin-1 and CRLF content under core.autocrlf=false hash over the raw bytes', async (t) => {
  const c = createCase(t);
  c.git(['config', 'core.autocrlf', 'false']);
  c.writeFile('crlf.txt', 'one\r\ntwo\r\n');
  c.git(['add', '--', 'crlf.txt']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('crlf.txt', 'one\r\nTWO\r\n');
  const latin1 = Buffer.from('caf\xe9\n', 'latin1');
  c.writeFile('latin1.txt', latin1);

  const units = await snapshot(c, { candidates: ['latin1.txt'], stagedNew: [] });

  const crlfHash = sha256('crlf.txt\0', Buffer.from('-two\r\n+TWO\r\n'), '\0', '0');
  const latin1Hash = sha256('A\0', 'latin1.txt\0', Buffer.from('+'), latin1);
  assert.deepEqual(units.map((u) => [u.path, u.status, u.hash]), [
    ['crlf.txt', 'M', crlfHash],
    ['latin1.txt', 'A', latin1Hash],
  ]);
  assert.ok(units[1].body.includes(latin1));
  // A lossy decode would change both hashes: U+FFFD for the Latin-1 byte, LF for CRLF.
  const lossy = Buffer.from(latin1.toString('utf8'), 'utf8');
  assert.notEqual(sha256('A\0', 'latin1.txt\0', Buffer.from('+'), lossy), latin1Hash);
  assert.notEqual(sha256('crlf.txt\0', Buffer.from('-two\n+TWO\n'), '\0', '0'), crlfHash);
});

test('inventory and snapshot: a non-UTF-8 path is no unit and is listed with \\xNN', async (t) => {
  const c = createCase(t);
  if (!holdsNonUtf8Names(c.repoDir)) {
    t.skip(NO_NON_UTF8_NAMES);
    return;
  }
  c.writeFile('ok.txt', 'a\n');
  writeRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'a\n');
  c.git(['add', '-A']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('ok.txt', 'b\n');
  writeRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'b\n');
  writeRaw(c, Buffer.from('bad\xff.txt', 'latin1'), 'new\n');
  writeRaw(c, Buffer.from('st\xfe.txt', 'latin1'), 'staged\n');
  c.git(['add', '--', 'st*.txt']);

  const listed = await inventory(c);
  const units = await snapshot(c, {
    candidates: listed.candidates.map((candidate) => candidate.path), stagedNew: listed.stagedNew,
  });

  assert.deepEqual(listed.notUtf8, ['bad\\xff.txt', 'st\\xfe.txt', 't\\xe9.txt']);
  assert.deepEqual(listed.tracked, ['ok.txt']);
  assert.deepEqual(listed.candidates, []);
  assert.deepEqual(listed.stagedNew, []);
  assert.deepEqual(listed.preStaged, []);
  assert.deepEqual(units.map((u) => [u.path, u.status]), [['ok.txt', 'M']]);
});

test('plan stores the non-UTF-8 paths with \\xNN in state.json and plans none of them', async (t) => {
  const c = createCase(t);
  if (!holdsNonUtf8Names(c.repoDir)) {
    t.skip(NO_NON_UTF8_NAMES);
    return;
  }
  c.writeFile('ok.txt', 'a\n');
  writeRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'a\n');
  c.git(['add', '-A']);
  c.git(['commit', '-q', '-m', 'seed']);
  c.writeFile('ok.txt', 'b\n');
  writeRaw(c, Buffer.from('t\xe9.txt', 'latin1'), 'b\n');
  writeRaw(c, Buffer.from('bad\xff.txt', 'latin1'), 'new\n');

  const result = await runCommit(c, ['plan']);

  assert.equal(result.exitCode, 0, `stdout ${result.stdout}\nstderr ${result.stderr}`);
  const state = JSON.parse(fs.readFileSync(path.join(result.json.runDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.notUtf8, ['bad\\xff.txt', 't\\xe9.txt']);
  assert.deepEqual(state.units.map((unit) => unit.path), ['ok.txt']);
  assert.deepEqual(state.candidates, []);
});
