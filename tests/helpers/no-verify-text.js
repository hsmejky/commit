'use strict';

// The `-n` / `--no-verify` / `--no-gpg-sign` row's fixed text (GRD-05, Q18): no route, no
// personal-skill line. Shared by guard-deny-catalogue, guard-allowlist and
// guard-extglob-body tests, which each assert it for a flag named in their own fixtures.

function noVerifyText(flag) {
  return `${flag} is not allowed. Fix the hook or signing setup instead.`;
}

module.exports = { noVerifyText };
