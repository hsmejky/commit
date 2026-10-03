// FND-05 (docs/roadmap/01-foundation.md): a Node `--import` preload, loaded only from the
// test tree (docs/spec/testing-seams.md, "Clock at Seam 1"), that replaces `Date.now` with a
// stepping clock so budget and kill-timeout cases (Q9, Q18) need no real waiting. Never
// packaged: the shipped CLI reads time only through `Date.now()` and gains no test-only
// switch to reach this (docs/spec/architectural-decisions.md, "Injected environment").
//
// Schedule: the file named by COMMIT_TEST_CLOCK_SCHEDULE (unset: no steps; a named file that
// does not exist fails the launch) holds a JSON array of steps, each
// `{ "event": ..., "elapsedMs": <number> }` in increasing `elapsedMs` order; each step's event
// is expected to occur in that same order while the schedule is driven. `event` is one of:
//   { "type": "path", "path": "<absolute path>" }
//     holds once that path exists.
//   { "type": "childPath", "dir": "<absolute path>", "name": "<file name>" }
//     holds once `<dir>/<some child>/<name>` exists, for a file in a folder whose name the test
//     cannot know in advance (a run's minted `<planId>/plan.json`, RUN-08).
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const realDateNow = Date.now.bind(Date);

const scheduleFile = process.env.COMMIT_TEST_CLOCK_SCHEDULE;
const schedule = scheduleFile ? JSON.parse(readFileSync(scheduleFile, 'utf8')) : [];

let previousElapsedMs = -Infinity;
for (const step of schedule) {
  if (!Number.isFinite(step.elapsedMs)) {
    throw new Error(`clock-preload: elapsedMs must be a finite number, got ${step.elapsedMs}`);
  }
  if (step.elapsedMs <= previousElapsedMs) {
    throw new Error(
      `clock-preload: elapsedMs must strictly increase, got ${step.elapsedMs} after ${previousElapsedMs}`,
    );
  }
  previousElapsedMs = step.elapsedMs;
}

/** @param {{type: string, [key: string]: unknown}} event */
function eventHolds(event) {
  if (event.type === 'path') return existsSync(event.path);
  if (event.type === 'childPath') {
    if (!existsSync(event.dir)) return false;
    return readdirSync(event.dir).some((child) => existsSync(join(event.dir, child, event.name)));
  }
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
