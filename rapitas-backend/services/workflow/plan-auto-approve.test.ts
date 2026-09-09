/**
 * plan-auto-approve テスト
 *
 * resolveEffectiveAutoApprovePlan's task/global/subtask precedence, and
 * maybeAutoApprovePlan's idempotency (only fires from plan_created),
 * per-flag gating, and the reason it records for the transition/activity log.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { releaseTaskExecutionLock } from '../agents/task-execution-lock';

const advanceWorkflow = mock(async () => ({ success: true }));
mock.module('./workflow-orchestrator', () => ({
  WorkflowOrchestrator: { getInstance: () => ({ advanceWorkflow }) },
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

type UserSettings = { autoApprovePlan?: boolean; autoApproveSubtaskPlan?: boolean } | null;
type TaskRow = {
  autoApprovePlan?: boolean;
  parentId?: number | null;
  workflowStatus?: string;
} | null;

let userSettings: UserSettings = null;
let taskRow: TaskRow = null;
const taskUpdates: Array<Record<string, unknown>> = [];
const activityLogCreates: Array<Record<string, unknown>> = [];

mock.module('../../config/database', () => ({
  prisma: {
    userSettings: { findFirst: () => Promise.resolve(userSettings) },
    task: {
      findUnique: () => Promise.resolve(taskRow),
      update: (args: Record<string, unknown>) => {
        taskUpdates.push(args);
        return Promise.resolve({});
      },
    },
    activityLog: {
      create: (args: { data: Record<string, unknown> }) => {
        activityLogCreates.push(args.data);
        return Promise.resolve({});
      },
    },
  },
}));

const recordedTransitions: Array<Record<string, unknown>> = [];
mock.module('./transition-recorder', () => ({
  recordTransition: (input: Record<string, unknown>) => {
    recordedTransitions.push(input);
    return Promise.resolve();
  },
}));

const { resolveEffectiveAutoApprovePlan, maybeAutoApprovePlan } =
  await import('./plan-auto-approve');

beforeEach(() => {
  advanceWorkflow.mockClear();
  userSettings = null;
  taskRow = null;
  taskUpdates.length = 0;
  activityLogCreates.length = 0;
  recordedTransitions.length = 0;
});

describe('resolveEffectiveAutoApprovePlan', () => {
  test('task not found → false', async () => {
    taskRow = null;
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(false);
  });

  test('task-level flag alone → true', async () => {
    taskRow = { autoApprovePlan: true, parentId: null };
    userSettings = null;
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(true);
  });

  test('global userSettings flag alone → true', async () => {
    taskRow = { autoApprovePlan: false, parentId: null };
    userSettings = { autoApprovePlan: true };
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(true);
  });

  test('subtask-specific global flag only applies when the task IS a subtask', async () => {
    userSettings = { autoApproveSubtaskPlan: true };
    taskRow = { autoApprovePlan: false, parentId: 10 };
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(true);

    taskRow = { autoApprovePlan: false, parentId: null };
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(false);
  });

  test('no flags set anywhere → false', async () => {
    taskRow = { autoApprovePlan: false, parentId: null };
    userSettings = { autoApprovePlan: false, autoApproveSubtaskPlan: false };
    expect(await resolveEffectiveAutoApprovePlan(1)).toBe(false);
  });
});

describe('plan auto-approval continuation', () => {
  test('stop after approval revokes the delayed next phase', async () => {
    taskRow = { autoApprovePlan: true, workflowStatus: 'plan_created' };
    await maybeAutoApprovePlan(99121);
    releaseTaskExecutionLock(99121);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });

  test('an unstopped approval still advances normally', async () => {
    taskRow = { autoApprovePlan: true, workflowStatus: 'plan_created' };
    await maybeAutoApprovePlan(99122);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(advanceWorkflow).toHaveBeenCalledWith(99122, 'ja');
  });
});

describe('maybeAutoApprovePlan', () => {
  test('no-op (idempotent) when task is not at plan_created', async () => {
    taskRow = { autoApprovePlan: true, parentId: null, workflowStatus: 'plan_approved' };
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r).toEqual({ newStatus: 'plan_approved', autoApproved: false });
    expect(taskUpdates).toHaveLength(0);
  });

  test('task not found → returns plan_created/false without throwing', async () => {
    taskRow = null;
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r).toEqual({ newStatus: 'plan_created', autoApproved: false });
  });

  test('no auto-approve flags set → stays at plan_created, no writes', async () => {
    taskRow = { autoApprovePlan: false, parentId: null, workflowStatus: 'plan_created' };
    userSettings = null;
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r).toEqual({ newStatus: 'plan_created', autoApproved: false });
    expect(taskUpdates).toHaveLength(0);
    expect(recordedTransitions).toHaveLength(0);
  });

  test('task-level flag flips status to plan_approved and records the transition + activity log', async () => {
    taskRow = { autoApprovePlan: true, parentId: null, workflowStatus: 'plan_created' };
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r.newStatus).toBe('plan_approved');
    expect(r.autoApproved).toBe(true);
    expect(r.reason).toBe('task-level autoApprovePlan setting enabled');
    expect(taskUpdates[0].data).toMatchObject({ workflowStatus: 'plan_approved' });
    expect(recordedTransitions).toHaveLength(1);
    expect(recordedTransitions[0].cause).toBe('auto_approve_plan');
    expect(activityLogCreates).toHaveLength(1);
  });

  test('global flag (no task-level flag) records the global reason', async () => {
    taskRow = { autoApprovePlan: false, parentId: null, workflowStatus: 'plan_created' };
    userSettings = { autoApprovePlan: true };
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r.reason).toBe('global autoApprovePlan setting enabled');
  });

  test('subtask flag (isSubtask + autoApproveSubtaskPlan) records the subtask reason', async () => {
    taskRow = { autoApprovePlan: false, parentId: 5, workflowStatus: 'plan_created' };
    userSettings = { autoApproveSubtaskPlan: true };
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r.reason).toBe('subtask autoApproveSubtaskPlan setting enabled');
  });

  test('task-level reason takes precedence over global/subtask when multiple flags are set', async () => {
    taskRow = { autoApprovePlan: true, parentId: 5, workflowStatus: 'plan_created' };
    userSettings = { autoApprovePlan: true, autoApproveSubtaskPlan: true };
    const r = await maybeAutoApprovePlan(1, 'ja', { autoAdvance: false });
    expect(r.reason).toBe('task-level autoApprovePlan setting enabled');
  });
});
