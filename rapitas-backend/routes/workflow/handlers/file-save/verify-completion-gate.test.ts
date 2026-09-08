import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';
import { beforeEach, expect, mock, test } from 'bun:test';

const update = mock(async (_args: unknown) => ({ count: 1 }));
const audit = mock(async (_args: unknown) => undefined);
const gate = mock(async () => ({ allow: false, reason: 'no_changes' }));
const tx = {
  task: { updateMany: update },
  agentExecution: { findFirst: async () => null },
  workflowTransition: { create: audit, findFirst: async () => null },
};
mock.module('../../../../config', () => ({
  prisma: {
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    task: {
      findUnique: async () => ({ title: 'Implement requirement', githubPrId: null }),
      update,
    },
    agentSession: { findFirst: async () => ({ worktreePath: '/task' }) },
    workflowTransition: { count: async () => 5 },
  },
}));
mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}));
mock.module('../../../../services/workflow/completion-gate', () => ({
  evaluateCompletionGate: gate,
}));
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: audit,
}));
mock.module('../../../../services/task/task-resolver', () => ({
  resolvePreferredBaseBranch: async () => 'develop',
}));
const { runVerifyCompletionGate } = await import('./verify-completion-gate');
beforeEach(() => {
  update.mockClear();
  audit.mockClear();
  gate.mockClear();
});
const receipt = {
  taskId: 909,
  executionId: null,
  evaluatedUpdatedAt: new Date('2026-09-08T00:00:00Z'),
} as CompletionReviewReceipt;
const params = {
  completionReceipt: receipt,
  taskId: 909,
  fileType: 'verify' as const,
  newStatus: 'verify_done',
  savedContent: 'PASS',
};

test('repeated empty diffs never complete a task without justification', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await runVerifyCompletionGate(params)).verifyGateBlocked).toBe(true);
  }
  expect(update.mock.calls).toHaveLength(3);
  for (const [args] of update.mock.calls) {
    expect((args as { data: { status: string } }).data.status).toBe('blocked');
  }
  for (const [args] of audit.mock.calls) {
    expect((args as { data: { toStatus: string } }).data.toStatus).toBe('verify_done');
  }
});

test('failed persistence propagates instead of recording a successful block', async () => {
  update.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(runVerifyCompletionGate(params)).rejects.toThrow('database unavailable');
  expect(audit).not.toHaveBeenCalled();
});

test('an allowed gate proceeds to the remaining completion gates', async () => {
  gate.mockResolvedValueOnce({ allow: true, reason: 'has_changes' });
  expect((await runVerifyCompletionGate(params)).verifyGateBlocked).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

test('a superseding task version is not overwritten or audited as blocked', async () => {
  update.mockResolvedValueOnce({ count: 0 });
  await expect(runVerifyCompletionGate(params)).rejects.toThrow('task changed');
  expect(audit).not.toHaveBeenCalled();
  expect(update.mock.calls[0][0]).toMatchObject({
    where: {
      id: 909,
      status: 'in-progress',
      workflowStatus: 'verify_done',
      updatedAt: receipt.evaluatedUpdatedAt,
    },
  });
});

test('audit failure rejects the transaction', async () => {
  audit.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(runVerifyCompletionGate(params)).rejects.toThrow('audit unavailable');
});
