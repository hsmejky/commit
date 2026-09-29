'use strict';

// Stub entry point for the fault-preload self-test (FND-10): a `.cjs` entry point, like the
// real entry points, that dynamically `import()`s the `.mjs` stub library
// (tests/fixtures/fault/named-imports.mjs) and runs the JSON "program" given in argv[2]
// through it, printing the same `{ results }` shape as tests/fixtures/fault/run-ops.cjs
// (Architectural decisions, "Module type fixed by extension").

async function main() {
  const { runProgram } = await import('./named-imports.mjs');
  const results = await runProgram(JSON.parse(process.argv[2]));
  process.stdout.write(`${JSON.stringify({ results })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
