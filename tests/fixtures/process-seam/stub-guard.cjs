'use strict';

// Stub guard entry point for the process-seam self-test (FND-04): reads the PreToolUse JSON
// from stdin to its end, echoes the parsed input on stdout, and, when the command mentions
// `plan`, writes a heartbeat file under the Claude home (`CLAUDE_CONFIG_DIR`, else `.claude`
// in the OS home), as the real guard does (C:guard). Unreadable input: no stdout, exit 0.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    process.stderr.write('unreadable input');
    return;
  }
  const command = input.tool_input && input.tool_input.command;
  if (typeof command === 'string' && command.includes('plan')) {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const dir = path.join(claudeHome, 'commit-guard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'heartbeat.json'),
      JSON.stringify({ ts: Date.now(), cwd: input.cwd, command }),
    );
  }
  process.stdout.write(JSON.stringify(input));
});
