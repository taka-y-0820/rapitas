/**
 * schema-change-gate.integration.test
 *
 * Regression test for the early-return gap identified in task 892's plan.md
 * (「重大な既存コードパスの欠落」): a schema-only change (no `.ts` files
 * touched) must NOT be waved through by runAutomatedVerification's
 * zero-changed-code-files fast path. Exercises the REAL git subprocess calls
 * against a throwaway repo — same style as
 * automated-verifier.diff-base-ref.test.ts — rather than mocking
 * getAllChangedFiles, since the bug lives in how the early return combines
 * multiple check results.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Real Git subprocesses can exceed Bun's 5s default under Windows suite load.
// Keep assertions intact and let subprocess work finish before fixture cleanup.
const GIT_TEST_TIMEOUT_MS = 30_000;
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAutomatedVerification } from '../../services/agents/verification/automated-verifier';

describe('runAutomatedVerification — schema-only change bypasses the zero-code-files fast path', () => {
  let repoDir: string;

  function run(cmd: string): string {
    return execSync(cmd, { cwd: repoDir }).toString().trim();
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'schema-gate-integration-'));
    run('git init -q');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');
    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    run('git add README.md');
    run('git commit -q -m "root"');

    mkdirSync(join(repoDir, 'prisma', 'schema'), { recursive: true });
    // Untracked — mirrors an agent adding a new schema file without staging it.
    writeFileSync(join(repoDir, 'prisma', 'schema', 'x.prisma'), 'model X { id Int @id }\n');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test(
    'result.ok is false and a failing schema-change check is present when the schema file is unplanned',
    async () => {
      const result = await runAutomatedVerification(repoDir, {
        planContent: '## 変更予定ファイル\n- `other.ts`',
      });
      expect(result.ok).toBe(false);
      const schemaCheck = result.checks.find((c) => c.name === 'schema-change');
      expect(schemaCheck).toBeDefined();
      expect(schemaCheck?.ok).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    'result.ok is true when the schema file is declared in plan.md',
    async () => {
      const result = await runAutomatedVerification(repoDir, {
        planContent: '## 変更予定ファイル\n- `prisma/schema/x.prisma`',
      });
      expect(result.ok).toBe(true);
      const schemaCheck = result.checks.find((c) => c.name === 'schema-change');
      expect(schemaCheck?.ok).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
