/**
 * plan-auto-approve テスト
 *
 * resolveEffectiveAutoApprovePlan's task/global/subtask precedence, and
 * maybeAutoApprovePlan's idempotency (only fires from plan_created),
 * per-flag gating, and the reason it records for the transition/activity log.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ExecutionCancelledError } from '../agents/execution-cancelled-error';
import { releaseTaskExecutionLock } from '../agents/task-execution-lock';

const advanceWorkflow = mock(async () => ({ success: true }));
mock.module('./workflow-orchestrator', () => ({
  WorkflowOrchestrator: { getInstance: () => ({ advanceWorkflow }) },
}));

const logError = mock(() => {});
const logInfo = mock(() => {});
mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: logInfo, warn: () => {}, error: logError, debug: () => {} }),
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
let manualDecision: { cause: string } | null = null;
let decisionUnavailable = false;
let approvalCount = 1;

mock.module('../../config/database', () => ({
  prisma: {
    workflowTransition: {
      findFirst: async () => {
        if (decisionUnavailable) throw new Error('decision lookup failed');
        return manualDecision;
      },
    },
    userSettings: { findFirst: () => Promise.resolve(userSettings) },
    task: {
      findUnique: () => Promise.resolve(taskRow),
      updateMany: (args: Record<string, unknown>) => {
        taskUpdates.push(args);
        return Promise.resolve({ count: approvalCount });
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
  manualDecision = null;
  decisionUnavailable = false;
  approvalCount = 1;
  advanceWorkflow.mockClear();
  logError.mockClear();
  logInfo.mockClear();
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
  test('manual rejection during the deferred advance prevents execution', async () => {
    userSettings = { autoApprovePlan: true };
    taskRow = { workflowStatus: 'plan_created' };
    await maybeAutoApprovePlan(99125);
    manualDecision = { cause: 'manual_plan_rejected' };
    await Bun.sleep(1100);
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });
  test('stop or concurrent revision winning the DB update prevents approval side effects', async () => {
    userSettings = { autoApprovePlan: true };
    taskRow = { workflowStatus: 'plan_created' };
    approvalCount = 0;
    expect((await maybeAutoApprovePlan(915)).autoApproved).toBe(false);
    expect(taskUpdates[0]).toMatchObject({
      where: { status: 'in-progress', workflowStatus: 'plan_created' },
    });
    expect(recordedTransitions).toHaveLength(0);
    expect(activityLogCreates).toHaveLength(0);
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });
  test('manual rejection overrides global auto-approve and prevents dispatch', async () => {
    userSettings = { autoApprovePlan: true };
    taskRow = { workflowStatus: 'plan_created' };
    manualDecision = { cause: 'manual_plan_rejected' };
    expect(await resolveEffectiveAutoApprovePlan(915)).toBe(false);
    expect((await maybeAutoApprovePlan(915)).autoApproved).toBe(false);
    expect(taskUpdates).toHaveLength(0);
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });
  test('unavailable manual decision holds instead of silently approving', async () => {
    userSettings = { autoApprovePlan: true };
    taskRow = { workflowStatus: 'plan_created' };
    decisionUnavailable = true;
    expect((await maybeAutoApprovePlan(915)).autoApproved).toBe(false);
    expect(taskUpdates).toHaveLength(0);
  });
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

describe('auto-advance error classification', () => {
  test('intentional stop is informational', async () => {
    taskRow = { autoApprovePlan: true, workflowStatus: 'plan_created' };
    advanceWorkflow.mockRejectedValueOnce(new ExecutionCancelledError('ownership revoked'));
    await maybeAutoApprovePlan(99123);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      { taskId: 99123, reason: 'ownership revoked' },
      '[plan-auto-approve] Auto-advance cancelled by stop',
    );
  });

  test('unexpected failures remain errors', async () => {
    taskRow = { autoApprovePlan: true, workflowStatus: 'plan_created' };
    const failure = new Error('database unavailable');
    advanceWorkflow.mockRejectedValueOnce(failure);
    await maybeAutoApprovePlan(99124);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(logError).toHaveBeenCalledWith(
      { err: failure, taskId: 99124 },
      '[plan-auto-approve] Auto-advance failed (non-fatal)',
    );
  });
});
