'use strict';

// Self-test for the shared purity-check helper (tests/helpers/assert-pure-source.js), used
// by MSG-01 and later pure-module tests (M8, M14, M19; see docs/spec/modules.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPureSourceText } = require('./helpers/assert-pure-source');

test('a comment that merely mentions a banned word passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "// this module deliberately avoids process and console\nexport const x = 1;\n",
      'fixture.mjs',
    );
  });
});

test('an import outside allowImports fails', () => {
  assert.throws(() => {
    assertPureSourceText(
      "import { helper } from './not-allowed.mjs';\nexport const x = 1;\n",
      'fixture.mjs',
      { allowImports: [] },
    );
  }, assert.AssertionError);
});

test('an import listed in allowImports passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "import { helper } from './allowed.mjs';\nexport const x = 1;\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  });
});

test('a banned ambient-state access still fails even with matching allowImports', () => {
  assert.throws(() => {
    assertPureSourceText(
      "import { helper } from './allowed.mjs';\nexport const x = process.cwd();\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  }, assert.AssertionError);
});

test('a dynamic import is always banned, even when the specifier is in allowImports', () => {
  assert.throws(() => {
    assertPureSourceText(
      "export const x = import('./allowed.mjs');\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  }, assert.AssertionError);
});

test('a "//" inside a string literal does not hide a banned use later on the line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const u = 'http://x'; const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a "//" inside a regex literal does not hide a banned use later on the line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const r = /\\//; const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('`export ... from` is checked against allowImports like a static import', () => {
  assert.throws(() => {
    assertPureSourceText(
      "export * from 'node:fs';\n",
      'fixture.mjs',
      { allowImports: [] },
    );
  }, assert.AssertionError);
});

test('`export ... from` listed in allowImports passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "export { helper } from './allowed.mjs';\n",
      'fixture.mjs',
      { allowImports: ['./allowed.mjs'] },
    );
  });
});

test('`import.meta` is banned', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const url = import.meta.url;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return /\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('typeof followed by a regex literal is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "typeof /\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword with no space is not mistaken for "//" comment', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return/\\//.test(s); const y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a regex literal right after a keyword does not derail quote tracking on the next line', () => {
  assert.throws(() => {
    assertPureSourceText(
      "return /'/.test(s);\nconst u = 'http://x'; process.exit();\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('division after a plain identifier is still division and does not break stripping', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const c = a / b;\nconst y = process.env;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('division followed by a comment naming a banned word on the same line passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('const c = a / b; // no process here\n', 'fixture.mjs');
  });
});

test('a banned word spelled inside a string literal (not real code) passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText("const msg = 'the process module is banned';\n", 'fixture.mjs');
  });
});

test('a banned word spelled inside a regex literal (not real code) passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('const r = /process\\.env/;\n', 'fixture.mjs');
  });
});

test('a banned word spelled inside template-literal text (not real code) passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('const msg = `no process here`;\n', 'fixture.mjs');
  });
});

