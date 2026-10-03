'use strict';

// The deny catalogue's fixture tables (GRD-05): each specific row's commands with their fixed
// text, the row precedence pairs, and one command per row reachable from Bash. Shared by
// guard-deny-catalogue (the texts) and guard-debug-log (GRD-16: stdout identical with and
// without COMMIT_GUARD_DEBUG over every row, in both shells).

const { noVerifyText } = require('./no-verify-text.js');

// The C:guard texts, spelled out here rather than read from the module under test.
const route = 'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';
const line = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';
const amendText = `To reword the last commit: ${route} Ask it to reword. To add changes, make a new commit the same way.\n${line}`;
const squashText = `git commit --squash opens an editor. ${route}\n${line}`;
const fixupKindText = (kind) => `--fixup=${kind}: opens an editor. Use plain --fixup=<commit>, or: ${route}\n${line}`;
const genericText = (flag) => `git commit ${flag} is not allowed here. ${route}\n${line}`;
const wrapperText = (name) => `git commit run by ${name} is not allowed: it can append arguments. ${route}\n${line}`;
const bareText = `Direct git commit is blocked. ${route}\n${line}`;

const cases = [
  // `--amend` without `--no-edit` (story 32): the reword route, never `--amend --no-edit`.
  ['git commit --amend', amendText],
  ['git commit --amend -q', amendText],
  ['git commit -q --amend', amendText],
  ['git commit --amend --fixup=1a2b3c4', amendText],
  ['git commit --fixup=1a2b3c4 --amend', amendText],
  ['git commit --amend --all', amendText],
  ['git commit --fixup=1a2b3c4 -q --amend=x', amendText],
  // A `--no-edit` given a value is not `--no-edit`.
  ['git commit --amend --no-edit=x', amendText],
  // `--squash` in any form (story 27): `--no-edit` does not exempt it (C:guard step 5).
  ['git commit --squash=HEAD', squashText],
  ['git commit --squash HEAD', squashText],
  ['git commit --squash=HEAD --no-edit', squashText],
  ['git commit --no-edit --squash=HEAD', squashText],
  ['git commit --no-edit --squash HEAD -q', squashText],
  ['git commit --fixup=1a2b3c4 --squash=HEAD', squashText],
  ['git commit --squash', squashText],
  // `-n`, `--no-verify`, `--no-gpg-sign` (story 30, Q18): no route, no personal-skill line.
  ['git commit -n', noVerifyText('-n')],
  ['git commit --no-verify', noVerifyText('--no-verify')],
  ['git commit --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -n', noVerifyText('-n')],
  ['git commit --amend --no-edit --no-verify', noVerifyText('--no-verify')],
  ['git commit --fixup=1a2b3c4 --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -qn', noVerifyText('-n')],
  ['git commit --no-verify=x --no-edit', noVerifyText('--no-verify')],
  // A tie within one row goes to the first matching token in argv order.
  ['git commit --no-gpg-sign -n --no-edit', noVerifyText('--no-gpg-sign')],
  ['git commit --no-edit -n --no-gpg-sign', noVerifyText('-n')],
  // `--fixup=amend:` / `--fixup=reword:` open an editor (story 28).
  ['git commit --fixup=amend:1a2b3c4', fixupKindText('amend')],
  ['git commit --fixup=reword:1a2b3c4', fixupKindText('reword')],
  ['git commit --fixup amend:HEAD~1', fixupKindText('amend')],
  ['git commit --fixup=reword:1a2b3c4 -q', fixupKindText('reword')],
  ['git commit -q --fixup=amend:', fixupKindText('amend')],
  // `-C`, `--reuse-message`, `-c <commit>`, `--reedit-message` take the generic row (story 28).
  ['git commit -C HEAD', genericText('-C')],
  ['git commit -CHEAD', genericText('-C')],
  ['git commit --reuse-message HEAD', genericText('--reuse-message')],
  ['git commit --reuse-message=HEAD', genericText('--reuse-message')],
  ['git commit -c HEAD', genericText('-c')],
  ['git commit -cHEAD', genericText('-c')],
  ['git commit --reedit-message HEAD', genericText('--reedit-message')],
  ['git commit --reedit-message=HEAD', genericText('--reedit-message')],
  ['git commit --no-edit -C HEAD', genericText('-C')],
  ['git commit --amend --no-edit -c HEAD', genericText('-c')],
];

// Stands for MESSAGES.literalArguments, read once the module is loaded.
const MESSAGES_LITERAL = Symbol('literalArguments');

