'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { decision } = require('./verification-command-hook.cjs');

for (const command of [
  'node ../scripts/run-checked.cjs -- "bunx tsc --noEmit" 2>&1 | tail -50',
  'bunx tsc --noEmit | head -30',
  'pnpm exec vitest run src/a.test.ts | tee result.log',
  'bun test; echo $?',
  'pnpm test\necho "$LASTEXITCODE"',
  'pnpm exec tsc --noEmit | Select-Object -Last 40',
  'echo "<< \'DOC\'"\nbun test | tail -1',
  'cat << DOC\n$(bun test | tail -1)\nDOC',
]) {
  test(`denies before execution: ${command}`, () => {
    for (const tool_name of ['Bash', 'PowerShell']) {
      assert.equal(
        decision({ tool_name, tool_input: { command } }).hookSpecificOutput.permissionDecision,
        'deny',
      );
    }
  });
}

for (const command of [
  'node ../scripts/run-checked.cjs --tail-lines 40 -- "bunx tsc --noEmit"',
  'bun test --isolate example.test.ts',
  'cat .verification-logs/result.log | tail -40',
  'git status --short',
  'rg "bun test" backend.log | tail -40',
  'rg "run-checked.cjs" backend.log | head -20',
  "cat > report.md << 'MDEOF'\nRejected example: bunx tsc --noEmit | tail -40\nMDEOF",
  'cat <<-"DOC"\n\tbun test | head -1\n\tDOC',
]) {
  test(`leaves normal permission flow intact: ${command}`, () => {
    assert.equal(decision({ tool_name: 'Bash', tool_input: { command } }), undefined);
  });
}

test('commands following a literal heredoc are still checked', () => {
  const command = "cat << 'DOC'\nbun test | tail -1\nDOC\nbun test | tail -1";
  assert.equal(
    decision({ tool_name: 'Bash', tool_input: { command } }).hookSpecificOutput.permissionDecision,
    'deny',
  );
});

test('hook executable emits the Claude PreToolUse protocol', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verification-command-hook.cjs')],
    {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bun test | tail -40' } }),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
