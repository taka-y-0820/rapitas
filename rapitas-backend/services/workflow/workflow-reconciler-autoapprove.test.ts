/**
 * workflow-reconciler-autoapprove テスト
 *
 * plan_created で停滞し auto-approve ポリシーが有効なタスクだけが
 * 再承認されること(人間ゲート待ちのタスクは触らない)、1タスクの失敗が
 * 他の修復を止めないことを検証する。Own file — mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

let staleTasks: Array<{ id: number }> = [];
const taskFindMany = mock(async () => staleTasks);
mock.module('../../config/database', () => ({
  prisma: { task: { findMany: taskFindMany } },
}));

let policyByTask: Record<number, boolean> = {};
const resolveEffectiveAutoApprovePlan = mock(
  async (taskId: number) => policyByTask[taskId] ?? false,
);
const maybeAutoApprovePlan = mock(async () => ({
  newStatus: 'plan_approved' as const,
  autoApproved: true,
}));
mock.module('./plan-auto-approve', () => ({
  resolveEffectiveAutoApprovePlan,
  maybeAutoApprovePlan,
}));

const { healAutoApproveStalls } = await import('./workflow-reconciler-autoapprove');

beforeEach(() => {
  staleTasks = [];
  policyByTask = {};
  taskFindMany.mockClear();
  resolveEffectiveAutoApprovePlan.mockClear();
  maybeAutoApprovePlan.mockClear();
  maybeAutoApprovePlan.mockResolvedValue({ newStatus: 'plan_approved', autoApproved: true });
});

describe('healAutoApproveStalls', () => {
  test('candidate selection excludes stopped todo and terminal tasks', async () => {
    await healAutoApproveStalls(Date.now());
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'in-progress' }),
      }),
    );
  });
  test('stale plan_created with active policy → re-approved with autoAdvance', async () => {
    staleTasks = [{ id: 492 }];
    policyByTask = { 492: true };

    const healed = await healAutoApproveStalls(Date.now());
    expect(healed).toBe(1);
    expect(maybeAutoApprovePlan).toHaveBeenCalledTimes(1);
    expect(
      (
        maybeAutoApprovePlan.mock.calls[0] as unknown as [number, string, { autoAdvance: boolean }]
      )[2],
    ).toEqual({ autoAdvance: true });
  });

  test('human-gate tasks (policy off) are left untouched', async () => {
    staleTasks = [{ id: 100 }];
    policyByTask = { 100: false };

    const healed = await healAutoApproveStalls(Date.now());
    expect(healed).toBe(0);
    expect(maybeAutoApprovePlan).not.toHaveBeenCalled();
  });

  test('a no-op approval (status changed meanwhile) is not counted as healed', async () => {
    staleTasks = [{ id: 101 }];
    policyByTask = { 101: true };
    maybeAutoApprovePlan.mockResolvedValueOnce({
      newStatus: 'plan_created',
      autoApproved: false,
    } as never);

    expect(await healAutoApproveStalls(Date.now())).toBe(0);
  });

  test('one failing task does not halt the remaining heals', async () => {
    staleTasks = [{ id: 1 }, { id: 2 }];
    policyByTask = { 1: true, 2: true };
    maybeAutoApprovePlan.mockRejectedValueOnce(new Error('db down'));

    expect(await healAutoApproveStalls(Date.now())).toBe(1);
    expect(maybeAutoApprovePlan).toHaveBeenCalledTimes(2);
  });

  test('no stale tasks → no-op', async () => {
    expect(await healAutoApproveStalls(Date.now())).toBe(0);
  });
});
