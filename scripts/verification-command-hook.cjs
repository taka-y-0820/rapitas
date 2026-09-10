#!/usr/bin/env node
'use strict';

// A quality guard for the observed verification pipeline mistake, not a shell
// sandbox. Keep ordinary log-reading pipelines available.
function unsafeVerification(command) {
  const verification =
    /(?:^|[\s/\\])(?:run-checked\.cjs|tsc|vitest|eslint|prettier)(?=[\s;|&"']|$)|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build)(?=[\s;|&"']|$)/i;
  const hidesExit =
    /\|\s*(?:&\s*)?(?:tail|head|tee|Select-Object|Out-String|Out-File)\b|(?:;|\r?\n|&&|\|\|)\s*(?:echo|Write-Output)\s+["']?\$(?:\?|LASTEXITCODE\b)/i;
  // Quoted search patterns and log text are not verification invocations.
  // This intentionally does not interpret scripts passed to sh -c or eval.
  const executableText = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, ' ');
  return verification.test(executableText) && hidesExit.test(command);
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
