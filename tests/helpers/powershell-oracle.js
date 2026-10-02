'use strict';

// Used by the PowerShell oracle test (tests/guard-powershell-oracle.test.js): finds a
// PowerShell executable and asks its parser API for the command elements of each span.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Reads one base64 (UTF-8) span per line, parses each with the PowerShell parser API and
// prints, base64 encoded, the elements of each span's first command: a string constant or
// an expandable string as its value, any other element as its source text. Elements are
// joined by NUL, spans by U+001E. Parse errors are ignored (5.1 reports `&&` and `||`).
const SCRIPT = `param([string]$In)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$records = New-Object System.Collections.Generic.List[string]
foreach ($line in [System.IO.File]::ReadAllLines($In)) {
  $span = $utf8.GetString([Convert]::FromBase64String($line))
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($span, [ref]$tokens, [ref]$errors)
  $command = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
  $words = New-Object System.Collections.Generic.List[string]
  if ($null -ne $command) {
    foreach ($e in $command.CommandElements) {
      if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
          $e -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        $words.Add($e.Value)
      } else {
        $words.Add($e.Extent.Text)
      }
    }
  }
  $records.Add([string]::Join([string][char]0, $words.ToArray()))
}
$text = [string]::Join([string][char]0x1e, $records.ToArray())
[Console]::Out.Write([Convert]::ToBase64String($utf8.GetBytes($text)))
`;

/**
 * Runs a PowerShell executable with the given arguments.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {string} cwd
 */
function runPowerShell(exe, args, cwd) {
  return spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * The version of a working PowerShell executable, or null.
 *
 * @param {string} exe
 * @param {string} cwd
 * @returns {string | null}
 */
function powerShellVersion(exe, cwd) {
  const probe = runPowerShell(exe, ['-Command', '$PSVersionTable.PSVersion.ToString()'], cwd);
  if (probe.error || probe.status !== 0) return null;
  const version = probe.stdout.trim();
  return /^\d+\.\d+/.test(version) ? version : null;
}

/**
 * The elements the PowerShell parser yields for each span's first command.
 *
 * @param {string} exe
 * @param {string[]} spans
 * @param {string} cwd a scratch directory for the script and its input
 * @returns {string[][]}
 */
function parseSpans(exe, spans, cwd) {
  const script = path.join(cwd, 'oracle.ps1');
  const input = path.join(cwd, 'spans.txt');
  fs.writeFileSync(script, SCRIPT, 'utf8');
  fs.writeFileSync(input, spans.map((s) => Buffer.from(s, 'utf8').toString('base64')).join('\n'), 'utf8');
  const result = runPowerShell(exe, ['-File', script, '-In', input], cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${exe} exited ${result.status}: ${result.stderr}`);
  const text = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  const records = text.split('\x1e');
  if (records.length !== spans.length) {
    throw new Error(`${exe}: ${records.length} record(s) for ${spans.length} span(s)`);
  }
  return records.map((r) => (r === '' ? [] : r.split('\0')));
}

module.exports = { runPowerShell, powerShellVersion, parseSpans };