// C:guard Precedence (D2): the full row order, each pair below matching both rows. The more
// specific row wins; the bare/`-m`/`-F`/`--message`/`--file` row applies only when nothing
// else matches.
const precedence = [
  // --amend over --squash, -n, the fixup kinds, the generic row, the wrapper and the bare row.
  ['git commit --amend -m x', amendText],
  ['git commit -m x --amend', amendText],
  ['git commit --amend -F msg.txt', amendText],
  ['git commit --amend --message=x', amendText],
  ['git commit --squash=HEAD --amend', amendText],
  ['git commit -n --amend', amendText],
  ['git commit --fixup=amend:HEAD --amend', amendText],
  ['git commit -a --amend', amendText],
  ['xargs git commit --amend', amendText],
  // --squash over -n, the fixup kinds, the generic row, the wrapper and the bare row.
  ['git commit --squash -m x', squashText],
  ['git commit -m x --squash=HEAD', squashText],
  ['git commit -n --squash=HEAD', squashText],
  ['git commit --fixup=reword:HEAD --squash=HEAD', squashText],
  ['git commit -a --squash=HEAD', squashText],
  ['xargs git commit --squash=HEAD --no-edit', squashText],
  // -n / --no-verify / --no-gpg-sign over the fixup kinds, the generic row, the wrapper and
  // the bare row.
  ['git commit -n -m x', noVerifyText('-n')],
  ['git commit -nm x', noVerifyText('-n')],
  ['git commit -m x -n', noVerifyText('-n')],
  ['git commit -an', noVerifyText('-n')],
  ['git commit --fixup=amend:HEAD --no-verify', noVerifyText('--no-verify')],
  ['git commit -a --no-gpg-sign', noVerifyText('--no-gpg-sign')],
  ['xargs git commit --no-edit -n', noVerifyText('-n')],
  // The fixup kinds over the generic row, the wrapper and the bare row.
  ['git commit --fixup=amend:HEAD -m x', fixupKindText('amend')],
  ['git commit -a --fixup=reword:HEAD', fixupKindText('reword')],
  ['git commit --no-edit --fixup=reword:HEAD', fixupKindText('reword')],
  ['xargs git commit --fixup=amend:HEAD', fixupKindText('amend')],
  // The generic row over the wrapper and the bare row; the wrapper over the bare row.
  ['git commit -C HEAD -m x', genericText('-C')],
  ['xargs git commit -c HEAD', genericText('-c')],
  ['xargs git commit -m x', wrapperText('xargs')],
  ['git commit -m x', bareText],
  // A value is never read as a flag of a higher row: git takes it as the option's value.
  ['git commit -C -n', genericText('-C')],
  ['git commit --reuse-message -n', genericText('--reuse-message')],
  ['git commit --reedit-message --amend', genericText('--reedit-message')],
  ['git commit --author -n --no-edit', genericText('--author')],
  ['git commit --trailer --squash=HEAD --no-edit', genericText('--trailer')],
  ['git commit --date -n', genericText('--date')],
  ['git commit --template --amend', genericText('--template')],
  ['git commit --cleanup -n', genericText('--cleanup')],
  ['git commit --pathspec-from-file --amend', genericText('--pathspec-from-file')],
  ['git commit --unified -n', genericText('--unified')],
  ['git commit --inter-hunk-context --amend', genericText('--inter-hunk-context')],
  ['git commit -U -n', genericText('-U')],
  // `--squash` itself outranks `-n`/`--amend`, so its value is never read as either, even
  // when the value spells a higher-row flag.
  ['git commit --squash --amend', squashText],
  ['git commit -m --amend', bareText],
  ['git commit --message --no-verify', bareText],
  // An abbreviation git accepts is not expanded (C:guard step 5): the generic row names it
  // exactly as written, never the row of the option it abbreviates.
  ['git commit --amen', genericText('--amen')],
  ['git commit --no-veri', genericText('--no-veri')],
  // An abbreviation of a value-taking option (`--auth` of `--author`) does not match that
  // full name, so it does not consume `-n` either: the `-n` row wins, even though git itself
  // reads `-n` as `--author`'s value. Denied either way (C:contracts/guard.md step 5).
  ['git commit --auth -n', noVerifyText('-n')],
  // ... and the literal-arguments row outranks every row of commit's arguments.
  ['git commit --amend -m "feat(x): y"', MESSAGES_LITERAL],
];

// One command per row reachable from a Bash command.
const everyRow = [
  'git commit -m x',
  'git commit --amend',
  'git commit --squash=HEAD',
  'git commit -n',
  'git commit --no-verify',
  'git commit --no-gpg-sign',
  'git commit --fixup=amend:HEAD',
  'git commit --fixup=reword:HEAD',
  'git commit -a',
  'git commit -C HEAD',
  'xargs git commit --no-edit',
  'git commit --fixup $s',
  'echo "$(date)"; git commit',
  'git -c k=v commit',
  'git --unknown commit',
  'git {commit,-m,x}',
];

module.exports = {
  route,
  line,
  amendText,
  squashText,
  fixupKindText,
  genericText,
  wrapperText,
  bareText,
  cases,
  MESSAGES_LITERAL,
  precedence,
  everyRow,
};
