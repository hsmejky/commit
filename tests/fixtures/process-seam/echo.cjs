'use strict';

// Stub entry point for the process-seam self-test (FND-04): writes argv[2] to stdout
// verbatim, argv[4] (if any) to stderr, and exits with argv[3] (default 0).

const [stdout = '', code = '0', stderr = ''] = process.argv.slice(2);
process.stderr.write(stderr);
process.stdout.write(stdout, () => {
  process.exitCode = Number(code);
});