test('a banned word inside a template literal\'s ${…} substitution still fails', () => {
  assert.throws(() => {
    assertPureSourceText('const msg = `value: ${process.env.X}`;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('an import specifier string still reads correctly once literals are blanked', () => {
  assert.throws(() => {
    assertPureSourceText(
      "import { helper } from './not-allowed.mjs';\nexport const x = 1;\n",
      'fixture.mjs',
      { allowImports: [] },
    );
  }, /not-allowed\.mjs/);
});

// Fail-closed lexing: whenever the helper cannot tell a literal from real code, it must
// leave the text in place (still checked), never blank real code.

test('a string holding a "{" inside a ${…} substitution does not hide later code', () => {
  assert.throws(() => {
    assertPureSourceText(
      "function g() {\n  return `${open ? '{' : ''}`;\n}\nprocess.exit(0);\nconst b = `ok`;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('a template nested inside a ${…} substitution does not hide later code', () => {
  assert.throws(() => {
    assertPureSourceText(
      "const s = `a ${`b ${'}'} c`} d`;\nprocess.exit(0);\nconst b = `ok`;\n",
      'fixture.mjs',
    );
  }, assert.AssertionError);
});

test('an unterminated template leaves the rest of the source checked', () => {
  assert.throws(() => {
    assertPureSourceText('const s = `${a`;\nprocess.exit(0);\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('an unterminated string leaves the rest of the source checked', () => {
  assert.throws(() => {
    assertPureSourceText("const s = 'abc\nprocess.exit(0);\n", 'fixture.mjs');
  }, assert.AssertionError);
});

test('an unterminated block comment leaves the rest of the source checked', () => {
  assert.throws(() => {
    assertPureSourceText('/* open\nprocess.exit(0);\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('division after a postfix ++ is not mistaken for a regex literal', () => {
  assert.throws(() => {
    assertPureSourceText('const t = n++ / 2 + process.uptime() / 2;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('division after a postfix -- is not mistaken for a regex literal', () => {
  assert.throws(() => {
    assertPureSourceText('const t = n-- / 2 + process.uptime() / 2;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

for (const prop of ['in', 'of', 'new', 'delete', 'return', 'typeof']) {
  test(`division after a keyword-named property (.${prop}) is not mistaken for a regex literal`, () => {
    assert.throws(() => {
      assertPureSourceText(
        `const avg = counts.${prop} / n + process.uptime() / 2;\n`,
        'fixture.mjs',
      );
    }, assert.AssertionError);
  });
}

test('division after an optional-chained keyword-named property is not mistaken for a regex', () => {
  assert.throws(() => {
    assertPureSourceText('const avg = counts?.in / n + process.uptime() / 2;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('a "/" guessed as a regex start is kept as code when what follows cannot follow a regex', () => {
  assert.throws(() => {
    assertPureSourceText('const t = {} / 2 + process.uptime() / 2;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

// Regressions: the blanking that lets real literals mention banned words keeps working.

test('a banned word in a regex literal after a keyword passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('function f(s) {\n  return /process\\.env/.test(s);\n}\n', 'fixture.mjs');
  });
});

test('banned words in regex literals with flags, in an array and as arguments pass', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText(
      "const rs = [/console/g, /Date\\b/i];\nconst ok = s.replace(/globalThis/g, '') && /process/.source;\n",
      'fixture.mjs',
    );
  });
});

test('a regex literal holding quotes, "//" and a class with "/" passes and stays scoped', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText("const r = /['\"]\\/\\/[/*]process/;\nconst y = 1;\n", 'fixture.mjs');
  });
  assert.throws(() => {
    assertPureSourceText("const r = /['\"]\\/\\/[/*]x/;\nprocess.exit(0);\n", 'fixture.mjs');
  }, assert.AssertionError);
});

test('a banned word in a string inside a ${…} substitution passes', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText("const s = `a ${cond ? '{process}' : `console`} b`;\n", 'fixture.mjs');
  });
});

test('a banned word in real code inside a nested ${…} substitution still fails', () => {
  assert.throws(() => {
    assertPureSourceText('const s = `a ${`b ${process.env.X}`} c`;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('an object literal with braces inside a ${…} substitution is balanced', () => {
  assert.doesNotThrow(() => {
    assertPureSourceText('const s = `${JSON.stringify({ a: { b: 1 } })} process`;\n', 'fixture.mjs');
  });
});

test('a keyword spelled as an identifier prefix still counts as an identifier', () => {
  assert.throws(() => {
    assertPureSourceText('const t = index / 2 + process.uptime() / 2;\n', 'fixture.mjs');
  }, assert.AssertionError);
});

test('lexing keeps length and line structure, blanking only comments and literal text', () => {
  const { lexSource } = require('./helpers/assert-pure-source');
  const source = [
    "import { a } from './a.mjs'; // note",
    '/* block',
    '   comment */ const s = `t ${x ? "{" : `n ${y}`} u`;',
    "const r = /re\\/x/g; const q = 'str';",
    'const t = n++ / 2;',
    '',
  ].join('\r\n');
  const { stripped, blanked } = lexSource(source);
  for (const out of [stripped, blanked]) {
    assert.equal(out.length, source.length);
    assert.deepEqual(
      [...out].map((ch, k) => (ch === '\n' || ch === '\r' ? k : -1)).filter((k) => k >= 0),
      [...source].map((ch, k) => (ch === '\n' || ch === '\r' ? k : -1)).filter((k) => k >= 0),
    );
  }
  assert.match(stripped, /from '\.\/a\.mjs';/);
  assert.doesNotMatch(stripped, /note|block|comment/);
  assert.ok(stripped.includes('/re\\/x/g'));
  assert.match(blanked, /\$\{x \? " " : ` +\$\{y\}` *\}/);
  assert.match(blanked, /const r = \/ {5}\/g; const q = ' {3}';/);
  assert.match(blanked, /const t = n\+\+ \/ 2;/);
});
