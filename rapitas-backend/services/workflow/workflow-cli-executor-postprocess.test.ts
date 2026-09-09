/**
 * workflow-cli-executor-postprocess.test
 *
 * Research findings must preserve acceptance verification and completion gates.
 *
 * Run this file on its own: bun's mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const taskUpdates: unknown[] = [];
const findQueueOwner = mock(async (): Promise<{ id: number } | null> => null);
mock.module('../../config', () => ({
  prisma: {
    workflowQueueItem: { findFirst: findQueueOwner },
    task: {
      update: (args: unknown) => {
        taskUpdates.push(args);
        return Promise.resolve({});
      },
    },
    agentExecution: { findFirst: () => Promise.resolve(null) },
  },
}));
let researchContent: string | null = null;
mock.module('./workflow-file-utils', () => ({
  cleanupRootWorkflowFiles: () => Promise.resolve(),
  readWorkflowFile: () =>
    researchContent ? Promise.resolve(researchContent) : Promise.reject(new Error('ENOENT')),
}));
const transitions: Array<{ cause: string }> = [];
mock.module('./transition-recorder', () => ({
  recordTransition: (args: { cause: string }) => {
    transitions.push(args);
    return Promise.resolve();
  },
}));
mock.module('./completion-gate', () => ({
  researchConcludesNoChange: (c: string) => c.includes('## 結論: 修正不要'),
}));
mock.module('../memory/timeline', () => ({ appendEvent: () => Promise.resolve() }));

const { runPostProcessing } = await import('./workflow-cli-executor-postprocess');

const advances: number[] = [];
const base = {
  taskId: 776,
  session: { id: 1 },
  language: 'ja' as const,
  effectiveSuccess: true,
  isInvestigationPhase: false,
  advanceWorkflow: (taskId: number) => {
    advances.push(taskId);
    return Promise.resolve({ success: true } as never);
  },
};
const RESEARCHER = { role: 'researcher', outputFile: 'research', nextStatus: 'research_done' };

beforeEach(() => {
  taskUpdates.length = 0;
  transitions.length = 0;
  advances.length = 0;
  researchContent = null;
  findQueueOwner.mockReset();
  findQueueOwner.mockResolvedValue(null);
});

test('queue owner alone advances implementer and auto-approved planner phases', async () => {
  findQueueOwner.mockResolvedValue({ id: 42 });
  for (const role of ['implementer', 'planner']) {
    await runPostProcessing({
      ...base,
      transition: { role } as never,
      phaseStatus: 'plan_approved',
    });
  }
  await Bun.sleep(1100);
  expect(findQueueOwner).toHaveBeenCalledTimes(2);
  expect(findQueueOwner).toHaveBeenCalledWith({
    where: { taskId: 776, status: 'running' },
    select: { id: true },
  });
  expect(advances).toEqual([]);
});

test('direct implementer execution still advances without a queue owner', async () => {
  await runPostProcessing({
    ...base,
    transition: { role: 'implementer' } as never,
    phaseStatus: 'in_progress',
  });
  await Bun.sleep(1100);
  expect(advances).toEqual([776]);
});

test('owner lookup failure does not start a competing execution', async () => {
  findQueueOwner.mockRejectedValue(new Error('DB unavailable'));
  await runPostProcessing({
    ...base,
    transition: { role: 'implementer' } as never,
    phaseStatus: 'in_progress',
  });
  await Bun.sleep(1100);
  expect(advances).toEqual([]);
});

describe('runPostProcessing — research preserves completion gates', () => {
  test('修正不要の結論だけで完了させない', async () => {
    researchContent = '# 調査\n\n## 結論: 修正不要\n\n既存実装で満たされている。';
    await runPostProcessing({
      ...base,
      transition: RESEARCHER as never,
      phaseStatus: 'research_done' as never,
    });
    expect(taskUpdates.length).toBe(0);
    expect(transitions).toEqual([]);
    expect(advances).toEqual([]);
  });

  test('修正不要の結論が無ければ通常どおり（完了させない）', async () => {
    researchContent = '# 調査\n\n## 結論: 修正が必要。実装方針は…';
    await runPostProcessing({
      ...base,
      transition: RESEARCHER as never,
      phaseStatus: 'research_done' as never,
    });
    expect(taskUpdates.length).toBe(0);
    expect(transitions.length).toBe(0);
  });

  test('research.md が読めなくても fail open で通常フロー', async () => {
    researchContent = null;
    await runPostProcessing({
      ...base,
      transition: RESEARCHER as never,
      phaseStatus: 'research_done' as never,
    });
    expect(taskUpdates.length).toBe(0);
  });

  test('researcher 以外の役割では判定しない', async () => {
    researchContent = '## 結論: 修正不要';
    await runPostProcessing({
      ...base,
      transition: { role: 'verifier', outputFile: 'verify', nextStatus: 'verify_done' } as never,
      phaseStatus: 'verify_done' as never,
    });
    expect(taskUpdates.length).toBe(0);
  });
});
