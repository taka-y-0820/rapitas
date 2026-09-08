/**
 * Shared automated verification gate tests.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockPrisma = {
  task: {
    update: mock(() => Promise.resolve({})),
    findUnique: mock(() => Promise.resolve(null)),
  },
  agentSession: {
    update: mock(() => Promise.resolve({})),
  },
  agentExecutionConfig: {
    findUnique: mock(() => Promise.resolve(null)),
  },
};

let verifierMode: 'pass' | 'fail' | 'throw' | 'indeterminate' | 'acceptance-ng' = 'pass';
// Captures the options runVerificationGate passed to runAutomatedVerification
// (task 874: verifies acceptanceCriteria/taskText wiring without a real verifier).
let capturedVerifyOptions: { acceptanceCriteria?: string[]; taskText?: string } | null = null;

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));
mock.module('../../config/logger', () => {
  const stub = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  // Provide BOTH the factory and the `logger` singleton — a transitively
  // imported module uses `import { logger }`, which errors if the mock omits it.
  return { createLogger: () => stub, logger: stub };
});
const createNotification = mock(() => Promise.resolve({})) as any;
// NOTE: mock.module replaces the module for the WHOLE bun test process (other
// test files run in the same invocation may import the real module too), so
// every value export is stubbed here rather than just `createNotification` —
// otherwise an unrelated file destructuring e.g. `notifyTaskCompleted` from
// this same physical module would fail with "export not found".
mock.module('../../services/communication/notification-service', () => ({
  createNotification,
  notifyTaskCompleted: () => Promise.resolve(),
  notifyAgentExecutionCompleted: () => Promise.resolve(),
  notifyApprovalRequested: () => Promise.resolve(),
  notifyAuthenticationFailure: () => Promise.resolve(),
  notifyPomodoroCompleted: () => Promise.resolve(),
  AUTH_FAILURE_NOTIFICATION_TITLE: 'Claude 認証切れ',
}));

mock.module('../../services/agents/verification/automated-verifier', () => ({
  runAutomatedVerification: mock(
    async (
      _worktreePath: string,
      options?: { acceptanceCriteria?: string[]; taskText?: string },
    ) => {
      capturedVerifyOptions = options ?? null;
      if (verifierMode === 'throw') throw new Error('tool crashed');
      if (verifierMode === 'acceptance-ng') {
        return {
          ok: true,
          changedFiles: ['src/ok.ts'],
          checks: [
            { name: 'lint', ran: true, ok: true, errorCount: 0, details: '' },
            { name: 'acceptance', ran: true, ok: false, errorCount: 1, details: '基準未充足' },
          ],
          summary: 'verification passed (acceptance advisory NG)',
        };
      }
      if (verifierMode === 'fail') {
        return {
          ok: false,
          changedFiles: ['src/broken.ts'],
          checks: [
            {
              name: 'typecheck',
              ran: true,
              ok: false,
              errorCount: 1,
              details: 'TS2322: Type string is not assignable to number',
            },
          ],
          summary: '1 new typecheck error in src/broken.ts',
        };
      }
      if (verifierMode === 'indeterminate') {
        // Task 659: triage came back null → the test check is ok:true but flagged.
        return {
          ok: true,
          changedFiles: ['src/ok.ts', 'src/ok.test.ts'],
          checks: [
            {
              name: 'test',
              ran: true,
              ok: true,
              errorCount: 0,
              details: '1 test command(s) failed, but the baseline comparison was indeterminate',
              indeterminate: true,
              indeterminateFailures: ['src/ok.test.ts', 'src/other.test.ts'],
            },
          ],
          summary: 'verification passed (test triage indeterminate)',
        };
      }
      return {
        ok: true,
        changedFiles: ['src/ok.ts'],
        checks: [{ name: 'lint', ran: true, ok: true, errorCount: 0, details: '' }],
        summary: 'verification passed',
      };
    },
  ),
  renderVerificationMarkdown: (result: { summary: string }) =>
    `# Verification\n\n${result.summary}`,
  // The gate also imports this (bug-fix tasks require a test change); the
  // mock previously omitted it, which broke module linking for this whole file.
  looksLikeBugFixTask: () => false,
  // Real implementation (not a stub) — the gate's verdict computation is the
  // behavior under test in the "verdict" describe block below.
  computeVerdict: (
    checks: Array<{ name: string; ran: boolean; ok: boolean; indeterminate?: boolean }>,
  ) => {
    const indeterminate = checks.some((c) => c.indeterminate === true);
    const advisoryNg = checks.some(
      (c) => (c.name === 'scope' || c.name === 'acceptance') && c.ran && c.ok === false,
    );
    return indeterminate || advisoryNg ? 'unknown' : 'pass';
  },
}));

// Spy on concern filing. Full mirror of the real module (bun mock.module is
// process-global) with only submitConcern replaced.
const realConcerns = await import('../../services/memory/concern-backlog-service');
const submitConcern = mock((_input: unknown) => Promise.resolve(1));
mock.module('../../services/memory/concern-backlog-service', () => ({
  ...realConcerns,
  submitConcern,
}));

const recordTransition = mock((_input: unknown) => Promise.resolve());
mock.module('../../services/workflow/transition-recorder', () => ({ recordTransition }));

const { runVerificationGate, recordUnknownVerdictMarker } =
  await import('../../services/agents/verification/verification-gate');

function resetMockFunctions(value: unknown): void {
  if (typeof value === 'function' && 'mockReset' in value) {
    (value as ReturnType<typeof mock>).mockReset();
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) resetMockFunctions(child);
  }
}

describe('runVerificationGate', () => {
  beforeEach(() => {
    resetMockFunctions(mockPrisma);
    mockPrisma.task.update.mockResolvedValue({});
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockPrisma.task.findUnique.mockResolvedValue(null);
    mockPrisma.agentExecutionConfig.findUnique.mockResolvedValue(null);
    createNotification.mockReset();
    createNotification.mockResolvedValue({});
    verifierMode = 'pass';
    submitConcern.mockReset();
    submitConcern.mockResolvedValue(1);
  });

  test('opens the gate when automated verification passes', async () => {
    const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.summary).toBe('verification passed');
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
  });

  test('blocks the task and fails the session when verification finds new failures', async () => {
    verifierMode = 'fail';

    const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

    expect(outcome.ok).toBe(false);
    expect(outcome.result?.summary).toContain('typecheck error');
    expect(mockPrisma.task.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ status: 'blocked' }),
    });
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('1 new typecheck error'),
      }),
    });
  });

  test('blocks publishing and records an environment failure if the verifier crashes', async () => {
    verifierMode = 'throw';

    const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

    expect(outcome.ok).toBe(false);
    expect(outcome.result?.unverifiable).toBe(true);
    expect(mockPrisma.task.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ status: 'blocked' }),
    });
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('検証環境'),
      }),
    });
  });

  test('a verifier crash also closes the gate without a session', async () => {
    verifierMode = 'throw';
    const outcome = await runVerificationGate(1, 'C:\\repo');
    expect(outcome.ok).toBe(false);
    expect(outcome.result?.unverifiable).toBe(true);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
  });

  describe('blockTaskForVerification — durable write fault injection', () => {
    test('retries the blocked-status write once on failure, then succeeds', async () => {
      verifierMode = 'fail';
      mockPrisma.task.update
        .mockImplementationOnce(() => Promise.reject(new Error('transient DB error')))
        .mockImplementationOnce(() => Promise.resolve({}));

      const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

      expect(outcome.ok).toBe(false);
      expect(mockPrisma.task.update).toHaveBeenCalledTimes(2);
      // Write eventually landed — no need to escalate via notification.
      expect(createNotification).not.toHaveBeenCalled();
    });

    test('notifies when the blocked-status write fails on every attempt', async () => {
      verifierMode = 'fail';
      mockPrisma.task.update.mockImplementation(() => Promise.reject(new Error('DB down')));

      const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

      expect(outcome.ok).toBe(false);
      expect(mockPrisma.task.update).toHaveBeenCalledTimes(2);
      // FAIL-CLOSED ESCALATION: the loop-stopping write never landed — a human
      // must be notified instead of the task silently staying un-blocked.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][0]).toEqual(
        expect.objectContaining({ metadata: expect.objectContaining({ taskId: 1 }) }),
      );
    });

    test('retries the session-failed write once on failure, then succeeds', async () => {
      verifierMode = 'fail';
      mockPrisma.agentSession.update
        .mockImplementationOnce(() => Promise.reject(new Error('transient DB error')))
        .mockImplementationOnce(() => Promise.resolve({}));

      const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

      expect(outcome.ok).toBe(false);
      expect(mockPrisma.agentSession.update).toHaveBeenCalledTimes(2);
    });

    test('does not throw when the session-failed write fails on every attempt', async () => {
      verifierMode = 'fail';
      mockPrisma.agentSession.update.mockImplementation(() => Promise.reject(new Error('DB down')));

      // Must resolve (not reject) even though the session write never lands —
      // the gate's own contract is "never throws", only the task/session rows
      // stay unconfirmed and are logged loudly.
      const outcome = await runVerificationGate(1, 'C:\\repo\\app\\.worktrees\\task-1', 10);

      expect(outcome.ok).toBe(false);
      expect(mockPrisma.agentSession.update).toHaveBeenCalledTimes(2);
    });
  });
});

// Task 659: an indeterminate triage must NOT block the task — it opens the
// gate and files one medium/other concern per unattributed file instead.
describe('runVerificationGate — indeterminate triage (task 659)', () => {
  beforeEach(() => {
    resetMockFunctions(mockPrisma);
    mockPrisma.task.update.mockResolvedValue({});
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockPrisma.task.findUnique.mockResolvedValue(null);
    mockPrisma.agentExecutionConfig.findUnique.mockResolvedValue(null);
    submitConcern.mockReset();
    submitConcern.mockResolvedValue(1);
    capturedVerifyOptions = null;
  });

  test('opens the gate and files a concern per unattributed test file', async () => {
    verifierMode = 'indeterminate';

    const outcome = await runVerificationGate(7, 'C:\\repo\\app\\.worktrees\\task-7', 70);

    expect(outcome.ok).toBe(true);
    expect(outcome.verdict).toBe('unknown');
    expect(outcome.result?.checks[0]?.indeterminate).toBe(true);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
    expect(submitConcern).toHaveBeenCalledTimes(2);
    expect(submitConcern).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'other',
        severity: 'medium',
        location: 'src/ok.test.ts',
        originTaskId: 7,
        source: 'verification-triage',
        dedupKey: 'test-triage-indeterminate:src/ok.test.ts',
      }),
    );
    expect(submitConcern).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: 'test-triage-indeterminate:src/other.test.ts' }),
    );
  });

  test('a failing submitConcern does not close the gate', async () => {
    verifierMode = 'indeterminate';
    submitConcern.mockImplementation(() => Promise.reject(new Error('concern DB down')));

    const outcome = await runVerificationGate(7, 'C:\\repo\\app\\.worktrees\\task-7', 70);

    expect(outcome.ok).toBe(true);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('files no concern when the verification carries no indeterminate files', async () => {
    verifierMode = 'pass';

    await runVerificationGate(7, 'C:\\repo\\app\\.worktrees\\task-7', 70);

    expect(submitConcern).not.toHaveBeenCalled();
  });
});

// Task 874: three-way verdict — acceptance/scope advisory NG must downgrade to
// 'unknown' (not silently 'pass'), and acceptanceCriteria/taskText must reach
// runAutomatedVerification (previously never wired — see research.md 前提監査4).
describe('runVerificationGate — verdict (task 874)', () => {
  beforeEach(() => {
    resetMockFunctions(mockPrisma);
    mockPrisma.task.update.mockResolvedValue({});
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockPrisma.task.findUnique.mockResolvedValue(null);
    mockPrisma.agentExecutionConfig.findUnique.mockResolvedValue(null);
    submitConcern.mockReset();
    submitConcern.mockResolvedValue(1);
    capturedVerifyOptions = null;
  });

  test("verdict is 'unknown' and a downgrade concern is filed when acceptance is advisory NG", async () => {
    verifierMode = 'acceptance-ng';

    const outcome = await runVerificationGate(8, 'C:\\repo\\app\\.worktrees\\task-8');

    expect(outcome.ok).toBe(true);
    expect(outcome.verdict).toBe('unknown');
    expect(submitConcern).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: 'verify-unknown:8:acceptance' }),
    );
  });

  test("verdict is 'fail' (never computed from checks) when the verifier crashes", async () => {
    verifierMode = 'throw';

    const outcome = await runVerificationGate(9, 'C:\\repo\\app\\.worktrees\\task-9');

    expect(outcome.ok).toBe(false);
    expect(outcome.verdict).toBe('fail');
  });

  test('passes acceptanceCriteria and taskText through to runAutomatedVerification', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'タイトルX',
      description: '説明Y',
      goals: null,
      constraints: null,
      acceptanceCriteria: JSON.stringify(['基準1', '基準2']),
    });

    await runVerificationGate(10, 'C:\\repo\\app\\.worktrees\\task-10');

    expect(capturedVerifyOptions?.acceptanceCriteria).toEqual(['基準1', '基準2']);
    expect(capturedVerifyOptions?.taskText).toContain('タイトルX');
  });
});

describe('recordUnknownVerdictMarker (task 874)', () => {
  test("records a WorkflowTransition with cause 'verification_unknown' and the given source", async () => {
    recordTransition.mockClear();

    await recordUnknownVerdictMarker(11, 'C:\\nonexistent-repo', 'workflow-auto-commit');

    expect(recordTransition).toHaveBeenCalledTimes(1);
    const arg = recordTransition.mock.calls[0]![0] as {
      taskId: number;
      cause: string;
      metadata: { source: string };
    };
    expect(arg.taskId).toBe(11);
    expect(arg.cause).toBe('verification_unknown');
    expect(arg.metadata.source).toBe('workflow-auto-commit');
  });
});
