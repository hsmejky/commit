// FND-05 (docs/roadmap/01-foundation.md): a Node `--import` preload, loaded only from the
// test tree (docs/spec/testing-seams.md, "Clock at Seam 1"), that replaces `Date.now` with a
// stepping clock so budget and kill-timeout cases (Q9, Q18) need no real waiting. Never
// packaged: the shipped CLI reads time only through `Date.now()` and gains no test-only
// switch to reach this (docs/spec/architectural-decisions.md, "Injected environment").
//
// Schedule: the file named by COMMIT_TEST_CLOCK_SCHEDULE (unset or absent: no steps) holds a
// JSON array of steps, each `{ "event": ..., "elapsedMs": <number> }` in increasing
// `elapsedMs` order. `event` is one of:
//   { "type": "path", "path": "<absolute path>" }
//     holds once that path exists.
//   { "type": "reflogCount", "repo": "<dir>", "ref": "<ref, default HEAD>", "atLeast": <n> }
//     holds once `<ref>`'s reflog in `repo` has at least `n` entries.
//
// The first `Date.now()` call after this module loads returns real time unchanged; that value
// is `callStarted`. From the second call on, each call walks forward over the schedule as far
// as the next not-yet-active step's event currently holds, then returns real time if no step is
// active yet, else `callStarted + elapsedMs` of the furthest active step, frozen until a later
// step's event also holds. A step already held on the second call applies from that call on. A
// step already passed is never re-checked, so the schedule reacts only to the events
// themselves, never to how many times `Date.now()` was called.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const realDateNow = Date.now.bind(Date);

const scheduleFile = process.env.COMMIT_TEST_CLOCK_SCHEDULE;
const schedule = scheduleFile ? JSON.parse(readFileSync(scheduleFile, 'utf8')) : [];

/** @param {{type: string, [key: string]: unknown}} event */
function eventHolds(event) {
  if (event.type === 'path') return existsSync(event.path);
  if (event.type === 'reflogCount') {
    const ref = event.ref || 'HEAD';
    const result = spawnSync('git', ['reflog', 'show', '--no-color', '--format=%H', ref], {
      cwd: event.repo,
      encoding: 'utf8',
    });
    if (result.status !== 0 || !result.stdout) return false;
    return result.stdout.split('\n').filter(Boolean).length >= event.atLeast;
  }
  throw new Error(`clock-preload: unknown event type ${event.type}`);
}

let callStarted = null;
let activeIndex = -1;

Date.now = function steppedNow() {
  if (callStarted === null) {
    callStarted = realDateNow();
    return callStarted;
  }
  while (activeIndex + 1 < schedule.length && eventHolds(schedule[activeIndex + 1].event)) {
    activeIndex += 1;
  }
  return activeIndex === -1 ? realDateNow() : callStarted + schedule[activeIndex].elapsedMs;
};
