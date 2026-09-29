// G3 Command classifier and deny catalogue (docs/spec/modules-shared-and-guard.md; C:guard
// Parsing steps 3-5, Deny messages). Pure.
//
// GRD-03 builds the thinnest classifier: a blanket result (G2) is the blanket deny, and a
// `git` token followed by a `commit` token is the bare-commit deny. The option scan, the Q4
// allowlist, the remaining deny rows and script calls (S2) follow in later slices.

/** C:guard `<route>`. It never names the `/commit` skill, which the model cannot invoke (Q2, Q8). */
export const ROUTE =
  'Spawn the commit:commit-worker agent (model: sonnet; pass intent: <what you changed and why>). Edit no files until it replies.';

/** The fixed line every message holding the route ends with (Q8; nothing is detected). */
export const PERSONAL_SKILL_LINE = 'If a personal commit skill sent you here, remove it (see the commit plugin README).';

const withPersonalLine = (text) => `${text}\n${PERSONAL_SKILL_LINE}`;

/** The deny catalogue rows built so far (C:guard Deny messages). */
export const MESSAGES = Object.freeze({
  bare: withPersonalLine(`Direct git commit is blocked. ${ROUTE}`),
  blanket: withPersonalLine(
    'This command mentions commit and holds a substitution, heredoc, here-string, comment or (Bash) typographic quote, which the guard does not parse. Keep them out of a command that mentions commit (write text to a file first, e.g. gh pr create --body-file), or to commit: '
      + ROUTE,
  ),
});

// A `git` token: basename `git` or `git.exe` after the last `/` or `\`, case-insensitive.
const GIT = /(?:^|[/\\])git(?:\.exe)?$/i;
const COMMIT = /^commit$/i;

/**
 * G3 `classify`: the guard's decision for G2's result.
 *
 * @param {Array<Array<string|object>> | { blanket: string }} parsed G2 `segments` output.
 * @param {{ agentType?: string, shell?: 'bash'|'powershell' }} [context]
 * @returns {{ decision: 'deny'|'none', message?: string, scriptCalls: object[] }}
 */
export function classify(parsed, context = {}) {
  void context;
  if (!Array.isArray(parsed)) return { decision: 'deny', message: MESSAGES.blanket, scriptCalls: [] };
  for (const segment of parsed) {
    // Redirections and heredocs are dropped with their target (C:guard step 2).
    const tokens = segment.filter((t) => typeof t === 'string' || Object.hasOwn(t, 'op'));
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const [token, next] = [tokens[i], tokens[i + 1]];
      if (typeof token === 'string' && GIT.test(token) && typeof next === 'string' && COMMIT.test(next)) {
        return { decision: 'deny', message: MESSAGES.bare, scriptCalls: [] };
      }
    }
  }
  return { decision: 'none', scriptCalls: [] };
}
