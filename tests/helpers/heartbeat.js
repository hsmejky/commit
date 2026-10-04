'use strict';

// Heartbeat processes for kill tests (GIT-05's `onStdout` cases, GIT-07's tree kill). A
// process that never exits on its own proves it is still running by ticking a heartbeat file
// instead of the test trusting its pid alone: on a busy Windows box a killed child's pid can
// be handed to an unrelated process within a second, which `process.kill(pid, 0)` would then
// report as alive (a false failure) and a cleanup kill by pid would hit (a stray kill). A pid
// is only acted on while its heartbeat is still ticking, which no other process can do.

const fs = require('node:fs');

const TICK_MS = 50;
const LIFETIME_MS = 120_000;
// `ticking()`'s default window: wide enough that a process stalled by antivirus-on-every-write
// or CPU contention on a loaded Windows runner still reads as alive. `stopped()` passes the
// narrower, original window instead (review-process-adapter-hang finding L3): a killed
// process never ticks again, so detecting that needs no slack, and keeping it tight is what
// lets `stopped()`'s short-attempt loop fail fast on a regression instead of hanging.
const ALIVE_WINDOW_MS = 3000;
const STOPPED_WINDOW_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// A Node snippet that writes its pid to `<base>.pid` and then a growing counter to
// `<base>.beat` every TICK_MS. It never exits on its own within a case; it does exit after
// LIFETIME_MS, a last line of defence against an immortal process if even the cleanup below
// never runs (e.g. the test process itself is killed).
function heartbeat(base) {
  return `{ const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${base}.pid`)}, String(process.pid));`
    + ` let n = 0; setInterval(() => { fs.writeFileSync(${JSON.stringify(`${base}.beat`)}, String(++n)); }, ${TICK_MS});`
    + ` setTimeout(() => process.exit(0), ${LIFETIME_MS}); }`;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// True if the heartbeat process at `base` is still running: its counter moves within
// `windowMs`, polled so a running process is reported as soon as it ticks.
async function ticking(base, windowMs = ALIVE_WINDOW_MS) {
  const before = readOrNull(`${base}.beat`);
  for (let waited = 0; waited < windowMs; waited += TICK_MS) {
    await sleep(TICK_MS);
    const now = readOrNull(`${base}.beat`);
    if (now !== null && now !== before) return true;
  }
  return false;
}

// Waits (bounded) until the heartbeat at `base` has ticked at least once (its process is up).
async function started(base, windowMs = 30_000) {
  for (let waited = 0; waited < windowMs; waited += TICK_MS) {
    if (readOrNull(`${base}.beat`) !== null) return true;
    await sleep(TICK_MS);
  }
  return false;
}

// Registers, before the case's own cleanup (`after` hooks run in the order they were added,
// and the case directory cannot be removed on Windows while a process still runs in it), a
// hook that kills every heartbeat process in `bases()` that is still running: a regression
// then fails the case instead of leaking an immortal process or hanging the suite.
function killLeftovers(t, bases) {
  t.after(async () => {
    for (const base of bases()) {
      const pid = Number(readOrNull(`${base}.pid`));
      if (!Number.isInteger(pid) || pid <= 0 || !(await ticking(base))) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
      // Windows keeps the case directory busy (the process's cwd) until the killed process
      // is fully gone, so wait (bounded) for its pid to disappear before the case's cleanup.
      for (let waited = 0; waited < 5000; waited += TICK_MS) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await sleep(TICK_MS);
      }
    }
  });
}

// Waits (bounded) until the heartbeat process at `base` has stopped ticking. Uses the
// narrow, strict window (not the widened `ticking()` default): a killed process never ticks
// again, so this still fails fast on a regression instead of hanging.
async function stopped(base) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await ticking(base, STOPPED_WINDOW_MS))) return true;
  }
  return false;
}

module.exports = { TICK_MS, heartbeat, killLeftovers, readOrNull, sleep, started, stopped, ticking };
