/**
 * workflow-handlers-files.question-lock.test.ts
 *
 * Verifies that question saves hold the same task-lifecycle lock the
 * scheduler uses for its same-task decision, while other file types
 * (research/plan/verify) bypass it entirely (task #901).
 */

import { describe, it, expect, mock } from 'bun:test';

mock.module('../../../config', () => ({ prisma: {} }));
mock.module('../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {},
}));
mock.module('../core/workflow-helpers', () => ({
  VALID_FILE_TYPES: ['research', 'question', 'plan', 'verify'],
  resolveWorkflowDir: () => Promise.resolve(null),
  getFileInfo: () => Promise.resolve({ exists: false }),
}));

let releaseTransition!: () => void;
let transitionGate = new Promise<void>((resolve) => {
  releaseTransition = resolve;
});

const mockComputeAndApplyStatusTransition = mock(async () => {
  await transitionGate;
  return {
    newStatus: 'awaiting_question',
    researchCompleted: false,
    verifyRerunAlreadyDone: false,
    verifyRepairBounced: false,
  };
});

mock.module('./file-save', () => ({
  validateFileType: (ft: string) => ft,
  resolveTargetTask: async () => ({
    task: { workflowStatus: 'in_progress', workflowMode: null },
    categoryId: 1,
    themeId: 1,
  }),
  guardStatusTransition: async () => ({ ok: true, status: 'in_progress' }),
  guardParentSubtasksTerminal: async () => {},
  prepareAndPersistContent: async () => ({
    ok: true,
    content: 'Q',
    fileLanguage: 'ja',
    savedContent: 'Q',
  }),
  computeAndApplyStatusTransition: mockComputeAndApplyStatusTransition,
  runPhaseCriticGate: async ({ newStatus }: { newStatus: string }) => ({
    newStatus,
    criticRejection: undefined,
  }),
  runPlanPostProcessing: async ({ newStatus }: { newStatus: string }) => ({
    newStatus,
    autoApproved: false,
    splitResult: undefined,
  }),
  runVerifyPostSaveAutomation: async ({ newStatus }: { newStatus: string }) => ({
    newStatus,
    taskMarkedDone: false,
    autoCommitPRResult: {},
  }),
}));

const { handleSaveFile } = await import('./workflow-handlers-files');
const { withTaskLifecycleLock } = await import('../../../services/workflow/task-lifecycle-lock');

/** Flushes N microtask turns — handleSaveFile hops through several awaited
 * pipeline stages before reaching the lock, so a fixed small count of
 * Promise.resolve() calls is not reliably enough. */
async function flushMicrotasks(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('handleSaveFile question-lock wiring', () => {
  it('question保存はcomputeAndApplyStatusTransition実行中タスクロックを保持する', async () => {
    const save = handleSaveFile({
      params: { taskId: '42', fileType: 'question' },
      body: { content: 'Q' },
      set: { status: 200 },
    });
    await flushMicrotasks();

    const probeOrder: string[] = [];
    const probe = withTaskLifecycleLock(42, async () => {
      probeOrder.push('probe');
    });
    await Promise.resolve();
    expect(probeOrder).toEqual([]);

    releaseTransition();
    await Promise.all([save, probe]);
    expect(probeOrder).toEqual(['probe']);
  });

  it('research保存はタスクロックを取らない', async () => {
    transitionGate = Promise.resolve();

    let releaseProbe!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probe = withTaskLifecycleLock(43, () => gate);
    let saved = false;
    const save = handleSaveFile({
      params: { taskId: '43', fileType: 'research' },
      body: { content: 'R' },
      set: { status: 200 },
    }).then(() => {
      saved = true;
    });
    try {
      await flushMicrotasks(50);
      expect(saved).toBe(true);
    } finally {
      releaseProbe();
      await Promise.all([probe, save]);
    }
  });
});
