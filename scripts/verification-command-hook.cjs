#!/usr/bin/env node
'use strict';

// A quality guard for the observed verification pipeline mistake, not a shell
// sandbox. Keep ordinary log-reading pipelines available.
function withoutLiteralHereDocs(command) {
  const pending = [];
  return command
    .split(/\r?\n/)
    .map((line) => {
      if (pending.length) {
        const doc = pending[0];
        if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.end) pending.shift();
        return '';
      }
      // Only quoted delimiters: unquoted heredocs can execute substitutions.
      // Scan the header outside strings so echo "<< 'DOC'" is not a redirect.
      let quote = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && quote !== "'") {
          i++;
          continue;
        }
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        const match = line.slice(i).match(/^<<(-?)\s*(?:'([^']+)'|"([^"$`]+)")/);
        if (match) {
          pending.push({ end: match[2] ?? match[3], tabs: match[1] === '-' });
          i += match[0].length - 1;
        } else if (ch === "'" || ch === '"') quote = ch;
      }
      return line;
    })
    .join('\n');
}

function unsafeVerification(command) {
  command = withoutLiteralHereDocs(command);
  const verification =
    /(?:^|[\s/\\])(?:run-checked\.cjs|tsc|vitest|eslint|prettier)(?=[\s;|&"']|$)|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build)(?=[\s;|&"']|$)/i;
  const hidesExit =
    /\|\s*(?:&\s*)?(?:tail|head|tee|Select-Object|Out-String|Out-File)\b|(?:;|\r?\n|&&|\|\|)\s*(?:echo|Write-Output|printf)\s+[^\r\n;]*\$(?:\?|LASTEXITCODE\b)/i;
  // Quoted search patterns and log text are not verification invocations.
  // This intentionally does not interpret scripts passed to sh -c or eval.
  const executableText = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, ' ');
  // Repository quality gates are also run directly, outside package-manager
  // scripts. Require a runtime invocation so reading these files stays allowed.
  const scriptVerification =
    /\b(?:node|bun)(?:\.exe)?\s+(?:--test\b|(?:run\s+)?(?:[^\s"';&|]*[/\\])?(?:check-[\w.-]+|verify-[\w.-]+|preflight-check|pre-commit-check)\.[cm]?[jt]s\b)/i;
  return (
    (verification.test(executableText) || scriptVerification.test(executableText)) &&
    hidesExit.test(command)
  );
}

function decision(input) {
  if (!['Bash', 'PowerShell'].includes(input.tool_name)) return undefined;
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !unsafeVerification(command)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Verification command rejected before execution: an output pipeline or trailing echo can hide its real exit code. Run it directly with node scripts/run-checked.cjs --tail-lines 40 -- "<command>" (use ../scripts from a package directory). Do not append a pipe or echo. Read the saved log in a separate tool call if needed.',
    },
  };
}

if (require.main === module) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    text += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const result = decision(JSON.parse(text));
      if (result) process.stdout.write(JSON.stringify(result));
    } catch {
      process.stderr.write('Verification hook received invalid input; retry the tool call.\n');
      process.exitCode = 2;
    }
  });
}

module.exports = { decision };
